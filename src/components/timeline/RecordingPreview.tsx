import { type Component, createMemo } from 'solid-js'
import { PPS, LANE_HEIGHT } from '~/lib/timeline-utils'

const INNER_PADDING_TOP = 6
const INNER_PADDING_BOTTOM = 6

export type RecordingPoint = {
  offset: number
  amplitude: number
}

type RecordingPreviewProps = {
  startSec: number
  points: RecordingPoint[]
}

const RecordingPreview: Component<RecordingPreviewProps> = (props) => {
  const dimensions = createMemo(() => {
    const pts = props.points
    if (!pts.length) {
      return { widthPx: 6, heightPx: LANE_HEIGHT - 12, innerHeight: Math.max(1, LANE_HEIGHT - 12 - INNER_PADDING_TOP - INNER_PADDING_BOTTOM) }
    }
    const last = pts[pts.length - 1]
    const widthPx = Math.max(6, Math.ceil(last.offset * PPS) + 4)
    const heightPx = Math.max(12, LANE_HEIGHT - 12)
    const innerHeight = Math.max(1, heightPx - INNER_PADDING_TOP - INNER_PADDING_BOTTOM)
    return { widthPx, heightPx, innerHeight }
  })

  const polygonPoints = createMemo(() => {
    const pts = props.points
    if (!pts.length) return ''
    const { widthPx, innerHeight } = dimensions()
    const midY = INNER_PADDING_TOP + innerHeight / 2
    const gain = innerHeight / 2
    const vertexCount = pts.length
    const combined = new Array<string>(vertexCount * 2 + 2)
    for (let i = 0; i < vertexCount; i++) {
      const point = pts[i]
      const x = Math.max(0, point.offset * PPS)
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
      class="absolute top-2 rounded border border-red-500/70 bg-red-500/15 shadow-[0_0_8px_rgba(248,113,113,0.35)] overflow-hidden pointer-events-none"
      style={{
        left: `${props.startSec * PPS}px`,
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
