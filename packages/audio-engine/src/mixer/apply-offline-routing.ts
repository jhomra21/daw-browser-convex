import { assert, getAutomationParameterDescriptor, normalizeCompressorParams, normalizeDelayParams, normalizeEqParams, normalizeSaturatorParams, type CompressorParamsLite, type ReverbParamsLite } from '@daw-browser/shared'
import { createEqNodes } from '../effects/dsp'
import { connectFxChain, createCompressorNodeChain, createDelayNodeChain, createReverbNodeChain, createSaturatorNodeChain, disconnectCompressorChain, type CompressorNodeChain, type CreateReverbImpulseResponse, type DelayNodeChain, type ReverbNodeChain, type SaturatorNodeChain } from '../effects/chain'
import { createReverbImpulseCache } from '../effects/reverb-impulse-cache'
import type { ResolvedMixerGraph } from './types'
import type { ExternalSidechainRoute } from '@daw-browser/timeline-core/types'
import type { AutomationAudioBinding } from '../automation'
import { resolveDelayAutomationBindings, resolveEqAutomationBindings, resolveReverbAutomationBindings, resolveSaturatorAutomationBindings } from '../automation-bindings'
import type { AudioEffectRuntimeInstance } from '../effects/runtime-instance'
import { createMixerRoutingPlan } from './graph-contract'
import { createOfflineCompressorLifecycle, type OfflineCompressorLifecycle, type OfflineProcessorTarget } from './offline-compressor-lifecycle'
import { MASTER_ROUTE_TARGET, mixerRouteKey, resolveMixerTiming } from './resolve-timing'
import { createStaticWorkletNodeChain, disconnectStaticWorkletNodeChain, resolveStaticWorkletAutomationBinding, type StaticWorkletKind, type StaticWorkletNodeChain } from '../effects/static-worklet-chain'
import { PROCESSOR_RESOURCE_LIMITS } from '../effects/processor-release-contract'

const MAX_OFFLINE_CHAINS = 32
const isStaticWorkletKind = (kind: AudioEffectRuntimeInstance['kind']): kind is StaticWorkletKind =>
  kind === 'utility' || kind === 'autofilter' || kind === 'gate' || kind === 'limiter' || kind === 'lofi' ||
  kind === 'chorus' || kind === 'flanger' || kind === 'phaser' || kind === 'tremolo' || kind === 'autopan' || kind === 'ensemble'
  || kind === 'spectral'
const isStaticWorkletInstance = (
  instance: AudioEffectRuntimeInstance,
): instance is Extract<AudioEffectRuntimeInstance, { kind: StaticWorkletKind }> => isStaticWorkletKind(instance.kind)

type OfflineTrackNodes = {
  input: GainNode
  postFx: GainNode
  gain: GainNode
  output: GainNode
  fx: OfflineFxChain
}

type OfflineMixerNodes = {
  masterInput: GainNode
  trackNodes: Map<string, OfflineTrackNodes>
  resolveTrackAutomationBindings: (target: { trackId: string; effectInstanceId?: string }, parameterId: string) => AutomationAudioBinding[]
  resolveMasterAutomationBindings: (target: { effectInstanceId?: string }, parameterId: string) => AutomationAudioBinding[]
  assertCompressorProcessorsHealthy: () => void
  dispose: () => void
}

type OfflineFxChainConfig = {
  instances: AudioEffectRuntimeInstance[]
  bpm?: number
}

