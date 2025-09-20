export type Clip = {
  id: string
  name: string
  buffer?: AudioBuffer | null
  startSec: number
  duration: number
  color: string
  sampleUrl?: string
}

export type Track = {
  id: string
  name: string
  volume: number
  clips: Clip[]
}

export type SelectedClip = {
  trackId: string
  clipId: string
} | null