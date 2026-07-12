import { AUDIO_EFFECT_ORDER, DELAY_MAX_DELAY_TIME_SEC, normalizeAudioEffectOrder, normalizeCompressorParams, normalizeDelayParams, normalizeReverbParams, normalizeSaturatorParams, type AudioEffectKind, type CompressorParamsLite, type DelayParamsLite, type ReverbParamsLite, type SaturatorParamsLite } from '@daw-browser/shared'
import { applyDelayNodeParams, applySaturatorNodeParams } from './dsp'
import { getReverbImpulseSignature } from './reverb-signature'
import { ensureCompressorWorklet, postCompressorParams } from './compressor-worklet'
import { compressorWorklet } from '../worklet-manifest'
import type { StaticWorkletNodeChain } from './static-worklet-chain'

export type CreateReverbImpulseResponse = (params: ReverbParamsLite) => AudioBuffer

export type ReverbNodeChain = {
  enabled: boolean
  internalsConnected: boolean
  impulseSignature: string | null
  dryGain: GainNode
  wetGain: GainNode
  preDelay: DelayNode
  lowCut: BiquadFilterNode
  highCut: BiquadFilterNode
  convolver: ConvolverNode
  widthSplitter: ChannelSplitterNode
  widthMerger: ChannelMergerNode
  leftToLeft: GainNode
  rightToLeft: GainNode
  leftToRight: GainNode
  rightToRight: GainNode
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

type GainTransitionScheduler = {
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
  request: (reconnect: () => void) => void
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
    request: (reconnect) => {
      if (disposed) return
      invalidate()
      const requestVersion = transitionVersion
      const currentTime = getCurrentTime()
      const fadeOutEnd = currentTime + fadeOutSec
      node.gain.cancelScheduledValues(currentTime)
      node.gain.setValueAtTime(node.gain.value, currentTime)
      node.gain.linearRampToValueAtTime(0, fadeOutEnd)
      timer = scheduler.schedule(() => {
        timer = undefined
        if (disposed || transitionVersion !== requestVersion) return
        reconnect()
        const reconnectTime = Math.max(fadeOutEnd, getCurrentTime())
        node.gain.setValueAtTime(0, reconnectTime)
        node.gain.linearRampToValueAtTime(1, reconnectTime + fadeInSec)
      }, fadeOutSec * 1000)
    },
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
  shaper: WaveShaperNode
  outputGain: GainNode
}

export type DelayNodeChain = {
  enabled: boolean
  pingPong: boolean
  internalsConnected: boolean
  dryGain: GainNode
  wetGain: GainNode
  delayLeft: DelayNode
  delayRight: DelayNode
  feedbackLeft: GainNode
  feedbackRight: GainNode
  lowCutLeft: BiquadFilterNode
  highCutLeft: BiquadFilterNode
  lowCutRight: BiquadFilterNode
  highCutRight: BiquadFilterNode
  splitter: ChannelSplitterNode
  merger: ChannelMergerNode
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
    if (!node) continue
    try { node.disconnect() } catch {}
  }
}

export function createReverbNodeChain(
  ctx: BaseAudioContext,
  params: ReverbParamsLite,
  createImpulseResponse: CreateReverbImpulseResponse,
): ReverbNodeChain {
  const chain: ReverbNodeChain = {
    enabled: !!params.enabled,
    internalsConnected: false,
    impulseSignature: null,
    dryGain: ctx.createGain(),
    wetGain: ctx.createGain(),
    preDelay: ctx.createDelay(2.0),
    lowCut: ctx.createBiquadFilter(),
    highCut: ctx.createBiquadFilter(),
    convolver: ctx.createConvolver(),
    widthSplitter: ctx.createChannelSplitter(2),
    widthMerger: ctx.createChannelMerger(2),
    leftToLeft: ctx.createGain(),
    rightToLeft: ctx.createGain(),
    leftToRight: ctx.createGain(),
    rightToRight: ctx.createGain(),
  }
  applyReverbNodeChainParams(chain, params, createImpulseResponse)
  return chain
}

