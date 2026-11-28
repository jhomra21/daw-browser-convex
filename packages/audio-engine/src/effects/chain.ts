import { normalizeCompressorParams, normalizeDelayParams, normalizeReverbParams, normalizeSaturatorParams, isOwnedProcessorKind, type AudioEffectKind, type CompressorParamsLite, type DelayParamsLite, type ReverbParamsLite, type SaturatorParamsLite } from '@daw-browser/shared'
import { applySaturatorNodeParams } from './dsp'
import { scheduleAudioParamRamp } from '../audio-param-ramp'
import { ensureCompressorWorklet, postCompressorParams } from './compressor-worklet'
import { compressorWorklet, delayWorklet, reverbWorklet, resolveWorkletModuleUrl } from '../worklet-manifest'
import type { StaticWorkletNodeChain } from './static-worklet-chain'
import { loadWorkletModule } from '../worklet-loader'
import { safeDisconnect } from '../safe-disconnect'

export type ReverbNodeChain = {
  enabled: boolean
  internalsConnected: boolean
  input: GainNode
  output: GainNode
  workletNode: AudioWorkletNode
  revision: number
}

export type CompressorNodeChain = {
  enabled: boolean
  state: 'active' | 'faulted' | 'closed'
  input: GainNode
  output: GainNode
  dryGain: GainNode
  processedGain: GainNode
  workletNode: AudioWorkletNode
  fault: Error | null
}

export type CompressorProcessorLifecyclePhase = 'registration' | 'construction' | 'protocol' | 'runtime'

export class CompressorProcessorError extends Error {
  readonly processor = 'daw-compressor-processor'
  readonly phase: CompressorProcessorLifecyclePhase

  constructor(phase: CompressorProcessorLifecyclePhase, message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'CompressorProcessorError'
    this.phase = phase
  }
}

export type CompressorFaultTransition = {
  state: CompressorNodeChain['state']
  fault: Error | null
  dryGain: { gain: CompressorFaultAudioParam }
  processedGain: { gain: CompressorFaultAudioParam }
}

type CompressorFaultAudioParam = {
  value: number
  cancelScheduledValues: (time: number) => void
  setValueAtTime: (value: number, time: number) => void
  linearRampToValueAtTime: (value: number, endTime: number) => void
}

type GainTransitionNode = {
  gain: CompressorFaultAudioParam
}

export type GainTransitionScheduler = {
  schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clear: (timer: ReturnType<typeof setTimeout>) => void
}

const defaultGainTransitionScheduler: GainTransitionScheduler = {
  // The bounded one-shot delay lets the fade-out render before disconnecting
  // the old graph. Callers retain the cancel function for lifecycle cleanup.
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (timer) => clearTimeout(timer),
}

export type GainTransitionOwner = {
  request: (reconnect: () => void, onSettled?: () => void) => void
  pending: () => boolean
  cancel: () => void
  dispose: () => void
}

export function createGainTransitionOwner(
  node: GainTransitionNode,
  getCurrentTime: () => number,
  scheduler: GainTransitionScheduler = defaultGainTransitionScheduler,
  fadeOutSec = 0.005,
  fadeInSec = 0.005,
): GainTransitionOwner {
  let disposed = false
  let transitionVersion = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const invalidate = () => {
    transitionVersion += 1

    if (timer === undefined) return
    scheduler.clear(timer)
    timer = undefined
  }

  const cancel = () => {
    if (disposed) return
    invalidate()
    const currentTime = getCurrentTime()
    node.gain.cancelScheduledValues(currentTime)
    node.gain.setValueAtTime(1, currentTime)
  }

  return {
    request: (reconnect, onSettled) => {
      if (disposed) return
      invalidate()
      const requestVersion = transitionVersion
      const currentTime = getCurrentTime()
      const fadeOutEnd = currentTime + fadeOutSec
      scheduleAudioParamRamp(node.gain, 0, currentTime, fadeOutSec)
      timer = scheduler.schedule(() => {
        timer = undefined

        if (disposed || transitionVersion !== requestVersion) return
        reconnect()
        const reconnectTime = Math.max(fadeOutEnd, getCurrentTime())
        node.gain.setValueAtTime(0, reconnectTime)
        node.gain.linearRampToValueAtTime(1, reconnectTime + fadeInSec)
        onSettled?.()
      }, fadeOutSec * 1000)
    },
    pending: () => timer !== undefined,
    cancel,
    dispose: () => {
      if (disposed) return
      disposed = true
      invalidate()
    },
  }
}

