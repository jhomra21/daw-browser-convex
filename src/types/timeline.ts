import type { AudioSourceKind } from '~/lib/audio-source'

export type TrackSend = {
  targetId: string
  amount: number
}

export type TrackChannelRole = 'track' | 'group' | 'return'

export type TrackRouting = {
  outputTargetId?: string
  sends?: TrackSend[]
}

export type Clip = {
  id: string
  historyRef?: string
  name: string
  buffer?: AudioBuffer | null
  startSec: number
  duration: number
  sourceAssetKey?: string
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
}

export type Track = {
  id: string
  historyRef?: string
  name: string
  volume: number
  clips: Clip[]
  muted?: boolean
  soloed?: boolean
  lockedBy?: string | null
  lockedAt?: number | null
  kind?: 'audio' | 'instrument'
  channelRole?: TrackChannelRole
  outputTargetId?: string
  sends?: TrackSend[]
}

export type SelectedClip = {
  trackId: string
  clipId: string
} | null
