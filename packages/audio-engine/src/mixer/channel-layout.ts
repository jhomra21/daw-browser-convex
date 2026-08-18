import { assert, assertDefined } from '@daw-browser/shared'
import type { ChannelLayout, MixerTrackFx, ResolvedMixerGraph } from './types'

export const getSourceChannelLayout = (channelCounts: readonly number[] | undefined): ChannelLayout | undefined => {
  if (!channelCounts || channelCounts.length === 0) return
  if (channelCounts.some((count) => count !== 1 && count !== 2)) return
  return channelCounts.every((count) => count === 1) ? 'mono' : 'stereo'
}

export const convertStereoToMonoSample = (left: number, right: number) => (0.5 * left) + (0.5 * right)

export const duplicateMonoSample = (sample: number): readonly [number, number] => [sample, sample]

const expandsLayout = (kind: 'delay' | 'reverb', params: { enabled?: boolean; pingPong?: boolean; stereoWidth?: number }) =>
  params.enabled === true && (
    (kind === 'delay' && params.pingPong === true) ||
    (kind === 'reverb' && (params.stereoWidth ?? 0) > 0)
  )

const propagateEffects = (input: ChannelLayout, fx: MixerTrackFx | ResolvedMixerGraph['master']): ChannelLayout => {
  let layout = input
  for (const instance of fx.instances) {
    if (instance.kind === 'eq' && instance.params.enabled && instance.params.channelMode === 'mono') {
      layout = 'mono'
    } else if (instance.kind === 'chorus' || instance.kind === 'autopan' || instance.kind === 'ensemble') {
      if (instance.params.state.enabled) layout = 'stereo'
    } else if ((instance.kind === 'delay' || instance.kind === 'reverb') && expandsLayout(instance.kind, instance.params)) {
      layout = 'stereo'
    }
  }
  return layout
}

const mergeLayouts = (layouts: readonly ChannelLayout[]): ChannelLayout =>
  layouts.some((layout) => layout === 'stereo') ? 'stereo' : 'mono'

export function propagateMixerGraphLayouts(graph: ResolvedMixerGraph): ResolvedMixerGraph {
  const channelById = new Map(graph.channels.map((entry) => [entry.channel.id, entry]))
  const incoming = new Map<string, string[]>()
  for (const entry of graph.channels) {
    const targets = entry.sends.map((send) => send.targetId)
    if (entry.outputTargetId) targets.push(entry.outputTargetId)
    for (const targetId of targets) {
      assert(channelById.has(targetId), `Missing channel layout target ${targetId}`)
      const sources = incoming.get(targetId) ?? []
      sources.push(entry.channel.id)
      incoming.set(targetId, sources)
    }
  }

  type ResolvedChannelLayout = { input: ChannelLayout; output: ChannelLayout }
  const resolved = new Map<string, ResolvedChannelLayout>()
  const visiting = new Set<string>()
  const visit = (channelId: string): ResolvedChannelLayout => {
    const existing = resolved.get(channelId)
    if (existing) return existing
    assert(!visiting.has(channelId), `Cyclic mixer routing at ${channelId}`)
    visiting.add(channelId)
    const entry = assertDefined(channelById.get(channelId), `Missing mixer channel ${channelId}`)
    const upstream = (incoming.get(channelId) ?? []).map((sourceId) => visit(sourceId).output)
    const input = upstream.length > 0 ? mergeLayouts(upstream) : entry.sourceLayout ?? 'stereo'
    const output = propagateEffects(input, entry.fx ?? { instances: [] })
    const result = { input, output }
    resolved.set(channelId, result)
    visiting.delete(channelId)
    return result
  }

  const channels = graph.channels.map((entry) => {
    const layout = visit(entry.channel.id)
    return { ...entry, inputLayout: layout.input, outputLayout: layout.output }
  })
  const masterInputs = channels
    .filter((entry) => !entry.outputTargetId)
    .map((entry) => entry.outputLayout)
  const masterInputLayout = mergeLayouts(masterInputs.length > 0 ? masterInputs : ['stereo'])
  return {
    channels,
    master: {
      ...graph.master,
      inputLayout: masterInputLayout,
      outputLayout: propagateEffects(masterInputLayout, graph.master),
    },
  }
}
