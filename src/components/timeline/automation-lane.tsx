import { For, createMemo, createSignal, onCleanup } from 'solid-js'
import {
  automationTargetKey,
  getAutomationParameterDescriptor,
  normalizeAutomationPoints,
  type AutomationEnvelope,
  type AutomationPoint,
  type AutomationTarget,
} from '@daw-browser/shared'
import { LANE_HEIGHT, PPS } from '~/lib/timeline-utils'

type AutomationLaneProps = {
  projectId: string
  target: AutomationTarget
  parameterId: string
  envelope: AutomationEnvelope | undefined
  durationSec: number
  onPreview: (envelope: AutomationEnvelope | undefined) => void
  onCommit: (envelope: AutomationEnvelope | undefined) => void
}

const AUTOMATION_LINE_COLOR = '#ef4444'

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

  const descriptor = createMemo(() => getAutomationParameterDescriptor(props.parameterId))
  const points = createMemo(() => props.envelope?.points ?? [])
  const valueToY = (value: number) => {
    const desc = descriptor()
    if (!desc) return LANE_HEIGHT / 2
    const ratio = (value - desc.min) / (desc.max - desc.min)
    return Math.max(8, Math.min(LANE_HEIGHT - 8, (1 - ratio) * (LANE_HEIGHT - 16) + 8))
  }
  const yToValue = (y: number) => {
    const desc = descriptor()
    if (!desc) return 0
    const ratio = 1 - ((Math.max(8, Math.min(LANE_HEIGHT - 8, y)) - 8) / (LANE_HEIGHT - 16))
    return desc.min + ratio * (desc.max - desc.min)
  }
  const path = createMemo(() => {
    const ordered = points()
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
      props.onCommit(undefined)
      return
    }
    props.onCommit(createEnvelope(props, nextPoints))
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
    setSelectedPointId(pointId)
    const move = (moveEvent: PointerEvent) => {
      const nextPoint = pointFromEvent(moveEvent)
      if (!nextPoint) return
      previewPoints(points().map((point) => point.id === pointId ? { ...point, timeSec: nextPoint.timeSec, value: nextPoint.value } : point))
    }
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const nextPoint = pointFromEvent(upEvent)
      if (!nextPoint) return
      commitPoints(points().map((point) => point.id === pointId ? { ...point, timeSec: nextPoint.timeSec, value: nextPoint.value } : point))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
  }

  const addPoint = (event: PointerEvent) => {
    event.stopPropagation()
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

  window.addEventListener('keydown', onKeyDown)
  onCleanup(() => window.removeEventListener('keydown', onKeyDown))

  return (
    <div
      ref={root}
      class="absolute inset-0 z-20"
      onPointerDown={addPoint}
    >
      <svg class="h-full w-full overflow-visible">
        <path d={path()} fill="none" stroke={AUTOMATION_LINE_COLOR} stroke-width="2" />
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
