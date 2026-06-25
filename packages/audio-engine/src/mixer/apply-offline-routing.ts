import { normalizeDelayParams, normalizeEqParams, normalizeSaturatorParams, type DelayParamsLite, type EqParamsLite, type ReverbParamsLite, type SaturatorParamsLite } from '@daw-browser/shared'
import { createEqNodes } from '../effects/dsp'
import { connectFxChain, createDelayNodeChain, createReverbNodeChain, createSaturatorNodeChain, type CreateReverbImpulseResponse } from '../effects/chain'
import { createReverbImpulseCache } from '../effects/reverb-impulse-cache'
import type { ResolvedMixerGraph } from './types'

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
  createImpulseResponse: CreateReverbImpulseResponse,
  eqParams?: EqParamsLite,
  saturatorParams?: SaturatorParamsLite,
  delayParams?: DelayParamsLite,
  reverbParams?: ReverbParamsLite,
  bpm = 120,
) {
  const eq = createEqNodes(ctx, eqParams ? normalizeEqParams(eqParams) : undefined, ctx.destination.channelCount || 2)
  const saturator = saturatorParams ? createSaturatorNodeChain(ctx, normalizeSaturatorParams(saturatorParams)) : null
  const delay = delayParams ? createDelayNodeChain(ctx, normalizeDelayParams(delayParams), bpm) : null
  const reverb = reverbParams
    ? createReverbNodeChain(ctx, reverbParams, createImpulseResponse)
    : null
  connectFxChain(input, destination, { eqNodes: eq, saturatorChain: saturator, delayChain: delay, reverbChain: reverb })
}

export function createOfflineMixerNodes(ctx: OfflineAudioContext, graph: ResolvedMixerGraph, bpm = 120): OfflineMixerNodes {
  const impulseCache = createReverbImpulseCache()
  const createCachedImpulseResponse = (params: ReverbParamsLite) => impulseCache.get(ctx, params)
  const masterInput = ctx.createGain()
  masterInput.gain.value = graph.master.volume
  buildOfflineFxChain(ctx, masterInput, ctx.destination, createCachedImpulseResponse, graph.master.eq, graph.master.saturator, graph.master.delay, graph.master.reverb, bpm)

  const trackNodes = new Map<string, OfflineTrackNodes>()
  for (const resolvedTrack of graph.channels) {
    const input = ctx.createGain()
    const gain = ctx.createGain()
    const output = ctx.createGain()
    gain.gain.value = resolvedTrack.gain
    output.gain.value = resolvedTrack.outputGain
    buildOfflineFxChain(ctx, input, gain, createCachedImpulseResponse, resolvedTrack.fx?.eq, resolvedTrack.fx?.saturator, resolvedTrack.fx?.delay, resolvedTrack.fx?.reverb, bpm)
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
