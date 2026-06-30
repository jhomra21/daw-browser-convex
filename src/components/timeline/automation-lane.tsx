import { For, createMemo, createSignal, onCleanup } from 'solid-js'
import {
  automationTargetKey,
  getAutomationParameterDescriptor,
  normalizeAutomationPoints,
  valueAtAutomationTime,
  type AutomationEnvelope,
  type AutomationPoint,
  type AutomationTarget,
} from '@daw-browser/shared'
import { PPS } from '~/lib/timeline-utils'

type AutomationLaneProps = {
  projectId: string
  target: AutomationTarget
  parameterId: string
  envelope: AutomationEnvelope | undefined
  durationSec: number
  heightPx: number
  onPreview: (envelope: AutomationEnvelope | undefined) => void
  onCommit: (envelope: AutomationEnvelope | undefined, targetKey: string) => void
  onCancelPreview: (targetKey: string) => void
}

const AUTOMATION_LINE_COLOR = '#ef4444'
const VERTICAL_PADDING = 7

const createEnvelope = (props: AutomationLaneProps, points: AutomationPoint[]): AutomationEnvelope => {
  const targetKey = automationTargetKey(props.target, props.parameterId)
  const descriptor = getAutomationParameterDescriptor(props.parameterId)
  return {
    id: props.envelope?.id ?? crypto.randomUUID(),
    projectId: props.projectId,
    target: props.target,
    targetKey,
    parameterId: props.parameterId,
    enabled: true,
    points: descriptor ? normalizeAutomationPoints(points, descriptor) : points,
    updatedAt: Date.now(),
  }
}

export default function AutomationLane(props: AutomationLaneProps) {
  const [selectedPointId, setSelectedPointId] = createSignal<string | null>(null)
  let root: HTMLDivElement | undefined
  let cleanupDrag: (() => void) | undefined

  const descriptor = createMemo(() => getAutomationParameterDescriptor(props.parameterId))
  const targetKey = createMemo(() => automationTargetKey(props.target, props.parameterId))
  const height = () => props.heightPx || root?.clientHeight || 36
  const points = createMemo(() => props.envelope?.points ?? [])
  const valueToY = (value: number) => {
    const desc = descriptor()
    if (!desc) return height() / 2
    const ratio = (value - desc.min) / (desc.max - desc.min)
    const innerHeight = Math.max(1, height() - VERTICAL_PADDING * 2)
    return Math.max(VERTICAL_PADDING, Math.min(height() - VERTICAL_PADDING, (1 - ratio) * innerHeight + VERTICAL_PADDING))
  }
  const yToValue = (y: number) => {
    const desc = descriptor()
    if (!desc) return 0
    const innerHeight = Math.max(1, height() - VERTICAL_PADDING * 2)
    const ratio = 1 - ((Math.max(VERTICAL_PADDING, Math.min(height() - VERTICAL_PADDING, y)) - VERTICAL_PADDING) / innerHeight)
    return desc.min + ratio * (desc.max - desc.min)
  }
  const displayPoints = createMemo(() => {
    const desc = descriptor()
    const ordered = points()
    if (!desc) return []
    if (ordered.length === 0) {
      return [
        { timeSec: 0, value: desc.defaultValue },
        { timeSec: props.durationSec, value: desc.defaultValue },
      ]
    }
    const first = ordered[0]
    const last = ordered[ordered.length - 1]
    const next = [...ordered]
    if (first && first.timeSec > 0) {
      next.unshift({
        id: 'automation-start-extension',
        timeSec: 0,
        value: valueAtAutomationTime(ordered, 0, desc.defaultValue),
        interpolation: 'linear',
      })
    }
    if (last && last.timeSec < props.durationSec) {
      next.push({
        id: 'automation-end-extension',
        timeSec: props.durationSec,
        value: last.value,
        interpolation: 'linear',
      })
    }
    return next
  })
  const path = createMemo(() => {
    const ordered = displayPoints()
    if (ordered.length === 0) return ''
    return ordered.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.timeSec * PPS} ${valueToY(point.value)}`).join(' ')
  })

  const pointFromEvent = (event: PointerEvent): AutomationPoint | null => {
    const rect = root?.getBoundingClientRect()
    if (!rect) return null
    const timeSec = Math.max(0, Math.min(props.durationSec, (event.clientX - rect.left) / PPS))
    return {
      id: crypto.randomUUID(),
      timeSec,
      value: yToValue(event.clientY - rect.top),
      interpolation: 'linear',
    }
  }

  const commitPoints = (nextPoints: AutomationPoint[]) => {
    if (nextPoints.length === 0) {
      props.onCommit(undefined, targetKey())
      return
    }
    props.onCommit(createEnvelope(props, nextPoints), targetKey())
  }

  const previewPoints = (nextPoints: AutomationPoint[]) => {
    if (nextPoints.length === 0) {
      props.onPreview(undefined)
      return
    }
    props.onPreview(createEnvelope(props, nextPoints))
  }

  const startDrag = (pointId: string, event: PointerEvent) => {
    event.stopPropagation()
    event.preventDefault()
    root?.focus()
    setSelectedPointId(pointId)
    const move = (moveEvent: PointerEvent) => {
      const nextPoint = pointFromEvent(moveEvent)
      if (!nextPoint) return
      previewPoints(points().map((point) => point.id === pointId ? { ...point, timeSec: nextPoint.timeSec, value: nextPoint.value } : point))
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      if (cleanupDrag === cleanup) cleanupDrag = undefined
    }
    const up = (upEvent: PointerEvent) => {
      cleanup()
      const nextPoint = pointFromEvent(upEvent)
      if (!nextPoint) return
      commitPoints(points().map((point) => point.id === pointId ? { ...point, timeSec: nextPoint.timeSec, value: nextPoint.value } : point))
    }
    const cancel = () => {
      cleanup()
      props.onCancelPreview(targetKey())
    }
    cleanupDrag?.()
    cleanupDrag = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
    window.addEventListener('pointercancel', cancel, { once: true })
  }

  const addPoint = (event: PointerEvent) => {
    event.stopPropagation()
    root?.focus()
    const point = pointFromEvent(event)
    if (!point) return
    setSelectedPointId(point.id)
    commitPoints([...points(), point])
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return
    const selected = selectedPointId()
    if (!selected) return
    event.preventDefault()
    commitPoints(points().filter((point) => point.id !== selected))
    setSelectedPointId(null)
  }

  onCleanup(() => {
    cleanupDrag?.()
    props.onCancelPreview(targetKey())
  })

  return (
    <div
      ref={root}
      tabIndex={0}
      class="absolute inset-0 z-20 touch-none"
      onPointerDown={addPoint}
      onKeyDown={onKeyDown}
    >
      <svg class="h-full w-full overflow-visible" aria-hidden="true">
        <path
          d={path()}
          fill="none"
          stroke={AUTOMATION_LINE_COLOR}
          stroke-width={points().length === 0 ? 1.25 : 2}
          stroke-opacity={points().length === 0 ? 0.5 : 1}
        />
        <For each={points()}>
          {(point) => (
            <g
              onPointerDown={(event) => startDrag(point.id, event)}
              class="cursor-grab"
            >
              <circle cx={point.timeSec * PPS} cy={valueToY(point.value)} r="10" fill="transparent" />
              <circle
                cx={point.timeSec * PPS}
                cy={valueToY(point.value)}
                r={selectedPointId() === point.id ? 5 : 4}
                fill={AUTOMATION_LINE_COLOR}
                stroke="#fee2e2"
                stroke-width="1"
              />
            </g>
          )}
        </For>
      </svg>
    </div>
  )
}
