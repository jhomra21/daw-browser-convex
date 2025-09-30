import { type Component, For } from 'solid-js'
import { PPS, RULER_HEIGHT } from '~/lib/timeline-utils'

type TimelineRulerProps = {
  durationSec: number
  bpm: number
  denom: number
  gridEnabled: boolean
  onMouseDown: (e: MouseEvent) => void
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

  const backgroundStyle = () => {
    if (props.gridEnabled) {
      const major = barStepPx()
      const minor = gridStepPx()
      return {
        background: `
          /* Minor beat lines (subtle) */
          repeating-linear-gradient(
            to right,
            rgba(255,255,255,0.08) 0px,
            rgba(255,255,255,0.08) 1px,
            transparent 1px,
            transparent ${minor}px
          ),
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
      class="absolute left-0 right-0 top-0 border-b border-neutral-800 bg-neutral-900"
      onMouseDown={props.onMouseDown}
      style={{ width: `${rulerWidthPx()}px`, height: `${RULER_HEIGHT}px`, ...backgroundStyle() }}
    >
      <For each={minorMarkers()}>
        {(marker) => (
          <div
            class="absolute bottom-0 w-px bg-neutral-600/60"
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