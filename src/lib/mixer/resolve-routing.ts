import type { MixerChannel } from '~/lib/mixer/channels'
import { getMixerChannelRole } from '~/lib/mixer/channels'
import { normalizeTrackRouting } from '~/lib/track-routing-core'
import type { ResolveMixerGraphOptions, ResolvedMixerGraph, ResolvedMixerSend } from '~/lib/mixer/types'

type ResolvedChannelRouting = {
  channel: MixerChannel
  outputTargetId?: string
  sends: ResolvedMixerSend[]
}

type SoloRoutingState = {
  activeOutputIds: Set<string>
  activeSendTargetsByChannelId: Map<string, Set<string>>
}

function resolveChannelRouting(
  channel: MixerChannel,
  routingTracks: Array<{ id: string; channelRole?: string }>,
): ResolvedChannelRouting {
  const normalized = normalizeTrackRouting({
    track: { id: channel.id, channelRole: channel.role },
    sends: Array.isArray(channel.sends) ? channel.sends : [],
    outputTargetId: channel.outputTargetId,
    tracks: routingTracks,
  })

  return {
    channel,
    outputTargetId: normalized.outputTargetId,
    sends: normalized.sends,
  }
}

function resolveDryPathChannelIds(
  channelId: string,
  outputTargetByChannelId: Map<string, string | undefined>,
) {
  const path: string[] = []
  const visited = new Set<string>()
  let currentId: string | undefined = channelId

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    path.push(currentId)
    currentId = outputTargetByChannelId.get(currentId)
  }

  return path
}

function pathTouchesSolo(path: string[], soloedIds: Set<string>) {
  for (const channelId of path) {
    if (soloedIds.has(channelId)) return true
  }
  return false
}

function resolveSoloRoutingState(channels: ResolvedChannelRouting[]): SoloRoutingState | null {
  const soloedIds = new Set(channels.filter(({ channel }) => channel.soloed).map(({ channel }) => channel.id))
  if (soloedIds.size === 0) return null

  const outputTargetByChannelId = new Map(
    channels.map(({ channel, outputTargetId }) => [channel.id, outputTargetId] as const),
  )
  const dryPathByChannelId = new Map(
    channels.map(({ channel }) => [channel.id, resolveDryPathChannelIds(channel.id, outputTargetByChannelId)] as const),
  )
  const activeOutputIds = new Set<string>()
  const activeSendTargetsByChannelId = new Map<string, Set<string>>()

  for (const { channel, sends } of channels) {
    const dryPath = dryPathByChannelId.get(channel.id) ?? [channel.id]
    const sourceOutputActive = pathTouchesSolo(dryPath, soloedIds)
    if (sourceOutputActive) {
      for (const pathChannelId of dryPath) {
        activeOutputIds.add(pathChannelId)
      }
    }

    for (const send of sends) {
      const targetPath = dryPathByChannelId.get(send.targetId)
      if (!targetPath) continue
      const targetOutputActive = pathTouchesSolo(targetPath, soloedIds)
      if (!sourceOutputActive && !targetOutputActive) continue

      const activeSendTargets = activeSendTargetsByChannelId.get(channel.id) ?? new Set<string>()
      activeSendTargets.add(send.targetId)
      activeSendTargetsByChannelId.set(channel.id, activeSendTargets)

      for (const pathChannelId of targetPath) {
        activeOutputIds.add(pathChannelId)
      }
    }
  }

  return {
    activeOutputIds,
    activeSendTargetsByChannelId,
  }
}

function isChannelOutputActive(
  channelId: string,
  soloRoutingState: SoloRoutingState | null,
) {
  if (!soloRoutingState) return true
  return soloRoutingState.activeOutputIds.has(channelId)
}

function resolveActiveSends(
  channelId: string,
  sends: ResolvedMixerSend[],
  muted: boolean,
  soloRoutingState: SoloRoutingState | null,
) {
  if (muted) return []
  if (!soloRoutingState) return sends

  const activeTargets = soloRoutingState.activeSendTargetsByChannelId.get(channelId)
  if (!activeTargets) return []
  return sends.filter((send) => activeTargets.has(send.targetId))
}

export function resolveMixerGraph(options: ResolveMixerGraphOptions): ResolvedMixerGraph {
  const channels = options.channels.filter((channel) => getMixerChannelRole(channel) !== 'master')
  const routingTracks = channels.map((channel) => ({ id: channel.id, channelRole: channel.role }))
  const resolvedChannels: ResolvedChannelRouting[] = channels.map((channel) => resolveChannelRouting(channel, routingTracks))
  const soloRoutingState = resolveSoloRoutingState(resolvedChannels)

  return {
    channels: resolvedChannels
      .map(({ channel, outputTargetId, sends }) => {
        const gain = !channel.muted && Number.isFinite(channel.volume) ? channel.volume : 0
        const outputGain = gain > 0 && isChannelOutputActive(channel.id, soloRoutingState) ? 1 : 0
        const activeSends = resolveActiveSends(channel.id, sends, channel.muted, soloRoutingState)
        return {
          channel,
          gain,
          outputGain,
          outputTargetId,
          sends: activeSends,
          fx: options.trackFx?.[channel.id],
        }
      }),
    master: {
      eq: options.masterEq,
      reverb: options.masterReverb,
    },
  }
}
