import { DraggableDeviceGraph, handleGraphKeyDelta } from '~/components/effects/draggable-device-graph'
import type { AutoFilterParams } from '@daw-browser/shared'
import {
  autoFilterFrequencyX,
  autoFilterResonanceY,
  autoFilterResponsePath,
  autoFilterXFrequency,
  autoFilterYResonance,
} from '~/components/effects/auto-filter-view'

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

// The filter's response with one handle: across moves the cutoff, up and down the resonance.
export default function AutoFilterGraph(props: {
  params: AutoFilterParams
  disabled: boolean
  onChange: (updates: Partial<AutoFilterParams>) => void
}) {
  const setCutoff = (frequencyHz: number) => props.onChange({ frequencyHz: clamp(frequencyHz, 20, 20_000) })
  const setResonance = (resonance: number) => props.onChange({ resonance: clamp(resonance, 0, 1) })

  return (
    <DraggableDeviceGraph
      disabled={props.disabled}
      path={() => autoFilterResponsePath(props.params)}
      class="h-[116px]"
      patternWidth={30}
      patternHeight={14}
      stroke="#22d3ee"
      handles={[{
        label: 'Auto Filter cutoff and resonance',
        x: () => autoFilterFrequencyX(props.params.frequencyHz),
        y: () => autoFilterResonanceY(props.params.resonance),
        onDrag: (point) => {
          props.onChange({
            frequencyHz: autoFilterXFrequency(point.x),
            resonance: autoFilterYResonance(point.y),
          })
        },
        onKeyDown: (event) => handleGraphKeyDelta(event, {
          ArrowRight: () => setCutoff(props.params.frequencyHz * 1.05),
          ArrowLeft: () => setCutoff(props.params.frequencyHz / 1.05),
          PageUp: () => setCutoff(props.params.frequencyHz * 1.5),
          PageDown: () => setCutoff(props.params.frequencyHz / 1.5),
          ArrowUp: () => setResonance(props.params.resonance + 0.02),
          ArrowDown: () => setResonance(props.params.resonance - 0.02),
          Home: () => setResonance(0),
          End: () => setResonance(1),
        }),
      }]}
    />
  )
}
