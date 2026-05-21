import type { AudioSourceKind, AudioSourceMetadata } from '~/lib/audio-source'
import type { ArpeggiatorParams, EqParams, ReverbParams, SynthParams } from '~/lib/effects/params'
import type { Track, TrackChannelRole, TrackSend } from '~/types/timeline'

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
  outputTargetId?: Track['id']
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

export type TrackEffect = 'eq' | 'reverb' | 'synth' | 'arp'
export type EffectType = TrackEffect | 'master-eq' | 'master-reverb'

export type EffectParamsByEffect = {
  eq: EqParams
  reverb: ReverbParams
  synth: SynthParams
  arp: ArpeggiatorParams
  'master-eq': EqParams
  'master-reverb': ReverbParams
}

type EffectTargetId<Effect extends EffectType> = Effect extends TrackEffect ? Track['id'] : 'master'

export type TrackEffectSnapshot = Partial<{
  eq: EqParams
  reverb: ReverbParams
  synth: SynthParams
  arp: ArpeggiatorParams
}>

type EffectParamsCommitPayloadMap = {
  [Effect in EffectType]: {
    targetId: EffectTargetId<Effect>
    effect: Effect
    from: EffectParamsByEffect[Effect]
    to: EffectParamsByEffect[Effect]
  }
}

export type EffectParamsCommitPayload<Effect extends EffectType = EffectType> = EffectParamsCommitPayloadMap[Effect]

type EffectParamsHistoryEntryMap = {
  [Effect in EffectType]: {
    type: 'effect-params'
    projectId: string
    data: {
      trackRef?: TrackRef
      effect: Effect
      from: EffectParamsByEffect[Effect]
      to: EffectParamsByEffect[Effect]
    }
  }
}

export type EffectParamsHistoryEntry<Effect extends EffectType = EffectType> = EffectParamsHistoryEntryMap[Effect]

export type HistoryEntry =
  | {
      type: 'clip-create'
      projectId: string
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
      projectId: string
      data: {
        items: Array<{ trackRef: TrackRef; clip: HistoryClipSnapshot }>
        recreatedClips?: Array<{ clipRef: ClipRef; clipId: string }>
      }
    }
  | {
      type: 'clips-move'
      projectId: string
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
      projectId: string
      data: {
        clipRef: ClipRef
        from: ClipTiming
        to: ClipTiming
      }
    }
  | {
      type: 'track-create'
      projectId: string
      data: { trackRef: TrackRef; currentTrackId?: string; index: number; kind?: 'audio' | 'instrument'; channelRole?: TrackChannelRole }
    }
  | {
    type: 'track-delete'
      projectId: string
      data: {
        track: TrackSnapshot
        clips: HistoryClipSnapshot[]
        effects?: TrackEffectSnapshot
        inboundRouting?: InboundTrackRoutingSnapshot[]
        recreatedTrackId?: string
        recreatedClips?: Array<{ clipRef: ClipRef; clipId: string }>
      }
    }
  | {
      type: 'track-volume'
      projectId: string
      data: { trackRef: TrackRef; scope: HistoryScope; from: number; to: number }
    }
  | {
      type: 'track-mute'
      projectId: string
      data: { trackRef: TrackRef; scope: HistoryScope; from: boolean; to: boolean }
    }
  | {
      type: 'track-solo'
      projectId: string
      data: { trackRef: TrackRef; scope: HistoryScope; from: boolean; to: boolean }
    }
  | {
      type: 'track-routing'
      projectId: string
      data: { trackRef: TrackRef; from: TrackRoutingHistorySnapshot; to: TrackRoutingHistorySnapshot }
    }
  | EffectParamsHistoryEntry

export type MergeKey = string

export type PersistedHistory = {
  undo: HistoryEntry[]
  redo: HistoryEntry[]
}
