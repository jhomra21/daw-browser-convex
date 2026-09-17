import { decodePeakByte } from './extract-peaks'
import type {
  WaveformPaintSegment,
  WaveformPainterContext,
  WaveformSourceData,
} from './types'

const DEFAULT_MAX_HEIGHT = 0.9
const DEFAULT_FILL_STYLE = 'rgba(255,255,255,0.55)'
export const MINIMUM_WAVEFORM_BACKING_THICKNESS_PX = 2

export const minimumWaveformThicknessCssPx = (backingScaleY: number) => (
  MINIMUM_WAVEFORM_BACKING_THICKNESS_PX
    / (Number.isFinite(backingScaleY) && backingScaleY > 0 ? backingScaleY : 1)
)

export const waveformSampleY = (input: {
  readonly sample: number
  readonly topY: number
  readonly contentH: number
  readonly maxHeightFraction?: number
  readonly amplitudeScale?: number
}) => {
  const maxHeight = Number.isFinite(input.maxHeightFraction)
    ? Math.max(0, Math.min(1, input.maxHeightFraction ?? DEFAULT_MAX_HEIGHT))
    : DEFAULT_MAX_HEIGHT
  const scale = Number.isFinite(input.amplitudeScale)
    ? Math.max(0, Math.min(1, input.amplitudeScale ?? 1))
    : 1
  return input.topY + input.contentH / 2
    - Math.max(-1, Math.min(1, input.sample))
      * input.contentH / 2 * maxHeight * scale
}

export type WaveformRibbonGeometry = {
  readonly upperY: number
  readonly lowerY: number
  readonly centerY: number
  readonly thickness: number
}

type WaveformRibbonPoint = {
  readonly x0: number
  readonly x1: number
  readonly ribbon: WaveformRibbonGeometry
}

export const waveformRibbonGeometry = (input: {
  readonly upperY: number
  readonly lowerY: number
  readonly minimumThicknessCssPx: number
  readonly backingScaleY: number
}): WaveformRibbonGeometry => {
  const rawUpperY = Math.min(input.upperY, input.lowerY)
  const rawLowerY = Math.max(input.upperY, input.lowerY)
  const rawThickness = rawLowerY - rawUpperY
  const rawCenterY = (rawUpperY + rawLowerY) / 2
  const minimumThicknessCssPx = Math.max(0, input.minimumThicknessCssPx)
  const thickness = Math.max(rawThickness, minimumThicknessCssPx)
  return {
    upperY: rawCenterY - thickness / 2,
    lowerY: rawCenterY + thickness / 2,
    centerY: rawCenterY,
    thickness,
  }
}

const intervalValues = (data: WaveformSourceData, channel: number, index: number) => {
  if (data.kind === 'samples') {
    const value = data.channels[channel]?.[index] ?? 0
    return { min: value, max: value }
  }
  const values = data.channels[channel]
  if (!values) return { min: 0, max: 0 }
  if (data.encoding === 'signed-u8') {
    return {
      min: decodePeakByte(values[index * 2] ?? 128),
      max: decodePeakByte(values[index * 2 + 1] ?? 128),
    }
  }
  return {
    min: values[index * 2] ?? 0,
    max: values[index * 2 + 1] ?? 0,
  }
}

const sourceFrameFor = (data: WaveformSourceData, index: number) => (
  data.kind === 'samples'
    ? data.firstFrame + index
    : data.firstFrame + index * data.framesPerInterval
)

const sourceSpanFor = (data: WaveformSourceData) => (
  data.kind === 'samples' ? 1 : data.framesPerInterval
)

