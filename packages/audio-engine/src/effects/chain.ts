import { normalizeReverbParams, type ReverbParamsLite } from '@daw-browser/shared'
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

export function connectParallelFxChain(
  input: AudioNode,
  destination: AudioNode,
  eqNodes: BiquadFilterNode[],
  reverbChain?: ReverbNodeChain | null,
) {
  connectEqNodes(eqNodes, destination)
  const eqEntry = getEqEntryNode(eqNodes, destination)

  if (reverbChain?.enabled) {
    input.connect(reverbChain.dryGain)
    input.connect(reverbChain.preDelay)
    connectReverbInternals(reverbChain)
    connectReverbOutputs(reverbChain, eqEntry)
    return
  }

  if (reverbChain) {
    disconnectReverbChain(reverbChain)
  }
  input.connect(eqEntry)
}
