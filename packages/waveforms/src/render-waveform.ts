import { decodePeakByte } from './extract-peaks'
import type { WaveformDrawOptions, WaveformSampleDrawOptions } from './types'

const DEFAULT_MAX_HEIGHT_FRACTION = 0.9
const DEFAULT_SAMPLE_POINT_RADIUS_PX = 1.75

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
    drawBoundary = true,
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
  if (drawBoundary && cssW > audioEndX && audioEndX >= 0) {
    ctx.strokeStyle = boundaryStyle
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(audioEndX + 0.5, 0)
    ctx.lineTo(audioEndX + 0.5, cssH)
    ctx.stroke()
  }
}

function normalizeVerticalZoom(value: number | undefined) {
  if (value === undefined) return 1
  if (!Number.isFinite(value)) return 1
  return Math.max(0, Math.min(32, value))
}

function sampleY(value: number, centerY: number, halfHeight: number, verticalZoom: number) {
  const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0
  const unclamped = centerY - sample * halfHeight * verticalZoom
  return Math.max(centerY - halfHeight, Math.min(centerY + halfHeight, unclamped))
}

export function drawWaveformSamples(options: WaveformSampleDrawOptions) {
  const {
    ctx,
    samples,
    padPx,
    topY,
    contentH,
    cssW,
    strokeStyle = 'rgba(255,255,255,0.75)',
    pointStyle = strokeStyle,
    lineWidth = 1,
    showPoints = false,
    pointRadiusPx = DEFAULT_SAMPLE_POINT_RADIUS_PX,
  } = options
  if (samples.channels.length === 0
    || !Number.isFinite(samples.sampleRate) || samples.sampleRate <= 0
    || !Number.isFinite(samples.sourceStartSec)
    || !Number.isFinite(samples.sourceEndSec)
    || samples.sourceEndSec <= samples.sourceStartSec
    || !Number.isFinite(contentH) || contentH <= 0
    || !Number.isFinite(cssW) || cssW <= 0) return

  const verticalZoom = normalizeVerticalZoom(options.verticalZoom)
  const channelHeight = contentH / samples.channels.length
  const legacyStart = padPx
  const legacyWidth = Math.max(0, cssW - padPx * 2)
  const drawStart = options.drawStartPx === undefined
    ? legacyStart
    : Math.max(0, Math.min(cssW, options.drawStartPx))
  const requestedDrawWidth = options.drawWidthPx === undefined ? legacyWidth : options.drawWidthPx
  const drawWidth = Number.isFinite(requestedDrawWidth)
    ? Math.max(0, Math.min(cssW - drawStart, requestedDrawWidth))
    : 0
  const durationSec = samples.sourceEndSec - samples.sourceStartSec
  const pointRadius = Number.isFinite(pointRadiusPx) ? Math.max(0.5, Math.min(4, pointRadiusPx)) : DEFAULT_SAMPLE_POINT_RADIUS_PX
  if (drawWidth <= 0) return

  const position = (frameOffset: number, channelIndex: number, value: number) => {
    const frame = samples.firstFrame + frameOffset
    const timestamp = frame / samples.sampleRate
    if (timestamp < samples.sourceStartSec || timestamp > samples.sourceEndSec) return null
    const x = drawStart + ((timestamp - samples.sourceStartSec) / durationSec) * drawWidth
    const channelTop = topY + channelIndex * channelHeight
    const centerY = channelTop + channelHeight / 2
    const progress = (timestamp - samples.sourceStartSec) / durationSec
    const amplitudeScale = options.amplitudeScaleAtProgress?.(Math.max(0, Math.min(1, progress))) ?? 1
    return {
      x,
      y: sampleY(value * Math.max(0, Math.min(1, amplitudeScale)), centerY, channelHeight / 2, verticalZoom),
    }
  }

  ctx.strokeStyle = strokeStyle
  ctx.lineWidth = Number.isFinite(lineWidth) ? Math.max(0.5, Math.min(4, lineWidth)) : 1
  for (let channelIndex = 0; channelIndex < samples.channels.length; channelIndex += 1) {
    const channel = samples.channels[channelIndex]
    if (!channel || channel.length === 0) continue

    let started = false
    ctx.beginPath()
    for (let frameOffset = 0; frameOffset < channel.length; frameOffset += 1) {
      const point = position(frameOffset, channelIndex, channel[frameOffset] ?? 0)
      if (!point) continue
      if (started) ctx.lineTo(point.x, point.y)
      else {
        ctx.moveTo(point.x, point.y)
        started = true
      }
    }
    if (started) ctx.stroke()

    if (!showPoints) continue
    ctx.fillStyle = pointStyle
    ctx.beginPath()
    for (let frameOffset = 0; frameOffset < channel.length; frameOffset += 1) {
      const point = position(frameOffset, channelIndex, channel[frameOffset] ?? 0)
      if (!point) continue
      ctx.moveTo(point.x + pointRadius, point.y)
      ctx.arc(point.x, point.y, pointRadius, 0, Math.PI * 2)
    }
    ctx.fill()
  }
}
