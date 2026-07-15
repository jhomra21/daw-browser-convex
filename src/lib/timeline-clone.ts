import type { Clip, Track } from '@daw-browser/timeline-core/types'

export const cloneTimelineClip = (clip: Clip): Clip => ({
  ...clip,
  fades: clip.fades ? { ...clip.fades } : undefined,
  midi: clip.midi
    ? {
        ...clip.midi,
        notes: clip.midi.notes.map((note) => ({ ...note })),
      }
    : undefined,
})

export const cloneTimelineTrack = (track: Track): Track => ({
  ...track,
  clips: track.clips.map(cloneTimelineClip),
  sends: track.sends?.map((send) => ({ ...send })),
})