export function applyReverbNodeChainParams(
  chain: ReverbNodeChain,
  params: ReverbParamsLite,
  createImpulseResponse: CreateReverbImpulseResponse,
) {
  const normalized = normalizeReverbParams(params)
  chain.enabled = normalized.enabled
  chain.dryGain.gain.value = 1 - normalized.wet
  chain.wetGain.gain.value = normalized.wet
  chain.preDelay.delayTime.value = normalized.preDelayMs / 1000
  chain.lowCut.type = 'highpass'
  chain.lowCut.frequency.value = normalized.lowCutHz
  chain.lowCut.Q.value = 0.707
  chain.highCut.type = 'lowpass'
  chain.highCut.frequency.value = normalized.highCutHz
  chain.highCut.Q.value = 0.707
  const width = normalized.stereoWidth
  chain.leftToLeft.gain.value = (1 + width) / 2
  chain.rightToLeft.gain.value = (1 - width) / 2
  chain.leftToRight.gain.value = (1 - width) / 2
  chain.rightToRight.gain.value = (1 + width) / 2
  if (!chain.enabled) {
    chain.convolver.buffer = null
    chain.impulseSignature = null
    return
  }
  const impulseSignature = getReverbImpulseSignature(normalized)
  if (chain.impulseSignature === impulseSignature) return
  const impulse = createImpulseResponse(normalized)
  chain.convolver.buffer = impulse
  chain.impulseSignature = impulseSignature
}

export function disconnectReverbChain(chain: ReverbNodeChain) {
  disconnectAudioNodes([
    chain.dryGain,
    chain.wetGain,
    chain.preDelay,
    chain.lowCut,
    chain.highCut,
    chain.convolver,
    chain.widthSplitter,
    chain.widthMerger,
    chain.leftToLeft,
    chain.rightToLeft,
    chain.leftToRight,
    chain.rightToRight,
  ])
  chain.internalsConnected = false
  chain.impulseSignature = null
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
    shaper: ctx.createWaveShaper(),
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
  disconnectAudioNodes([chain.dryGain, chain.wetGain, chain.driveGain, chain.colorFilter, chain.shaper, chain.outputGain])
  chain.internalsConnected = false
}

function connectSaturatorInternals(chain: SaturatorNodeChain) {
  if (chain.internalsConnected) return
  chain.driveGain.connect(chain.colorFilter)
  chain.colorFilter.connect(chain.shaper)
  chain.shaper.connect(chain.wetGain)
  chain.dryGain.connect(chain.outputGain)
  chain.wetGain.connect(chain.outputGain)
  chain.internalsConnected = true
}

export function createDelayNodeChain(ctx: BaseAudioContext, params: DelayParamsLite, bpm: number): DelayNodeChain {
  const normalized = normalizeDelayParams(params)
  const chain: DelayNodeChain = {
    enabled: normalized.enabled,
    pingPong: normalized.pingPong,
    internalsConnected: false,
    dryGain: ctx.createGain(),
    wetGain: ctx.createGain(),
    delayLeft: ctx.createDelay(DELAY_MAX_DELAY_TIME_SEC),
    delayRight: ctx.createDelay(DELAY_MAX_DELAY_TIME_SEC),
    feedbackLeft: ctx.createGain(),
    feedbackRight: ctx.createGain(),
    lowCutLeft: ctx.createBiquadFilter(),
    highCutLeft: ctx.createBiquadFilter(),
    lowCutRight: ctx.createBiquadFilter(),
    highCutRight: ctx.createBiquadFilter(),
    splitter: ctx.createChannelSplitter(2),
    merger: ctx.createChannelMerger(2),
  }
  applyDelayNodeChainParams(chain, normalized, bpm)
  return chain
}

