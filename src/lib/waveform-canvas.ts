export const MAX_WAVEFORM_BACKING_PIXELS = 2_000_000

export const normalizedWaveformDevicePixelRatio = (value: number) => (
  Number.isFinite(value) ? Math.min(3, Math.max(1, value)) : 1
)

export const waveformCanvasSize = (input: {
  cssWidthPx: number
  cssHeightPx: number
  devicePixelRatio: number
}) => {
  const dpr = normalizedWaveformDevicePixelRatio(input.devicePixelRatio)
  const cssWidthPx = Math.max(1, Math.ceil(input.cssWidthPx))
  const cssHeightPx = Math.max(1, Math.ceil(input.cssHeightPx))
  const backingHeightPx = Math.max(1, Math.ceil(cssHeightPx * dpr))
  const requestedBackingWidthPx = Math.max(1, Math.ceil(cssWidthPx * dpr))
  const maxBackingWidthPx = Math.max(1, Math.floor(MAX_WAVEFORM_BACKING_PIXELS / backingHeightPx))
  const backingWidthPx = Math.min(requestedBackingWidthPx, maxBackingWidthPx)
  return {
    cssWidthPx,
    cssHeightPx,
    backingWidthPx,
    backingHeightPx,
    dpr,
    contextScaleX: backingWidthPx / cssWidthPx,
    contextScaleY: backingHeightPx / cssHeightPx,
  }
}
