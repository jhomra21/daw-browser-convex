import { decodePeakByte } from '~/lib/audio-peaks/extract-peaks'
import type { WaveformDrawOptions } from '~/lib/audio-peaks/types'

const MAX_HALF_HEIGHT_FRACTION = 0.36

export function drawWaveformPeaks(options: WaveformDrawOptions) {
  const { ctx, peaks, drawCols, padPx, topY, contentH, cssW, cssH } = options

  let peak = 0
  for (let i = 0; i < drawCols; i++) {
    const min = decodePeakByte(peaks[i * 2])
    const max = decodePeakByte(peaks[i * 2 + 1])
    const amplitude = Math.max(Math.abs(min), Math.abs(max))
    if (amplitude > peak) peak = amplitude
  }

  const halfH = contentH / 2
  const midY = topY + halfH
  const gain = peak > MAX_HALF_HEIGHT_FRACTION ? (MAX_HALF_HEIGHT_FRACTION / peak) : 1

  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  for (let i = 0; i < drawCols; i++) {
    const min = decodePeakByte(peaks[i * 2])
    const max = decodePeakByte(peaks[i * 2 + 1])
    const amplitude = Math.max(Math.abs(min), Math.abs(max))
    const halfHeight = Math.min(halfH, amplitude * halfH * gain)
    if (halfHeight <= 0.35) continue
    const top = Math.max(topY, midY - halfHeight)
    const height = Math.min(contentH, Math.max(1, halfHeight * 2))
    ctx.fillRect(padPx + i, top, 1, height)
  }

  const audioEndX = Math.min(cssW, padPx + drawCols)
  if (cssW > audioEndX && audioEndX >= 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(audioEndX + 0.5, 0)
    ctx.lineTo(audioEndX + 0.5, cssH)
    ctx.stroke()
  }
}
