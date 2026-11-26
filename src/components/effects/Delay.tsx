import { For, Show } from 'solid-js'
import EffectShell from '~/components/effects/EffectShell'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { DraggableDeviceGraph, handleGraphKeyDelta } from '~/components/effects/draggable-device-graph'
import { ChoiceMenu, DeviceToggleButton, DeviceValueStrip } from '~/components/ui/device-control'
import {
  createDefaultDelayParams,
  DELAY_DRY_WET_MAX,
  DELAY_DRY_WET_MIN,
  DELAY_FEEDBACK_MAX,
  DELAY_FEEDBACK_MIN,
  DELAY_FILTER_HZ_MAX,
  DELAY_FILTER_HZ_MIN,
  DELAY_FILTER_WIDTH_MAX,
  DELAY_FILTER_WIDTH_MIN,
  DELAY_OFFSET_PERCENT_MAX,
  DELAY_OFFSET_PERCENT_MIN,
  DELAY_TIME_MS_MAX,
  DELAY_TIME_MS_MIN,
  type DelayFeel,
  type DelayParams,
  type DelaySmoothing,
  type DelaySyncDivision,
} from '@daw-browser/shared'
import { cn } from '~/lib/utils'
import { formatDeviceFrequency, formatDeviceMilliseconds, formatDevicePercent } from '~/lib/device-value-format'

type DelayProps = {
  params: DelayParams
  onChange: (updates: Partial<DelayParams>) => void
  onToggleEnabled?: (enabled: boolean) => void
  onReset?: () => void
  class?: string
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}

const defaults = createDefaultDelayParams()
const DIVISIONS: readonly DelaySyncDivision[] = ['1/32', '1/16', '1/8', '1/4', '1/2', '1/1']

const FEEL_CHOICES: readonly { value: DelayFeel; label: string }[] = [
  { value: 'straight', label: 'Straight' },
  { value: 'dotted', label: 'Dotted' },
  { value: 'triplet', label: 'Triplet' },
]

const SMOOTHINGS: readonly { value: DelaySmoothing; label: string }[] = [
  { value: 'repitch', label: 'Repitch' },
  { value: 'fade', label: 'Fade' },
  { value: 'jump', label: 'Jump' },
]

// The filter graph is a log frequency axis, 20 Hz to 20 kHz, over the 180 by 58 units of DraggableDeviceGraph.
const GRAPH_WIDTH = 180
const GRAPH_HEIGHT = 58
const CURVE_STEPS = 48
const DB_BOTTOM = -36

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const hzToX = (hz: number) => Math.log(hz / DELAY_FILTER_HZ_MIN) / Math.log(DELAY_FILTER_HZ_MAX / DELAY_FILTER_HZ_MIN) * GRAPH_WIDTH
const xToHz = (x: number) => DELAY_FILTER_HZ_MIN * (DELAY_FILTER_HZ_MAX / DELAY_FILTER_HZ_MIN) ** (x / GRAPH_WIDTH)
// A wider filter sits higher on the graph.

const widthToY = (width: number) => (DELAY_FILTER_WIDTH_MAX - width) / (DELAY_FILTER_WIDTH_MAX - DELAY_FILTER_WIDTH_MIN) * GRAPH_HEIGHT
const yToWidth = (y: number) => DELAY_FILTER_WIDTH_MAX - y / GRAPH_HEIGHT * (DELAY_FILTER_WIDTH_MAX - DELAY_FILTER_WIDTH_MIN)

// The kernel's band-pass: constant 0 dB peak, with a bandwidth in octaves.
const bandPassDb = (hz: number, centerHz: number, widthOctaves: number) => {
  const q = 1 / (2 * Math.sinh(Math.LN2 / 2 * widthOctaves))
  const detune = hz / centerHz - centerHz / hz

  return -10 * Math.log10(1 + q * q * detune * detune)
}

const curvePath = (centerHz: number, widthOctaves: number) =>
  Array.from({ length: CURVE_STEPS + 1 }, (_, step) => {
    const x = step / CURVE_STEPS * GRAPH_WIDTH
    const y = -clamp(bandPassDb(xToHz(x), centerHz, widthOctaves), DB_BOTTOM, 0) / -DB_BOTTOM * GRAPH_HEIGHT

    return `${step === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(2)}`
  }).join(' ')

const percentOffset = (value: number) => `${Math.round(value)} %`

type ChannelProps = {
  title: string
  disabled: boolean
  sync: boolean
  division: DelaySyncDivision
  feel: DelayFeel
  timeMs: number
  defaultTimeMs: number
  offsetPercent: number
  timeParameterId: string
  offsetParameterId: string
  automation: Pick<DelayProps, 'automationRangesByParameterId' | 'onAutomationParameterTouch' | 'onManualAutomationOverride'>
  onSync: (sync: boolean) => void
  onDivision: (division: DelaySyncDivision) => void
  onFeel: (feel: DelayFeel) => void
  onTime: (timeMs: number) => void
  onOffset: (offsetPercent: number) => void
}

