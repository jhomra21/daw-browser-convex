export type Clip = {
  id: string
  name: string
  buffer?: AudioBuffer | null
  startSec: number
  duration: number
  /** Seconds of silence before audio begins within the clip window */
  leftPadSec?: number
  color: string
  sampleUrl?: string
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
}

export type SelectedClip = {
  trackId: string
  clipId: string
} | null