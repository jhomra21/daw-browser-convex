import EffectShell from '~/components/effects/EffectShell'
import { DraggableDeviceGraph, handleGraphKeyDelta } from '~/components/effects/draggable-device-graph'
import { DeviceToggleButton, DeviceValueStrip } from '~/components/ui/device-control'
import Knob from '~/components/ui/knob'
import { For, Show } from 'solid-js'
import {
  createDefaultDelayParams,
  DELAY_DRY_WET_MAX,
  DELAY_DRY_WET_MIN,
  DELAY_FEEDBACK_MAX,
  DELAY_FEEDBACK_MIN,
  DELAY_HIGH_CUT_HZ_MAX,
  DELAY_HIGH_CUT_HZ_MIN,
  DELAY_LOW_CUT_HZ_MAX,
  DELAY_LOW_CUT_HZ_MIN,
  DELAY_TIME_MS_MAX,
  DELAY_TIME_MS_MIN,
  type DelayParams,
  type DelaySyncDivision,
} from '@daw-browser/shared'
import { useSteppedValueControl } from '~/hooks/useSteppedValueControl'
import { cn } from '~/lib/utils'

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

const DEFAULT_PARAMS = createDefaultDelayParams()
const DIVISIONS: DelaySyncDivision[] = ['1/16', '1/8', '1/4', '1/2', '1/1']

