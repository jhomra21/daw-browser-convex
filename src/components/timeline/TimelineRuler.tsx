import { createMemo, type Component, Index, Show, onCleanup } from 'solid-js'
import { ARRANGEMENT_OVERVIEW_HEIGHT, RULER_HEIGHT, quantizeSecToGrid } from '~/lib/timeline-utils'
import { musicalBarLabelAtTime, selectTimelineGridIntervals } from '~/lib/timeline-view'

type TimelineRulerProps = {
  durationSec: number
  bpm: number
  denom: number
  gridEnabled: boolean
  pixelsPerSecond: number
  visibleRange: { startSec: number; endSec: number }
  viewportWidthPx: number
  timeToX: (timeSec: number) => number
  xToTime: (x: number) => number
  onPointerDown: (e: PointerEvent) => void
  loopEnabled?: boolean
  loopStartSec?: number
  loopEndSec?: number
  onSetLoopRegion?: (startSec: number, endSec: number) => void
}

const formatTimeInterval = (seconds: number) => {
  if (seconds < 0.001) return `${Math.round(seconds * 1_000_000)}µs`
  if (seconds < 1) return `${Math.round(seconds * 1_000)}ms`
  return `${seconds}s`
}

export const collectTimelineMarkerIndices = (
  first: number,
  last: number,
  stepSec: number,
  rulerWidthPx: number,
  timeToX: (timeSec: number) => number,
  isExcluded?: (positionPx: number, index: number) => boolean,
) => {
  if (!(Number.isFinite(stepSec) && stepSec > 0) || last < first) return []

  const indices: number[] = []
  for (let index = first; index <= last; index += 1) {
    const positionPx = timeToX(index * stepSec)
    if (positionPx <= rulerWidthPx && !isExcluded?.(positionPx, index)) {
      indices.push(index)
    }
  }
  return indices
}