function DelayChannel(props: ChannelProps) {
  return (
    <section class="flex min-w-0 flex-col items-stretch gap-1" aria-label={props.title}>
      <h3 class="h-4 text-center text-xs font-semibold leading-none text-muted-foreground">{props.title}</h3>
      <div class="grid grid-cols-2 gap-1">
        <DeviceToggleButton label="Sync" ariaLabel={`${props.title} Sync`} active={props.sync} disabled={props.disabled} onClick={() => props.onSync(true)} />
        <DeviceToggleButton label="Time" ariaLabel={`${props.title} Time`} active={!props.sync} disabled={props.disabled} onClick={() => props.onSync(false)} />
      </div>
      <Show
        when={props.sync}
        fallback={
          <div class="flex h-[72px] items-center justify-center">
            <AutomatedKnob size={32} label="Time" ariaLabel={`${props.title} Time knob`} valueLabel={formatDeviceMilliseconds(props.timeMs, 0)} value={props.timeMs} resetValue={props.defaultTimeMs} min={DELAY_TIME_MS_MIN} max={DELAY_TIME_MS_MAX} step={1} logarithmic disabled={props.disabled} parameterId={props.timeParameterId} automation={props.automation} onValueChange={props.onTime} />
          </div>
        }
      >
        <div class="flex h-[72px] flex-col gap-1">
          <div class="grid grid-cols-3 gap-1">
            <For each={DIVISIONS}>
              {(division) => (
                <DeviceToggleButton label={division} ariaLabel={`${props.title} ${division}`} active={props.division === division} disabled={props.disabled} onClick={() => props.onDivision(division)} />
              )}
            </For>
          </div>
          <ChoiceMenu label={`${props.title} Feel`} choices={FEEL_CHOICES} value={props.feel} disabled={props.disabled} onSelect={props.onFeel} />
        </div>
      </Show>
      <div class="flex justify-center">
        <AutomatedKnob size={26} label="Offset" ariaLabel={`${props.title} Offset`} valueLabel={percentOffset(props.offsetPercent)} value={props.offsetPercent} resetValue={0} min={DELAY_OFFSET_PERCENT_MIN} max={DELAY_OFFSET_PERCENT_MAX} step={1} bipolar disabled={props.disabled || !props.sync} parameterId={props.offsetParameterId} automation={props.automation} onValueChange={props.onOffset} />
      </div>
    </section>
  )
}

const filterKeys = (params: () => DelayParams, change: (updates: Partial<DelayParams>) => void) => (event: KeyboardEvent) => handleGraphKeyDelta(event, {
  ArrowRight: () => change({ filterHz: Math.round(clamp(params().filterHz * 1.05, DELAY_FILTER_HZ_MIN, DELAY_FILTER_HZ_MAX)) }),
  ArrowLeft: () => change({ filterHz: Math.round(clamp(params().filterHz / 1.05, DELAY_FILTER_HZ_MIN, DELAY_FILTER_HZ_MAX)) }),
  ArrowUp: () => change({ filterWidth: clamp(params().filterWidth + 0.1, DELAY_FILTER_WIDTH_MIN, DELAY_FILTER_WIDTH_MAX) }),
  ArrowDown: () => change({ filterWidth: clamp(params().filterWidth - 0.1, DELAY_FILTER_WIDTH_MIN, DELAY_FILTER_WIDTH_MAX) }),
})

