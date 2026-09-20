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

type CanonicalWaveformAnchor = {
  readonly sourceFrame: number
  readonly min: number
  readonly max: number
  readonly exact: boolean
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

const normalizeWaveformChannel = (
  data: WaveformSourceData,
  channel: number,
  sourceStartFrame: number,
  sourceEndFrame: number,
): CanonicalWaveformAnchor[] => {
  const valueCount = data.kind === 'samples'
    ? data.channels[0]?.length ?? 0
    : data.intervalCount
  const sourceSpan = sourceSpanFor(data)
  const firstSourceFrame = sourceFrameFor(data, 0)
  const firstIndex = Math.max(
    0,
    Math.floor((sourceStartFrame - firstSourceFrame) / sourceSpan),
  )
  const lastIndex = Math.min(
    valueCount,
    Math.ceil((sourceEndFrame - firstSourceFrame) / sourceSpan),
  )
  const values: CanonicalWaveformAnchor[] = []
  for (let index = firstIndex; index < lastIndex; index += 1) {
    const sourceFrame = sourceFrameFor(data, index)
    const sourceEnd = sourceFrame + sourceSpan
    if (
      data.kind === 'samples'
      && (sourceFrame < sourceStartFrame || sourceFrame >= sourceEndFrame)
    ) continue
    const clippedStart = Math.max(sourceFrame, sourceStartFrame)
    const clippedEnd = Math.min(sourceEnd, sourceEndFrame)
    if (clippedEnd <= clippedStart) continue
    const range = intervalValues(data, channel, index)
    values.push({
      sourceFrame: data.kind === 'samples'
        ? sourceFrame
        : (clippedStart + clippedEnd) / 2,
      min: range.min,
      max: range.max,
      exact: data.kind === 'samples',
    })
  }
  if (values.length === 0) return values
  const first = values[0]
  const last = values[values.length - 1]
  if (!first || !last) return values
  // Aggregate intervals use their clipped center as the stable source anchor.
  // Boundary anchors preserve clip edges without introducing interval-width
  // geometry into the painter.
  return [
    ...(first.sourceFrame > sourceStartFrame
      ? [{ ...first, sourceFrame: sourceStartFrame, exact: false }]
      : []),
    ...values,
    ...(last.sourceFrame < sourceEndFrame
      ? [{ ...last, sourceFrame: sourceEndFrame, exact: false }]
      : []),
  ]
}

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
  const laneH = segment.contentH / channelCount
  const fadeScaleCache = new Map<number, number>()
  const amplitudeScaleAt = (frame: number) => {
    const cached = fadeScaleCache.get(frame)
    if (cached !== undefined) return cached
    const scale = segment.fadeScaleAtSourceFrame?.(frame) ?? 1
    const normalized = Number.isFinite(scale)
      ? Math.max(0, Math.min(1, scale))
      : 0
    fadeScaleCache.set(frame, normalized)
    return normalized
  }
  ctx.fillStyle = style?.fillStyle ?? DEFAULT_FILL_STYLE
  for (let channel = 0; channel < channelCount; channel += 1) {
    const values = normalizeWaveformChannel(
      data,
      channel,
      segment.sourceStartFrame,
      segment.sourceEndFrame,
    )
    const upper: Array<readonly [number, number]> = []
    const lower: Array<readonly [number, number]> = []
    for (const value of values) {
      const scale = amplitudeScaleAt(value.sourceFrame)
      const topY = segment.topY + laneH * channel
      const upperY = waveformSampleY({
        sample: value.max,
        topY,
        contentH: laneH,
        maxHeightFraction,
        amplitudeScale: scale,
      })
      const lowerY = waveformSampleY({
        sample: value.min,
        topY,
        contentH: laneH,
        maxHeightFraction,
        amplitudeScale: scale,
      })
      const ribbon = waveformRibbonGeometry({
        upperY,
        lowerY,
        minimumThicknessCssPx,
        backingScaleY,
      })
      const x = segment.startPx
        + ((value.sourceFrame - segment.sourceStartFrame) / sourceSpan) * width
      upper.push([x, ribbon.upperY])
      lower.push([x, ribbon.lowerY])
    }
    if (upper.length === 0 || lower.length === 0) continue
    ctx.beginPath()
    const firstUpper = upper[0]
    if (!firstUpper) continue
    ctx.moveTo(firstUpper[0], firstUpper[1])
    for (const point of upper.slice(1)) {
      ctx.lineTo(point[0], point[1])
    }
    for (let index = lower.length - 1; index >= 0; index -= 1) {
      const point = lower[index]
      if (!point) continue
      ctx.lineTo(point[0], point[1])
    }
    ctx.fill()
    if (pointRadius <= 0) continue
    ctx.beginPath()
    for (const value of values) {
      if (!value.exact) continue
      const scale = amplitudeScaleAt(value.sourceFrame)
      const x = segment.startPx
        + ((value.sourceFrame - segment.sourceStartFrame) / sourceSpan) * width
      const y = waveformSampleY({
        sample: value.min,
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
