import type { Clip, Track } from '~/types/timeline'

export const cloneTimelineClip = (clip: Clip): Clip => ({
  ...clip,
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