export function drawWaveformSignal(
  ctx: WaveformPainterContext,
  segment: WaveformPaintSegment,
) {
  const data = segment.data
  const pointRadius = segment.style?.pointRadius ?? 0
  const backingScaleY = Number.isFinite(segment.style?.backingScaleY)
    ? segment.style?.backingScaleY ?? 1
    : 1
  const minimumThicknessCssPx = Number.isFinite(segment.style?.minimumThicknessCssPx)
    ? Math.max(0, segment.style?.minimumThicknessCssPx ?? 0)
    : minimumWaveformThicknessCssPx(backingScaleY)
  const channelCount = Math.min(segment.channelCount, data.channels.length)
  if (channelCount <= 0 || segment.endPx <= segment.startPx) return
  const style = segment.style
  const maxHeightFraction = style?.maxHeightFraction ?? DEFAULT_MAX_HEIGHT
  const width = Math.max(1e-9, segment.endPx - segment.startPx)
  const sourceSpan = Math.max(1, segment.sourceEndFrame - segment.sourceStartFrame)
  const visibleStart = Math.max(0, Math.floor(
    (segment.sourceStartFrame - sourceFrameFor(data, 0)) / sourceSpanFor(data),
  ))
  const visibleEnd = Math.min(
    data.kind === 'samples' ? data.channels[0]?.length ?? 0 : data.intervalCount,
    Math.ceil((segment.sourceEndFrame - sourceFrameFor(data, 0)) / sourceSpanFor(data)),
  )
  const laneH = segment.contentH / channelCount
  const amplitudeScales = segment.fadeScaleAtSourceFrame
    ? new Float64Array(Math.max(0, visibleEnd - visibleStart))
    : undefined
  if (amplitudeScales) {
    for (let index = visibleStart; index < visibleEnd; index += 1) {
      const frame = sourceFrameFor(data, index)
      const scale = segment.fadeScaleAtSourceFrame?.(
        data.kind === 'samples' ? frame : frame + sourceSpanFor(data) / 2,
      ) ?? 1
      amplitudeScales[index - visibleStart] = Number.isFinite(scale)
        ? Math.max(0, Math.min(1, scale))
        : 0
    }
  }
  ctx.fillStyle = style?.fillStyle ?? DEFAULT_FILL_STYLE
  for (let channel = 0; channel < channelCount; channel += 1) {
    const ribbons: WaveformRibbonPoint[] = []
    for (let index = visibleStart; index < visibleEnd; index += 1) {
      const startFrame = sourceFrameFor(data, index)
      const span = sourceSpanFor(data)
      const endFrame = startFrame + span
      if (endFrame <= segment.sourceStartFrame || startFrame >= segment.sourceEndFrame) continue
      const x0 = data.kind === 'samples'
        ? segment.startPx + ((startFrame - segment.sourceStartFrame) / sourceSpan) * width
        : segment.startPx + ((Math.max(startFrame, segment.sourceStartFrame) - segment.sourceStartFrame) / sourceSpan) * width
      const x1 = data.kind === 'samples'
        ? x0
        : segment.startPx + ((Math.min(endFrame, segment.sourceEndFrame) - segment.sourceStartFrame) / sourceSpan) * width
      const values = intervalValues(data, channel, index)
      const scale = amplitudeScales?.[index - visibleStart] ?? 1
      const topY = segment.topY + laneH * channel
      const upperY = waveformSampleY({ sample: values.max, topY, contentH: laneH, maxHeightFraction, amplitudeScale: scale })
      const lowerY = waveformSampleY({ sample: values.min, topY, contentH: laneH, maxHeightFraction, amplitudeScale: scale })
      const ribbon = waveformRibbonGeometry({
        upperY,
        lowerY,
        minimumThicknessCssPx,
        backingScaleY,
      })
      ribbons.push({ x0, x1, ribbon })
    }
    if (ribbons.length === 0) continue
    ctx.beginPath()
    for (const [index, point] of ribbons.entries()) {
      if (index === 0) {
        ctx.moveTo(point.x0, point.ribbon.upperY)
      } else {
        ctx.lineTo(point.x0, point.ribbon.upperY)
      }
      if (data.kind !== 'samples') {
        ctx.lineTo(point.x1, point.ribbon.upperY)
      }
    }
    for (let index = ribbons.length - 1; index >= 0; index -= 1) {
      const point = ribbons[index]
      if (!point) continue
      ctx.lineTo(
        data.kind === 'samples' ? point.x0 : point.x1,
        point.ribbon.lowerY,
      )
      if (data.kind !== 'samples') {
        ctx.lineTo(point.x0, point.ribbon.lowerY)
      }
    }
    ctx.fill()
    if (data.kind !== 'samples' || pointRadius <= 0) continue
    ctx.beginPath()
    for (let index = visibleStart; index < visibleEnd; index += 1) {
      const frame = sourceFrameFor(data, index)
      if (frame < segment.sourceStartFrame || frame >= segment.sourceEndFrame) continue
      const value = intervalValues(data, channel, index).min
      const scale = amplitudeScales?.[index - visibleStart] ?? 1
      const x = segment.startPx + ((frame - segment.sourceStartFrame) / sourceSpan) * width
      const y = waveformSampleY({
        sample: value,
        topY: segment.topY + laneH * channel,
        contentH: laneH,
        maxHeightFraction,
        amplitudeScale: scale,
      })
      ctx.moveTo(x + pointRadius, y)
      ctx.arc(x, y, pointRadius, 0, Math.PI * 2)
    }
    ctx.fill()
  }
}
