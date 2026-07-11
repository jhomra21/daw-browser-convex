import { assert, normalizeAudioEffectOrder, AUDIO_EFFECT_ORDER, type AudioEffectKind } from '@daw-browser/shared'
import type { ChannelLayout, MixerTrackFx, ResolvedMixerGraph } from './types'

export const getSourceChannelLayout = (channelCounts: readonly number[] | undefined): ChannelLayout | undefined => {
  if (!channelCounts || channelCounts.length === 0) return
  if (channelCounts.some((count) => count !== 1 && count !== 2)) return
  return channelCounts.every((count) => count === 1) ? 'mono' : 'stereo'
}

export const convertStereoToMonoSample = (left: number, right: number) => (0.5 * left) + (0.5 * right)

export const duplicateMonoSample = (sample: number): readonly [number, number] => [sample, sample]

const expandsLayout = (kind: AudioEffectKind, params: { enabled?: boolean; pingPong?: boolean; stereoWidth?: number }) =>
  params.enabled === true && (
    (kind === 'delay' && params.pingPong === true) ||
    (kind === 'reverb' && (params.stereoWidth ?? 0) > 0) ||
    kind === 'chorus' || kind === 'autopan' || kind === 'ensemble'
  )

const propagateEffects = (input: ChannelLayout, fx: MixerTrackFx | ResolvedMixerGraph['master']): ChannelLayout => {
  let layout = input
  if (fx.instances) {
    for (const instance of fx.instances) {
      if (instance.kind === 'chorus' || instance.kind === 'autopan' || instance.kind === 'ensemble') {
        if (instance.params.state.enabled) layout = 'stereo'
      } else if (instance.kind === 'delay' || instance.kind === 'reverb') {
        if (expandsLayout(instance.kind, instance.params)) layout = 'stereo'
      }
    }
    return layout
  }
  const order = normalizeAudioEffectOrder(fx.order ?? AUDIO_EFFECT_ORDER, AUDIO_EFFECT_ORDER)
  for (const kind of order) {
    const params = kind === 'eq' ? fx.eq
      : kind === 'compressor' ? fx.compressor
      : kind === 'saturator' ? fx.saturator
      : kind === 'delay' ? fx.delay
      : kind === 'reverb' ? fx.reverb
      : undefined
    if (params && expandsLayout(kind, params)) layout = 'stereo'
  }
  return layout
}

const mergeLayouts = (layouts: readonly ChannelLayout[]): ChannelLayout =>
  layouts.some((layout) => layout === 'stereo') ? 'stereo' : 'mono'

export function propagateMixerGraphLayouts(graph: ResolvedMixerGraph): ResolvedMixerGraph {
  const channelById = new Map(graph.channels.map((entry) => [entry.channel.id, entry]))
  const incoming = new Map<string, string[]>()
  for (const entry of graph.channels) {
    const targets = [...entry.sends.map((send) => send.targetId)]
    if (entry.outputTargetId) targets.push(entry.outputTargetId)
    for (const targetId of targets) {
      assert(channelById.has(targetId), `Missing channel layout target ${targetId}`)
      const sources = incoming.get(targetId) ?? []
      sources.push(entry.channel.id)
      incoming.set(targetId, sources)
    }
  }

  const resolved = new Map<string, { input: ChannelLayout; output: ChannelLayout }>()
  const visiting = new Set<string>()
  const visit = (channelId: string): { input: ChannelLayout; output: ChannelLayout } => {
    const existing = resolved.get(channelId)
    if (existing) return existing
    assert(!visiting.has(channelId), `Cyclic mixer routing at ${channelId}`)
    visiting.add(channelId)
    const entry = channelById.get(channelId)
    assert(entry, `Missing mixer channel ${channelId}`)
    const upstream = (incoming.get(channelId) ?? []).map((sourceId) => visit(sourceId).output)
    const input = upstream.length > 0 ? mergeLayouts(upstream) : entry.sourceLayout ?? 'stereo'
    const output = propagateEffects(input, entry.fx ?? {})
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
