import type { ReverbParamsLite } from '~/lib/effects/params'

export type ReverbNodeChain = {
  enabled: boolean
  dryGain: GainNode
  wetGain: GainNode
  preDelay: DelayNode
  convolver: ConvolverNode
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export function disconnectAudioNodes(nodes: Array<AudioNode | null | undefined>) {
  for (const node of nodes) {
    if (!node) continue
    try { node.disconnect() } catch {}
  }
}

export function connectEqNodes(eqNodes: BiquadFilterNode[], destination: AudioNode) {
  if (eqNodes.length === 0) return
  for (let index = 0; index < eqNodes.length; index++) {
    const node = eqNodes[index]
    try { node.disconnect() } catch {}
    node.connect(index < eqNodes.length - 1 ? eqNodes[index + 1] : destination)
  }
}

export function getEqEntryNode(eqNodes: BiquadFilterNode[], destination: AudioNode) {
  return eqNodes[0] ?? destination
}

export function createReverbNodeChain(
  ctx: BaseAudioContext,
  params: ReverbParamsLite,
  createImpulseResponse: (decaySec: number) => AudioBuffer | null,
): ReverbNodeChain {
  const chain: ReverbNodeChain = {
    enabled: !!params.enabled,
    dryGain: ctx.createGain(),
    wetGain: ctx.createGain(),
    preDelay: ctx.createDelay(2.0),
    convolver: ctx.createConvolver(),
  }
  applyReverbNodeChainParams(chain, params, createImpulseResponse)
  return chain
}

export function applyReverbNodeChainParams(
  chain: ReverbNodeChain,
  params: ReverbParamsLite,
  createImpulseResponse: (decaySec: number) => AudioBuffer | null,
) {
  chain.enabled = !!params.enabled
  chain.dryGain.gain.value = 1 - clamp(params.wet, 0, 1)
  chain.wetGain.gain.value = clamp(params.wet, 0, 1)
  chain.preDelay.delayTime.value = clamp(params.preDelayMs / 1000, 0, 0.2)
  const impulse = createImpulseResponse(params.decaySec)
  if (impulse) {
    chain.convolver.buffer = impulse
  }
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
    disconnectAudioNodes([
      reverbChain.dryGain,
      reverbChain.wetGain,
      reverbChain.preDelay,
      reverbChain.convolver,
    ])
    input.connect(reverbChain.dryGain)
    reverbChain.dryGain.connect(eqEntry)
    input.connect(reverbChain.preDelay)
    reverbChain.preDelay.connect(reverbChain.convolver)
    reverbChain.convolver.connect(reverbChain.wetGain)
    reverbChain.wetGain.connect(eqEntry)
    return
  }

  if (reverbChain) {
    disconnectAudioNodes([
      reverbChain.dryGain,
      reverbChain.wetGain,
      reverbChain.preDelay,
      reverbChain.convolver,
    ])
  }
  input.connect(eqEntry)
}
