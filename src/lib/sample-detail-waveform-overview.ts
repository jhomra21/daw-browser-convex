import {
  panSampleDetailWaveformViewport,
  type SampleDetailWaveformViewport,
} from './sample-detail-waveform-viewport'

type OverviewViewportRectInput = {
  viewport: SampleDetailWaveformViewport
  clipDurationSec: number
  widthPx: number
}

const isPositiveFinite = (value: number) => Number.isFinite(value) && value > 0

export function getSampleDetailWaveformOverviewViewportRect(input: OverviewViewportRectInput) {
  if (!isPositiveFinite(input.clipDurationSec)
    || !isPositiveFinite(input.widthPx)
    || !Number.isFinite(input.viewport.startSec)
    || !Number.isFinite(input.viewport.endSec)
    || input.viewport.endSec < input.viewport.startSec) {
    return { leftPx: 0, widthPx: 0 }
  }

  const startFraction = Math.max(0, Math.min(1, input.viewport.startSec / input.clipDurationSec))
  const endFraction = Math.max(startFraction, Math.min(1, input.viewport.endSec / input.clipDurationSec))
  return {
    leftPx: startFraction * input.widthPx,
    widthPx: (endFraction - startFraction) * input.widthPx,
  }
}

export function getSampleDetailWaveformOverviewGrabOffset(
  viewport: SampleDetailWaveformViewport,
  pointerSec: number,
) {
  const durationSec = viewport.endSec - viewport.startSec
  if (!Number.isFinite(pointerSec) || !isPositiveFinite(durationSec)) return 0
  if (pointerSec >= viewport.startSec && pointerSec <= viewport.endSec) {
    return pointerSec - viewport.startSec
  }
  return durationSec / 2
}

export function moveSampleDetailWaveformOverviewViewport(input: {
  viewport: SampleDetailWaveformViewport
  clipDurationSec: number
  sampleRate: number
  pointerSec: number
  grabOffsetSec: number
}) {
  if (!Number.isFinite(input.pointerSec)
    || !Number.isFinite(input.grabOffsetSec)
    || !isPositiveFinite(input.clipDurationSec)
    || !isPositiveFinite(input.sampleRate)
    || !Number.isFinite(input.viewport.startSec)
    || !Number.isFinite(input.viewport.endSec)
    || input.viewport.endSec <= input.viewport.startSec) {
    return input.viewport
  }
  const requestedStartSec = input.pointerSec - input.grabOffsetSec
  return panSampleDetailWaveformViewport({
    viewport: input.viewport,
    clipDurationSec: input.clipDurationSec,
    sampleRate: input.sampleRate,
    deltaSec: requestedStartSec - input.viewport.startSec,
  })
}
