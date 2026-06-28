import { normalizeCompressorParams, normalizeDelayParams, normalizeEqParams, normalizeSaturatorParams, type AudioEffectKind, type CompressorParamsLite, type DelayParamsLite, type EqParamsLite, type ReverbParamsLite, type SaturatorParamsLite } from '@daw-browser/shared'
import { createEqNodes } from '../effects/dsp'
import { connectFxChain, createCompressorNodeChain, createDelayNodeChain, createReverbNodeChain, createSaturatorNodeChain, type CreateReverbImpulseResponse } from '../effects/chain'
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

type OfflineFxChainConfig = {
  eq?: EqParamsLite
  compressor?: CompressorParamsLite
  saturator?: SaturatorParamsLite
  delay?: DelayParamsLite
  reverb?: ReverbParamsLite
  order?: AudioEffectKind[]
  bpm?: number
}

async function buildOfflineFxChain(
  ctx: OfflineAudioContext,
  input: GainNode,
  destination: AudioNode,
  createImpulseResponse: CreateReverbImpulseResponse,
  config: OfflineFxChainConfig,
) {
  const eq = createEqNodes(ctx, config.eq ? normalizeEqParams(config.eq) : undefined, ctx.destination.channelCount || 2)
  const compressorParams = config.compressor ? normalizeCompressorParams(config.compressor) : null
  const compressor = compressorParams?.enabled ? await createCompressorNodeChain(ctx, compressorParams) : null
  const saturator = config.saturator ? createSaturatorNodeChain(ctx, normalizeSaturatorParams(config.saturator)) : null
  const delay = config.delay ? createDelayNodeChain(ctx, normalizeDelayParams(config.delay), config.bpm ?? 120) : null
  const reverb = config.reverb
    ? createReverbNodeChain(ctx, config.reverb, createImpulseResponse)
    : null
  connectFxChain(input, destination, { eqNodes: eq, compressorChain: compressor, saturatorChain: saturator, delayChain: delay, reverbChain: reverb, order: config.order })
}

export async function createOfflineMixerNodes(ctx: OfflineAudioContext, graph: ResolvedMixerGraph, bpm = 120): Promise<OfflineMixerNodes> {
  const impulseCache = createReverbImpulseCache()
  const createCachedImpulseResponse = (params: ReverbParamsLite) => impulseCache.get(ctx, params)
  const masterInput = ctx.createGain()
  masterInput.gain.value = graph.master.volume
  await buildOfflineFxChain(ctx, masterInput, ctx.destination, createCachedImpulseResponse, { eq: graph.master.eq, compressor: graph.master.compressor, saturator: graph.master.saturator, delay: graph.master.delay, reverb: graph.master.reverb, order: graph.master.order, bpm })

  const trackNodes = new Map<string, OfflineTrackNodes>()
  for (const resolvedTrack of graph.channels) {
    const input = ctx.createGain()
    const gain = ctx.createGain()
    const output = ctx.createGain()
    gain.gain.value = resolvedTrack.gain
    output.gain.value = resolvedTrack.outputGain
    await buildOfflineFxChain(ctx, input, gain, createCachedImpulseResponse, { eq: resolvedTrack.fx?.eq, compressor: resolvedTrack.fx?.compressor, saturator: resolvedTrack.fx?.saturator, delay: resolvedTrack.fx?.delay, reverb: resolvedTrack.fx?.reverb, order: resolvedTrack.fx?.order, bpm })
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
