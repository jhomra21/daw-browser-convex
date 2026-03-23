import type { Track, TrackChannelRole, TrackSend } from '~/types/timeline'

export type MixerChannelRole = TrackChannelRole | 'master'

export type MixerChannel = {
  id: string
  sourceTrackId?: string
  name: string
  role: MixerChannelRole
  volume: number
  muted: boolean
  soloed: boolean
  sends: TrackSend[]
  outputTargetId?: string
  kind?: 'audio' | 'instrument'
}

export function getMixerChannelRole(channel: Pick<MixerChannel, 'role'> | null | undefined): MixerChannelRole {
  if (channel?.role === 'return' || channel?.role === 'group' || channel?.role === 'master') return channel.role
  return 'track'
}

export function createMixerChannel(track: Track): MixerChannel {
  const role: MixerChannelRole = track.channelRole === 'return' || track.channelRole === 'group' ? track.channelRole : 'track'
  return {
    id: track.id,
    sourceTrackId: track.id,
    name: track.name,
    role,
    volume: Number.isFinite(track.volume) ? track.volume : 0.8,
    muted: !!track.muted,
    soloed: !!track.soloed,
    sends: Array.isArray(track.sends) ? track.sends : [],
    outputTargetId: track.outputTargetId,
    kind: track.kind,
  }
}

export function createMixerChannels(tracks: Track[]): MixerChannel[] {
  return tracks.map(createMixerChannel)
}