export function handleCompressorProcessorError(chain: CompressorFaultTransition, currentTime: number) {
  if (chain.state !== 'active') return
  chain.state = 'faulted'
  chain.fault = new Error('Compressor processor failed during runtime processing.')
  chain.dryGain.gain.cancelScheduledValues(currentTime)
  chain.processedGain.gain.cancelScheduledValues(currentTime)
  chain.dryGain.gain.setValueAtTime(chain.dryGain.gain.value, currentTime)
  chain.processedGain.gain.setValueAtTime(chain.processedGain.gain.value, currentTime)
  chain.dryGain.gain.linearRampToValueAtTime(1, currentTime + 0.01)
  chain.processedGain.gain.linearRampToValueAtTime(0, currentTime + 0.01)
}

export type SaturatorNodeChain = {
  enabled: boolean
  internalsConnected: boolean
  dryGain: GainNode
  wetGain: GainNode
  driveGain: GainNode
  colorFilter: BiquadFilterNode
  waveNode: ReturnType<BaseAudioContext['createWaveShaper']>
  outputGain: GainNode
}

// The worklet is both ends of the chain: a disabled delay stays in the routing and keeps hearing its input, so its bypass is a crossfade inside the processor.
export type DelayNodeChain = {
  enabled: boolean
  workletNode: AudioWorkletNode
  revision: number
  bpm: number
}

export type FxChainStageConfig = {
  id: string
  kind: AudioEffectKind | 'spectral'
  eqNodes?: BiquadFilterNode[]
  compressorChain?: CompressorNodeChain | null
  saturatorChain?: SaturatorNodeChain | null
  delayChain?: DelayNodeChain | null
  reverbChain?: ReverbNodeChain | null
  staticWorkletChain?: StaticWorkletNodeChain | null
}

export function disconnectAudioNodes(nodes: Array<AudioNode | null | undefined>) {
  for (const node of nodes) {
    safeDisconnect(node)
  }
}

export function createReverbNodeChain(
  ctx: BaseAudioContext,
  params: ReverbParamsLite,
): Promise<ReverbNodeChain> {
  return loadWorkletModule(ctx, resolveWorkletModuleUrl(reverbWorklet.modulePath)).then(() => {
    const workletNode = new AudioWorkletNode(ctx, reverbWorklet.processorName, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    })

    const chain: ReverbNodeChain = {
      enabled: !!params.enabled,
      internalsConnected: false,
      input: ctx.createGain(),
      output: ctx.createGain(),
      workletNode,
      revision: 0,
    }

    applyReverbNodeChainParams(chain, params)

    return chain
  })
}

