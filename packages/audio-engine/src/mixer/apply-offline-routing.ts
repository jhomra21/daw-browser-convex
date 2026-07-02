import { assert, normalizeCompressorParams, normalizeDelayParams, normalizeEqParams, normalizeSaturatorParams, type AudioEffectKind, type CompressorParamsLite, type DelayParamsLite, type EqParamsLite, type ReverbParamsLite, type SaturatorParamsLite } from '@daw-browser/shared'
import { createEqNodes } from '../effects/dsp'
import { connectFxChain, createCompressorNodeChain, createDelayNodeChain, createReverbNodeChain, createSaturatorNodeChain, type CreateReverbImpulseResponse, type DelayNodeChain, type ReverbNodeChain, type SaturatorNodeChain } from '../effects/chain'
import { createReverbImpulseCache } from '../effects/reverb-impulse-cache'
import type { ResolvedMixerGraph } from './types'
import type { AutomationAudioBinding } from '../automation'
import { resolveDelayAutomationBindings, resolveEqAutomationBindings, resolveReverbAutomationBindings, resolveSaturatorAutomationBindings } from '../automation-bindings'

type OfflineTrackNodes = {
  input: GainNode
  gain: GainNode
  output: GainNode
  eqNodesByBand: Map<string, BiquadFilterNode>
  saturator: SaturatorNodeChain | null
  delay: DelayNodeChain | null
  reverb: ReverbNodeChain | null
}

type OfflineMixerNodes = {
  masterInput: GainNode
  masterEqNodesByBand: Map<string, BiquadFilterNode>
  trackNodes: Map<string, OfflineTrackNodes>
  resolveTrackAutomationBindings: (trackId: string, parameterId: string) => AutomationAudioBinding[]
  resolveMasterAutomationBindings: (parameterId: string) => AutomationAudioBinding[]
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

type OfflineFxChain = {
  eqNodesByBand: Map<string, BiquadFilterNode>
  saturator: SaturatorNodeChain | null
  delay: DelayNodeChain | null
  reverb: ReverbNodeChain | null
}

async function buildOfflineFxChain(
  ctx: OfflineAudioContext,
  input: GainNode,
  destination: AudioNode,
  createImpulseResponse: CreateReverbImpulseResponse,
  config: OfflineFxChainConfig,
): Promise<OfflineFxChain> {
  const normalizedEq = config.eq ? normalizeEqParams(config.eq) : undefined
  const eq = createEqNodes(ctx, normalizedEq, ctx.destination.channelCount || 2)
  const eqNodesByBand = new Map((normalizedEq?.bands ?? []).filter((band) => band.enabled).flatMap((band, index) => {
    const node = eq[index]
    return node ? [[band.id, node]] : []
  }))
  const compressorParams = config.compressor ? normalizeCompressorParams(config.compressor) : null
  const compressor = compressorParams?.enabled ? await createCompressorNodeChain(ctx, compressorParams) : null
  const saturator = config.saturator ? createSaturatorNodeChain(ctx, normalizeSaturatorParams(config.saturator)) : null
  const delay = config.delay ? createDelayNodeChain(ctx, normalizeDelayParams(config.delay), config.bpm ?? 120) : null
  const reverb = config.reverb
    ? createReverbNodeChain(ctx, config.reverb, createImpulseResponse)
    : null
  connectFxChain(input, destination, { eqNodes: eq, compressorChain: compressor, saturatorChain: saturator, delayChain: delay, reverbChain: reverb, order: config.order })
  return { eqNodesByBand, saturator, delay, reverb }
}

const resolveFxAutomationBindings = (
  parameterId: string,
  nodes: { saturator: SaturatorNodeChain | null; delay: DelayNodeChain | null; reverb: ReverbNodeChain | null },
): AutomationAudioBinding[] => {
  return [
    ...resolveSaturatorAutomationBindings(nodes.saturator, parameterId),
    ...resolveDelayAutomationBindings(nodes.delay, parameterId),
    ...resolveReverbAutomationBindings(nodes.reverb, parameterId),
  ]
}

export async function createOfflineMixerNodes(ctx: OfflineAudioContext, graph: ResolvedMixerGraph, bpm = 120): Promise<OfflineMixerNodes> {
  const impulseCache = createReverbImpulseCache()
  const createCachedImpulseResponse = (params: ReverbParamsLite) => impulseCache.get(ctx, params)
  const masterInput = ctx.createGain()
  masterInput.gain.value = graph.master.volume
  const masterFx = await buildOfflineFxChain(ctx, masterInput, ctx.destination, createCachedImpulseResponse, { eq: graph.master.eq, compressor: graph.master.compressor, saturator: graph.master.saturator, delay: graph.master.delay, reverb: graph.master.reverb, order: graph.master.order, bpm })

  const trackNodes = new Map<string, OfflineTrackNodes>()
  for (const resolvedTrack of graph.channels) {
    const input = ctx.createGain()
    const gain = ctx.createGain()
    const output = ctx.createGain()
    gain.gain.value = resolvedTrack.gain
    output.gain.value = resolvedTrack.outputGain
    const fx = await buildOfflineFxChain(ctx, input, gain, createCachedImpulseResponse, { eq: resolvedTrack.fx?.eq, compressor: resolvedTrack.fx?.compressor, saturator: resolvedTrack.fx?.saturator, delay: resolvedTrack.fx?.delay, reverb: resolvedTrack.fx?.reverb, order: resolvedTrack.fx?.order, bpm })
    trackNodes.set(resolvedTrack.channel.id, { input, gain, output, eqNodesByBand: fx.eqNodesByBand, saturator: fx.saturator, delay: fx.delay, reverb: fx.reverb })
  }

  for (const resolvedTrack of graph.channels) {
    const channelId = resolvedTrack.channel.id
    const source = trackNodes.get(channelId)
    assert(source, `Missing offline mixer source for track ${channelId}`)
    const outputTarget = resolvedTrack.outputTargetId ? trackNodes.get(resolvedTrack.outputTargetId)?.input : undefined
    source.gain.connect(source.output)
    source.output.connect(outputTarget ?? masterInput)
    for (const send of resolvedTrack.sends) {
      const target = trackNodes.get(send.targetId)
      assert(target, `Missing offline mixer send target for track ${send.targetId}`)
      const sendGain = ctx.createGain()
      sendGain.gain.value = send.amount
      source.gain.connect(sendGain)
      sendGain.connect(target.input)
    }
  }

  return {
    masterInput,
    masterEqNodesByBand: masterFx.eqNodesByBand,
    trackNodes,
    resolveTrackAutomationBindings: (trackId, parameterId) => {
      const nodes = trackNodes.get(trackId)
      if (!nodes) return []
      if (parameterId === 'volume') return [{ param: nodes.gain.gain, valueToAudioValue: (value) => value }]
      return [
        ...resolveEqAutomationBindings(nodes.eqNodesByBand, parameterId),
        ...resolveFxAutomationBindings(parameterId, nodes),
      ]
    },
    resolveMasterAutomationBindings: (parameterId) => {
      if (parameterId === 'volume') return [{ param: masterInput.gain, valueToAudioValue: (value) => value }]
      return [
        ...resolveEqAutomationBindings(masterFx.eqNodesByBand, parameterId),
        ...resolveFxAutomationBindings(parameterId, { saturator: masterFx.saturator, delay: masterFx.delay, reverb: masterFx.reverb }),
      ]
    },
  }
}