type OfflineFxChain = {
  compressorByInstanceId: Map<string, CompressorNodeChain>
  eqByInstanceId: Map<string, Map<string, BiquadFilterNode>>
  saturatorByInstanceId: Map<string, SaturatorNodeChain>
  delayByInstanceId: Map<string, DelayNodeChain>
  reverbByInstanceId: Map<string, ReverbNodeChain>
  staticWorkletByInstanceId: Map<string, StaticWorkletNodeChain>
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

  const eqByInstanceId = new Map<string, Map<string, BiquadFilterNode>>()
  const compressorByInstanceId = new Map<string, CompressorNodeChain>()
  const saturatorByInstanceId = new Map<string, SaturatorNodeChain>()
  const delayByInstanceId = new Map<string, DelayNodeChain>()
  const reverbByInstanceId = new Map<string, ReverbNodeChain>()
  const staticWorkletByInstanceId = new Map<string, StaticWorkletNodeChain>()
  const stages = []
  const seen = new Set<string>()
  for (const instance of config.instances) {
    if (seen.has(instance.id)) throw new Error(`Duplicate effect instance ID: ${instance.id}`)
    seen.add(instance.id)
    if (isStaticWorkletInstance(instance)) {
      const worklet = await createStaticWorkletNodeChain(ctx, instance.kind, instance.params)
      staticWorkletByInstanceId.set(instance.id, worklet)
      stages.push({ id: instance.id, kind: instance.kind, staticWorkletChain: worklet })
      continue
    }
    if (instance.kind === 'eq') {
      const normalized = normalizeEqParams(instance.params)
      const eqNodes = createEqNodes(ctx, normalized, ctx.destination.channelCount || 2)
      const nodesByBand = new Map(normalized.bands.filter((band) => band.enabled).flatMap((band, index) => {
        const eqNode = eqNodes[index]
        return eqNode ? [[band.id, eqNode]] : []
      }))
      eqByInstanceId.set(instance.id, nodesByBand)
      stages.push({ id: instance.id, kind: instance.kind, eqNodes })
      continue
    }
    if (instance.kind === 'compressor') {
      const compressorParams = normalizeCompressorParams(instance.params)
      const compressor = compressorParams.enabled ? await createCompressor(compressorParams, instance.id) : null
      if (compressor) compressorByInstanceId.set(instance.id, compressor)
      stages.push({ id: instance.id, kind: instance.kind, compressorChain: compressor })
      continue
    }
    if (instance.kind === 'saturator') {
      const saturator = createSaturatorNodeChain(ctx, normalizeSaturatorParams(instance.params))
      saturatorByInstanceId.set(instance.id, saturator)
      stages.push({ id: instance.id, kind: instance.kind, saturatorChain: saturator })
      continue
    }
    if (instance.kind === 'delay') {
      const delay = createDelayNodeChain(ctx, normalizeDelayParams(instance.params), config.bpm ?? 120)
      delayByInstanceId.set(instance.id, delay)
      stages.push({ id: instance.id, kind: instance.kind, delayChain: delay })
      continue
    }
    if (instance.kind === 'reverb') {
      const reverb = createReverbNodeChain(ctx, instance.params, createImpulseResponse)
      reverbByInstanceId.set(instance.id, reverb)
      stages.push({ id: instance.id, kind: instance.kind, reverbChain: reverb })
      continue
    }
    throw new Error('Unsupported audio effect kind.')
  }
  connectFxChain(input, destination, { instances: stages })
  return { compressorByInstanceId, eqByInstanceId, saturatorByInstanceId, delayByInstanceId, reverbByInstanceId, staticWorkletByInstanceId }
}

const resolveFxAutomationBindings = (
  parameterId: string,
  nodes: OfflineFxChain,
  effectInstanceId?: string,
): AutomationAudioBinding[] => {
  const descriptor = getAutomationParameterDescriptor(parameterId)
  if (!descriptor || descriptor.owner === 'mixer' || descriptor.owner === 'sampler' || descriptor.owner === 'granular' || descriptor.owner === 'synth' || descriptor.owner === 'compressor') return []
  if (effectInstanceId) {
    if (isStaticWorkletKind(descriptor.owner)) return resolveStaticWorkletAutomationBinding(nodes.staticWorkletByInstanceId.get(effectInstanceId), parameterId)
    if (descriptor.owner === 'eq') return resolveEqAutomationBindings(nodes.eqByInstanceId.get(effectInstanceId) ?? new Map(), parameterId)
    if (descriptor.owner === 'saturator') return resolveSaturatorAutomationBindings(nodes.saturatorByInstanceId.get(effectInstanceId), parameterId)
    if (descriptor.owner === 'delay') return resolveDelayAutomationBindings(nodes.delayByInstanceId.get(effectInstanceId), parameterId)
    return resolveReverbAutomationBindings(nodes.reverbByInstanceId.get(effectInstanceId), parameterId)
  }
  if (descriptor.owner === 'eq') {
    const compatible = [...nodes.eqByInstanceId.values()]
    return compatible.length === 1 ? resolveEqAutomationBindings(compatible[0] ?? new Map(), parameterId) : []
  }
  if (descriptor.owner === 'saturator') {
    const compatible = [...nodes.saturatorByInstanceId.values()]
    return compatible.length === 1 ? resolveSaturatorAutomationBindings(compatible[0], parameterId) : []
  }
  if (descriptor.owner === 'delay') {
    const compatible = [...nodes.delayByInstanceId.values()]
    return compatible.length === 1 ? resolveDelayAutomationBindings(compatible[0], parameterId) : []
  }
  const compatible = [...nodes.reverbByInstanceId.values()]
  return compatible.length === 1 ? resolveReverbAutomationBindings(compatible[0], parameterId) : []
}