const formatPercent = (value: number) => `${Math.round(value * 100)}%`
const formatMs = (value: number) => `${Math.round(value)} ms`
const formatFrequency = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${Math.round(value)} Hz`

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const normalizeLowCut = (value: number, highCutHz: number) => Math.round(clamp(value, DELAY_LOW_CUT_HZ_MIN, Math.min(DELAY_LOW_CUT_HZ_MAX, highCutHz - 1)))
const normalizeHighCut = (value: number, lowCutHz: number) => Math.round(clamp(value, Math.max(DELAY_HIGH_CUT_HZ_MIN, lowCutHz + 1), DELAY_HIGH_CUT_HZ_MAX) / 100) * 100
const frequencyX = (value: number, min: number, max: number) => {
  const normalized = (Math.log10(value) - Math.log10(min)) / (Math.log10(max) - Math.log10(min))
  return clamp(normalized, 0, 1) * 180
}
const pointToFrequency = (x: number) => {
  const normalized = clamp(x / 180, 0, 1)
  const logMin = Math.log10(DELAY_LOW_CUT_HZ_MIN)
  const logMax = Math.log10(DELAY_HIGH_CUT_HZ_MAX)
  return 10 ** (logMin + normalized * (logMax - logMin))
}

function DelayValueStrip(props: {
  label: string
  value: number
  valueLabel: string
  min: number
  max: number
  step: number
  disabled: boolean
  onValueChange: (value: number) => void
}) {
  const control = useSteppedValueControl({
    value: () => props.value,
    min: () => props.min,
    max: () => props.max,
    step: () => props.step,
    disabled: () => props.disabled,
    onValueChange: (value) => props.onValueChange(value),
    valueFromDrag: ({ startValue, startPosition, currentPosition }) => {
      const deltaY = startPosition.y - currentPosition.y
      const logMin = Math.log10(props.min)
      const logMax = Math.log10(props.max)
      const normalizedStart = (Math.log10(startValue) - logMin) / (logMax - logMin)
      const normalizedNext = clamp(normalizedStart + deltaY * 0.005, 0, 1)
      return 10 ** (logMin + normalizedNext * (logMax - logMin))
    },
  })

  return (
    <div
      role="slider"
      tabIndex={props.disabled ? undefined : 0}
      aria-label={props.label}
      aria-disabled={props.disabled}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={control.visualValue()}
      aria-valuetext={props.valueLabel}
      class={props.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-ns-resize'}
      onPointerDown={control.onPointerDown}
      onKeyDown={control.handleKeyDown}
    >
      <DeviceValueStrip value={props.valueLabel} valueClass="text-left" />
    </div>
  )
}

function DelayFilterGraph(props: {
  params: DelayParams
  disabled: boolean
  onLowCutChange: (value: number) => void
  onHighCutChange: (value: number) => void
}) {
  const lowX = () => frequencyX(props.params.lowCutHz, DELAY_LOW_CUT_HZ_MIN, DELAY_HIGH_CUT_HZ_MAX)
  const highX = () => frequencyX(props.params.highCutHz, DELAY_LOW_CUT_HZ_MIN, DELAY_HIGH_CUT_HZ_MAX)
  const onLowCutKeyDown = (event: KeyboardEvent) => handleGraphKeyDelta(event, {
    ArrowRight: () => props.onLowCutChange(props.params.lowCutHz + 10),
    ArrowUp: () => props.onLowCutChange(props.params.lowCutHz + 10),
    ArrowLeft: () => props.onLowCutChange(props.params.lowCutHz - 10),
    ArrowDown: () => props.onLowCutChange(props.params.lowCutHz - 10),
    PageUp: () => props.onLowCutChange(props.params.lowCutHz + 100),
    PageDown: () => props.onLowCutChange(props.params.lowCutHz - 100),
    Home: () => props.onLowCutChange(DELAY_LOW_CUT_HZ_MIN),
    End: () => props.onLowCutChange(DELAY_LOW_CUT_HZ_MAX),
  })
  const onHighCutKeyDown = (event: KeyboardEvent) => handleGraphKeyDelta(event, {
    ArrowRight: () => props.onHighCutChange(props.params.highCutHz + 100),
    ArrowUp: () => props.onHighCutChange(props.params.highCutHz + 100),
    ArrowLeft: () => props.onHighCutChange(props.params.highCutHz - 100),
    ArrowDown: () => props.onHighCutChange(props.params.highCutHz - 100),
    PageUp: () => props.onHighCutChange(props.params.highCutHz + 1000),
    PageDown: () => props.onHighCutChange(props.params.highCutHz - 1000),
    Home: () => props.onHighCutChange(DELAY_HIGH_CUT_HZ_MIN),
    End: () => props.onHighCutChange(DELAY_HIGH_CUT_HZ_MAX),
  })
  const filterPath = () => {
    if (!props.params.filterEnabled) return 'M 0 30 L 180 30'
    return `M 0 48 C ${lowX()} 48 ${lowX()} 30 ${lowX() + 28} 30 L ${highX() - 28} 30 C ${highX()} 30 ${highX()} 48 180 48`
  }

  return (
    <DraggableDeviceGraph
      disabled={props.disabled || !props.params.filterEnabled}
      path={filterPath}
      class="h-[116px]"
      patternWidth={14}
      patternHeight={10}
      stroke="#22d3ee"
      handles={props.params.filterEnabled
        ? [
          {
            label: 'Delay low cut frequency',
            x: lowX,
            y: () => 30,
            onDrag: (point) => props.onLowCutChange(pointToFrequency(point.x)),
            onKeyDown: onLowCutKeyDown,
          },
          {
            label: 'Delay high cut frequency',
            x: highX,
            y: () => 30,
            onDrag: (point) => props.onHighCutChange(pointToFrequency(point.x)),
            onKeyDown: onHighCutKeyDown,
          },
        ]
        : []}
    >
      <line x1="0" y1="29" x2="180" y2="29" stroke="#525252" stroke-width="1" />
    </DraggableDeviceGraph>
  )
}

export default function Delay(props: DelayProps) {
  const timeMode = () => props.params.mode === 'time'
  const automationRange = (parameterId: string) => props.automationRangesByParameterId?.get(parameterId)
  const changeAutomated = (parameterId: string, updates: Partial<DelayParams>) => {
    props.onManualAutomationOverride?.(parameterId)
    props.onChange(updates)
  }
  const updateLowCut = (value: number) => {
    const lowCutHz = normalizeLowCut(value, props.params.highCutHz)
    if (lowCutHz === props.params.lowCutHz) return
    props.onChange({ lowCutHz })
  }
  const updateHighCut = (value: number) => {
    const highCutHz = normalizeHighCut(value, props.params.lowCutHz)
    if (highCutHz === props.params.highCutHz) return
    props.onChange({ highCutHz })
  }

  return (
    <EffectShell
      title="Delay"
      typeLabel="Stereo"
      enabled={props.params.enabled}
      onToggleEnabled={props.onToggleEnabled}
      onReset={props.onReset}
      class={cn('w-[380px] min-w-[380px]', props.class)}
    >
      <div class={cn('flex min-h-0 flex-1 flex-col px-3 py-3', !props.params.enabled && 'opacity-70')}>
        <div class="grid grid-cols-[5.6rem_minmax(0,1fr)_4.75rem] gap-2">
          <div class="flex min-w-0 flex-col gap-2">
            <div class="grid grid-cols-2 gap-1">
              <DeviceToggleButton label="Sync" active={!timeMode()} disabled={!props.params.enabled} onClick={() => props.onChange({ mode: 'sync' })} />
              <DeviceToggleButton label="Time" active={timeMode()} disabled={!props.params.enabled} onClick={() => props.onChange({ mode: 'time' })} />
            </div>
            <Show
              when={timeMode()}
              fallback={
                <div class="grid grid-cols-2 gap-1">
                  <For each={DIVISIONS}>
                    {(syncDivision) => (
                      <DeviceToggleButton
                        label={syncDivision}
                        active={props.params.syncDivision === syncDivision}
                        disabled={!props.params.enabled}
                        onClick={() => props.onChange({ syncDivision })}
                      />
                    )}
                  </For>
                </div>
              }
            >
              <Knob class="py-1" label="Time" valueLabel={formatMs(props.params.timeMs)} value={props.params.timeMs} resetValue={DEFAULT_PARAMS.timeMs} min={DELAY_TIME_MS_MIN} max={DELAY_TIME_MS_MAX} step={1} disabled={!props.params.enabled} automationRange={automationRange('delay.timeMs')} automated={!!automationRange('delay.timeMs')} onAutomationSelect={() => props.onAutomationParameterTouch?.('delay.timeMs')} onValueChange={(timeMs) => changeAutomated('delay.timeMs', { timeMs })} />
            </Show>
          </div>

          <div class="flex min-w-0 flex-col gap-2 rounded-sm border border-neutral-800 bg-neutral-900/70 p-2">
            <DelayFilterGraph
              params={props.params}
              disabled={!props.params.enabled}
              onLowCutChange={updateLowCut}
              onHighCutChange={updateHighCut}
            />
            <div class="grid grid-cols-[4.2rem_minmax(0,1fr)_minmax(0,1fr)] gap-1">
              <DeviceToggleButton label="Filter" active={props.params.filterEnabled} disabled={!props.params.enabled} onClick={() => props.onChange({ filterEnabled: !props.params.filterEnabled })} />
              <DelayValueStrip label="Delay low cut frequency" value={props.params.lowCutHz} valueLabel={formatFrequency(props.params.lowCutHz)} min={DELAY_LOW_CUT_HZ_MIN} max={DELAY_LOW_CUT_HZ_MAX} step={1} disabled={!props.params.enabled || !props.params.filterEnabled} onValueChange={updateLowCut} />
              <DelayValueStrip label="Delay high cut frequency" value={props.params.highCutHz} valueLabel={formatFrequency(props.params.highCutHz)} min={DELAY_HIGH_CUT_HZ_MIN} max={DELAY_HIGH_CUT_HZ_MAX} step={100} disabled={!props.params.enabled || !props.params.filterEnabled} onValueChange={updateHighCut} />
            </div>
          </div>

          <div class="flex min-w-0 flex-col justify-between gap-2">
            <DeviceToggleButton label="Ping Pong" active={props.params.pingPong} disabled={!props.params.enabled} onClick={() => props.onChange({ pingPong: !props.params.pingPong })} />
          </div>
        </div>

        <div class="mt-auto grid grid-cols-4 gap-3 pb-2 pt-3">
          <Knob class="px-1 py-1" label="Low Cut" valueLabel={formatFrequency(props.params.lowCutHz)} value={props.params.lowCutHz} resetValue={DEFAULT_PARAMS.lowCutHz} min={DELAY_LOW_CUT_HZ_MIN} max={DELAY_LOW_CUT_HZ_MAX} step={1} logarithmic disabled={!props.params.enabled || !props.params.filterEnabled} automationRange={automationRange('delay.lowCutHz')} automated={!!automationRange('delay.lowCutHz')} onAutomationSelect={() => props.onAutomationParameterTouch?.('delay.lowCutHz')} onValueChange={(value) => { props.onManualAutomationOverride?.('delay.lowCutHz'); updateLowCut(value) }} />
          <Knob class="px-1 py-1" label="High Cut" valueLabel={formatFrequency(props.params.highCutHz)} value={props.params.highCutHz} resetValue={DEFAULT_PARAMS.highCutHz} min={DELAY_HIGH_CUT_HZ_MIN} max={DELAY_HIGH_CUT_HZ_MAX} step={100} logarithmic disabled={!props.params.enabled || !props.params.filterEnabled} automationRange={automationRange('delay.highCutHz')} automated={!!automationRange('delay.highCutHz')} onAutomationSelect={() => props.onAutomationParameterTouch?.('delay.highCutHz')} onValueChange={(value) => { props.onManualAutomationOverride?.('delay.highCutHz'); updateHighCut(value) }} />
          <Knob class="px-1 py-1" label="Feedback" valueLabel={formatPercent(props.params.feedback)} value={props.params.feedback} resetValue={DEFAULT_PARAMS.feedback} min={DELAY_FEEDBACK_MIN} max={DELAY_FEEDBACK_MAX} step={0.01} disabled={!props.params.enabled} automationRange={automationRange('delay.feedback')} automated={!!automationRange('delay.feedback')} onAutomationSelect={() => props.onAutomationParameterTouch?.('delay.feedback')} onValueChange={(feedback) => changeAutomated('delay.feedback', { feedback })} />
          <Knob class="px-1 py-1" label="Dry/Wet" valueLabel={formatPercent(props.params.dryWet)} value={props.params.dryWet} resetValue={DEFAULT_PARAMS.dryWet} min={DELAY_DRY_WET_MIN} max={DELAY_DRY_WET_MAX} step={0.01} disabled={!props.params.enabled} automationRange={automationRange('delay.dryWet')} automated={!!automationRange('delay.dryWet')} onAutomationSelect={() => props.onAutomationParameterTouch?.('delay.dryWet')} onValueChange={(dryWet) => changeAutomated('delay.dryWet', { dryWet })} />
        </div>
      </div>
    </EffectShell>
  )
}
