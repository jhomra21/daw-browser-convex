import { type Component, For, Show, onCleanup } from 'solid-js'
import { PPS, RULER_HEIGHT, quantizeSecToGrid } from '~/lib/timeline-utils'

type TimelineRulerProps = {
  durationSec: number
  bpm: number
  denom: number
  gridEnabled: boolean
  onMouseDown: (e: MouseEvent) => void
  loopEnabled?: boolean
  loopStartSec?: number
  loopEndSec?: number
  onSetLoopRegion?: (startSec: number, endSec: number) => void
}

type Marker = {
  positionPx: number
  label?: string
}

const TimelineRuler: Component<TimelineRulerProps> = (props) => {
  // Use identical math to GridOverlay so lines align perfectly
  const secondsPerBeat = () => 60 / Math.max(1e-6, props.bpm || 0)
  const secondsPerBar = () => secondsPerBeat() * 4
  const gridStepSec = () => secondsPerBeat() * (4 / Math.max(1, props.denom || 4))

  const gridStepPx = () => Math.max(0.5, gridStepSec() * PPS)
  const barStepPx = () => Math.max(0.5, secondsPerBar() * PPS)

  const rulerWidthPx = () => Math.max(0, props.durationSec * PPS)
  const loopStartPx = () => Math.max(0, (props.loopStartSec ?? 0) * PPS)
  const loopEndPx = () => Math.min(rulerWidthPx(), Math.max(loopStartPx(), (props.loopEndSec ?? 0) * PPS))
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
    listenersAttached = false
  }

  const attachPointerListeners = () => {
    if (listenersAttached) return
    try { window.addEventListener('pointermove', onPointerMove) } catch {}
    try { window.addEventListener('pointerup', onPointerUp) } catch {}
    listenersAttached = true
  }

  const clientXToSecLocal = (clientX: number) => {
    const rect = rootEl?.getBoundingClientRect()
    if (!rect) return 0
    const x = clientX - rect.left
    return Math.max(0, x / PPS)
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

  const onLocalMouseDown = (e: MouseEvent) => {
    // Defer to scrub handler if we lack a loop setter or click is in lower half
    const rect = rootEl?.getBoundingClientRect()
    const inTopHalf = rect ? (e.clientY - rect.top) <= (RULER_HEIGHT / 2) : true
    if (!props.onSetLoopRegion || !inTopHalf || !props.loopEnabled) { props.onMouseDown?.(e); return }
    if (e.button !== 0) { props.onMouseDown?.(e); return }

    const sec = clientXToSecLocal(e.clientX)
    const startPx = loopStartPx()
    const endPx = loopEndPx()
    const xPx = (sec * PPS)
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
  const onLocalMouseMove = (e: MouseEvent) => {
    if (!rootEl) return
    const rect = rootEl.getBoundingClientRect()
    const inTopHalf = (e.clientY - rect.top) <= (RULER_HEIGHT / 2)
    if (!inTopHalf || !props.loopEnabled) { rootEl.style.cursor = '' ; return }
    const sec = clientXToSecLocal(e.clientX)
    const xPx = sec * PPS
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

  const onLocalMouseLeave = () => {
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
            rgba(255,255,255,0.24) 0px,
            rgba(255,255,255,0.24) 2px,
            transparent 2px,
            transparent ${major}px
          ),
          #171717`
      } as const
    }

    const fiveSecPx = PPS * 5
    return {
      background: `
        /* 5s lines */
        repeating-linear-gradient(
          to right,
          rgba(255,255,255,0.20) 0px,
          rgba(255,255,255,0.20) 2px,
          transparent 2px,
          transparent ${fiveSecPx}px
        ),
        #171717`
    } as const
  }

  const majorMarkers = () => {
    if (props.gridEnabled) {
      const step = secondsPerBar()
      if (!(Number.isFinite(step) && step > 0)) return [] as Marker[]
      const count = Math.ceil(props.durationSec / step)
      return Array.from({ length: count + 1 }, (_, idx) => {
        const positionPx = idx * step * PPS
        if (positionPx > rulerWidthPx()) return null
        return { positionPx, label: `${idx + 1}` }
      }).filter(Boolean) as Marker[]
    }

    const step = 5
    const count = Math.ceil(props.durationSec / step)
    return Array.from({ length: count + 1 }, (_, idx) => {
      const positionPx = idx * step * PPS
      if (positionPx > rulerWidthPx()) return null
      const seconds = idx * step
      return { positionPx, label: `${seconds}s` }
    }).filter(Boolean) as Marker[]
  }

  const minorMarkers = () => {
    const majors = majorMarkers()
    const majorLookup = new Set(majors.map(m => Math.round(m.positionPx)))

    if (props.gridEnabled) {
      const stepSec = gridStepSec()
      if (!(Number.isFinite(stepSec) && stepSec > 0)) return [] as Marker[]
      const count = Math.ceil(props.durationSec / stepSec)
      return Array.from({ length: count + 1 }, (_, idx) => {
        const positionPx = idx * stepSec * PPS
        if (positionPx > rulerWidthPx()) return null
        if (majorLookup.has(Math.round(positionPx))) return null
        return { positionPx }
      }).filter(Boolean) as Marker[]
    }

    const count = Math.ceil(props.durationSec)
    return Array.from({ length: count + 1 }, (_, idx) => {
      const positionPx = idx * PPS
      if (positionPx > rulerWidthPx()) return null
      if (majorLookup.has(Math.round(positionPx))) return null
      return { positionPx }
    }).filter(Boolean) as Marker[]
  }

  return (
    <div
      class="sticky top-0 z-20 border-b border-neutral-800 bg-neutral-900"
      style={{ width: `${rulerWidthPx()}px`, height: `${RULER_HEIGHT}px`, ...backgroundStyle() }}
      ref={el => { rootEl = el }}
      onMouseDown={onLocalMouseDown as any}
      onMouseMove={onLocalMouseMove as any}
      onMouseLeave={onLocalMouseLeave as any}
    >
      <Show when={showLoop()}>
        <div
          class="absolute top-0 bottom-0 bg-green-400/10 border-y border-green-400/40"
          style={{ left: `${loopStartPx()}px`, width: `${loopWidthPx()}px` }}
        />
      </Show>
      <For each={minorMarkers()}>
        {(marker) => (
          <div
            class="absolute top-0 w-px bg-neutral-600/60"
            style={{ left: `${marker.positionPx}px`, height: `${RULER_HEIGHT / 2}px` }}
          />
        )}
      </For>
      <For each={majorMarkers()}>
        {(marker) => (
          <div class="absolute bottom-0" style={{ left: `${marker.positionPx}px` }}>
            <div class="w-[2px] bg-neutral-200/80" style={{ height: `${RULER_HEIGHT}px` }} />
            <div class="absolute -top-5 text-[10px] font-medium text-neutral-300 select-none">
              {marker.label}
            </div>
          </div>
        )}
      </For>
    </div>
  )
}

export default TimelineRuler