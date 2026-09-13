export const MAX_WAVEFORM_RASTER_WIDTH_PX = 4_096
export const MAX_WAVEFORM_BACKING_PIXELS = 2_000_000

export const normalizedWaveformDevicePixelRatio = (value: number) => (
  Number.isFinite(value) ? Math.min(3, Math.max(1, value)) : 1
)

export const boundedWaveformRasterWidth = (widthPx: number) => Math.max(
  1,
  Math.min(MAX_WAVEFORM_RASTER_WIDTH_PX, Math.ceil(widthPx)),
)

export const waveformCanvasSize = (input: {
  cssWidthPx: number
  cssHeightPx: number
  devicePixelRatio: number
}) => {
  const dpr = normalizedWaveformDevicePixelRatio(input.devicePixelRatio)
  const cssWidthPx = boundedWaveformRasterWidth(input.cssWidthPx)
  const cssHeightPx = Math.max(1, Math.ceil(input.cssHeightPx))
  const requestedBackingWidthPx = Math.max(1, Math.ceil(cssWidthPx * dpr))
  const maxBackingWidthPx = Math.max(
    1,
    Math.floor(MAX_WAVEFORM_BACKING_PIXELS / (cssHeightPx * dpr * dpr)),
  )
  const backingWidthPx = Math.min(requestedBackingWidthPx, maxBackingWidthPx)
  return {
    cssWidthPx,
    cssHeightPx,
    backingWidthPx,
    backingHeightPx: Math.max(1, Math.floor(cssHeightPx * dpr)),
    dpr,
    contextScaleX: backingWidthPx / cssWidthPx,
    contextScaleY: Math.max(1, Math.floor(cssHeightPx * dpr)) / cssHeightPx,
  }
}