const TimelineRuler: Component<TimelineRulerProps> = (props) => {
  const intervals = createMemo(() => selectTimelineGridIntervals(props.pixelsPerSecond, props.bpm, props.denom, props.gridEnabled))
  const barStepPx = () => Math.max(0.5, intervals().majorSec * props.pixelsPerSecond)

  const rulerWidthPx = () => Math.max(0, props.viewportWidthPx)
  const loopStartPx = () => Math.max(0, props.timeToX(props.loopStartSec ?? 0))
  const loopEndPx = () => Math.min(rulerWidthPx(), Math.max(loopStartPx(), props.timeToX(props.loopEndSec ?? 0)))
  const loopWidthPx = () => Math.max(0, loopEndPx() - loopStartPx())
  const showLoop = () => props.loopEnabled && loopWidthPx() > 1

  // --- Loop editing ---
  let rootEl: HTMLDivElement | null = null
  let dragging = false
  let dragMode: 'none' | 'resize-start' | 'resize-end' | 'create' | 'move' = 'none'
  let dragStartSec = 0
  let dragLoopLen = 0
  let dragOffsetFromStart = 0
  let listenersAttached = false

  const detachPointerListeners = () => {
    if (!listenersAttached) return
    try { window.removeEventListener('pointermove', onPointerMove) } catch {}
    try { window.removeEventListener('pointerup', onPointerUp) } catch {}
    try { window.removeEventListener('pointercancel', onPointerUp) } catch {}
    listenersAttached = false
  }

  const attachPointerListeners = () => {
    if (listenersAttached) return
    try { window.addEventListener('pointermove', onPointerMove) } catch {}
    try { window.addEventListener('pointerup', onPointerUp) } catch {}
    try { window.addEventListener('pointercancel', onPointerUp) } catch {}
    listenersAttached = true
  }

  const clientXToSecLocal = (clientX: number) => {
    const rect = rootEl?.getBoundingClientRect()
    if (!rect) return 0
    const x = clientX - rect.left
    return props.xToTime(x)
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging || dragMode === 'none') return
    if (!props.loopEnabled) {
      dragging = false
      dragMode = 'none'
      detachPointerListeners()
      return
    }
    const sec = clientXToSecLocal(e.clientX)
    if (!props.onSetLoopRegion) return
    if (dragMode === 'create') {
      let s = Math.min(dragStartSec, sec)
      let ed = Math.max(dragStartSec, sec)
      if (props.gridEnabled) {
        s = quantizeSecToGrid(s, props.bpm, props.denom, 'round')
        ed = quantizeSecToGrid(ed, props.bpm, props.denom, 'round')
      }
      props.onSetLoopRegion(s, Math.max(s + 0.05, ed))
      return
    }
    const curStart = props.loopStartSec ?? 0
    const curEnd = props.loopEndSec ?? 0
    if (dragMode === 'resize-start') {
      let nextStart = Math.min(sec, curEnd - 0.05)
      if (props.gridEnabled) nextStart = quantizeSecToGrid(nextStart, props.bpm, props.denom, 'round')
      props.onSetLoopRegion(nextStart, curEnd)
    } else if (dragMode === 'resize-end') {
      let nextEnd = Math.max(sec, curStart + 0.05)
      if (props.gridEnabled) nextEnd = quantizeSecToGrid(nextEnd, props.bpm, props.denom, 'round')
      props.onSetLoopRegion(curStart, nextEnd)
    } else if (dragMode === 'move') {
      const length = dragLoopLen > 0 ? dragLoopLen : Math.max(0.05, (props.loopEndSec ?? 0) - (props.loopStartSec ?? 0))
      let nextStart = sec - dragOffsetFromStart
      if (props.gridEnabled) nextStart = quantizeSecToGrid(nextStart, props.bpm, props.denom, 'round')
      nextStart = Math.max(0, Math.min(nextStart, (props.durationSec || 0) - length))
      const nextEnd = nextStart + length
      props.onSetLoopRegion(nextStart, nextEnd)
    }
  }

  const onPointerUp = () => {
    if (!dragging) return
    dragging = false
    dragMode = 'none'
    detachPointerListeners()
  }

  const onLocalPointerDown = (e: PointerEvent) => {
    // Defer to scrub handler if we lack a loop setter or click is in lower half
    const rect = rootEl?.getBoundingClientRect()
    const inTopHalf = rect ? (e.clientY - rect.top) <= (RULER_HEIGHT / 2) : true
    if (!props.onSetLoopRegion || !inTopHalf || !props.loopEnabled) { props.onPointerDown?.(e); return }
    if (e.button !== 0) { props.onPointerDown?.(e); return }

    const sec = clientXToSecLocal(e.clientX)
    const startPx = loopStartPx()
    const endPx = loopEndPx()
    const xPx = props.timeToX(sec)
    const near = 6 // px threshold for grabbing edges
    const hasLoop = props.loopEnabled && (props.loopEndSec ?? 0) - (props.loopStartSec ?? 0) > 0.05
    if (hasLoop && Math.abs(xPx - startPx) <= near) {
      dragging = true; dragMode = 'resize-start'; e.preventDefault(); e.stopPropagation()
    } else if (hasLoop && Math.abs(xPx - endPx) <= near) {
      dragging = true; dragMode = 'resize-end'; e.preventDefault(); e.stopPropagation()
    } else if (hasLoop && xPx > startPx && xPx < endPx) {
      dragging = true; dragMode = 'move'; e.preventDefault(); e.stopPropagation()
      dragLoopLen = (props.loopEndSec ?? 0) - (props.loopStartSec ?? 0)
      dragOffsetFromStart = sec - (props.loopStartSec ?? 0)
    } else {
      dragging = true; dragMode = 'create'; dragStartSec = sec; e.preventDefault(); e.stopPropagation()
      // Initialize a minimal loop so feedback is visible immediately
      props.onSetLoopRegion?.(sec, sec + 0.1)
    }
    attachPointerListeners()
  }

  // Cursor feedback for edges and move area in top half
  const onLocalPointerMove = (e: PointerEvent) => {
    if (!rootEl) return
    const rect = rootEl.getBoundingClientRect()
    const inTopHalf = (e.clientY - rect.top) <= (RULER_HEIGHT / 2)
    if (!inTopHalf || !props.loopEnabled) { rootEl.style.cursor = '' ; return }
    const sec = clientXToSecLocal(e.clientX)
    const xPx = props.timeToX(sec)
    const startPx = loopStartPx()
    const endPx = loopEndPx()
    const near = 6
    const hasLoop = props.loopEnabled && (props.loopEndSec ?? 0) - (props.loopStartSec ?? 0) > 0.05
    if (hasLoop && (Math.abs(xPx - startPx) <= near || Math.abs(xPx - endPx) <= near)) {
      rootEl.style.cursor = 'ew-resize'
    } else if (hasLoop && xPx > startPx && xPx < endPx) {
      rootEl.style.cursor = 'move'
    } else {
      rootEl.style.cursor = ''
    }
  }

  const onLocalPointerLeave = () => {
    if (rootEl) rootEl.style.cursor = ''
  }

  onCleanup(() => {
    detachPointerListeners()
  })

  const backgroundStyle = () => {
    if (props.gridEnabled) {
      const major = barStepPx()
      return {
        background: `
          /* Major bar lines */
          repeating-linear-gradient(
            to right,
            var(--timeline-grid-major) 0px,
            var(--timeline-grid-major) 2px,
            transparent 2px,
            transparent ${major}px
          ),
          var(--timeline-surface)`
      } as const
    }

    const fiveSecPx = props.pixelsPerSecond * 5
    return {
      background: `
        /* 5s lines */
        repeating-linear-gradient(
          to right,
          var(--timeline-grid-major) 0px,
          var(--timeline-grid-major) 2px,
          transparent 2px,
          transparent ${fiveSecPx}px
        ),
        var(--timeline-surface)`
    } as const
  }

  const majorMarkerIndices = createMemo<number[]>(() => {
    if (props.gridEnabled) {
      const step = intervals().majorSec
      if (!(Number.isFinite(step) && step > 0)) return []
      const first = Math.max(0, Math.floor(props.visibleRange.startSec / step) - 1)
      const last = Math.min(Math.ceil(props.durationSec / step), Math.ceil(props.visibleRange.endSec / step) + 1)
      return collectTimelineMarkerIndices(first, last, step, rulerWidthPx(), props.timeToX)
    }

    const step = intervals().majorSec
    const first = Math.max(0, Math.floor(props.visibleRange.startSec / step) - 1)
    const last = Math.min(Math.ceil(props.durationSec / step), Math.ceil(props.visibleRange.endSec / step) + 1)
    return collectTimelineMarkerIndices(first, last, step, rulerWidthPx(), props.timeToX)
  })

  const minorMarkerIndices = createMemo<number[]>(() => {
    const majors = majorMarkerIndices()
    const step = intervals().minorSec
    const majorStep = intervals().majorSec
    const majorLookup = new Set(majors.map(index => Math.round(props.timeToX(index * majorStep))))

    if (props.gridEnabled) {
      if (!(Number.isFinite(step) && step > 0)) return []
      const first = Math.max(0, Math.floor(props.visibleRange.startSec / step) - 1)
      const last = Math.min(Math.ceil(props.durationSec / step), Math.ceil(props.visibleRange.endSec / step) + 1)
      return collectTimelineMarkerIndices(
        first,
        last,
        step,
        rulerWidthPx(),
        props.timeToX,
        positionPx => majorLookup.has(Math.round(positionPx)),
      )
    }

    const first = Math.max(0, Math.floor(props.visibleRange.startSec / step) - 1)
    const last = Math.min(Math.ceil(props.durationSec / step), Math.ceil(props.visibleRange.endSec / step) + 1)
    return collectTimelineMarkerIndices(
      first,
      last,
      step,
      rulerWidthPx(),
      props.timeToX,
      positionPx => majorLookup.has(Math.round(positionPx)),
    )
  })

  return (
    <div
      data-timeline-ruler="1"
      class="sticky z-30 border-b border-border bg-timeline-surface"
      style={{
        top: `${ARRANGEMENT_OVERVIEW_HEIGHT}px`,
        width: `${rulerWidthPx()}px`,
        height: `${RULER_HEIGHT}px`,
        'background-position': `${-props.visibleRange.startSec * props.pixelsPerSecond}px 0px`,
        ...backgroundStyle(),
      }}
      ref={el => { rootEl = el }}
      onPointerDown={onLocalPointerDown}
      onPointerMove={onLocalPointerMove}
      onPointerLeave={onLocalPointerLeave}
    >
      <Show when={showLoop()}>
        <div
          class="absolute top-0 bottom-0 bg-green-400/10 border-y border-green-400/40"
          style={{ left: `${loopStartPx()}px`, width: `${loopWidthPx()}px` }}
        />
      </Show>
      <Index each={minorMarkerIndices()}>
        {(markerIndex) => {
          const positionPx = () => props.timeToX(markerIndex() * intervals().minorSec)
          return (
            <div
              class="absolute top-0 w-px bg-timeline-grid-minor"
              style={{ left: `${positionPx()}px`, height: `${RULER_HEIGHT / 2}px` }}
            />
          )
        }}
      </Index>
      <Index each={majorMarkerIndices()}>
        {(markerIndex) => {
          const positionPx = () => props.timeToX(markerIndex() * intervals().majorSec)
          const label = () => props.gridEnabled
            ? `${musicalBarLabelAtTime(markerIndex() * intervals().majorSec, props.bpm)}`
            : formatTimeInterval(markerIndex() * intervals().majorSec)
          return (
            <div class="absolute bottom-0" style={{ left: `${positionPx()}px` }}>
              <div class="w-0.5 bg-timeline-grid-major" style={{ height: `${RULER_HEIGHT}px` }} />
              <div class="absolute -top-5 text-2xs font-medium text-muted-foreground select-none">
                {label()}
              </div>
            </div>
          )
        }}
      </Index>
    </div>
  )
}

export default TimelineRuler
