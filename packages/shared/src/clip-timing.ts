type ClipTimingPatchInput = {
  startSec: number
  duration: number
  leftPadSec?: number
  bufferOffsetSec?: number
  midiOffsetBeats?: number
}

type NormalizedClipTimingPatch = {
  startSec: number
  duration: number
  leftPadSec?: number
  bufferOffsetSec?: number
  midiOffsetBeats?: number
}

export function normalizeClipStartSec(startSec: number): number {
  if (!Number.isFinite(startSec)) return 0
  return Math.max(0, startSec)
}

function normalizeClipOffset(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, value)
}

export function normalizeClipTimingPatch(input: ClipTimingPatchInput): NormalizedClipTimingPatch {
  return {
    startSec: normalizeClipStartSec(input.startSec),
    duration: normalizeClipStartSec(input.duration),
    leftPadSec: normalizeClipOffset(input.leftPadSec),
    bufferOffsetSec: normalizeClipOffset(input.bufferOffsetSec),
    midiOffsetBeats: normalizeClipOffset(input.midiOffsetBeats),
  }
}