export default function Delay(props: DelayProps) {
  const off = () => !props.params.enabled
  const filterOff = () => off() || !props.params.filterEnabled

  // A handle drag moves automatable params without going through a knob, so it reports the override itself.
  const changeFromGraph = (updates: Partial<DelayParams>) => {
    for (const key of Object.keys(updates)) props.onManualAutomationOverride?.(`delay.${key}`)
    props.onChange(updates)
  }

  return (
    <EffectShell
      title="Delay"
      typeLabel="Stereo"
      enabled={props.params.enabled}
      onToggleEnabled={props.onToggleEnabled}
      onReset={props.onReset}
      class={cn('w-[640px] min-w-[640px]', props.class)}
    >
      <div class={cn('grid min-h-0 flex-1 grid-cols-[17.5rem_minmax(0,1fr)_5rem] gap-2 px-3 py-2', off() && 'opacity-70')}>
        <div class="flex min-h-0 min-w-0 flex-col gap-1">
          <div class="grid grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)] gap-1">
            <DelayChannel
              title="Left"
              disabled={off()}
              sync={props.params.syncLeft}
              division={props.params.divisionLeft}
              feel={props.params.feelLeft}
              timeMs={props.params.timeLeftMs}
              defaultTimeMs={defaults.timeLeftMs}
              offsetPercent={props.params.offsetLeftPercent}
              timeParameterId="delay.timeMs"
              offsetParameterId="delay.offsetLeftPercent"
              automation={props}
              onSync={(syncLeft) => props.onChange({ syncLeft })}
              onDivision={(divisionLeft) => props.onChange({ divisionLeft })}
              onFeel={(feelLeft) => props.onChange({ feelLeft })}
              onTime={(timeLeftMs) => props.onChange({ timeLeftMs })}
              onOffset={(offsetLeftPercent) => props.onChange({ offsetLeftPercent })}
            />
            <div class="flex items-center">
              <DeviceToggleButton class="w-full" label="Link" ariaLabel="Link channels" active={props.params.link} disabled={off()} onClick={() => props.onChange({ link: !props.params.link })} />
            </div>
            <DelayChannel
              title="Right"
              disabled={off() || props.params.link}
              sync={props.params.syncRight}
              division={props.params.divisionRight}
              feel={props.params.feelRight}
              timeMs={props.params.timeRightMs}
              defaultTimeMs={defaults.timeRightMs}
              offsetPercent={props.params.offsetRightPercent}
              timeParameterId="delay.timeRightMs"
              offsetParameterId="delay.offsetRightPercent"
              automation={props}
              onSync={(syncRight) => props.onChange({ syncRight })}
              onDivision={(divisionRight) => props.onChange({ divisionRight })}
              onFeel={(feelRight) => props.onChange({ feelRight })}
              onTime={(timeRightMs) => props.onChange({ timeRightMs })}
              onOffset={(offsetRightPercent) => props.onChange({ offsetRightPercent })}
            />
          </div>
          <section class="flex items-center justify-around gap-2 pt-1" aria-label="Feedback and Freeze">
            <AutomatedKnob size={26} label="Feedback" valueLabel={formatDevicePercent(props.params.feedback)} value={props.params.feedback} resetValue={defaults.feedback} min={DELAY_FEEDBACK_MIN} max={DELAY_FEEDBACK_MAX} step={0.01} disabled={off()} parameterId="delay.feedback" automation={props} onValueChange={(feedback) => props.onChange({ feedback })} />
            <DeviceToggleButton class="w-16" label="Freeze" active={props.params.freeze} disabled={off()} onClick={() => props.onChange({ freeze: !props.params.freeze })} />
          </section>
        </div>

        <section class="flex min-h-0 min-w-0 flex-col gap-1 pt-5" aria-label="Filter">
          <DraggableDeviceGraph
            disabled={filterOff()}
            class="h-[116px]"
            stroke="#22d3ee"
            path={() => props.params.filterEnabled ? curvePath(props.params.filterHz, props.params.filterWidth) : `M 0 0 L ${GRAPH_WIDTH} 0`}
            handles={[{
              label: 'Filter frequency and width',
              dimmed: () => !props.params.filterEnabled,
              x: () => hzToX(props.params.filterHz),
              y: () => widthToY(props.params.filterWidth),
              onDrag: (point: { x: number; y: number }) => changeFromGraph({ filterHz: Math.round(clamp(xToHz(point.x), DELAY_FILTER_HZ_MIN, DELAY_FILTER_HZ_MAX)), filterWidth: clamp(Math.round(yToWidth(point.y) * 100) / 100, DELAY_FILTER_WIDTH_MIN, DELAY_FILTER_WIDTH_MAX) }),
              onKeyDown: filterKeys(() => props.params, changeFromGraph),
            }]}
          />
          <div class="grid grid-cols-[3rem_minmax(0,1fr)_minmax(0,1fr)] gap-1">
            <DeviceToggleButton label="Filter" ariaLabel="Filter on" active={props.params.filterEnabled} disabled={off()} onClick={() => props.onChange({ filterEnabled: !props.params.filterEnabled })} />
            <DeviceValueStrip value={formatDeviceFrequency(props.params.filterHz, 2)} />
            <DeviceValueStrip value={props.params.filterWidth.toFixed(2)} />
          </div>
          <div class="grid grid-cols-[3rem_minmax(0,1fr)_minmax(0,1fr)] gap-1 text-2xs leading-none text-muted-foreground">
            <span />
            <span>Freq</span>
            <span>Width</span>
          </div>
        </section>

        <section class="flex min-h-0 min-w-0 flex-col justify-between gap-1" aria-label="Output">
          <div class="flex flex-col gap-1">
            <h3 class="h-4 text-center text-xs font-semibold leading-none text-muted-foreground">Smoothing</h3>
            <For each={SMOOTHINGS}>
              {(smoothing) => (
                <DeviceToggleButton label={smoothing.label} active={props.params.smoothing === smoothing.value} disabled={off()} onClick={() => props.onChange({ smoothing: smoothing.value })} />
              )}
            </For>
          </div>
          <DeviceToggleButton label="Ping Pong" active={props.params.pingPong} disabled={off()} onClick={() => props.onChange({ pingPong: !props.params.pingPong })} />
          <div class="flex justify-center">
            <AutomatedKnob size={32} label="Dry/Wet" valueLabel={formatDevicePercent(props.params.dryWet)} value={props.params.dryWet} resetValue={defaults.dryWet} min={DELAY_DRY_WET_MIN} max={DELAY_DRY_WET_MAX} step={0.01} disabled={off()} parameterId="delay.dryWet" automation={props} onValueChange={(dryWet) => props.onChange({ dryWet })} />
          </div>
        </section>
      </div>
    </EffectShell>
  )
}
