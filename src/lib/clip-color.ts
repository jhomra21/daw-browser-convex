import type { Clip } from '@daw-browser/timeline-core/types'

export const getDefaultClipColor = (clip: Pick<Clip, "sourceKind" | "midi">) => {
  if (clip.sourceKind === "recording") return "clip-recording"
  return clip.midi ? "clip-midi" : "clip-audio"
}
