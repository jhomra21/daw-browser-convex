export type SampleDetailWaveformViewport = {
  startSec: number
  endSec: number
}

type ViewportBounds = {
  clipDurationSec: number
  sampleRate: number
}

const isPositiveFinite = (value: number) => Number.isFinite(value) && value > 0
const clampUnit = (value: number) => Math.max(0, Math.min(1, value))

export function fitSampleDetailWaveformViewport(clipDurationSec: number): SampleDetailWaveformViewport {
  return {
    startSec: 0,
    endSec: Math.max(0, Number.isFinite(clipDurationSec) ? clipDurationSec : 0),
  }
}

export function clampSampleDetailWaveformViewport(
  viewport: SampleDetailWaveformViewport,
  bounds: ViewportBounds,
): SampleDetailWaveformViewport {
  if (!isPositiveFinite(bounds.clipDurationSec) || !isPositiveFinite(bounds.sampleRate)) {
    return fitSampleDetailWaveformViewport(bounds.clipDurationSec)
  }

  const minimumDurationSec = Math.min(bounds.clipDurationSec, 2 / bounds.sampleRate)
  const requestedDurationSec = viewport.endSec - viewport.startSec
  const durationSec = Math.max(
    minimumDurationSec,
    Math.min(
      bounds.clipDurationSec,
      Number.isFinite(requestedDurationSec) && requestedDurationSec > 0
        ? requestedDurationSec
        : bounds.clipDurationSec,
    ),
  )
  const requestedStartSec = Number.isFinite(viewport.startSec) ? viewport.startSec : 0
  const startSec = Math.max(0, Math.min(bounds.clipDurationSec - durationSec, requestedStartSec))
  return { startSec, endSec: startSec + durationSec }
}

export function zoomSampleDetailWaveformViewport(input: {
  viewport: SampleDetailWaveformViewport
  clipDurationSec: number
  sampleRate: number
  anchorFraction: number
  zoomFactor: number
}): SampleDetailWaveformViewport {
  const current = clampSampleDetailWaveformViewport(input.viewport, input)
  if (!isPositiveFinite(input.zoomFactor)) return current

  const anchorFraction = clampUnit(input.anchorFraction)
  const currentDurationSec = current.endSec - current.startSec
  const anchorSec = current.startSec + currentDurationSec * anchorFraction
  const nextDurationSec = currentDurationSec / input.zoomFactor
  return clampSampleDetailWaveformViewport({
    startSec: anchorSec - nextDurationSec * anchorFraction,
    endSec: anchorSec + nextDurationSec * (1 - anchorFraction),
  }, input)
}

export function panSampleDetailWaveformViewport(input: {
  viewport: SampleDetailWaveformViewport
  clipDurationSec: number
  sampleRate: number
  deltaSec: number
}): SampleDetailWaveformViewport {
  const current = clampSampleDetailWaveformViewport(input.viewport, input)
  if (!Number.isFinite(input.deltaSec) || input.deltaSec === 0) return current
  return clampSampleDetailWaveformViewport({
    startSec: current.startSec + input.deltaSec,
    endSec: current.endSec + input.deltaSec,
  }, input)
}

export function sampleDetailWaveformTimeAtX(input: {
  viewport: SampleDetailWaveformViewport
  xPx: number
  widthPx: number
}) {
  const fraction = input.widthPx > 0 && Number.isFinite(input.widthPx)
    ? clampUnit(input.xPx / input.widthPx)
    : 0
  return input.viewport.startSec + (input.viewport.endSec - input.viewport.startSec) * fraction
}

export function sampleDetailWaveformXAtTime(input: {
  viewport: SampleDetailWaveformViewport
  timeSec: number
  widthPx: number
}) {
  const durationSec = input.viewport.endSec - input.viewport.startSec
  if (!isPositiveFinite(durationSec) || !isPositiveFinite(input.widthPx)) return 0
  return ((input.timeSec - input.viewport.startSec) / durationSec) * input.widthPx
}
