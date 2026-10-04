import { getEffectChainTiming } from '../effects/timing'
import type { ExternalSidechainRoute } from '@daw-browser/timeline-core/types'
import type { ResolvedMixerGraph } from './types'

type MixerTimingPlan = {
  routeDelayFrames: ReadonlyMap<string, number>
  sidechainDelayFrames: ReadonlyMap<string, number>
  graphLatencyFrames: number
}

export type ExternalNodeLatencyFrames = ReadonlyMap<string, number>

type MixerEdgeKind = 'output' | 'send'
type MixerSendTap = 'pre-fx' | 'pre-fader' | 'post-fader'

export const mixerRouteKey = (
  sourceId: string,
  targetId: string,
  kind: MixerEdgeKind,
  tap?: MixerSendTap,
) => JSON.stringify([sourceId, targetId, kind, tap ?? null])

export const sidechainRouteKey = (
  sourceTrackId: string,
  targetTrackId: string,
  effectInstanceId: string,
) => JSON.stringify([sourceTrackId, targetTrackId, effectInstanceId])

export const MASTER_ROUTE_TARGET = '$master'

const getChannelLatency = (
  channel: ResolvedMixerGraph['channels'][number],
  sampleRate: number,
  bpm: number,
) => {
  const fx = channel.fx
  if (!fx) return 0
  return getEffectChainTiming(fx.instances, sampleRate, bpm).latencyFrames
}

const getSidechainTargetPrefixLatency = (
  channel: ResolvedMixerGraph['channels'][number],
  effectInstanceId: string,
  sampleRate: number,
  bpm: number,
) => {
  const instances = channel.fx?.instances ?? []
  const targetIndex = instances.findIndex((instance) => instance.id === effectInstanceId)
  if (targetIndex < 0) {
    throw new Error(`Missing sidechain timing target ${effectInstanceId} on ${channel.channel.id}`)
  }
  return getEffectChainTiming(instances.slice(0, targetIndex), sampleRate, bpm).latencyFrames
}

