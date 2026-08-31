import {
  clampSampleDetailWaveformViewport,
  type SampleDetailWaveformViewport,
} from './sample-detail-waveform-viewport'

export type SampleDetailWaveformSelection = {
  startSec: number
  endSec: number
}

export type SampleDetailWaveformSelectionRect = {
  leftPx: number
  widthPx: number
}

type SelectionViewportInput = {
  selection: SampleDetailWaveformSelection
  clipDurationSec: number
  sampleRate: number
}

const isPositiveFinite = (value: number) => Number.isFinite(value) && value > 0
const sameViewport = (a: SampleDetailWaveformViewport, b: SampleDetailWaveformViewport) => (
  a.startSec === b.startSec && a.endSec === b.endSec
)

export function createSampleDetailWaveformSelection(input: {
  anchorSec: number
  focusSec: number
  clipDurationSec: number
}): SampleDetailWaveformSelection | null {
  if (!isPositiveFinite(input.clipDurationSec)
    || !Number.isFinite(input.anchorSec)
    || !Number.isFinite(input.focusSec)) return null

  const anchorSec = Math.max(0, Math.min(input.clipDurationSec, input.anchorSec))
  const focusSec = Math.max(0, Math.min(input.clipDurationSec, input.focusSec))
  const startSec = Math.min(anchorSec, focusSec)
  const endSec = Math.max(anchorSec, focusSec)
  return endSec > startSec ? { startSec, endSec } : null
}

export function getSampleDetailWaveformSelectionRect(input: {
  selection: SampleDetailWaveformSelection
  viewport: SampleDetailWaveformViewport
  widthPx: number
}): SampleDetailWaveformSelectionRect | null {
  const viewportDurationSec = input.viewport.endSec - input.viewport.startSec
  if (!isPositiveFinite(viewportDurationSec)
    || !isPositiveFinite(input.widthPx)
    || !Number.isFinite(input.selection.startSec)
    || !Number.isFinite(input.selection.endSec)
    || input.selection.endSec <= input.selection.startSec) return null

  const visibleStartSec = Math.max(input.viewport.startSec, input.selection.startSec)
  const visibleEndSec = Math.min(input.viewport.endSec, input.selection.endSec)
  if (visibleEndSec <= visibleStartSec) return null

  const leftPx = ((visibleStartSec - input.viewport.startSec) / viewportDurationSec) * input.widthPx
  const rightPx = ((visibleEndSec - input.viewport.startSec) / viewportDurationSec) * input.widthPx
  return {
    leftPx,
    widthPx: Math.max(0, rightPx - leftPx),
  }
}

export function getSampleDetailWaveformSelectionViewport(
  input: SelectionViewportInput,
): SampleDetailWaveformViewport | null {
  if (!isPositiveFinite(input.clipDurationSec)
    || !isPositiveFinite(input.sampleRate)
    || !Number.isFinite(input.selection.startSec)
    || !Number.isFinite(input.selection.endSec)
    || input.selection.endSec <= input.selection.startSec) return null

  const startSec = Math.max(0, Math.min(input.clipDurationSec, input.selection.startSec))
  const endSec = Math.max(startSec, Math.min(input.clipDurationSec, input.selection.endSec))
  if (endSec <= startSec) return null

  const minimumDurationSec = Math.min(input.clipDurationSec, 2 / input.sampleRate)
  const selectedDurationSec = endSec - startSec
  const durationSec = Math.max(minimumDurationSec, selectedDurationSec)
  const centerSec = startSec + selectedDurationSec / 2
  return clampSampleDetailWaveformViewport({
    startSec: centerSec - durationSec / 2,
    endSec: centerSec + durationSec / 2,
  }, input)
}

export function pushSampleDetailWaveformViewportHistory(
  history: readonly SampleDetailWaveformViewport[],
  viewport: SampleDetailWaveformViewport,
) {
  if (!Number.isFinite(viewport.startSec)
    || !Number.isFinite(viewport.endSec)
    || viewport.endSec <= viewport.startSec) return [...history]
  const previous = history[history.length - 1]
  return previous && sameViewport(previous, viewport)
    ? [...history]
    : [...history, viewport]
}

export function popSampleDetailWaveformViewportHistory(
  history: readonly SampleDetailWaveformViewport[],
): {
  history: SampleDetailWaveformViewport[]
  viewport?: SampleDetailWaveformViewport
} {
  const viewport = history[history.length - 1]
  if (!viewport) return { history: [] }
  return {
    history: history.slice(0, -1),
    viewport,
  }
}
