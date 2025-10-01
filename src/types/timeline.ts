export type Clip = {
  id: string
  name: string
  buffer?: AudioBuffer | null
  startSec: number
  duration: number
  /** Seconds of silence before audio begins within the clip window */
  leftPadSec?: number
  /** Seconds to skip from the start of the audio buffer when playing this clip */
  bufferOffsetSec?: number
  color: string
  sampleUrl?: string
  /** Present when this is a MIDI clip (instrument-generated, not audio sample) */
  midi?: {
    wave: 'sine' | 'square' | 'sawtooth' | 'triangle'
    gain?: number
    notes: { beat: number; length: number; pitch: number; velocity?: number }[]
  }
  /** For MIDI clips, number of beats to offset the internal content when trimming from the left */
  midiOffsetBeats?: number
}

export type Track = {
  id: string
  name: string
  volume: number
  clips: Clip[]
  /** Local-only mute toggle (not persisted) */
  muted?: boolean
  /** Local-only solo toggle (not persisted) */
  soloed?: boolean
  /** If present, track is locked for editing by the referenced user */
  lockedBy?: string | null
  lockedAt?: number | null
  /** Optional track kind, defaults to 'audio'. When 'instrument', only MIDI clips are allowed. */
  kind?: 'audio' | 'instrument'
}

export type SelectedClip = {
  trackId: string
  clipId: string
} | null