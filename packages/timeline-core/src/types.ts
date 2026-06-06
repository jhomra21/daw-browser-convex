import type { AudioSourceKind } from '@daw-browser/shared'
export type TrackId = string

export type TrackSend = {
  targetId: TrackId
  amount: number
}

export type TrackChannelRole = 'track' | 'group' | 'return'

export type TrackRouting = {
  outputTargetId?: TrackId
  sends?: TrackSend[]
}

type ClipRuntimeFields<TBuffer> = [TBuffer] extends [never]
  ? unknown
  : { buffer?: TBuffer | null }

export type Clip<TBuffer = never> = {
  id: string
  historyRef?: string
  name: string
  mediaStatus?: 'missing' | 'permission-denied'
  startSec: number
  duration: number
  sourceAssetKey?: string
  waveformAssetKey?: string
  sourceKind?: AudioSourceKind
  sourceDurationSec?: number
  sourceSampleRate?: number
  sourceChannelCount?: number
  leftPadSec?: number
  bufferOffsetSec?: number
  color: string
  sampleUrl?: string
  midi?: {
    wave: 'sine' | 'square' | 'sawtooth' | 'triangle'
    gain?: number
    notes: { beat: number; length: number; pitch: number; velocity?: number }[]
  }
  midiOffsetBeats?: number
} & ClipRuntimeFields<TBuffer>

export type Track<TBuffer = never> = {
  id: TrackId
  historyRef?: string
  name: string
  volume: number
  clips: Clip<TBuffer>[]
  muted?: boolean
  soloed?: boolean
  lockedBy?: string | null
  lockedAt?: number | null
  kind?: 'audio' | 'instrument'
  channelRole?: TrackChannelRole
  outputTargetId?: TrackId
  sends?: TrackSend[]
}

export type SelectedClip = {
  trackId: TrackId
  clipId: string
} | null
