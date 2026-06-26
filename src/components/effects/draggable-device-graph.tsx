import { createSignal, createUniqueId, For, type JSX } from 'solid-js'
import { cn } from '~/lib/utils'

const GRAPH_WIDTH = 180
const GRAPH_HEIGHT = 58

type GraphKey = 'ArrowRight' | 'ArrowUp' | 'ArrowLeft' | 'ArrowDown' | 'PageUp' | 'PageDown' | 'Home' | 'End'

type DeviceGraphHandle = {
  label: string
  x: () => number
  y: () => number
  onDrag: (point: { x: number, y: number }) => void
  onKeyDown?: (event: KeyboardEvent) => void
}

const clampGraphValue = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const graphKey = (key: string): GraphKey | undefined => {
  if (
    key === 'ArrowRight'
    || key === 'ArrowUp'
    || key === 'ArrowLeft'
    || key === 'ArrowDown'
    || key === 'PageUp'
    || key === 'PageDown'
    || key === 'Home'
    || key === 'End'
  ) return key
  return undefined
}

export function handleGraphKeyDelta(
  event: KeyboardEvent,
  deltas: Partial<Record<GraphKey, () => void>>,
) {
  const key = graphKey(event.key)
  const apply = key === undefined ? undefined : deltas[key]
  if (!apply) return
  event.preventDefault()
  apply()
}

export function DraggableDeviceGraph(props: {
  disabled: boolean
  path: () => string
  handles: DeviceGraphHandle[]
  class?: string
  patternWidth?: number
  patternHeight?: number
  stroke?: string
  children?: JSX.Element
}) {
  const patternId = createUniqueId()
  const patternWidth = () => props.patternWidth ?? 18
  const patternHeight = () => props.patternHeight ?? 14
  const [activeHandle, setActiveHandle] = createSignal<DeviceGraphHandle>()
  let graphRef: HTMLDivElement | undefined
  let dragBounds: DOMRect | undefined
  const graphPoint = (event: PointerEvent) => {
    const bounds = dragBounds ?? graphRef?.getBoundingClientRect()
    if (!bounds) return { x: 0, y: 0 }
    return {
      x: clampGraphValue(((event.clientX - bounds.left) / bounds.width) * GRAPH_WIDTH, 0, GRAPH_WIDTH),
      y: clampGraphValue(((event.clientY - bounds.top) / bounds.height) * GRAPH_HEIGHT, 0, GRAPH_HEIGHT),
    }
  }
  const dragActiveHandle = (event: PointerEvent) => {
    if (activeHandle()) event.preventDefault()
    activeHandle()?.onDrag(graphPoint(event))
  }
  const endDrag = (event: PointerEvent) => {
    if (graphRef?.hasPointerCapture(event.pointerId)) {
      graphRef.releasePointerCapture(event.pointerId)
    }
    dragBounds = undefined
    setActiveHandle()
  }

  return (
    <div
      ref={(element) => (graphRef = element)}
      class={cn('relative h-[116px] shrink-0 touch-none overflow-hidden bg-neutral-950', props.class)}
      onPointerMove={dragActiveHandle}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <svg
        viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
        class="absolute inset-0 h-full w-full"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <pattern id={patternId} width={patternWidth()} height={patternHeight()} patternUnits="userSpaceOnUse">
            <path d={`M ${patternWidth()} 0 L 0 0 0 ${patternHeight()}`} fill="none" stroke="#262626" stroke-width="1" />
          </pattern>
        </defs>
        <rect width={GRAPH_WIDTH} height={GRAPH_HEIGHT} fill={`url(#${patternId})`} />
        {props.children}
        <path d={props.path()} fill="none" stroke={props.stroke ?? '#fb923c'} stroke-width="2" vector-effect="non-scaling-stroke" />
      </svg>
      <For each={props.handles}>
        {(handle) => (
          <button
            type="button"
            aria-label={handle.label}
            class={cn(
              'absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-cyan-300 bg-neutral-950',
              props.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-grab active:cursor-grabbing',
            )}
            style={{
              left: `${(handle.x() / GRAPH_WIDTH) * 100}%`,
              top: `${(handle.y() / GRAPH_HEIGHT) * 100}%`,
            }}
            disabled={props.disabled}
            onPointerDown={(event) => {
              if (props.disabled) return
              event.preventDefault()
              dragBounds = graphRef?.getBoundingClientRect()
              graphRef?.setPointerCapture(event.pointerId)
              setActiveHandle(handle)
              handle.onDrag(graphPoint(event))
            }}
            onKeyDown={(event) => {
              if (props.disabled) return
              handle.onKeyDown?.(event)
            }}
          />
        )}
      </For>
    </div>
  )
}