export function applyDelayNodeChainParams(chain: DelayNodeChain, params: DelayParamsLite, bpm: number) {
  const normalized = normalizeDelayParams(params)
  chain.enabled = normalized.enabled
  chain.pingPong = normalized.pingPong
  applyDelayNodeParams(chain, normalized, bpm)
}

export function disconnectDelayChain(chain: DelayNodeChain) {
  disconnectAudioNodes([
    chain.dryGain, chain.wetGain, chain.delayLeft, chain.delayRight, chain.feedbackLeft, chain.feedbackRight,
    chain.lowCutLeft, chain.highCutLeft, chain.lowCutRight, chain.highCutRight, chain.splitter, chain.merger,
  ])
  chain.internalsConnected = false
}

function connectDelayInternals(chain: DelayNodeChain) {
  if (chain.internalsConnected) return
  if (chain.pingPong) {
    chain.splitter.connect(chain.delayLeft, 0)
    chain.splitter.connect(chain.delayRight, 1)
    chain.delayLeft.connect(chain.lowCutLeft)
    chain.lowCutLeft.connect(chain.highCutLeft)
    chain.highCutLeft.connect(chain.merger, 0, 0)
    chain.highCutLeft.connect(chain.feedbackRight)
    chain.feedbackRight.connect(chain.delayRight)
    chain.delayRight.connect(chain.lowCutRight)
    chain.lowCutRight.connect(chain.highCutRight)
    chain.highCutRight.connect(chain.merger, 0, 1)
    chain.highCutRight.connect(chain.feedbackLeft)
    chain.feedbackLeft.connect(chain.delayLeft)
    chain.merger.connect(chain.wetGain)
  } else {
    chain.delayLeft.connect(chain.lowCutLeft)
    chain.lowCutLeft.connect(chain.highCutLeft)
    chain.highCutLeft.connect(chain.wetGain)
    chain.highCutLeft.connect(chain.feedbackLeft)
    chain.feedbackLeft.connect(chain.delayLeft)
  }
  chain.internalsConnected = true
}

function connectReverbInternals(chain: ReverbNodeChain) {
  if (chain.internalsConnected) return
  chain.preDelay.connect(chain.lowCut)
  chain.lowCut.connect(chain.highCut)
  chain.highCut.connect(chain.convolver)
  chain.convolver.connect(chain.wetGain)
  chain.wetGain.connect(chain.widthSplitter)
  chain.widthSplitter.connect(chain.leftToLeft, 0)
  chain.widthSplitter.connect(chain.leftToRight, 0)
  chain.widthSplitter.connect(chain.rightToLeft, 1)
  chain.widthSplitter.connect(chain.rightToRight, 1)
  chain.leftToLeft.connect(chain.widthMerger, 0, 0)
  chain.rightToLeft.connect(chain.widthMerger, 0, 0)
  chain.leftToRight.connect(chain.widthMerger, 0, 1)
  chain.rightToRight.connect(chain.widthMerger, 0, 1)
  chain.internalsConnected = true
}