export function applyReverbNodeChainParams(
  chain: ReverbNodeChain,
  params: ReverbParamsLite,
) {
  const normalized = normalizeReverbParams(params)
  chain.enabled = normalized.enabled
  chain.revision += 1
  chain.workletNode.port.postMessage({ type: 'configure', version: 1, revision: chain.revision, state: normalized })

  for (const [parameterId, value] of [
    ['reverb.wet', normalized.wet],
    ['reverb.decaySec', normalized.decaySec],
    ['reverb.preDelayMs', normalized.preDelayMs],
    ['reverb.reflections', normalized.reflections],
    ['reverb.reflectionModAmountMs', normalized.reflectionModAmountMs],
    ['reverb.reflectionModRateHz', normalized.reflectionModRateHz],
    ['reverb.reflectionShape', normalized.reflectionShape],
    ['reverb.diffuse', normalized.diffuse],
    ['reverb.size', normalized.size],
    ['reverb.diffusion', normalized.diffusion],
    ['reverb.lowCutHz', normalized.lowCutHz],
    ['reverb.highCutHz', normalized.highCutHz],
    ['reverb.lowShelfHz', normalized.lowShelfHz],
    ['reverb.highShelfHz', normalized.highShelfHz],
    ['reverb.lowShelfDb', normalized.lowShelfDb],
    ['reverb.highShelfDb', normalized.highShelfDb],
    ['reverb.chorusAmountMs', normalized.chorusAmountMs],
    ['reverb.chorusRateHz', normalized.chorusRateHz],
    ['reverb.stereoWidth', normalized.stereoWidth],
  ] as const) {
    const parameter = chain.workletNode.parameters.get(parameterId)

    if (parameter) parameter.value = value
  }
}

export function disconnectReverbChain(chain: ReverbNodeChain) {
  disconnectAudioNodes([
    chain.input,
    chain.output,
    chain.workletNode,
  ])

  try { chain.workletNode.port.postMessage({ type: 'release', version: 1 }) } catch {}

  try { chain.workletNode.port.close() } catch {}

  chain.internalsConnected = false
}

export async function createCompressorNodeChain(
  ctx: BaseAudioContext,
  params: CompressorParamsLite,
  onFault?: (code: string) => void,
): Promise<CompressorNodeChain> {
  const normalized = normalizeCompressorParams(params)

  try {
    await ensureCompressorWorklet(ctx)
  } catch (error) {
    throw new CompressorProcessorError('registration', 'Failed to register compressor processor.', error)
  }

  const input = ctx.createGain()
  const output = ctx.createGain()
  const dryGain = ctx.createGain()
  const processedGain = ctx.createGain()
  let workletNode: AudioWorkletNode

  try {
    workletNode = new AudioWorkletNode(ctx, compressorWorklet.processorName, {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    })
  } catch (error) {
    disconnectAudioNodes([input, output, dryGain, processedGain])
    throw new CompressorProcessorError('construction', 'Failed to construct compressor processor.', error)
  }

  const chain: CompressorNodeChain = {
    enabled: normalized.enabled,
    state: 'active',
    input,
    output,
    dryGain,
    processedGain,
    workletNode,
    fault: null,
  }

  try {
    input.connect(dryGain)
    dryGain.connect(output)
    input.connect(workletNode)
    workletNode.connect(processedGain)
    processedGain.connect(output)
    dryGain.gain.value = 0
    processedGain.gain.value = 1
    workletNode.onprocessorerror = () => {
      onFault?.('processor-error')
      handleCompressorProcessorError(chain, ctx.currentTime)
    }
  } catch (error) {
    disconnectCompressorChain(chain)
    throw new CompressorProcessorError('construction', 'Failed to connect compressor processor.', error)
  }

  try {
    postCompressorParams(chain.workletNode, normalized)
  } catch (error) {
    disconnectCompressorChain(chain)
    throw new CompressorProcessorError('protocol', 'Failed to initialize compressor processor protocol.', error)
  }

  return chain
}

export function applyCompressorNodeChainParams(chain: CompressorNodeChain, params: CompressorParamsLite) {
  const normalized = normalizeCompressorParams(params)
  chain.enabled = normalized.enabled
  postCompressorParams(chain.workletNode, normalized)
}

export function disconnectCompressorChain(chain: CompressorNodeChain) {
  chain.state = 'closed'
  chain.workletNode.onprocessorerror = null
  disconnectAudioNodes([chain.input, chain.output, chain.dryGain, chain.processedGain, chain.workletNode])

  try { chain.workletNode.port.close() } catch {}
}

