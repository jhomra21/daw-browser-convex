import { type Component, createMemo } from 'solid-js'

const INNER_PADDING_TOP = 6
const INNER_PADDING_BOTTOM = 6

type RecordingPoint = {
  offset: number
  amplitude: number
}

type RecordingPreviewProps = {
  points: RecordingPoint[]
  widthPx: number
  heightPx: number
  leftPx: number
  pixelsPerSecond: number
}

export const clipRecordingPreviewToViewport = (input: {
  startSec: number
  points: RecordingPoint[]
  visibleStartSec: number
  visibleEndSec: number
  pixelsPerSecond: number
}) => {
  const last = input.points[input.points.length - 1]
  if (!last || input.visibleEndSec <= input.startSec || last.offset <= 0) return null
  const startOffset = Math.max(0, input.visibleStartSec - input.startSec)
  const endOffset = Math.min(last.offset, input.visibleEndSec - input.startSec)
  if (endOffset <= startOffset) return null
  const pointCandidates = recordingPreviewRequiresViewportClip({
    lastOffsetSec: last.offset,
    pixelsPerSecond: input.pixelsPerSecond,
    visibleWidthPx: (input.visibleEndSec - input.visibleStartSec) * input.pixelsPerSecond,
  })
    ? input.points.filter((point) => point.offset >= startOffset && point.offset <= endOffset)
    : input.points
  const interpolate = (offset: number) => {
    const next = input.points.findIndex((point) => point.offset >= offset)
    if (next <= 0) return input.points[0] ?? { offset, amplitude: 0 }
    const right = input.points[next]
    const left = input.points[next - 1]
    if (!right || !left || right.offset === left.offset) return right ?? left
    const ratio = (offset - left.offset) / (right.offset - left.offset)
    return {
      offset,
      amplitude: left.amplitude + (right.amplitude - left.amplitude) * ratio,
    }
  }
  const points = [
    interpolate(startOffset),
    ...pointCandidates.filter((point) => point.offset > startOffset && point.offset < endOffset),
    interpolate(endOffset),
  ].map((point) => ({
    offset: point.offset - startOffset,
    amplitude: point.amplitude,
  }))
  return {
    leftPx: Math.max(0, (input.startSec + startOffset - input.visibleStartSec) * input.pixelsPerSecond),
    widthPx: (endOffset - startOffset) * input.pixelsPerSecond,
    points,
  }
}

export const recordingPreviewRequiresViewportClip = (input: {
  lastOffsetSec: number
  pixelsPerSecond: number
  visibleWidthPx: number
}) => (
  input.lastOffsetSec * input.pixelsPerSecond > Math.max(input.visibleWidthPx * 2, 2048)
)

const RecordingPreview: Component<RecordingPreviewProps> = (props) => {
  const dimensions = createMemo(() => {
    const widthPx = Math.max(6, Math.ceil(props.widthPx))
    const heightPx = Math.max(12, props.heightPx - 4)
    const innerHeight = Math.max(1, heightPx - INNER_PADDING_TOP - INNER_PADDING_BOTTOM)
    return { widthPx, heightPx, innerHeight }
  })

  const polygonPoints = createMemo(() => {
    const pts = props.points
    const { widthPx, innerHeight } = dimensions()
    const midY = INNER_PADDING_TOP + innerHeight / 2
    const gain = innerHeight / 2
    const vertexCount = pts.length
    const combined = Array.from({length: vertexCount * 2 + 2})
    for (let i = 0; i < vertexCount; i++) {
      const point = pts[i]
      const x = Math.max(0, point.offset * props.pixelsPerSecond)
      const amp = Math.min(1, Math.max(0, point.amplitude))
      const yTop = midY - amp * gain
      const yBottom = midY + amp * gain
      combined[i] = `${x},${yTop}`
      combined[vertexCount + 1 + (vertexCount - 1 - i)] = `${x},${yBottom}`
    }
    combined[vertexCount] = `${widthPx},${midY}`
    combined[combined.length - 1] = `0,${midY}`
    return combined.join(' ')
  })

  const widthStyle = createMemo(() => `${dimensions().widthPx}px`)
  const heightStyle = createMemo(() => `${dimensions().heightPx}px`)

  return (
    <div
      class="pointer-events-none absolute top-2 overflow-hidden border border-red-500/70 bg-red-500/15 shadow-md shadow-red-500/20"
      style={{
        left: `${props.leftPx}px`,
        width: widthStyle(),
        height: heightStyle(),
      }}
    >
      <svg viewBox={`0 0 ${dimensions().widthPx} ${dimensions().heightPx}`} width="100%" height="100%">
        <rect x="0" y="0" width="100%" height="100%" fill="rgba(248,113,113,0.06)" />
        <polygon points={polygonPoints()} fill="rgba(248,113,113,0.45)" />
        <line x1="0" y1="50%" x2="100%" y2="50%" stroke="rgba(248,113,113,0.65)" stroke-width="1" stroke-dasharray="2 2" />
      </svg>
    </div>
  )
}

export default RecordingPreview
