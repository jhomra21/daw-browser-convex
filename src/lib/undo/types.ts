import type { AudioSourceKind, AudioSourceMetadata } from '~/lib/audio-source'
import type { ArpeggiatorParams, CompressorParams, DelayParams, EqParams, ReverbParams, SaturatorParams, SynthParams, TrackInstrumentParams } from '@daw-browser/shared'
import type { AudioWarp, Track, TrackChannelRole, TrackSend } from '@daw-browser/timeline-core/types'

export type TrackRef = string
export type ClipRef = string
export type HistoryScope = 'shared' | 'local'

export type ClipTiming = {
  startSec: number
  duration: number
  leftPadSec?: number
  bufferOffsetSec?: number
  /** Legacy persisted undo entries may include audioWarp here. New warp history uses clip-audio-warp. */
  audioWarp?: AudioWarp
  gain?: number
  midiOffsetBeats?: number
}

export type ClipAudioWarpSnapshot = {
  audioWarp: AudioWarp
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

export type TrackEffect = 'eq' | 'compressor' | 'saturator' | 'delay' | 'reverb' | 'synth' | 'instrument' | 'arp'
export type EffectType = TrackEffect | 'master-eq' | 'master-compressor' | 'master-saturator' | 'master-delay' | 'master-reverb'

export type EffectParamsByEffect = {
  eq: EqParams
  compressor: CompressorParams
  saturator: SaturatorParams
  delay: DelayParams
  reverb: ReverbParams
  synth: SynthParams
  instrument: TrackInstrumentParams
  arp: ArpeggiatorParams
  'master-eq': EqParams
  'master-compressor': CompressorParams
  'master-saturator': SaturatorParams
  'master-delay': DelayParams
  'master-reverb': ReverbParams
}

type EffectTargetId<Effect extends EffectType> = Effect extends TrackEffect ? Track['id'] : 'master'

export type TrackEffectSnapshot = Partial<{
  eq: EqParams
  compressor: CompressorParams
  saturator: SaturatorParams
  delay: DelayParams
  reverb: ReverbParams
  synth: SynthParams
  instrument: TrackInstrumentParams
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

type EffectParamsHistoryEntryData<Effect extends EffectType = EffectType> =
  Effect extends EffectType
    ? Omit<EffectParamsCommitPayload<Effect>, 'targetId'> & { trackRef?: TrackRef }
    : never

export type EffectParamsHistoryEntry<Effect extends EffectType = EffectType> = {
  type: 'effect-params'
  projectId: string
  data: EffectParamsHistoryEntryData<Effect>
}

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
      type: 'clip-audio-warp'
      projectId: string
      data: {
        clipRef: ClipRef
        from: ClipAudioWarpSnapshot
        to: ClipAudioWarpSnapshot
      }
    }
  | {
      type: 'track-create'
      projectId: string
      data: { trackRef: TrackRef; currentTrackId?: string; index: number; kind?: 'audio' | 'instrument'; channelRole?: TrackChannelRole }
    }
  | {
      type: 'track-clip-create'
      projectId: string
      data: {
        track: { trackRef: TrackRef; currentTrackId?: string; index: number; kind?: 'audio' | 'instrument'; channelRole?: TrackChannelRole }
        clip: {
          trackRef: TrackRef
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