export async function createOfflineMixerNodes(
  ctx: OfflineAudioContext,
  graph: ResolvedMixerGraph,
  bpm = 120,
  sidechainRoutes: readonly ExternalSidechainRoute[] = [],
  detectorOnlyTrackIds: ReadonlySet<string> = new Set(),
): Promise<OfflineMixerNodes> {
  const chains = graph.channels.length + 1
  if (chains > MAX_OFFLINE_CHAINS) throw new Error(`Offline rendering is limited to ${MAX_OFFLINE_CHAINS} effect chains.`)
  const staticWorkletCount = [graph.master.instances, ...graph.channels.map((entry) => entry.fx?.instances)]
    .reduce((count, instances) => count + (instances?.filter((instance) => isStaticWorkletKind(instance.kind)).length ?? 0), 0)
  if (staticWorkletCount > PROCESSOR_RESOURCE_LIMITS.offlineOwnedWorklets) throw new Error(`Offline rendering is limited to ${PROCESSOR_RESOURCE_LIMITS.offlineOwnedWorklets} static worklets.`)
  const routingPlan = createMixerRoutingPlan(graph)
  const timingPlan = resolveMixerTiming(graph, ctx.sampleRate, bpm)
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
    const masterFx = await buildOfflineFxChain(ctx, masterInput, ctx.destination, createCachedImpulseResponse, { instances: graph.master.instances, bpm }, { kind: 'master' }, compressorLifecycle)

    const trackNodes = new Map<string, OfflineTrackNodes>()
    for (const resolvedTrack of graph.channels) {
      const input = ctx.createGain()
      const postFx = ctx.createGain()
      const gain = ctx.createGain()
      const output = ctx.createGain()
      const fx = await buildOfflineFxChain(ctx, input, postFx, createCachedImpulseResponse, { instances: resolvedTrack.fx?.instances ?? [], bpm }, { kind: 'track', trackId: resolvedTrack.channel.id }, compressorLifecycle)
      trackNodes.set(resolvedTrack.channel.id, { input, postFx, gain, output, fx })
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
      source.postFx.connect(source.gain)
      source.gain.connect(source.output)
      const outputDelayFrames = timingPlan.routeDelayFrames.get(mixerRouteKey(channelId, channel.outputTargetId ?? MASTER_ROUTE_TARGET, 'output')) ?? 0
      if (outputDelayFrames > 0) {
        const outputDelay = ctx.createDelay()
        outputDelay.delayTime.value = outputDelayFrames / ctx.sampleRate
        source.output.connect(outputDelay)
        outputDelay.connect(outputTarget)
      } else {
        source.output.connect(outputTarget)
      }
      for (const send of channel.sends) {
        const target = trackNodes.get(send.targetId)
        assert(target, `Missing offline mixer send target for track ${send.targetId}`)
        const sendGain = ctx.createGain()
        sendGain.gain.value = send.amount
        const sendSource = send.tap === 'pre-fx'
          ? source.input
          : send.tap === 'pre-fader'
            ? source.postFx
            : source.output
        sendSource.connect(sendGain)
        const sendDelayFrames = timingPlan.routeDelayFrames.get(mixerRouteKey(channelId, send.targetId, 'send', send.tap)) ?? 0
        if (sendDelayFrames > 0) {
          const sendDelay = ctx.createDelay()
          sendDelay.delayTime.value = sendDelayFrames / ctx.sampleRate
          sendGain.connect(sendDelay)
          sendDelay.connect(target.input)
        } else {
          sendGain.connect(target.input)
        }
      }
    }

    for (const route of sidechainRoutes) {
      const source = trackNodes.get(route.sourceTrackId)
      const target = trackNodes.get(route.targetTrackId)
      const compressor = target?.fx.compressorByInstanceId.get(route.effectInstanceId)
      const owned = target?.fx.staticWorkletByInstanceId.get(route.effectInstanceId)
      const targetNode = compressor?.workletNode ?? (owned?.kind === 'gate' || owned?.kind === 'spectral' ? owned.node : undefined)
      assert(source && target && targetNode, `Invalid offline sidechain route for effect ${route.effectInstanceId}`)
      const detectorSource = detectorOnlyTrackIds.has(route.sourceTrackId) ? source.gain : source.output
      detectorSource.connect(targetNode, 0, 1)
    }

    return {
      masterInput,
      trackNodes,
      assertCompressorProcessorsHealthy: () => {
        compressorLifecycle.assertHealthy()
        const fxChains = [masterFx, ...trackNodes.values().map((nodes) => nodes.fx)]
        for (const fx of fxChains) {
          for (const [instanceId, processor] of fx.staticWorkletByInstanceId) {
            if (processor.state === 'faulted') {
              throw new Error(`Offline ${processor.kind} processor "${instanceId}" failed: ${processor.fault?.message ?? 'unknown fault'}`)
            }
          }
        }
      },
      dispose: () => {
        compressorLifecycle.dispose()
        for (const chain of masterFx.staticWorkletByInstanceId.values()) disconnectStaticWorkletNodeChain(chain)
        for (const nodes of trackNodes.values()) {
          for (const chain of nodes.fx.staticWorkletByInstanceId.values()) disconnectStaticWorkletNodeChain(chain)
        }
      },
      resolveTrackAutomationBindings: (target, parameterId) => {
        const nodes = trackNodes.get(target.trackId)
        if (!nodes) return []
        if (parameterId === 'volume') return target.effectInstanceId ? [] : [{ param: nodes.gain.gain, valueToAudioValue: (value) => value }]
        return resolveFxAutomationBindings(parameterId, nodes.fx, target.effectInstanceId)
      },
      resolveMasterAutomationBindings: (target, parameterId) => {
        if (parameterId === 'volume') return target.effectInstanceId ? [] : [{ param: masterInput.gain, valueToAudioValue: (value) => value }]
        return resolveFxAutomationBindings(parameterId, masterFx, target.effectInstanceId)
      },
    }
  } catch (error) {
    compressorLifecycle.dispose()
    throw error
  }
}
