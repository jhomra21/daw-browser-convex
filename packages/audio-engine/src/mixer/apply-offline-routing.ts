import { assert, normalizeCompressorParams, normalizeDelayParams, normalizeEqParams, normalizeSaturatorParams, type AudioEffectKind, type CompressorParamsLite, type DelayParamsLite, type EqParamsLite, type ReverbParamsLite, type SaturatorParamsLite } from '@daw-browser/shared'
import { createEqNodes } from '../effects/dsp'
import { connectFxChain, createCompressorNodeChain, createDelayNodeChain, createReverbNodeChain, createSaturatorNodeChain, disconnectCompressorChain, type CompressorNodeChain, type CreateReverbImpulseResponse, type DelayNodeChain, type ReverbNodeChain, type SaturatorNodeChain } from '../effects/chain'
import { createReverbImpulseCache } from '../effects/reverb-impulse-cache'
import type { ResolvedMixerGraph } from './types'
import type { AutomationAudioBinding } from '../automation'
import { resolveDelayAutomationBindings, resolveEqAutomationBindings, resolveReverbAutomationBindings, resolveSaturatorAutomationBindings } from '../automation-bindings'
import type { AudioEffectRuntimeInstance } from '../effects/runtime-instance'
import { createMixerRoutingPlan } from './graph-contract'
import { createOfflineCompressorLifecycle, type OfflineCompressorLifecycle, type OfflineProcessorTarget } from './offline-compressor-lifecycle'

type OfflineTrackNodes = {
  input: GainNode
  gain: GainNode
  output: GainNode
  eqNodesByBand: Map<string, BiquadFilterNode>
  saturators: SaturatorNodeChain[]
  delays: DelayNodeChain[]
  reverbs: ReverbNodeChain[]
}

type OfflineMixerNodes = {
  masterInput: GainNode
  masterEqNodesByBand: Map<string, BiquadFilterNode>
  trackNodes: Map<string, OfflineTrackNodes>
  resolveTrackAutomationBindings: (trackId: string, parameterId: string) => AutomationAudioBinding[]
  resolveMasterAutomationBindings: (parameterId: string) => AutomationAudioBinding[]
  assertCompressorProcessorsHealthy: () => void
  dispose: () => void
}

type OfflineFxChainConfig = {
  eq?: EqParamsLite
  compressor?: CompressorParamsLite
  saturator?: SaturatorParamsLite
  delay?: DelayParamsLite
  reverb?: ReverbParamsLite
  order?: AudioEffectKind[]
  instances?: AudioEffectRuntimeInstance[]
  bpm?: number
}

type OfflineFxChain = {
  eqNodesByBand: Map<string, BiquadFilterNode>
  saturators: SaturatorNodeChain[]
  delays: DelayNodeChain[]
  reverbs: ReverbNodeChain[]
}

async function buildOfflineFxChain(
  ctx: OfflineAudioContext,
  input: GainNode,
  destination: AudioNode,
  createImpulseResponse: CreateReverbImpulseResponse,
  config: OfflineFxChainConfig,
  target: OfflineProcessorTarget,
  compressorLifecycle: OfflineCompressorLifecycle<CompressorNodeChain>,
): Promise<OfflineFxChain> {
  const createCompressor = async (params: CompressorParamsLite, instanceId: string) => {
    return compressorLifecycle.create(target, instanceId, () => createCompressorNodeChain(ctx, params))
  }

  if (config.instances) {
    const eqNodesByBand = new Map<string, BiquadFilterNode>()
    const saturators: SaturatorNodeChain[] = []
    const delays: DelayNodeChain[] = []
    const reverbs: ReverbNodeChain[] = []
    const stages = []
    for (const instance of config.instances) {
      if (instance.kind === 'eq') {
        const normalized = normalizeEqParams(instance.params)
        const eqNodes = createEqNodes(ctx, normalized, ctx.destination.channelCount || 2)
        for (const [bandId, node] of new Map(normalized.bands.filter((band) => band.enabled).flatMap((band, index) => {
          const eqNode = eqNodes[index]
          return eqNode ? [[band.id, eqNode]] : []
        }))) eqNodesByBand.set(bandId, node)
        stages.push({ id: instance.id, kind: instance.kind, eqNodes })
        continue
      }
      if (instance.kind === 'compressor') {
        const compressorParams = normalizeCompressorParams(instance.params)
        const compressor = compressorParams.enabled ? await createCompressor(compressorParams, instance.id) : null
        stages.push({ id: instance.id, kind: instance.kind, compressorChain: compressor })
        continue
      }
      if (instance.kind === 'saturator') {
        const saturator = createSaturatorNodeChain(ctx, normalizeSaturatorParams(instance.params))
        saturators.push(saturator)
        stages.push({ id: instance.id, kind: instance.kind, saturatorChain: saturator })
        continue
      }
      if (instance.kind === 'delay') {
        const delay = createDelayNodeChain(ctx, normalizeDelayParams(instance.params), config.bpm ?? 120)
        delays.push(delay)
        stages.push({ id: instance.id, kind: instance.kind, delayChain: delay })
        continue
      }
      const reverb = createReverbNodeChain(ctx, instance.params, createImpulseResponse)
      reverbs.push(reverb)
      stages.push({ id: instance.id, kind: instance.kind, reverbChain: reverb })
    }
    connectFxChain(input, destination, { instances: stages })
    return { eqNodesByBand, saturators, delays, reverbs }
  }
  const normalizedEq = config.eq ? normalizeEqParams(config.eq) : undefined
  const eq = createEqNodes(ctx, normalizedEq, ctx.destination.channelCount || 2)
  const eqNodesByBand = new Map((normalizedEq?.bands ?? []).filter((band) => band.enabled).flatMap((band, index) => {
    const node = eq[index]
    return node ? [[band.id, node]] : []
  }))
  const compressorParams = config.compressor ? normalizeCompressorParams(config.compressor) : null
  const compressor = compressorParams?.enabled ? await createCompressor(compressorParams, 'legacy-compressor') : null
  const saturator = config.saturator ? createSaturatorNodeChain(ctx, normalizeSaturatorParams(config.saturator)) : null
  const delay = config.delay ? createDelayNodeChain(ctx, normalizeDelayParams(config.delay), config.bpm ?? 120) : null
  const reverb = config.reverb
    ? createReverbNodeChain(ctx, config.reverb, createImpulseResponse)
    : null
  connectFxChain(input, destination, { eqNodes: eq, compressorChain: compressor, saturatorChain: saturator, delayChain: delay, reverbChain: reverb, order: config.order })
  return {
    eqNodesByBand,
    saturators: saturator ? [saturator] : [],
    delays: delay ? [delay] : [],
    reverbs: reverb ? [reverb] : [],
  }
}