export function createSaturatorNodeChain(ctx: BaseAudioContext, params: SaturatorParamsLite): SaturatorNodeChain {
  const chain: SaturatorNodeChain = {
    enabled: !!params.enabled,
    internalsConnected: false,
    dryGain: ctx.createGain(),
    wetGain: ctx.createGain(),
    driveGain: ctx.createGain(),
    colorFilter: ctx.createBiquadFilter(),
    waveNode: ctx['createWaveShaper'](),
    outputGain: ctx.createGain(),
  }

  applySaturatorNodeChainParams(chain, params)

  return chain
}

export function applySaturatorNodeChainParams(chain: SaturatorNodeChain, params: SaturatorParamsLite) {
  const normalized = normalizeSaturatorParams(params)
  chain.enabled = normalized.enabled
  applySaturatorNodeParams(chain, normalized)
}

export function disconnectSaturatorChain(chain: SaturatorNodeChain) {
  disconnectAudioNodes([chain.dryGain, chain.wetGain, chain.driveGain, chain.colorFilter, chain.waveNode, chain.outputGain])
  chain.internalsConnected = false
}

function connectSaturatorInternals(chain: SaturatorNodeChain) {
  if (chain.internalsConnected) return
  chain.driveGain.connect(chain.colorFilter)
  chain.colorFilter.connect(chain.waveNode)
  chain.waveNode.connect(chain.wetGain)
  chain.dryGain.connect(chain.outputGain)
  chain.wetGain.connect(chain.outputGain)
  chain.internalsConnected = true
}

export async function createDelayNodeChain(ctx: BaseAudioContext, params: DelayParamsLite, bpm: number): Promise<DelayNodeChain> {
  await loadWorkletModule(ctx, resolveWorkletModuleUrl(delayWorklet.modulePath))

  const chain: DelayNodeChain = {
    enabled: params.enabled,
    workletNode: new AudioWorkletNode(ctx, delayWorklet.processorName, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    }),
    revision: 0,
    bpm: 0,
  }

  setDelayChainTempo(chain, bpm)
  applyDelayNodeChainParams(chain, params)

  return chain
}

// A worklet knows no project tempo, so the one a synced time resolves against is posted to it.
export function setDelayChainTempo(chain: DelayNodeChain, bpm: number) {
  if (chain.bpm === bpm) return
  chain.workletNode.port.postMessage({ type: 'tempo', version: 1, bpm })
  chain.bpm = bpm
}

export function applyDelayNodeChainParams(chain: DelayNodeChain, params: DelayParamsLite) {
  const normalized = normalizeDelayParams(params)
  chain.enabled = normalized.enabled
  chain.revision += 1
  chain.workletNode.port.postMessage({ type: 'configure', version: 1, revision: chain.revision, state: normalized })

  for (const [parameterId, value] of [
    ['delay.timeMs', normalized.timeLeftMs],
    ['delay.timeRightMs', normalized.timeRightMs],
    ['delay.offsetLeftPercent', normalized.offsetLeftPercent],
    ['delay.offsetRightPercent', normalized.offsetRightPercent],
    ['delay.feedback', normalized.feedback],
    ['delay.dryWet', normalized.dryWet],
    ['delay.filterHz', normalized.filterHz],
    ['delay.filterWidth', normalized.filterWidth],
  ] as const) {
    const parameter = chain.workletNode.parameters.get(parameterId)

    if (parameter) parameter.value = value
  }
}

export function disconnectDelayChain(chain: DelayNodeChain) {
  disconnectAudioNodes([chain.workletNode])

  try { chain.workletNode.port.postMessage({ type: 'release', version: 1 }) } catch {}

  try { chain.workletNode.port.close() } catch {}
}

function connectReverbInternals(chain: ReverbNodeChain) {
  if (chain.internalsConnected) return
  chain.input.connect(chain.workletNode)
  chain.workletNode.connect(chain.output)
  chain.internalsConnected = true
}

