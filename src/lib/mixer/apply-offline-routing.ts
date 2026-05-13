import type { EqParamsLite, ReverbParamsLite } from '~/lib/effects/params'
import { createEqNodes, createImpulseResponseBuffer } from '~/lib/effects/dsp'
import { connectParallelFxChain, createReverbNodeChain } from '~/lib/effects/chain'
import type { ResolvedMixerGraph } from '~/lib/mixer/types'

type OfflineTrackNodes = {
  input: GainNode
  gain: GainNode
  output: GainNode
}

type OfflineMixerNodes = {
  trackNodes: Map<string, OfflineTrackNodes>
}

function buildOfflineFxChain(
  ctx: OfflineAudioContext,
  input: GainNode,
  destination: AudioNode,
  eqParams?: EqParamsLite,
  reverbParams?: ReverbParamsLite,
) {
  const eq = createEqNodes(ctx, eqParams, ctx.destination.channelCount || 2)
  const reverb = reverbParams
    ? createReverbNodeChain(ctx, reverbParams, (decaySec) => createImpulseResponseBuffer(ctx, decaySec).buffer)
    : null
  connectParallelFxChain(input, destination, eq, reverb)
}

export function createOfflineMixerNodes(ctx: OfflineAudioContext, graph: ResolvedMixerGraph): OfflineMixerNodes {
  const masterInput = ctx.createGain()
  masterInput.gain.value = 1
  buildOfflineFxChain(ctx, masterInput, ctx.destination, graph.master.eq, graph.master.reverb)

  const trackNodes = new Map<string, OfflineTrackNodes>()
  for (const resolvedTrack of graph.channels) {
    const input = ctx.createGain()
    const gain = ctx.createGain()
    const output = ctx.createGain()
    gain.gain.value = resolvedTrack.gain
    output.gain.value = resolvedTrack.outputGain
    buildOfflineFxChain(ctx, input, gain, resolvedTrack.fx?.eq, resolvedTrack.fx?.reverb)
    trackNodes.set(resolvedTrack.channel.id, { input, gain, output })
  }

  for (const resolvedTrack of graph.channels) {
    const channelId = resolvedTrack.channel.id
    const source = trackNodes.get(channelId)
    if (!source) continue
    const outputTarget = resolvedTrack.outputTargetId ? trackNodes.get(resolvedTrack.outputTargetId)?.input : undefined
    source.gain.connect(source.output)
    source.output.connect(outputTarget ?? masterInput)
    for (const send of resolvedTrack.sends) {
      const target = trackNodes.get(send.targetId)
      if (!target) continue
      const sendGain = ctx.createGain()
      sendGain.gain.value = send.amount
      source.gain.connect(sendGain)
      sendGain.connect(target.input)
    }
  }

  return { trackNodes }
}