const resolveFxAutomationBindings = (
  parameterId: string,
  nodes: { saturators: readonly SaturatorNodeChain[]; delays: readonly DelayNodeChain[]; reverbs: readonly ReverbNodeChain[] },
): AutomationAudioBinding[] => {
  return [
    ...nodes.saturators.flatMap((saturator) => resolveSaturatorAutomationBindings(saturator, parameterId)),
    ...nodes.delays.flatMap((delay) => resolveDelayAutomationBindings(delay, parameterId)),
    ...nodes.reverbs.flatMap((reverb) => resolveReverbAutomationBindings(reverb, parameterId)),
  ]
}

export async function createOfflineMixerNodes(ctx: OfflineAudioContext, graph: ResolvedMixerGraph, bpm = 120): Promise<OfflineMixerNodes> {
  const routingPlan = createMixerRoutingPlan(graph)
  const impulseCache = createReverbImpulseCache()
  const createCachedImpulseResponse = (params: ReverbParamsLite) => impulseCache.get(ctx, params)
  const masterInput = ctx.createGain()
  masterInput.gain.value = routingPlan.masterVolume
  const compressorLifecycle = createOfflineCompressorLifecycle(
    disconnectCompressorChain,
    (chain, handler) => {
      chain.workletNode.port.onmessage = handler ? (event) => handler(event.data) : null
    },
  )

  try {
    const masterFx = await buildOfflineFxChain(ctx, masterInput, ctx.destination, createCachedImpulseResponse, { eq: graph.master.eq, compressor: graph.master.compressor, saturator: graph.master.saturator, delay: graph.master.delay, reverb: graph.master.reverb, order: graph.master.order, instances: graph.master.instances, bpm }, { kind: 'master' }, compressorLifecycle)

    const trackNodes = new Map<string, OfflineTrackNodes>()
    for (const resolvedTrack of graph.channels) {
      const input = ctx.createGain()
      const gain = ctx.createGain()
      const output = ctx.createGain()
      const fx = await buildOfflineFxChain(ctx, input, gain, createCachedImpulseResponse, { eq: resolvedTrack.fx?.eq, compressor: resolvedTrack.fx?.compressor, saturator: resolvedTrack.fx?.saturator, delay: resolvedTrack.fx?.delay, reverb: resolvedTrack.fx?.reverb, order: resolvedTrack.fx?.order, instances: resolvedTrack.fx?.instances, bpm }, { kind: 'track', trackId: resolvedTrack.channel.id }, compressorLifecycle)
      trackNodes.set(resolvedTrack.channel.id, { input, gain, output, eqNodesByBand: fx.eqNodesByBand, saturators: fx.saturators, delays: fx.delays, reverbs: fx.reverbs })
    }

    for (const channel of routingPlan.channels) {
      const channelId = channel.channelId
      const source = trackNodes.get(channelId)
      assert(source, `Missing offline mixer source for track ${channelId}`)
      source.gain.gain.value = channel.gain
      source.output.gain.value = channel.outputGain
      const targetNodes = channel.outputTargetId
        ? trackNodes.get(channel.outputTargetId)
        : undefined
      if (channel.outputTargetId) {
        assert(targetNodes, `Missing offline mixer output target for track ${channel.outputTargetId}`)
      }
      const outputTarget = targetNodes?.input ?? masterInput
      source.gain.connect(source.output)
      source.output.connect(outputTarget)
      for (const send of channel.sends) {
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
      assertCompressorProcessorsHealthy: compressorLifecycle.assertHealthy,
      dispose: compressorLifecycle.dispose,
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
          ...resolveFxAutomationBindings(parameterId, masterFx),
        ]
      },
    }
  } catch (error) {
    compressorLifecycle.dispose()
    throw error
  }
}