export function connectFxChain(
  input: AudioNode,
  destination: AudioNode,
  config: {
    instances: FxChainStageConfig[]
  },
) {
  type FxStage = {
    connectInput: (source: AudioNode) => void
    outputs: AudioNode[]
  }

  const createStage = (stageConfig: FxChainStageConfig): FxStage | null => {
    const eqNodes = stageConfig.eqNodes ?? []
    const compressor = stageConfig.compressorChain?.enabled ? stageConfig.compressorChain : null
    const saturator = stageConfig.saturatorChain?.enabled ? stageConfig.saturatorChain : null
    // A disabled delay stays in the chain on a dry output so it keeps hearing its input.
    const delay = stageConfig.delayChain ?? null
    const reverb = stageConfig.reverbChain?.enabled ? stageConfig.reverbChain : null
    const staticWorklet = stageConfig.staticWorkletChain?.state === 'active' ? stageConfig.staticWorkletChain : null

    if (saturator) connectSaturatorInternals(saturator)
    else if (stageConfig.saturatorChain) disconnectSaturatorChain(stageConfig.saturatorChain)

    if (reverb) connectReverbInternals(reverb)
    else if (stageConfig.reverbChain) disconnectReverbChain(stageConfig.reverbChain)

    if (stageConfig.kind === 'eq') {
      if (eqNodes.length === 0) return null
      disconnectAudioNodes(eqNodes)

      for (let index = 0; index < eqNodes.length; index++) {
        if (index < eqNodes.length - 1) eqNodes[index].connect(eqNodes[index + 1])
      }

      return {
        connectInput: (source) => source.connect(eqNodes[0]),
        outputs: [eqNodes[eqNodes.length - 1]],
      }
    }

    if (isOwnedProcessorKind(stageConfig.kind)) {
      if (!staticWorklet) return null
      disconnectAudioNodes([staticWorklet.node])

      return {
        connectInput: (source) => source.connect(staticWorklet.node),
        outputs: [staticWorklet.node],
      }
    }

    if (stageConfig.kind === 'compressor') {
      if (!compressor) return null
      disconnectAudioNodes([compressor.input, compressor.output])
      compressor.input.connect(compressor.dryGain)
      compressor.input.connect(compressor.workletNode)
      compressor.output.disconnect()

      return {
        connectInput: (source) => source.connect(compressor.input),
        outputs: [compressor.output],
      }
    }

    if (stageConfig.kind === 'saturator') {
      if (!saturator) return null
      disconnectAudioNodes([saturator.outputGain])

      return {
        connectInput: (source) => {
          source.connect(saturator.dryGain)
          source.connect(saturator.driveGain)
        },
        outputs: [saturator.outputGain],
      }
    }

    if (stageConfig.kind === 'delay') {
      if (!delay) return null
      disconnectAudioNodes([delay.workletNode])

      return {
        connectInput: (source) => source.connect(delay.workletNode),
        outputs: [delay.workletNode],
      }
    }

    if (stageConfig.kind === 'reverb') {
      if (!reverb) return null
      disconnectAudioNodes([reverb.input, reverb.output])

      return {
        connectInput: (source) => source.connect(reverb.input),
        outputs: [reverb.output],
      }
    }

    throw new Error(`Unsupported audio effect kind "${stageConfig.kind}".`)
  }

  input.disconnect()

  const stages = config.instances.flatMap((stageConfig) => {
    const stage = createStage(stageConfig)

    return stage ? [stage] : []
  })

  if (stages.length === 0) {
    input.connect(destination)

    return
  }

  stages[0].connectInput(input)

  for (let index = 0; index < stages.length; index++) {
    const nextStage = stages[index + 1]

    for (const output of stages[index].outputs) {
      if (nextStage) nextStage.connectInput(output)
      else output.connect(destination)
    }
  }
}
