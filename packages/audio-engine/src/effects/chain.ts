import { DELAY_MAX_DELAY_TIME_SEC, normalizeDelayParams, normalizeReverbParams, normalizeSaturatorParams, type DelayParamsLite, type ReverbParamsLite, type SaturatorParamsLite } from '@daw-browser/shared'
import { applyDelayNodeParams, applySaturatorNodeParams } from './dsp'
import { getReverbImpulseSignature } from './reverb-signature'

export type CreateReverbImpulseResponse = (params: ReverbParamsLite) => AudioBuffer

export type ReverbNodeChain = {
  enabled: boolean
  internalsConnected: boolean
  outputTarget: AudioNode | null
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

export type SaturatorNodeChain = {
  enabled: boolean
  outputTarget: AudioNode | null
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
  outputTarget: AudioNode | null
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

function connectEqNodes(eqNodes: BiquadFilterNode[], destination: AudioNode) {
  if (eqNodes.length === 0) return
  for (let index = 0; index < eqNodes.length; index++) {
    const node = eqNodes[index]
    try { node.disconnect() } catch {}
    node.connect(index < eqNodes.length - 1 ? eqNodes[index + 1] : destination)
  }
}

function getEqEntryNode(eqNodes: BiquadFilterNode[], destination: AudioNode) {
  return eqNodes[0] ?? destination
}

export function createReverbNodeChain(
  ctx: BaseAudioContext,
  params: ReverbParamsLite,
  createImpulseResponse: CreateReverbImpulseResponse,
): ReverbNodeChain {
  const chain: ReverbNodeChain = {
    enabled: !!params.enabled,
    internalsConnected: false,
    outputTarget: null,
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
  chain.outputTarget = null
  chain.impulseSignature = null
}

export function createSaturatorNodeChain(ctx: BaseAudioContext, params: SaturatorParamsLite): SaturatorNodeChain {
  const chain: SaturatorNodeChain = {
    enabled: !!params.enabled,
    outputTarget: null,
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
  chain.outputTarget = null
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
    outputTarget: null,
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
  chain.outputTarget = null
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

function connectReverbOutputs(chain: ReverbNodeChain, destination: AudioNode) {
  if (chain.outputTarget === destination) return
  disconnectAudioNodes([chain.dryGain, chain.widthMerger])
  chain.dryGain.connect(destination)
  chain.widthMerger.connect(destination)
  chain.outputTarget = destination
}

export function connectFxChain(
  input: AudioNode,
  destination: AudioNode,
  config: {
    eqNodes?: BiquadFilterNode[]
    saturatorChain?: SaturatorNodeChain | null
    delayChain?: DelayNodeChain | null
    reverbChain?: ReverbNodeChain | null
  },
) {
  const eqNodes = config.eqNodes ?? []
  const saturator = config.saturatorChain?.enabled ? config.saturatorChain : null
  const delay = config.delayChain?.enabled ? config.delayChain : null
  const reverb = config.reverbChain?.enabled ? config.reverbChain : null
  if (saturator) connectSaturatorInternals(saturator)
  else if (config.saturatorChain) disconnectSaturatorChain(config.saturatorChain)
  if (delay) connectDelayInternals(delay)
  else if (config.delayChain) disconnectDelayChain(config.delayChain)
  if (reverb) connectReverbInternals(reverb)
  else if (config.reverbChain) disconnectReverbChain(config.reverbChain)

  const connectToSaturator = (source: AudioNode) => {
    if (!saturator) return
    source.connect(saturator.dryGain)
    source.connect(saturator.driveGain)
  }
  const connectToDelay = (source: AudioNode) => {
    if (!delay) return
    source.connect(delay.dryGain)
    if (delay.pingPong) source.connect(delay.splitter)
    else source.connect(delay.delayLeft)
  }
  const connectToReverb = (source: AudioNode) => {
    if (!reverb) return
    source.connect(reverb.dryGain)
    source.connect(reverb.preDelay)
  }
  const connectToNext = (source: AudioNode, start: 'eq' | 'saturator' | 'delay' | 'reverb') => {
    try { source.disconnect() } catch {}
    if (start === 'eq' && saturator) return connectToSaturator(source)
    if ((start === 'eq' || start === 'saturator') && delay) return connectToDelay(source)
    if ((start === 'eq' || start === 'saturator' || start === 'delay') && reverb) return connectToReverb(source)
    source.connect(destination)
  }

  if (eqNodes.length > 0) {
    try { input.disconnect() } catch {}
    input.connect(eqNodes[0])
    disconnectAudioNodes(eqNodes)
    for (let index = 0; index < eqNodes.length; index++) {
      if (index < eqNodes.length - 1) eqNodes[index].connect(eqNodes[index + 1])
      else connectToNext(eqNodes[index], 'eq')
    }
  } else if (saturator) {
    try { input.disconnect() } catch {}
    connectToSaturator(input)
  } else if (delay) {
    try { input.disconnect() } catch {}
    connectToDelay(input)
  } else if (reverb) {
    try { input.disconnect() } catch {}
    connectToReverb(input)
  } else {
    try { input.disconnect() } catch {}
    input.connect(destination)
  }
  if (saturator) connectToNext(saturator.outputGain, 'saturator')
  if (delay) connectToNext(delay.wetGain, 'delay')
  if (reverb) connectToNext(reverb.widthMerger, 'reverb')
}
