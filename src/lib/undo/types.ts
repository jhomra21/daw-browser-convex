import type { AudioSourceKind, AudioSourceMetadata } from '~/lib/audio-source'
import type { ArpeggiatorParams, AudioEffectKind, AutomationEnvelope, AutoPanParamsEnvelope, ChorusParamsEnvelope, CompressorParams, DelayParams, EnsembleParamsEnvelope, EqParams, FlangerParamsEnvelope, GateParamsEnvelope, LimiterParamsEnvelope, LoFiParamsEnvelope, PhaserParamsEnvelope, ReverbParams, SaturatorParams, SpectralParamsEnvelope, SynthParams, TrackInstrumentParams, TremoloParamsEnvelope, UtilityParamsEnvelope } from '@daw-browser/shared'
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
    tap?: 'pre-fx' | 'pre-fader' | 'post-fader'
  }>
  outputTargetRef?: TrackRef
}

export type InboundTrackRoutingSnapshot = TrackRoutingHistorySnapshot & {
  sourceTrackRef: TrackRef
}

export type SidechainRouteHistorySnapshot = {
  sourceTrackRef: TrackRef
  targetTrackRef: TrackRef
  effectInstanceId: string
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
  groupRef?: TrackRef
  collapsed?: boolean
  color?: string
  routing: TrackRoutingHistorySnapshot
}

export type TrackEffect = AudioEffectKind | 'synth' | 'instrument' | 'arp'
export type EffectType = TrackEffect | `master-${AudioEffectKind}`

export type EffectParamsByEffect = {
  utility: UtilityParamsEnvelope
  eq: EqParams
  autofilter: import('@daw-browser/shared').AutoFilterParamsEnvelope
  gate: GateParamsEnvelope
  compressor: CompressorParams
  saturator: SaturatorParams
  limiter: LimiterParamsEnvelope
  lofi: LoFiParamsEnvelope
  delay: DelayParams
  reverb: ReverbParams
  chorus: ChorusParamsEnvelope
  flanger: FlangerParamsEnvelope
  phaser: PhaserParamsEnvelope
  tremolo: TremoloParamsEnvelope
  autopan: AutoPanParamsEnvelope
  ensemble: EnsembleParamsEnvelope
  spectral: SpectralParamsEnvelope
  synth: SynthParams
  instrument: TrackInstrumentParams
  arp: ArpeggiatorParams
  'master-utility': UtilityParamsEnvelope
  'master-eq': EqParams
  'master-autofilter': import('@daw-browser/shared').AutoFilterParamsEnvelope
  'master-gate': GateParamsEnvelope
  'master-compressor': CompressorParams
  'master-saturator': SaturatorParams
  'master-limiter': LimiterParamsEnvelope
  'master-lofi': LoFiParamsEnvelope
  'master-delay': DelayParams
  'master-reverb': ReverbParams
  'master-chorus': ChorusParamsEnvelope
  'master-flanger': FlangerParamsEnvelope
  'master-phaser': PhaserParamsEnvelope
  'master-tremolo': TremoloParamsEnvelope
  'master-autopan': AutoPanParamsEnvelope
  'master-ensemble': EnsembleParamsEnvelope
  'master-spectral': SpectralParamsEnvelope
}

export type TrackAudioEffectSnapshot = {
  [Effect in AudioEffectKind]: {
    effect: Effect
    instanceId?: string
    index?: number
    params: EffectParamsByEffect[Effect]
  }
}[AudioEffectKind]

type EffectTargetId<Effect extends EffectType> = Effect extends TrackEffect ? Track['id'] : 'master'

export type TrackEffectSnapshot = Partial<{
  eq: EqParams
  compressor: CompressorParams
  saturator: SaturatorParams
  limiter: LimiterParamsEnvelope
  delay: DelayParams
  reverb: ReverbParams
  spectral: SpectralParamsEnvelope
  audioEffects: TrackAudioEffectSnapshot[]
  synth: SynthParams
  instrument: TrackInstrumentParams
  arp: ArpeggiatorParams
}>

export type TrackAutomationSnapshot = AutomationEnvelope[]

type EffectParamsCommitPayloadMap = {
  [Effect in EffectType]: {
    targetId: EffectTargetId<Effect>
    effect: Effect
    instanceId?: string
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

export type AutomationEnvelopeHistoryEntry = {
  type: 'automation-envelope-change'
  projectId: string
  data: {
    before: AutomationEnvelope | null
    after: AutomationEnvelope | null
  }
}

export type HistoryEntry =
  | {
      type: 'section-edit'
      projectId: string
      data: { entries: HistoryEntry[] }
    }
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
      data: { trackRef: TrackRef; currentTrackId?: string; index: number; kind?: 'audio' | 'instrument'; channelRole?: TrackChannelRole; collapsed?: boolean; color?: string }
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
        automation?: TrackAutomationSnapshot
        inboundRouting?: InboundTrackRoutingSnapshot[]
        sidechainRoutes?: SidechainRouteHistorySnapshot[]
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
  | {
      type: 'track-group'
      projectId: string
      data: {
        groupTrackRef: TrackRef
        currentGroupTrackId?: string
        groupTrack: { index: number; name: string; color?: string }
        childUpdates: Array<{
          trackRef: TrackRef
          previousGroupRef?: TrackRef
          previousOutputTargetRef?: TrackRef
          nextOutputTargetRef?: TrackRef
        }>
      }
    }
  | {
      type: 'track-ungroup'
      projectId: string
      data: {
        groupTrackRef: TrackRef
        sourceGroupTrackId?: string
        currentGroupTrackId?: string
        restoreOperationId?: string
        groupTrack?: TrackSnapshot
        effects?: TrackEffectSnapshot
        automation?: TrackAutomationSnapshot
        sidechainRoutes?: SidechainRouteHistorySnapshot[]
        childSnapshots: Array<{
          trackRef: TrackRef
          previousGroupRef: TrackRef
          previousOutputTargetRef?: TrackRef
          nextOutputTargetRef?: TrackRef
        }>
      }
    }
  | {
      type: 'track-color'
      projectId: string
      data: { trackRef: TrackRef; from: string | undefined; to: string | undefined }
    }
  | {
      type: 'track-color-cascade'
      projectId: string
      data: {
        tracks: Array<{ trackRef: TrackRef; from: string | undefined; to: string | undefined }>
        clips: Array<{ clipRef: ClipRef; from: string | undefined; to: string }>
      }
    }
  | {
      type: 'track-reorder'
      projectId: string
      data: {
        patches: Array<{
          trackRef: TrackRef
          fromIndex: number
          toIndex: number
          fromGroupRef?: TrackRef
          toGroupRef?: TrackRef
          fromOutputTargetRef?: TrackRef
          toOutputTargetRef?: TrackRef
        }>
      }
    }
  | {
      type: 'clip-color'
      projectId: string
      data: { clipRef: ClipRef; from: string | undefined; to: string | undefined }
    }
  | AutomationEnvelopeHistoryEntry
  | EffectParamsHistoryEntry

export type MergeKey = string

export type PersistedHistory = {
  undo: HistoryEntry[]
  redo: HistoryEntry[]
}
