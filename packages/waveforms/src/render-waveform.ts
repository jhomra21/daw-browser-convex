import { decodePeakByte } from './extract-peaks'
import type { WaveformDrawOptions, WaveformSampleChannelSlice } from './types'

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
    xOffsetPx = 0,
    opacity = 1,
  } = options
  if (opacity <= 0 || drawCols <= 0 || peaks.length < 2) return
  const normalizedMaxHeightFraction = Number.isFinite(maxHeightFraction)
    ? Math.max(0, Math.min(1, maxHeightFraction))
    : DEFAULT_MAX_HEIGHT_FRACTION
  const previousAlpha = ctx.globalAlpha ?? 1
  ctx.globalAlpha = previousAlpha * Math.max(0, Math.min(1, opacity))
  try {
    const halfH = contentH / 2
    const midY = topY + halfH
    ctx.fillStyle = fillStyle
    const sourceColumns = Math.floor(peaks.length / 2)
    if (sourceColumns <= 0) return
    for (let i = 0; i < drawCols; i++) {
      const sourceStart = Math.floor(i * sourceColumns / Math.max(1, drawCols))
      const sourceEnd = Math.max(
        sourceStart + 1,
        Math.ceil((i + 1) * sourceColumns / Math.max(1, drawCols)),
      )
      let min = Infinity
      let max = -Infinity
      for (let sourceColumn = sourceStart; sourceColumn < sourceEnd; sourceColumn += 1) {
        min = Math.min(min, decodePeakByte(peaks[sourceColumn * 2] ?? 128))
        max = Math.max(max, decodePeakByte(peaks[sourceColumn * 2 + 1] ?? 128))
      }
      const amplitude = Math.max(Math.abs(min), Math.abs(max))
      const amplitudeScale = options.amplitudeScaleAtColumn?.(i) ?? 1
      const scale = Number.isFinite(amplitudeScale)
        ? Math.max(0, Math.min(1, amplitudeScale))
        : 0
      const halfHeight = Math.min(
        halfH,
        amplitude * scale * halfH * normalizedMaxHeightFraction,
      )
      if (halfHeight <= 0.35) continue
      const top = Math.max(topY, midY - halfHeight)
      const height = Math.min(contentH, Math.max(1, halfHeight * 2))
      ctx.fillRect(xOffsetPx + padPx + i, top, 1, height)
    }

    const audioEndX = Math.min(cssW, xOffsetPx + padPx + drawCols)
    if (options.drawBoundary !== false && cssW > audioEndX && audioEndX >= 0) {
      ctx.strokeStyle = boundaryStyle
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(audioEndX + 0.5, 0)
      ctx.lineTo(audioEndX + 0.5, cssH)
      ctx.stroke()
    }
  } finally {
    ctx.globalAlpha = previousAlpha
  }
}

export function drawWaveformPcmLine(options: {
  ctx: Pick<CanvasRenderingContext2D, 'strokeStyle' | 'fillStyle' | 'lineWidth' | 'beginPath' | 'moveTo' | 'lineTo' | 'stroke' | 'fillRect' | 'arc' | 'fill'> & { globalAlpha?: number }
  pcm: WaveformSampleChannelSlice
  topY: number
  contentH: number
  cssW: number
  fillStyle?: string
  pointRadius?: number
  lineOpacity?: number
  pointOpacity?: number
  maxHeightFraction?: number
  xOffsetPx?: number
  amplitudeScaleAtSample?: (index: number) => number
}) {
  const {
    ctx,
    pcm,
    topY,
    contentH,
    cssW,
    fillStyle = 'rgba(255,255,255,0.55)',
    xOffsetPx = 0,
  } = options
  const lineOpacity = Math.max(0, Math.min(1, options.lineOpacity ?? 1))
  const pointOpacity = Math.max(0, Math.min(1, options.pointOpacity ?? 0))
  const pointRadius = Math.max(0, options.pointRadius ?? 0)
  if (cssW <= 0 || pcm.channels.length === 0 || (lineOpacity <= 0 && (pointOpacity <= 0 || pointRadius <= 0))) return
  const laneHeight = contentH / Math.max(1, pcm.channels.length)
  const maxHeightFraction = Number.isFinite(options.maxHeightFraction)
    ? Math.max(0, Math.min(1, options.maxHeightFraction ?? 0.9))
    : 0.9
  const durationSec = pcm.sourceEndSec - pcm.sourceStartSec
  const previousAlpha = ctx.globalAlpha ?? 1
  try {
    if (lineOpacity > 0) {
      ctx.globalAlpha = previousAlpha * lineOpacity
      for (const [channelIndex, samples] of pcm.channels.entries()) {
        if (samples.length === 0) continue
        const midY = topY + laneHeight * (channelIndex + 0.5)
        const amplitude = laneHeight * maxHeightFraction / 2
        ctx.strokeStyle = fillStyle
        ctx.lineWidth = 1
        ctx.beginPath()
        for (let index = 0; index < samples.length; index += 1) {
          const sampleTimeSec = (pcm.firstFrame + index) / pcm.sampleRate
          const progress = durationSec > 0
            ? (sampleTimeSec - pcm.sourceStartSec) / durationSec
            : 0
          const x = xOffsetPx + Math.max(0, Math.min(1, progress)) * cssW
          const scale = Math.max(0, Math.min(1, options.amplitudeScaleAtSample?.(index) ?? 1))
          const y = midY - Math.max(-1, Math.min(1, samples[index] ?? 0)) * amplitude * scale
          if (index === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
    }

    if (pointOpacity > 0 && pointRadius > 0) {
      ctx.globalAlpha = previousAlpha * pointOpacity
      for (const [channelIndex, samples] of pcm.channels.entries()) {
        if (samples.length === 0) continue
        const midY = topY + laneHeight * (channelIndex + 0.5)
        const amplitude = laneHeight * maxHeightFraction / 2
        ctx.fillStyle = fillStyle
        for (let index = 0; index < samples.length; index += 1) {
          const sampleTimeSec = (pcm.firstFrame + index) / pcm.sampleRate
          const progress = durationSec > 0
            ? (sampleTimeSec - pcm.sourceStartSec) / durationSec
            : 0
          const x = xOffsetPx + Math.max(0, Math.min(1, progress)) * cssW
          const scale = Math.max(0, Math.min(1, options.amplitudeScaleAtSample?.(index) ?? 1))
          const y = midY - Math.max(-1, Math.min(1, samples[index] ?? 0)) * amplitude * scale
          ctx.beginPath()
          ctx.arc(x, y, pointRadius, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
  } finally {
    ctx.globalAlpha = previousAlpha
  }
}
