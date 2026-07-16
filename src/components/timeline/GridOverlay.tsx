import { createMemo, type Component, Show } from 'solid-js'
import { selectTimelineGridIntervals } from '~/lib/timeline-view'

type GridOverlayProps = {
  durationSec: number
  bpm: number
  denom: number
  enabled: boolean
  pixelsPerSecond: number
}

const GridOverlay: Component<GridOverlayProps> = (props) => {
  const intervals = createMemo(() => selectTimelineGridIntervals(props.pixelsPerSecond, props.bpm, props.denom, props.enabled))
  const gridStepPx = () => Math.max(0.5, intervals().minorSec * props.pixelsPerSecond)
  const barStepPx = () => Math.max(0.5, intervals().majorSec * props.pixelsPerSecond)

  const backgroundStyle = () => {
    const minor = gridStepPx()
    const major = barStepPx()
    // Two repeating gradients: minor (thin, faint) and major (thicker, brighter)
    // Use transparent background so underlying content remains visible
    return {
      background: `
        /* Minor grid lines */
        repeating-linear-gradient(
          to right,
          var(--timeline-grid-minor) 0px,
          var(--timeline-grid-minor) 1px,
          transparent 1px,
          transparent ${minor}px
        ),
        /* Major bar lines anchored at 0 so they align with top verticals */
        repeating-linear-gradient(
          to right,
          var(--timeline-grid-major) 0px,
          var(--timeline-grid-major) 2px,
          transparent 2px,
          transparent ${major}px
        )`
    }
  }

  return (
    <Show when={props.enabled}>
      <div
        class="absolute left-0 top-0 pointer-events-none z-10"
        style={{
          width: `${Math.max(0, props.durationSec * props.pixelsPerSecond)}px`,
          height: '100%',
          ...backgroundStyle(),
        }}
      />
    </Show>
  )
}

export default GridOverlay