export const resolveMixerTiming = (
  graph: ResolvedMixerGraph,
  sampleRate: number,
  bpm = 120,
  externalLatencyFrames: ExternalNodeLatencyFrames = new Map(),
  sidechainRoutes: readonly ExternalSidechainRoute[] = [],
): MixerTimingPlan => {
  const channelById = new Map(graph.channels.map((entry) => [entry.channel.id, entry]))
  const getExternalLatency = (channelId: string) => externalLatencyFrames.get(channelId) ?? 0
  const getNodeLatency = (channel: ResolvedMixerGraph['channels'][number]) => (
    getChannelLatency(channel, sampleRate, bpm) + getExternalLatency(channel.channel.id)
  )
  const getTapLatency = (
    source: ResolvedMixerGraph['channels'][number],
    sourceOutputLatency: number,
    tap: MixerSendTap,
  ) => {
    if (tap === 'pre-fx') return sourceOutputLatency - getNodeLatency(source)
    if (tap === 'pre-fader') return sourceOutputLatency
    return sourceOutputLatency
  }

  const incoming = new Map<string, Array<{ sourceId: string; kind: MixerEdgeKind; tap?: MixerSendTap }>>()
  for (const entry of graph.channels) {
    const edges = [
      ...entry.sends.map((send) => ({ targetId: send.targetId, kind: 'send' as const, tap: send.tap ?? 'post-fader' })),
      ...(entry.outputTargetId ? [{ targetId: entry.outputTargetId, kind: 'output' as const }] : []),
    ]
    for (const edge of edges) {
      const targetId = edge.targetId
      if (!channelById.has(targetId)) throw new Error(`Missing mixer timing target ${targetId}`)
      const sources = incoming.get(targetId) ?? []
      sources.push({
        sourceId: entry.channel.id,
        kind: edge.kind,
        tap: edge.kind === 'send' ? edge.tap : undefined,
      })
      incoming.set(targetId, sources)
    }
  }

  const sidechainsByTarget = new Map<string, Array<{
    route: ExternalSidechainRoute
    prefixLatencyFrames: number
  }>>()
  for (const route of sidechainRoutes) {
    if (route.sourceTrackId === route.targetTrackId) {
      throw new Error('An effect cannot sidechain from its own track.')
    }
    if (!channelById.has(route.sourceTrackId)) {
      throw new Error(`Missing sidechain timing source ${route.sourceTrackId}`)
    }
    const target = channelById.get(route.targetTrackId)
    if (!target) throw new Error(`Missing sidechain timing target ${route.targetTrackId}`)
    const routes = sidechainsByTarget.get(route.targetTrackId) ?? []
    routes.push({
      route,
      prefixLatencyFrames: getSidechainTargetPrefixLatency(
        target,
        route.effectInstanceId,
        sampleRate,
        bpm,
      ),
    })
    sidechainsByTarget.set(route.targetTrackId, routes)
  }

  const pathLatency = new Map<string, number>()
  const inputLatency = new Map<string, number>()
  const visiting = new Set<string>()
  const visit = (channelId: string): number => {
    const cached = pathLatency.get(channelId)
    if (cached !== undefined) return cached
    if (visiting.has(channelId)) throw new Error(`Cyclic mixer timing dependency at ${channelId}`)
    visiting.add(channelId)
    const entry = channelById.get(channelId)
    if (!entry) throw new Error(`Missing mixer channel ${channelId}`)

    let upstreamLatency = Math.max(0, ...(incoming.get(channelId) ?? []).map((edge) => {
      const sourceOutputLatency = visit(edge.sourceId)
      if (edge.kind !== 'send') return sourceOutputLatency
      const source = channelById.get(edge.sourceId)
      if (!source) throw new Error(`Missing mixer channel ${edge.sourceId}`)
      return getTapLatency(source, sourceOutputLatency, edge.tap ?? 'post-fader')
    }))

    for (const sidechain of sidechainsByTarget.get(channelId) ?? []) {
      const detectorArrival = visit(sidechain.route.sourceTrackId)
      upstreamLatency = Math.max(
        upstreamLatency,
        detectorArrival - sidechain.prefixLatencyFrames,
      )
    }
    upstreamLatency = Math.max(0, upstreamLatency)
    inputLatency.set(channelId, upstreamLatency)

    const latency = upstreamLatency + getNodeLatency(entry)
    pathLatency.set(channelId, latency)
    visiting.delete(channelId)
    return latency
  }

  for (const entry of graph.channels) visit(entry.channel.id)

  const routeDelayFrames = new Map<string, number>()
  for (const [targetId, edges] of incoming) {
    const targetInputLatency = inputLatency.get(targetId) ?? 0
    for (const edge of edges) {
      const sourceOutputLatency = pathLatency.get(edge.sourceId) ?? 0
      const source = channelById.get(edge.sourceId)
      if (!source) throw new Error(`Missing mixer channel ${edge.sourceId}`)
      const arrival = edge.kind === 'send'
        ? getTapLatency(source, sourceOutputLatency, edge.tap ?? 'post-fader')
        : sourceOutputLatency
      routeDelayFrames.set(
        mixerRouteKey(edge.sourceId, targetId, edge.kind, edge.tap),
        targetInputLatency - arrival,
      )
    }
  }

  const sidechainDelayFrames = new Map<string, number>()
  for (const [targetId, sidechains] of sidechainsByTarget) {
    const targetInputLatency = inputLatency.get(targetId) ?? 0
    for (const sidechain of sidechains) {
      const detectorArrival = pathLatency.get(sidechain.route.sourceTrackId) ?? 0
      sidechainDelayFrames.set(
        sidechainRouteKey(
          sidechain.route.sourceTrackId,
          sidechain.route.targetTrackId,
          sidechain.route.effectInstanceId,
        ),
        targetInputLatency + sidechain.prefixLatencyFrames - detectorArrival,
      )
    }
  }

  const masterSources = graph.channels.filter((entry) => !entry.outputTargetId).map((entry) => entry.channel.id)
  const masterInputLatency = Math.max(0, ...masterSources.map((id) => pathLatency.get(id) ?? 0))
  for (const sourceId of masterSources) {
    routeDelayFrames.set(
      mixerRouteKey(sourceId, MASTER_ROUTE_TARGET, 'output'),
      masterInputLatency - (pathLatency.get(sourceId) ?? 0),
    )
  }
  const masterLatency = getEffectChainTiming(graph.master.instances, sampleRate, bpm).latencyFrames

  return { routeDelayFrames, sidechainDelayFrames, graphLatencyFrames: masterInputLatency + masterLatency }
}
