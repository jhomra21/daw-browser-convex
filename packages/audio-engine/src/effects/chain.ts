import { AUDIO_EFFECT_ORDER, DELAY_MAX_DELAY_TIME_SEC, normalizeAudioEffectOrder, normalizeCompressorParams, normalizeDelayParams, normalizeReverbParams, normalizeSaturatorParams, type AudioEffectKind, type CompressorParamsLite, type DelayParamsLite, type ReverbParamsLite, type SaturatorParamsLite } from '@daw-browser/shared'
import { applyDelayNodeParams, applySaturatorNodeParams } from './dsp'
import { getReverbImpulseSignature } from './reverb-signature'
import { ensureCompressorWorklet, postCompressorParams } from './compressor-worklet'

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
  internalsConnected: boolean
  workletNode: AudioWorkletNode
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

export async function createCompressorNodeChain(ctx: BaseAudioContext, params: CompressorParamsLite): Promise<CompressorNodeChain> {
  const normalized = normalizeCompressorParams(params)
  await ensureCompressorWorklet(ctx)
  const chain: CompressorNodeChain = {
    enabled: normalized.enabled,
    internalsConnected: false,
    workletNode: new AudioWorkletNode(ctx, 'daw-compressor-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }),
  }
  postCompressorParams(chain.workletNode, normalized)
  return chain
}

export function applyCompressorNodeChainParams(chain: CompressorNodeChain, params: CompressorParamsLite) {
  const normalized = normalizeCompressorParams(params)
  chain.enabled = normalized.enabled
  postCompressorParams(chain.workletNode, normalized)
}

export function disconnectCompressorChain(chain: CompressorNodeChain) {
  disconnectAudioNodes([chain.workletNode])
  chain.workletNode.port.close()
  chain.internalsConnected = false
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
  },
) {
  const eqNodes = config.eqNodes ?? []
  const compressor = config.compressorChain?.enabled ? config.compressorChain : null
  const saturator = config.saturatorChain?.enabled ? config.saturatorChain : null
  const delay = config.delayChain?.enabled ? config.delayChain : null
  const reverb = config.reverbChain?.enabled ? config.reverbChain : null
  if (!compressor && config.compressorChain) disconnectCompressorChain(config.compressorChain)
  if (saturator) connectSaturatorInternals(saturator)
  else if (config.saturatorChain) disconnectSaturatorChain(config.saturatorChain)
  if (delay) connectDelayInternals(delay)
  else if (config.delayChain) disconnectDelayChain(config.delayChain)
  if (reverb) connectReverbInternals(reverb)
  else if (config.reverbChain) disconnectReverbChain(config.reverbChain)

  type FxStage = {
    connectInput: (source: AudioNode) => void
    outputs: AudioNode[]
  }
  const stagesByKind = new Map<AudioEffectKind, FxStage>()

  if (eqNodes.length > 0) {
    disconnectAudioNodes(eqNodes)
    for (let index = 0; index < eqNodes.length; index++) {
      if (index < eqNodes.length - 1) eqNodes[index].connect(eqNodes[index + 1])
    }
    stagesByKind.set('eq', {
      connectInput: (source) => source.connect(eqNodes[0]),
      outputs: [eqNodes[eqNodes.length - 1]],
    })
  }

  if (compressor) {
    disconnectAudioNodes([compressor.workletNode])
    stagesByKind.set('compressor', {
      connectInput: (source) => source.connect(compressor.workletNode),
      outputs: [compressor.workletNode],
    })
  }

  if (saturator) {
    disconnectAudioNodes([saturator.outputGain])
    stagesByKind.set('saturator', {
      connectInput: (source) => {
        source.connect(saturator.dryGain)
        source.connect(saturator.driveGain)
      },
      outputs: [saturator.outputGain],
    })
  }

  if (delay) {
    disconnectAudioNodes([delay.dryGain, delay.wetGain])
    stagesByKind.set('delay', {
      connectInput: (source) => {
        source.connect(delay.dryGain)
        source.connect(delay.pingPong ? delay.splitter : delay.delayLeft)
      },
      outputs: [delay.dryGain, delay.wetGain],
    })
  }

  if (reverb) {
    disconnectAudioNodes([reverb.dryGain, reverb.widthMerger])
    stagesByKind.set('reverb', {
      connectInput: (source) => {
        source.connect(reverb.dryGain)
        source.connect(reverb.preDelay)
      },
      outputs: [reverb.dryGain, reverb.widthMerger],
    })
  }

  try { input.disconnect() } catch {}
  const stages = normalizeAudioEffectOrder(config.order ?? AUDIO_EFFECT_ORDER, AUDIO_EFFECT_ORDER)
    .flatMap((kind) => {
      const stage = stagesByKind.get(kind)
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
