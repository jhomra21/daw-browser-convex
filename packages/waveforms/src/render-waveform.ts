import { decodePeakByte } from './extract-peaks'
import type { WaveformDrawOptions } from './types'

const DEFAULT_MAX_HEIGHT_FRACTION = 0.36

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

  let peak = 0
  for (let i = 0; i < drawCols; i++) {
    const min = decodePeakByte(peaks[i * 2])
    const max = decodePeakByte(peaks[i * 2 + 1])
    const amplitude = Math.max(Math.abs(min), Math.abs(max))
    if (amplitude > peak) peak = amplitude
  }

  const halfH = contentH / 2
  const midY = topY + halfH
  const gain = peak > normalizedMaxHeightFraction
    ? normalizedMaxHeightFraction / peak
    : 1

  ctx.fillStyle = fillStyle
  for (let i = 0; i < drawCols; i++) {
    const min = decodePeakByte(peaks[i * 2])
    const max = decodePeakByte(peaks[i * 2 + 1])
    const amplitude = Math.max(Math.abs(min), Math.abs(max))
    const amplitudeScale = options.amplitudeScaleAtColumn?.(i) ?? 1
    const scale = Number.isFinite(amplitudeScale)
      ? Math.max(0, Math.min(1, amplitudeScale))
      : 0
    const halfHeight = Math.min(halfH, amplitude * scale * halfH * gain)
    if (halfHeight <= 0.35) continue
    const top = Math.max(topY, midY - halfHeight)
    const height = Math.min(contentH, Math.max(1, halfHeight * 2))
    ctx.fillRect(padPx + i, top, 1, height)
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
