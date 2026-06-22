import { normalizeEqParams, type EqParamsLite, type ReverbParamsLite } from '@daw-browser/shared'
import { createEqNodes, createImpulseResponseBuffer, createReverbImpulseRender } from '../effects/dsp'
import { connectParallelFxChain, createReverbNodeChain, type CreateReverbImpulseResponse } from '../effects/chain'
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
  reverbParams?: ReverbParamsLite,
) {
  const eq = createEqNodes(ctx, eqParams ? normalizeEqParams(eqParams) : undefined, ctx.destination.channelCount || 2)
  const reverb = reverbParams
    ? createReverbNodeChain(ctx, reverbParams, createImpulseResponse)
    : null
  connectParallelFxChain(input, destination, eq, reverb)
}

export function createOfflineMixerNodes(ctx: OfflineAudioContext, graph: ResolvedMixerGraph): OfflineMixerNodes {
  const impulseCache = new Map<string, AudioBuffer>()
  const createCachedImpulseResponse = (params: ReverbParamsLite) => {
    const render = createReverbImpulseRender(ctx, params)
    const cacheKey = `${ctx.sampleRate}:${render.info.signature}`
    const cached = impulseCache.get(cacheKey)
    if (cached) return cached
    const { buffer } = createImpulseResponseBuffer(ctx, render)
    impulseCache.set(cacheKey, buffer)
    return buffer
  }
  const masterInput = ctx.createGain()
  masterInput.gain.value = graph.master.volume
  buildOfflineFxChain(ctx, masterInput, ctx.destination, createCachedImpulseResponse, graph.master.eq, graph.master.reverb)

  const trackNodes = new Map<string, OfflineTrackNodes>()
  for (const resolvedTrack of graph.channels) {
    const input = ctx.createGain()
    const gain = ctx.createGain()
    const output = ctx.createGain()
    gain.gain.value = resolvedTrack.gain
    output.gain.value = resolvedTrack.outputGain
    buildOfflineFxChain(ctx, input, gain, createCachedImpulseResponse, resolvedTrack.fx?.eq, resolvedTrack.fx?.reverb)
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
