import type { AudioSourceKind, AudioSourceMetadata } from '~/lib/audio-source'
import type { TrackChannelRole, TrackSend } from '~/types/timeline'

export type TrackRef = string
export type ClipRef = string
export type HistoryScope = 'shared' | 'local'

export type ClipTiming = {
  startSec: number
  duration: number
  leftPadSec?: number
  bufferOffsetSec?: number
  midiOffsetBeats?: number
}

export type ClipOffsets = Omit<ClipTiming, 'startSec' | 'duration'>

export type ClipSnapshot = {
  startSec: number
  duration: number
  name?: string
  sampleUrl?: string
  source?: AudioSourceMetadata
  sourceAssetKey?: string
  sourceKind?: AudioSourceKind
  midi?: any
  timing?: ClipOffsets
}

export type HistoryClipSnapshot = ClipSnapshot & {
  clipRef: ClipRef
}

export type TrackRoutingSnapshot = {
  sends: TrackSend[]
  outputTargetId?: string
}

export type TrackRoutingHistorySnapshot = {
  sends: Array<{
    targetTrackRef: TrackRef
    amount: number
  }>
  outputTargetRef?: TrackRef
}

export type InboundTrackRoutingSnapshot = TrackRoutingHistorySnapshot & {
  sourceTrackRef: TrackRef
}

export type TrackSnapshot = {
  trackRef?: TrackRef
  index: number
  name: string
  volume: number
  muted?: boolean
  soloed?: boolean
  kind?: 'audio' | 'instrument'
  channelRole?: TrackChannelRole
  routing: TrackRoutingHistorySnapshot
}

export type HistoryEntry =
  | {
      type: 'clip-create'
      roomId: string
      data: {
        trackRef: TrackRef
        clip: {
          clipRef: ClipRef
          currentId?: string
          startSec: number
          duration: number
          name?: string
          sampleUrl?: string
          source?: AudioSourceMetadata
          sourceAssetKey?: string
          sourceKind?: AudioSourceKind
          midi?: any
          timing?: ClipOffsets
        }
      }
    }
  | {
      type: 'clip-delete'
      roomId: string
      data: {
        items: Array<{ trackRef: TrackRef; clip: HistoryClipSnapshot }>
        recreatedClips?: Array<{ clipRef: ClipRef; clipId: string }>
      }
    }
  | {
      type: 'clips-move'
      roomId: string
      data: {
        moves: Array<{
          clipRef: ClipRef
          from: { trackRef: TrackRef; startSec: number }
          to: { trackRef: TrackRef; startSec: number }
        }>
      }
    }
  | {
      type: 'clip-timing'
      roomId: string
      data: {
        clipRef: ClipRef
        from: ClipTiming
        to: ClipTiming
      }
    }
  | {
      type: 'track-create'
      roomId: string
      data: { trackRef: TrackRef; currentTrackId?: string; index: number; kind?: 'audio' | 'instrument'; channelRole?: TrackChannelRole }
    }
  | {
    type: 'track-delete'
      roomId: string
      data: {
        track: TrackSnapshot
        clips: HistoryClipSnapshot[]
        effects?: { eq?: any; reverb?: any; synth?: any; arp?: any }
        inboundRouting?: InboundTrackRoutingSnapshot[]
        recreatedTrackId?: string
        recreatedClips?: Array<{ clipRef: ClipRef; clipId: string }>
      }
    }
  | {
      type: 'track-volume'
      roomId: string
      data: { trackRef: TrackRef; scope: HistoryScope; from: number; to: number }
    }
  | {
      type: 'track-mute'
      roomId: string
      data: { trackRef: TrackRef; scope: HistoryScope; from: boolean; to: boolean }
    }
  | {
      type: 'track-solo'
      roomId: string
      data: { trackRef: TrackRef; scope: HistoryScope; from: boolean; to: boolean }
    }
  | {
      type: 'track-routing'
      roomId: string
      data: { trackRef: TrackRef; from: TrackRoutingHistorySnapshot; to: TrackRoutingHistorySnapshot }
    }
  | {
      type: 'effect-params'
      roomId: string
      data: {
        trackRef?: TrackRef
        effect: 'eq' | 'reverb' | 'synth' | 'arp' | 'master-eq' | 'master-reverb'
        from: any
        to: any
      }
    }

export type MergeKey = string

export type PersistedHistory = {
  undo: HistoryEntry[]
  redo: HistoryEntry[]
}
