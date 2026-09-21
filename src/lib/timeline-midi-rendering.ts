export const getVisibleMidiBarIndices = (input: {
  clipDurationSec: number
  windowStartSec: number
  windowEndSec: number
  barDurationSec: number
}) => {
  if (!Number.isFinite(input.clipDurationSec)
    || !Number.isFinite(input.windowStartSec)
    || !Number.isFinite(input.windowEndSec)
    || !Number.isFinite(input.barDurationSec)
    || input.clipDurationSec <= 0
    || input.windowEndSec <= input.windowStartSec
    || input.barDurationSec <= 0) return null
  const firstBar = Math.max(1, Math.ceil(input.windowStartSec / input.barDurationSec - 1e-9))
  const lastBar = Math.min(
    Math.floor(input.clipDurationSec / input.barDurationSec + 1e-9),
    Math.floor(input.windowEndSec / input.barDurationSec + 1e-9),
  )
  return lastBar >= firstBar ? { firstBar, lastBar } : null
}

export const getVisibleMidiNoteProjection = (input: {
  noteBeat: number
  noteLength: number
  midiOffsetBeats: number
  secondsPerBeat: number
  windowStartSec: number
  windowEndSec: number
}) => {
  const trimmedBeats = Math.max(0, input.midiOffsetBeats - input.noteBeat)
  const effectiveLength = Math.max(0, input.noteLength - trimmedBeats)
  if (effectiveLength <= 0) return null
  const startSec = Math.max(0, input.noteBeat - input.midiOffsetBeats) * input.secondsPerBeat
  const endSec = startSec + effectiveLength * input.secondsPerBeat
  if (endSec <= input.windowStartSec || startSec >= input.windowEndSec) return null
  return { startSec, endSec }
}
