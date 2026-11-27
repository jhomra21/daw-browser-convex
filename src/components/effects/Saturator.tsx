import { Show } from 'solid-js'
import EffectShell from '~/components/effects/EffectShell'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { DraggableDeviceGraph } from '~/components/effects/draggable-device-graph'
import { ChoiceMenu, DeviceToggleButton } from '~/components/ui/device-control'
import {
  createDefaultSaturatorParams,
  evaluateSaturatorCurvePoint,
  saturatorLatencyFrames,
  SATURATOR_BASS_THRESHOLD_DB_MAX,
  SATURATOR_BASS_THRESHOLD_DB_MIN,
  SATURATOR_COLOR_DB_MAX,
  SATURATOR_COLOR_DB_MIN,
  SATURATOR_COLOR_FREQUENCY_HZ_MAX,
  SATURATOR_COLOR_FREQUENCY_HZ_MIN,
  SATURATOR_COLOR_WIDTH_MAX,
  SATURATOR_COLOR_WIDTH_MIN,
  SATURATOR_DRIVE_DB_MAX,
  SATURATOR_DRIVE_DB_MIN,
  SATURATOR_DRY_WET_MAX,
  SATURATOR_DRY_WET_MIN,
  SATURATOR_OUTPUT_DB_MAX,
  SATURATOR_OUTPUT_DB_MIN,
  SATURATOR_WARP_DEPTH_MAX,
  SATURATOR_WARP_DEPTH_MIN,
  SATURATOR_WARP_PERIOD_MAX,
  SATURATOR_WARP_PERIOD_MIN,
  type SaturatorCurve,
  type SaturatorParams,
  type SaturatorPostClip,
} from '@daw-browser/shared'
import { cn } from '~/lib/utils'
import { formatDeviceDb, formatDeviceFrequency, formatDevicePercent } from '~/lib/device-value-format'

type SaturatorProps = {
  params: SaturatorParams
  onChange: (updates: Partial<SaturatorParams>) => void
  onToggleEnabled?: (enabled: boolean) => void
  onReset?: () => void
  class?: string
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}

const defaults = createDefaultSaturatorParams()

