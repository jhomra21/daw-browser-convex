import { type Component, Show } from 'solid-js'
import { PPS } from '~/lib/timeline-utils'

type GridOverlayProps = {
  durationSec: number
  heightPx: number
  bpm: number
  denom: number
  enabled: boolean
}

const GridOverlay: Component<GridOverlayProps> = (props) => {
  const secondsPerBeat = () => 60 / Math.max(1e-6, props.bpm || 0)
  const gridStepSec = () => secondsPerBeat() * (4 / Math.max(1, props.denom || 4))
  // Use fractional pixels to avoid cumulative drift at high resolutions (e.g., 1/16 at 120 BPM => 12.5px)
  const gridStepPx = () => Math.max(0.5, gridStepSec() * PPS)
  const barStepPx = () => Math.max(0.5, secondsPerBeat() * 4 * PPS)

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
          rgba(255,255,255,0.08) 0px,
          rgba(255,255,255,0.08) 1px,
          transparent 1px,
          transparent ${minor}px
        ),
        /* Major bar lines anchored at 0 so they align with top verticals */
        repeating-linear-gradient(
          to right,
          rgba(255,255,255,0.16) 0px,
          rgba(255,255,255,0.16) 2px,
          transparent 2px,
          transparent ${major}px
        )`
    } as any
  }

  return (
    <Show when={props.enabled}>
      <div
        class="absolute left-0 top-0 pointer-events-none"
        style={{
          width: `${Math.max(0, props.durationSec * PPS)}px`,
          height: `${props.heightPx}px`,
          ...backgroundStyle(),
        }}
      />
    </Show>
  )
}

export default GridOverlay