export function connectFxChain(
  input: AudioNode,
  destination: AudioNode,
  config: {
    eqNodes?: BiquadFilterNode[]
    compressorChain?: CompressorNodeChain | null
    saturatorChain?: SaturatorNodeChain | null
    delayChain?: DelayNodeChain | null
    reverbChain?: ReverbNodeChain | null
    order?: AudioEffectKind[]
    instances?: FxChainStageConfig[]
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
    const delay = stageConfig.delayChain?.enabled ? stageConfig.delayChain : null
    const reverb = stageConfig.reverbChain?.enabled ? stageConfig.reverbChain : null
    const staticWorklet = stageConfig.staticWorkletChain?.state === 'active' ? stageConfig.staticWorkletChain : null

    if (!compressor && stageConfig.compressorChain) disconnectAudioNodes([stageConfig.compressorChain.input])
    if (saturator) connectSaturatorInternals(saturator)
    else if (stageConfig.saturatorChain) disconnectSaturatorChain(stageConfig.saturatorChain)
    if (delay) connectDelayInternals(delay)
    else if (stageConfig.delayChain) disconnectDelayChain(stageConfig.delayChain)
    if (reverb) connectReverbInternals(reverb)
    else if (stageConfig.reverbChain) disconnectReverbChain(stageConfig.reverbChain)

    if (stageConfig.kind === 'eq' && eqNodes.length > 0) {
      disconnectAudioNodes(eqNodes)
      for (let index = 0; index < eqNodes.length; index++) {
        if (index < eqNodes.length - 1) eqNodes[index].connect(eqNodes[index + 1])
      }
      return {
        connectInput: (source) => source.connect(eqNodes[0]),
        outputs: [eqNodes[eqNodes.length - 1]],
      }
    }

    if (staticWorklet) {
      disconnectAudioNodes([staticWorklet.node])
      return {
        connectInput: (source) => source.connect(staticWorklet.node),
        outputs: [staticWorklet.node],
      }
    }

    if (stageConfig.kind === 'compressor' && compressor) {
      disconnectAudioNodes([compressor.input, compressor.output])
      compressor.input.connect(compressor.dryGain)
      compressor.input.connect(compressor.workletNode)
      compressor.output.disconnect()
      return {
        connectInput: (source) => source.connect(compressor.input),
        outputs: [compressor.output],
      }
    }

    if (stageConfig.kind === 'saturator' && saturator) {
      disconnectAudioNodes([saturator.outputGain])
      return {
        connectInput: (source) => {
          source.connect(saturator.dryGain)
          source.connect(saturator.driveGain)
        },
        outputs: [saturator.outputGain],
      }
    }

    if (stageConfig.kind === 'delay' && delay) {
      disconnectAudioNodes([delay.dryGain, delay.wetGain])
      return {
        connectInput: (source) => {
          source.connect(delay.dryGain)
          source.connect(delay.pingPong ? delay.splitter : delay.delayLeft)
        },
        outputs: [delay.dryGain, delay.wetGain],
      }
    }

    if (stageConfig.kind === 'reverb' && reverb) {
      disconnectAudioNodes([reverb.dryGain, reverb.widthMerger])
      return {
        connectInput: (source) => {
          source.connect(reverb.dryGain)
          source.connect(reverb.preDelay)
        },
        outputs: [reverb.dryGain, reverb.widthMerger],
      }
    }

    return null
  }

  const createLegacyStages = () => {
    const stagesByKind = new Map<AudioEffectKind, FxStage>()
    const eqNodes = config.eqNodes ?? []
    if (eqNodes.length > 0) {
      const stage = createStage({ id: 'eq', kind: 'eq', eqNodes })
      if (stage) stagesByKind.set('eq', stage)
    }

    const compressorStage = createStage({ id: 'compressor', kind: 'compressor', compressorChain: config.compressorChain })
    if (compressorStage) stagesByKind.set('compressor', compressorStage)
    const saturatorStage = createStage({ id: 'saturator', kind: 'saturator', saturatorChain: config.saturatorChain })
    if (saturatorStage) stagesByKind.set('saturator', saturatorStage)
    const delayStage = createStage({ id: 'delay', kind: 'delay', delayChain: config.delayChain })
    if (delayStage) stagesByKind.set('delay', delayStage)
    const reverbStage = createStage({ id: 'reverb', kind: 'reverb', reverbChain: config.reverbChain })
    if (reverbStage) stagesByKind.set('reverb', reverbStage)

    return normalizeAudioEffectOrder(config.order ?? AUDIO_EFFECT_ORDER, AUDIO_EFFECT_ORDER)
      .flatMap((kind) => {
        const stage = stagesByKind.get(kind)
        return stage ? [stage] : []
      })
  }

  try { input.disconnect() } catch {}
  const stages = config.instances
    ? config.instances.flatMap((stageConfig) => {
      const stage = createStage(stageConfig)
      return stage ? [stage] : []
    })
    : createLegacyStages()
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
