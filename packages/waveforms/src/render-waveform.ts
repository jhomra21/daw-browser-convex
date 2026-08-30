import { decodePeakByte } from './extract-peaks'
import type { WaveformDrawOptions } from './types'

const DEFAULT_MAX_HEIGHT_FRACTION = 0.9

export function drawWaveformPeaks(options: WaveformDrawOptions) {
  const {
    ctx,
    peaks,
    drawCols,
    padPx,
    topY,
    contentH,
    cssW,
    cssH,
    fillStyle = 'rgba(255,255,255,0.55)',
    boundaryStyle = 'rgba(255,255,255,0.35)',
    maxHeightFraction = DEFAULT_MAX_HEIGHT_FRACTION,
  } = options
  const normalizedMaxHeightFraction = Number.isFinite(maxHeightFraction)
    ? Math.max(0, Math.min(1, maxHeightFraction))
    : DEFAULT_MAX_HEIGHT_FRACTION

  const halfH = contentH / 2
  const midY = topY + halfH

  ctx.fillStyle = fillStyle
  for (let i = 0; i < drawCols; i++) {
    const amplitudeScale = options.amplitudeScaleAtColumn?.(i) ?? 1
    const columnScale = Number.isFinite(amplitudeScale)
      ? Math.max(0, Math.min(1, amplitudeScale))
      : 0
    if (columnScale === 0 || normalizedMaxHeightFraction === 0) continue

    const min = decodePeakByte(peaks[i * 2]) * columnScale * normalizedMaxHeightFraction
    const max = decodePeakByte(peaks[i * 2 + 1]) * columnScale * normalizedMaxHeightFraction
    if (min === 0 && max === 0) continue

    const upper = Math.max(min, max)
    const lower = Math.min(min, max)
    const rangeTop = Math.max(topY, Math.min(topY + contentH, midY - upper * halfH))
    const rangeBottom = Math.max(topY, Math.min(topY + contentH, midY - lower * halfH))
    const height = Math.max(1, rangeBottom - rangeTop)
    ctx.fillRect(padPx + i, rangeTop, 1, height)
  }

  const audioEndX = Math.min(cssW, padPx + drawCols)
  if (cssW > audioEndX && audioEndX >= 0) {
    ctx.strokeStyle = boundaryStyle
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(audioEndX + 0.5, 0)
    ctx.lineTo(audioEndX + 0.5, cssH)
    ctx.stroke()
  }
}
