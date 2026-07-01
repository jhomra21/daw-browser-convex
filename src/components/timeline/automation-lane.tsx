import { For, Show, createMemo, createSignal, onCleanup } from 'solid-js'
import {
  automationTargetKey,
  automationRatioToValue,
  automationValueToRatio,
  getAutomationParameterDescriptor,
  normalizeAutomationPoints,
  valueAtAutomationTime,
  type AutomationParameterDescriptor,
  type AutomationEnvelope,
  type AutomationPoint,
  type AutomationTarget,
} from '@daw-browser/shared'
import { PPS } from '~/lib/timeline-utils'
import TimelineContextMenu, { type TimelineContextMenuItem } from './context-menu/timeline-context-menu'

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
const POINT_TIME_NUDGE_SEC = 0.05
const POINT_VALUE_NUDGE_RATIO = 0.01

const formatTime = (timeSec: number) => `${timeSec.toFixed(2)}s`

const formatValue = (value: number, unit: AutomationParameterDescriptor['unit']) => {
  if (unit === 'percent') return `${Math.round(value * 100)}%`
  if (unit === 'db') return `${value.toFixed(1)} dB`
  if (unit === 'hz') return value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${Math.round(value)} Hz`
  if (unit === 'seconds') return `${value.toFixed(2)}s`
  return value.toFixed(2)
}

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
  const [hoveredPointId, setHoveredPointId] = createSignal<string | null>(null)
  let root: HTMLDivElement | undefined
  let cleanupDrag: (() => void) | undefined

  const descriptor = createMemo(() => getAutomationParameterDescriptor(props.parameterId))
  const targetKey = createMemo(() => automationTargetKey(props.target, props.parameterId))
  const height = () => props.heightPx || root?.clientHeight || 36
  const points = createMemo(() => props.envelope?.points ?? [])
  const valueToY = (value: number) => {
    const desc = descriptor()
    if (!desc) return height() / 2
    const ratio = automationValueToRatio(desc, value)
    const innerHeight = Math.max(1, height() - VERTICAL_PADDING * 2)
    return Math.max(VERTICAL_PADDING, Math.min(height() - VERTICAL_PADDING, (1 - ratio) * innerHeight + VERTICAL_PADDING))
  }
  const yToValue = (y: number) => {
    const desc = descriptor()
    if (!desc) return 0
    const innerHeight = Math.max(1, height() - VERTICAL_PADDING * 2)
    const ratio = 1 - ((Math.max(VERTICAL_PADDING, Math.min(height() - VERTICAL_PADDING, y)) - VERTICAL_PADDING) / innerHeight)
    return automationRatioToValue(desc, ratio)
  }
  const displayPoints = createMemo(() => {
    const desc = descriptor()
    const ordered = points()
    if (!desc) return []
    if (ordered.length === 0) {
      return [
        { id: 'automation-empty-start', timeSec: 0, value: desc.defaultValue, interpolation: 'linear' },
        { id: 'automation-empty-end', timeSec: props.durationSec, value: desc.defaultValue, interpolation: 'linear' },
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
  const displayedPoint = createMemo(() => {
    const activeId = hoveredPointId() ?? selectedPointId()
    if (!activeId) return undefined
    return points().find((point) => point.id === activeId)
  })
  const selectedPoint = createMemo(() => {
    const selected = selectedPointId()
    return selected ? points().find((point) => point.id === selected) : undefined
  })
  const readout = createMemo(() => {
    const point = displayedPoint()
    const desc = descriptor()
    if (!point || !desc) return undefined
    return `${formatTime(point.timeSec)} · ${formatValue(point.value, desc.unit)} · ${point.interpolation}`
  })
  const path = createMemo(() => {
    const ordered = displayPoints()
    if (ordered.length === 0) return ''
    const commands: string[] = []
    ordered.forEach((point, index) => {
      const x = point.timeSec * PPS
      const y = valueToY(point.value)
      if (index === 0) {
        commands.push(`M ${x} ${y}`)
        return
      }
      const previous = ordered[index - 1]
      if (previous?.interpolation === 'hold') {
        commands.push(`L ${x} ${valueToY(previous.value)}`)
      }
      commands.push(`L ${x} ${y}`)
    })
    return commands.join(' ')
  })

  const pointFromClientPosition = (clientX: number, clientY: number): AutomationPoint | null => {
    const rect = root?.getBoundingClientRect()
    if (!rect) return null
    const timeSec = Math.max(0, Math.min(props.durationSec, (clientX - rect.left) / PPS))
    return {
      id: crypto.randomUUID(),
      timeSec,
      value: yToValue(clientY - rect.top),
      interpolation: 'linear',
    }
  }

  const pointFromEvent = (event: PointerEvent | MouseEvent): AutomationPoint | null =>
    pointFromClientPosition(event.clientX, event.clientY)

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
    if (event.button !== 0) return
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

  const addPoint = (event: MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
    root?.focus()
    const point = pointFromEvent(event)
    if (!point) return
    setSelectedPointId(point.id)
    commitPoints([...points(), point])
  }

  const addPointAtStoredPosition = () => {
    const position = contextMenuPosition()
    if (!position) return
    root?.focus()
    const point = pointFromClientPosition(position.clientX, position.clientY)
    if (!point) return
    setSelectedPointId(point.id)
    commitPoints([...points(), point])
  }

  const updateSelectedPoint = (update: (point: AutomationPoint) => AutomationPoint) => {
    const selected = selectedPointId()
    if (!selected) return
    const nextPoints = points().map((point) => point.id === selected ? update(point) : point)
    commitPoints(nextPoints)
  }

  const toggleSelectedInterpolation = () => {
    updateSelectedPoint((point) => ({
      ...point,
      interpolation: point.interpolation === 'hold' ? 'linear' : 'hold',
    }))
  }

  const deleteSelectedPoint = () => {
    const selected = selectedPointId()
    if (!selected) return
    commitPoints(points().filter((point) => point.id !== selected))
    setSelectedPointId(null)
  }

  const [contextMenuPosition, setContextMenuPosition] = createSignal<{ clientX: number; clientY: number } | null>(null)
  const contextMenuItems = (): TimelineContextMenuItem[] => [
    { kind: 'label', label: descriptor()?.label ?? props.parameterId },
    { kind: 'item', label: 'Add point', disabled: !contextMenuPosition(), onSelect: addPointAtStoredPosition },
    { kind: 'separator' },
    {
      kind: 'item',
      label: selectedPoint()?.interpolation === 'hold' ? 'Set interpolation: linear' : 'Set interpolation: hold',
      shortcut: 'I',
      disabled: !selectedPoint(),
      onSelect: toggleSelectedInterpolation,
    },
    {
      kind: 'item',
      label: 'Delete selected point',
      shortcut: '⌫',
      disabled: !selectedPoint(),
      onSelect: deleteSelectedPoint,
    },
  ]

  const onKeyDown = (event: KeyboardEvent) => {
    const selected = selectedPointId()
    if (!selected) return
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      deleteSelectedPoint()
      return
    }
    if (event.key === 'i' || event.key === 'I') {
      event.preventDefault()
      toggleSelectedInterpolation()
      return
    }
    const desc = descriptor()
    if (!desc) return
    const multiplier = event.shiftKey ? 10 : 1
    const timeDelta = POINT_TIME_NUDGE_SEC * multiplier
    const ratioDelta = POINT_VALUE_NUDGE_RATIO * multiplier
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      updateSelectedPoint((point) => ({
        ...point,
        timeSec: Math.max(0, Math.min(props.durationSec, point.timeSec + direction * timeDelta)),
      }))
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? -1 : 1
      updateSelectedPoint((point) => ({
        ...point,
        value: automationRatioToValue(desc, automationValueToRatio(desc, point.value) + direction * ratioDelta),
      }))
    }
  }

  onCleanup(() => {
    cleanupDrag?.()
    props.onCancelPreview(targetKey())
  })

  const laneElement = (
    <div
      ref={root}
      tabIndex={0}
      data-timeline-keyboard-local="true"
      class="absolute inset-0 z-20 touch-none"
      onPointerDown={(event) => {
        event.stopPropagation()
        root?.focus()
      }}
      onDblClick={addPoint}
      onContextMenu={(event) => setContextMenuPosition({ clientX: event.clientX, clientY: event.clientY })}
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
              onContextMenu={(event) => {
                setSelectedPointId(point.id)
                setContextMenuPosition({ clientX: event.clientX, clientY: event.clientY })
              }}
              onDblClick={(event) => event.stopPropagation()}
              onPointerEnter={() => setHoveredPointId(point.id)}
              onPointerLeave={() => setHoveredPointId((current) => current === point.id ? null : current)}
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
      <Show when={readout()}>
        {(label) => (
          <div class="pointer-events-none absolute right-2 top-1 rounded border border-red-500/40 bg-neutral-950/90 px-2 py-1 text-[10px] text-red-100 shadow-lg shadow-black/30">
            {label()}
          </div>
        )}
      </Show>
      <Show when={selectedPoint()}>
        {(point) => (
          <button
            type="button"
            class="absolute bottom-1 right-2 rounded border border-red-500/40 bg-neutral-950/90 px-2 py-1 text-[10px] uppercase tracking-wide text-red-100 hover:border-red-400"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              toggleSelectedInterpolation()
            }}
            title="Toggle interpolation (I)"
          >
            {point().interpolation === 'hold' ? 'Hold' : 'Linear'}
          </button>
        )}
      </Show>
    </div>
  )

  return (
    <TimelineContextMenu
      items={contextMenuItems}
      onOpenChange={(open) => {
        if (!open) setContextMenuPosition(null)
      }}
    >
      {laneElement}
    </TimelineContextMenu>
  )
}
