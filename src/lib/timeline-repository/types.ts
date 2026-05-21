import type { AudioSourceKind } from '~/lib/audio-source'
import type { TrackChannelRole } from '~/types/timeline'

export type TimelineEntityKind = 'track' | 'clip' | 'effect' | 'mixerChannel'

export type TimelineTrackId = string
export type TimelineClipId = string
export type TimelineAssetId = string

export type TimelineTrackRow = {
  id: TimelineTrackId
  historyRef: string
  name: string
  index: number
  volume: number
  muted: boolean
  soloed: boolean
  kind: 'audio' | 'instrument'
  channelRole: TrackChannelRole
  outputTargetId?: TimelineTrackId
  sends: { targetId: TimelineTrackId; amount: number }[]
  createdAt: number
  updatedAt: number
}

export type TimelineClipRow = {
  id: TimelineClipId
  trackId: TimelineTrackId
  historyRef: string
  name: string
  startSec: number
  duration: number
  color: string
  sourceAssetId?: TimelineAssetId
  sourceAssetKey?: string
  sourceKind?: AudioSourceKind
  sourceDurationSec?: number
  sourceSampleRate?: number
  sourceChannelCount?: number
  leftPadSec?: number
  bufferOffsetSec?: number
  sampleUrl?: string
  midi?: {
    wave: 'sine' | 'square' | 'sawtooth' | 'triangle'
    gain?: number
    notes: { beat: number; length: number; pitch: number; velocity?: number }[]
  }
  midiOffsetBeats?: number
  createdAt: number
  updatedAt: number
}

export type TimelineSnapshot = {
  projectId: string
  tracks: TimelineTrackRow[]
  clips: TimelineClipRow[]
}

export type CreateTrackInput = {
  id?: TimelineTrackId
  historyRef?: string
  name?: string
  index?: number
  volume?: number
  muted?: boolean
  soloed?: boolean
  kind?: 'audio' | 'instrument'
  channelRole?: TrackChannelRole
  outputTargetId?: TimelineTrackId
  sends?: { targetId: TimelineTrackId; amount: number }[]
}

export type CreateClipInput = {
  id?: TimelineClipId
  historyRef?: string
  trackId: TimelineTrackId
  name?: string
  startSec: number
  duration: number
  color?: string
  sourceAssetId?: TimelineAssetId
  sourceAssetKey?: string
  sourceKind?: AudioSourceKind
  sourceDurationSec?: number
  sourceSampleRate?: number
  sourceChannelCount?: number
  leftPadSec?: number
  bufferOffsetSec?: number
  sampleUrl?: string
  midi?: TimelineClipRow['midi']
  midiOffsetBeats?: number
}

export type UpdateClipInput = {
  clipId: TimelineClipId
  trackId?: TimelineTrackId
  startSec?: number
  duration?: number
  name?: string
  leftPadSec?: number
  bufferOffsetSec?: number
  sourceAssetId?: TimelineAssetId
  sourceAssetKey?: string
  sourceKind?: AudioSourceKind
  sourceDurationSec?: number
  sourceSampleRate?: number
  sourceChannelCount?: number
  midi?: TimelineClipRow['midi']
  midiOffsetBeats?: number
}

export type UpdateTrackInput = {
  trackId: TimelineTrackId
  volume?: number
  muted?: boolean
  soloed?: boolean
  outputTargetId?: TimelineTrackId | null
  sends?: { targetId: TimelineTrackId; amount: number }[]
}

export type TimelineRepository = {
  loadSnapshot: () => Promise<TimelineSnapshot>
  createTrack: (input: CreateTrackInput) => Promise<TimelineTrackRow>
  updateTrack: (input: UpdateTrackInput) => Promise<TimelineTrackRow | null>
  createClip: (input: CreateClipInput) => Promise<TimelineClipRow>
  updateClip: (input: UpdateClipInput) => Promise<TimelineClipRow | null>
  deleteTrack: (trackId: TimelineTrackId) => Promise<void>
  deleteClip: (clipId: TimelineClipId) => Promise<void>
}
