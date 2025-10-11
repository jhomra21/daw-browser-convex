export type ClipTiming = {
  startSec: number
  duration: number
  leftPadSec?: number
  bufferOffsetSec?: number
  midiOffsetBeats?: number
}

export type ClipSnapshot = {
  startSec: number
  duration: number
  name?: string
  sampleUrl?: string
  midi?: any
  timing?: ClipTiming
}

export type HistoryEntry =
  | {
      type: 'clip-create'
      roomId: string
      data: {
        trackId: string
        clip: {
          originalId: string
          currentId?: string
          startSec: number
          duration: number
          name?: string
          sampleUrl?: string
          midi?: any
          timing?: ClipTiming
        }
      }
    }
  | {
      type: 'clip-delete'
      roomId: string
      data: {
        items: Array<{ trackId: string; clip: ClipSnapshot }>
        recreatedClipIds?: string[]
        // Backwards compatibility for pre-multi-track undo entries
        trackId?: string
        clips?: ClipSnapshot[]
      }
    }
  | {
      type: 'clips-move'
      roomId: string
      data: {
        moves: Array<{
          clipId: string
          from: { trackId: string; startSec: number }
          to: { trackId: string; startSec: number }
        }>
      }
    }
  | {
      type: 'clip-timing'
      roomId: string
      data: {
        clipId: string
        from: ClipTiming
        to: ClipTiming
      }
    }
  | {
      type: 'track-create'
      roomId: string
      data: { trackId: string; kind?: 'audio' | 'instrument' }
    }
  | {
      type: 'track-delete'
      roomId: string
      data: {
        track: { id: string; name: string; volume: number; muted?: boolean; soloed?: boolean; kind?: 'audio' | 'instrument' }
        clips: ClipSnapshot[]
        effects?: { eq?: any; reverb?: any; synth?: any; arp?: any }
        recreatedTrackId?: string
        recreatedClipIds?: string[]
      }
    }
  | {
      type: 'track-volume'
      roomId: string
      data: { trackId: string; from: number; to: number }
    }
  | {
      type: 'track-mute'
      roomId: string
      data: { trackId: string; from: boolean; to: boolean }
    }
  | {
      type: 'track-solo'
      roomId: string
      data: { trackId: string; from: boolean; to: boolean }
    }
  | {
      type: 'effect-params'
      roomId: string
      data: {
        targetId: string // 'master' or trackId
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
