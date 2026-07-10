import type { AudioSourceKind } from '~/lib/audio-source'
import type { AutomationEnvelope } from '@daw-browser/shared'
import type { AudioWarp, TrackChannelRole, TrackId } from '@daw-browser/timeline-core/types'

export type TimelineEntityKind = 'track' | 'clip' | 'effect' | 'mixerChannel'

export type TimelineTrackId = TrackId
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
  groupId?: TimelineTrackId
  collapsed?: boolean
  color?: string
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
  audioWarp?: AudioWarp
  gain?: number
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
  groupId?: TimelineTrackId
  collapsed?: boolean
  color?: string
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
  audioWarp?: AudioWarp
  gain?: number
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
  audioWarp?: AudioWarp
  gain?: number
  color?: string
  sourceAssetId?: TimelineAssetId
  sourceAssetKey?: string
  sourceKind?: AudioSourceKind
  sourceDurationSec?: number
  sourceSampleRate?: number
  sourceChannelCount?: number
  sampleUrl?: string | null
  midi?: TimelineClipRow['midi']
  midiOffsetBeats?: number
}

export type MoveClipInput = {
  clipId: TimelineClipId
  trackId: TimelineTrackId
  startSec: number
}

export type UpdateTrackInput = {
  trackId: TimelineTrackId
  index?: number
  volume?: number
  muted?: boolean
  soloed?: boolean
  outputTargetId?: TimelineTrackId | null
  groupId?: TimelineTrackId | null
  collapsed?: boolean
  color?: string | null
  sends?: { targetId: TimelineTrackId; amount: number }[]
}

export type ReorderAndGroupTrackInput = {
  trackId: TimelineTrackId
  index: number
  groupId?: TimelineTrackId | null
  outputTargetId?: TimelineTrackId | null
}

export type TrackColorBatchUpdate = {
  trackId: TimelineTrackId
  color?: string | null
}

export type ClipColorBatchUpdate = {
  clipId: TimelineClipId
  color: string
}

export type RestoreUngroupInput = {
  group: TimelineTrackRow
  children: Array<{ trackId: TimelineTrackId; outputTargetId?: TimelineTrackId; outputToGroup: boolean }>
  effects: Array<{
    id: string
    targetId: TimelineTrackId
    effect: string
    instanceId?: string
    params: unknown
    index?: number
    updatedAt: number
  }>
  automation: AutomationEnvelope[]
}

export type TimelineRepository = {
  loadSnapshot: () => Promise<TimelineSnapshot>
  createTrack: (input: CreateTrackInput) => Promise<TimelineTrackRow>
  updateTrack: (input: UpdateTrackInput) => Promise<TimelineTrackRow | null>
  createClip: (input: CreateClipInput) => Promise<TimelineClipRow>
  updateClip: (input: UpdateClipInput) => Promise<TimelineClipRow | null>
  moveClips: (moves: MoveClipInput[]) => Promise<void>
  reorderAndGroup: (updates: ReorderAndGroupTrackInput[]) => Promise<void>
  ungroupTrack: (groupId: TimelineTrackId) => Promise<void>
  restoreUngroup: (input: RestoreUngroupInput) => Promise<void>
  applyColorBatch: (updates: { tracks: TrackColorBatchUpdate[]; clips: ClipColorBatchUpdate[] }) => Promise<void>
  deleteTrack: (trackId: TimelineTrackId) => Promise<void>
  deleteClip: (clipId: TimelineClipId) => Promise<void>
  deleteClips: (clipIds: TimelineClipId[]) => Promise<void>
}
