import { getEffectChainTiming } from '../effects/timing'
import type { ResolvedMixerGraph } from './types'

type MixerTimingPlan = {
  routeDelayFrames: ReadonlyMap<string, number>
  graphLatencyFrames: number
}

type MixerEdgeKind = 'output' | 'send'
type MixerSendTap = 'pre-fx' | 'pre-fader' | 'post-fader'

export const mixerRouteKey = (
  sourceId: string,
  targetId: string,
  kind: MixerEdgeKind,
  tap?: MixerSendTap,
) => JSON.stringify([sourceId, targetId, kind, tap ?? null])
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

export const resolveMixerTiming = (
  graph: ResolvedMixerGraph,
  sampleRate: number,
  bpm = 120,
): MixerTimingPlan => {
  const channelById = new Map(graph.channels.map((entry) => [entry.channel.id, entry]))
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

  const pathLatency = new Map<string, number>()
  const visiting = new Set<string>()
  const visit = (channelId: string): number => {
    const cached = pathLatency.get(channelId)
    if (cached !== undefined) return cached
    if (visiting.has(channelId)) throw new Error(`Cyclic mixer routing at ${channelId}`)
    visiting.add(channelId)
    const entry = channelById.get(channelId)
    if (!entry) throw new Error(`Missing mixer channel ${channelId}`)
    const upstreamLatency = Math.max(0, ...(incoming.get(channelId) ?? []).map((edge) => {
      const sourceOutputLatency = visit(edge.sourceId)
      if (edge.kind !== 'send' || edge.tap !== 'pre-fx') return sourceOutputLatency
      const source = channelById.get(edge.sourceId)
      if (!source) throw new Error(`Missing mixer channel ${edge.sourceId}`)
      return sourceOutputLatency - getChannelLatency(source, sampleRate, bpm)
    }))
    const latency = upstreamLatency + getChannelLatency(entry, sampleRate, bpm)
    pathLatency.set(channelId, latency)
    visiting.delete(channelId)
    return latency
  }

  for (const entry of graph.channels) visit(entry.channel.id)
  const masterSources = graph.channels.filter((entry) => !entry.outputTargetId).map((entry) => entry.channel.id)
  const routeDelayFrames = new Map<string, number>()
  for (const [targetId, edges] of incoming) {
    const edgeLatency = (edge: (typeof edges)[number]) => {
      const channelLatency = pathLatency.get(edge.sourceId) ?? 0
      return edge.kind === 'send' && edge.tap === 'pre-fx'
        ? channelLatency - getChannelLatency(channelById.get(edge.sourceId)!, sampleRate, bpm)
        : channelLatency
    }
    const convergenceLatency = Math.max(0, ...edges.map(edgeLatency))
    for (const edge of edges) {
      routeDelayFrames.set(
        mixerRouteKey(edge.sourceId, targetId, edge.kind, edge.tap),
        convergenceLatency - edgeLatency(edge),
      )
    }
  }
  const masterInputLatency = Math.max(0, ...masterSources.map((id) => pathLatency.get(id) ?? 0))
  for (const sourceId of masterSources) {
    routeDelayFrames.set(mixerRouteKey(sourceId, MASTER_ROUTE_TARGET, 'output'), masterInputLatency - (pathLatency.get(sourceId) ?? 0))
  }
  const masterLatency = getEffectChainTiming(graph.master.instances, sampleRate, bpm).latencyFrames

  return { routeDelayFrames, graphLatencyFrames: masterInputLatency + masterLatency }
}