const CURVES: readonly { value: SaturatorCurve; label: string }[] = [
  { value: 'soft', label: 'Soft' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
  { value: 'clip', label: 'Clip' },
  { value: 'analog', label: 'Analog' },
  { value: 'sine', label: 'Sine' },
  { value: 'bass', label: 'Bass Shaper' },
  { value: 'fold', label: 'Fold' },
  { value: 'warp', label: 'Warp' },
]

const POST_CLIPS: readonly { value: SaturatorPostClip; label: string }[] = [
  { value: 'off', label: 'No Clip' },
  { value: 'soft', label: 'Soft Clip' },
  { value: 'hard', label: 'Hard Clip' },
]

// The curve display is the transfer function over full-scale input, 180 by 58 units like every DraggableDeviceGraph: x is the input
// from -1 to 1, y the output from -1 to 1, with the output held to the graph's own 1.25 headroom.
const GRAPH_WIDTH = 180
const GRAPH_HEIGHT = 58
const HEADROOM = 1.25

// What the kernel does to a sample: the drive, then the curve, then Post Clip (Soft is the Analog knee, Hard the clip).
const curvePath = (params: SaturatorParams) => {
  const driveGain = 10 ** (params.driveDb / 20)

  return Array.from({ length: GRAPH_WIDTH + 1 }, (_, x) => {
    const curved = evaluateSaturatorCurvePoint(params.curve, (x / GRAPH_WIDTH * 2 - 1) * driveGain, params)
    const clipped = params.postClip === 'off' ? curved : evaluateSaturatorCurvePoint(params.postClip === 'soft' ? 'analog' : 'clip', curved)
    const y = GRAPH_HEIGHT / 2 - Math.min(HEADROOM, Math.max(-HEADROOM, clipped)) * GRAPH_HEIGHT / 2

    return `${x === 0 ? 'M' : 'L'} ${x} ${y.toFixed(2)}`
  }).join(' ')
}

export default function Saturator(props: SaturatorProps) {
  const off = () => !props.params.enabled

  return (
    <EffectShell
      title="Saturator"
      typeLabel="Audio"
      enabled={props.params.enabled}
      onToggleEnabled={props.onToggleEnabled}
      onReset={props.onReset}
      titleActions={<DeviceToggleButton label="HQ" ariaLabel={`Hi-Quality: 2x oversampling, adds ${saturatorLatencyFrames(true, props.params.postClip)} frames of latency`} active={props.params.hiQuality} disabled={off()} class="px-2" onClick={() => props.onChange({ hiQuality: !props.params.hiQuality })} />}
      class={cn('w-[460px] min-w-[460px]', props.class)}
    >
      <div class={cn('grid min-h-0 flex-1 grid-cols-[13rem_minmax(0,1fr)] gap-3 px-3 py-2', off() && 'opacity-70')}>
        <section class="flex min-h-0 min-w-0 flex-col gap-1" aria-label="Curve">
          <ChoiceMenu label="Curve" choices={CURVES} value={props.params.curve} disabled={off()} onSelect={(curve) => props.onChange({ curve })} />
          <DraggableDeviceGraph
            disabled={off()}
            class="h-auto min-h-0 flex-1"
            stroke="#22d3ee"
            path={() => curvePath(props.params)}
            handles={[]}
          >
            <line x1="0" y1={GRAPH_HEIGHT / 2} x2={GRAPH_WIDTH} y2={GRAPH_HEIGHT / 2} stroke="#404040" stroke-width="1" vector-effect="non-scaling-stroke" />
            <line x1={GRAPH_WIDTH / 2} y1="0" x2={GRAPH_WIDTH / 2} y2={GRAPH_HEIGHT} stroke="#404040" stroke-width="1" vector-effect="non-scaling-stroke" />
            <line x1="0" y1={GRAPH_HEIGHT} x2={GRAPH_WIDTH} y2="0" stroke="#525252" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" />
          </DraggableDeviceGraph>
          <div class="grid grid-cols-[minmax(0,1fr)_3.5rem] gap-1">
            <ChoiceMenu label="Post Clip" choices={POST_CLIPS} value={props.params.postClip} disabled={off()} onSelect={(postClip) => props.onChange({ postClip })} />
            <DeviceToggleButton label="Color" active={props.params.color} disabled={off()} onClick={() => props.onChange({ color: !props.params.color })} />
          </div>
        </section>

        <section class="grid min-w-0 grid-cols-3 content-start items-start justify-items-center gap-y-1" aria-label="Controls">
          <AutomatedKnob size={32} label="Drive" valueLabel={formatDeviceDb(props.params.driveDb, 1)} value={props.params.driveDb} resetValue={defaults.driveDb} min={SATURATOR_DRIVE_DB_MIN} max={SATURATOR_DRIVE_DB_MAX} step={0.1} disabled={off()} parameterId="saturator.driveDb" automation={props} onValueChange={(driveDb) => props.onChange({ driveDb })} />
          <AutomatedKnob size={32} label="Output" valueLabel={formatDeviceDb(props.params.outputDb, 1, true)} value={props.params.outputDb} resetValue={defaults.outputDb} min={SATURATOR_OUTPUT_DB_MIN} max={SATURATOR_OUTPUT_DB_MAX} step={0.1} bipolar disabled={off()} parameterId="saturator.outputDb" automation={props} onValueChange={(outputDb) => props.onChange({ outputDb })} />
          <AutomatedKnob size={32} label="Dry/Wet" valueLabel={formatDevicePercent(props.params.dryWet)} value={props.params.dryWet} resetValue={defaults.dryWet} min={SATURATOR_DRY_WET_MIN} max={SATURATOR_DRY_WET_MAX} step={0.01} disabled={off()} parameterId="saturator.dryWet" automation={props} onValueChange={(dryWet) => props.onChange({ dryWet })} />
          {/* Each curve's own knobs exist only on that curve, and Color's only while Color is on. */}
          <Show when={props.params.curve === 'bass'}>
            <AutomatedKnob size={32} label="Threshold" valueLabel={formatDeviceDb(props.params.bassThresholdDb, 1)} value={props.params.bassThresholdDb} resetValue={defaults.bassThresholdDb} min={SATURATOR_BASS_THRESHOLD_DB_MIN} max={SATURATOR_BASS_THRESHOLD_DB_MAX} step={0.1} disabled={off()} parameterId="saturator.bassThresholdDb" automation={props} onValueChange={(bassThresholdDb) => props.onChange({ bassThresholdDb })} />
          </Show>
          <Show when={props.params.curve === 'warp'}>
            <AutomatedKnob size={32} label="Depth" ariaLabel="Warp Depth" valueLabel={formatDevicePercent(props.params.warpDepth)} value={props.params.warpDepth} resetValue={defaults.warpDepth} min={SATURATOR_WARP_DEPTH_MIN} max={SATURATOR_WARP_DEPTH_MAX} step={0.01} disabled={off()} parameterId="saturator.warpDepth" automation={props} onValueChange={(warpDepth) => props.onChange({ warpDepth })} />
            <AutomatedKnob size={32} label="Period" ariaLabel="Warp Period" valueLabel={props.params.warpPeriod.toFixed(2)} value={props.params.warpPeriod} resetValue={defaults.warpPeriod} min={SATURATOR_WARP_PERIOD_MIN} max={SATURATOR_WARP_PERIOD_MAX} step={0.01} disabled={off()} parameterId="saturator.warpPeriod" automation={props} onValueChange={(warpPeriod) => props.onChange({ warpPeriod })} />
          </Show>
          <Show when={props.params.color}>
            <AutomatedKnob size={32} label="Freq" ariaLabel="Color Frequency" valueLabel={formatDeviceFrequency(props.params.colorFrequencyHz, 2)} value={props.params.colorFrequencyHz} resetValue={defaults.colorFrequencyHz} min={SATURATOR_COLOR_FREQUENCY_HZ_MIN} max={SATURATOR_COLOR_FREQUENCY_HZ_MAX} step={1} logarithmic disabled={off()} parameterId="saturator.colorFrequencyHz" automation={props} onValueChange={(colorFrequencyHz) => props.onChange({ colorFrequencyHz })} />
            <AutomatedKnob size={32} label="Width" ariaLabel="Color Width" valueLabel={formatDevicePercent(props.params.colorWidth)} value={props.params.colorWidth} resetValue={defaults.colorWidth} min={SATURATOR_COLOR_WIDTH_MIN} max={SATURATOR_COLOR_WIDTH_MAX} step={0.01} disabled={off()} parameterId="saturator.colorWidth" automation={props} onValueChange={(colorWidth) => props.onChange({ colorWidth })} />
            <AutomatedKnob size={32} label="Amt Lo" valueLabel={formatDeviceDb(props.params.colorLowDb, 1, true)} value={props.params.colorLowDb} resetValue={defaults.colorLowDb} min={SATURATOR_COLOR_DB_MIN} max={SATURATOR_COLOR_DB_MAX} step={0.1} bipolar disabled={off()} parameterId="saturator.colorLowDb" automation={props} onValueChange={(colorLowDb) => props.onChange({ colorLowDb })} />
            <AutomatedKnob size={32} label="Amt Hi" valueLabel={formatDeviceDb(props.params.colorHighDb, 1, true)} value={props.params.colorHighDb} resetValue={defaults.colorHighDb} min={SATURATOR_COLOR_DB_MIN} max={SATURATOR_COLOR_DB_MAX} step={0.1} bipolar disabled={off()} parameterId="saturator.colorHighDb" automation={props} onValueChange={(colorHighDb) => props.onChange({ colorHighDb })} />
          </Show>
        </section>
      </div>
    </EffectShell>
  )
}
