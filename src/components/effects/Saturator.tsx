import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import Knob from '~/components/ui/knob'
import { For, createUniqueId } from 'solid-js'
import {
  createDefaultSaturatorParams,
  SATURATOR_COLOR_AMOUNT_MAX,
  SATURATOR_COLOR_AMOUNT_MIN,
  SATURATOR_COLOR_FREQUENCY_HZ_MAX,
  SATURATOR_COLOR_FREQUENCY_HZ_MIN,
  SATURATOR_DRIVE_DB_MAX,
  SATURATOR_DRIVE_DB_MIN,
  SATURATOR_DRY_WET_MAX,
  SATURATOR_DRY_WET_MIN,
  SATURATOR_OUTPUT_DB_MAX,
  SATURATOR_OUTPUT_DB_MIN,
  evaluateSaturatorCurvePoint,
  type SaturatorCurve,
  type SaturatorParams,
} from '@daw-browser/shared'
import { cn } from '~/lib/utils'

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

const DEFAULT_PARAMS = createDefaultSaturatorParams()
const CURVES: SaturatorCurve[] = ['soft', 'medium', 'hard', 'clip']

const formatDb = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`
const formatPercent = (value: number) => `${Math.round(value * 100)}%`
const formatFrequency = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${Math.round(value)} Hz`
const formatCurve = (curve: SaturatorCurve) => curve[0].toUpperCase() + curve.slice(1)

const createSaturatorCurvePoints = (curve: SaturatorCurve) => {
  const points: string[] = []
  for (let index = 0; index <= 80; index++) {
    const input = (index / 80) * 2 - 1
    const output = evaluateSaturatorCurvePoint(curve, input)
    points.push(`${(index / 80) * 180},${50 - output * 40}`)
  }
  return points.join(' ')
}

const SATURATOR_CURVE_POINTS: Record<SaturatorCurve, string> = {
  soft: createSaturatorCurvePoints('soft'),
  medium: createSaturatorCurvePoints('medium'),
  hard: createSaturatorCurvePoints('hard'),
  clip: createSaturatorCurvePoints('clip'),
}

function SaturatorCurveGraph(props: { curve: SaturatorCurve }) {
  const patternId = createUniqueId()

  return (
    <div class="relative h-[118px] w-[220px] shrink-0 self-center overflow-hidden bg-neutral-950">
      <svg
        viewBox="0 0 180 100"
        class="absolute inset-0 h-full w-full"
        preserveAspectRatio="none"
        aria-label="Saturator curve preview"
      >
        <defs>
          <pattern id={patternId} width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#262626" stroke-width="1" />
          </pattern>
        </defs>
        <rect width="180" height="100" fill={`url(#${patternId})`} />
        <rect x="52" y="0" width="76" height="100" fill="#22d3ee" opacity="0.24" />
        <line x1="0" y1="50" x2="180" y2="50" stroke="#525252" stroke-width="1" />
        <line x1="90" y1="0" x2="90" y2="100" stroke="#525252" stroke-width="1" />
        <polyline points={SATURATOR_CURVE_POINTS[props.curve]} fill="none" stroke="#22d3ee" stroke-width="2.25" vector-effect="non-scaling-stroke" />
      </svg>
    </div>
  )
}

export default function Saturator(props: SaturatorProps) {
  const automationRange = (parameterId: string) => props.automationRangesByParameterId?.get(parameterId)
  const changeAutomated = (parameterId: string, updates: Partial<SaturatorParams>) => {
    props.onManualAutomationOverride?.(parameterId)
    props.onChange(updates)
  }
  return (
    <EffectShell
      title="Saturator"
      typeLabel="Audio"
      enabled={props.params.enabled}
      onToggleEnabled={props.onToggleEnabled}
      onReset={props.onReset}
      class={cn('w-[320px] min-w-[320px]', props.class)}
    >
      <div class={cn('flex min-h-0 flex-1 flex-col gap-2 px-3 py-1', !props.params.enabled && 'opacity-70')}>
        <div class="flex min-w-0 shrink-0 flex-col gap-1.5 p-1">
          <div class="grid grid-cols-4 gap-1">
            <For each={CURVES}>
              {(curve) => (
                <DeviceToggleButton
                  label={formatCurve(curve)}
                  active={props.params.curve === curve}
                  disabled={!props.params.enabled}
                  onClick={() => props.onChange({ curve })}
                />
              )}
            </For>
          </div>
          <SaturatorCurveGraph curve={props.params.curve} />
          <div class="grid grid-cols-[4.2rem_repeat(2,minmax(0,1fr))] items-end gap-2">
            <DeviceToggleButton label="Color" active={props.params.color} disabled={!props.params.enabled} onClick={() => props.onChange({ color: !props.params.color })} />
            <Knob class="px-0 py-0" size={28} label="Freq" valueLabel={formatFrequency(props.params.colorFrequencyHz)} value={props.params.colorFrequencyHz} resetValue={DEFAULT_PARAMS.colorFrequencyHz} min={SATURATOR_COLOR_FREQUENCY_HZ_MIN} max={SATURATOR_COLOR_FREQUENCY_HZ_MAX} step={1} logarithmic disabled={!props.params.enabled || !props.params.color} automationRange={automationRange('saturator.colorFrequencyHz')} automated={!!automationRange('saturator.colorFrequencyHz')} onAutomationSelect={() => props.onAutomationParameterTouch?.('saturator.colorFrequencyHz')} onValueChange={(colorFrequencyHz) => changeAutomated('saturator.colorFrequencyHz', { colorFrequencyHz })} />
            <Knob class="px-0 py-0" size={28} label="Amt" valueLabel={formatPercent(props.params.colorAmount)} value={props.params.colorAmount} resetValue={DEFAULT_PARAMS.colorAmount} min={SATURATOR_COLOR_AMOUNT_MIN} max={SATURATOR_COLOR_AMOUNT_MAX} step={0.01} disabled={!props.params.enabled || !props.params.color} onValueChange={(colorAmount) => props.onChange({ colorAmount })} />
          </div>
        </div>

        <div class="grid grid-cols-3 gap-3">
          <Knob label="Drive" valueLabel={formatDb(props.params.driveDb)} value={props.params.driveDb} resetValue={DEFAULT_PARAMS.driveDb} min={SATURATOR_DRIVE_DB_MIN} max={SATURATOR_DRIVE_DB_MAX} step={0.1} disabled={!props.params.enabled} automationRange={automationRange('saturator.driveDb')} automated={!!automationRange('saturator.driveDb')} onAutomationSelect={() => props.onAutomationParameterTouch?.('saturator.driveDb')} onValueChange={(driveDb) => changeAutomated('saturator.driveDb', { driveDb })} />
          <Knob label="Output" valueLabel={formatDb(props.params.outputDb)} value={props.params.outputDb} resetValue={DEFAULT_PARAMS.outputDb} min={SATURATOR_OUTPUT_DB_MIN} max={SATURATOR_OUTPUT_DB_MAX} step={0.1} bipolar disabled={!props.params.enabled} automationRange={automationRange('saturator.outputDb')} automated={!!automationRange('saturator.outputDb')} onAutomationSelect={() => props.onAutomationParameterTouch?.('saturator.outputDb')} onValueChange={(outputDb) => changeAutomated('saturator.outputDb', { outputDb })} />
          <Knob label="Dry/Wet" valueLabel={formatPercent(props.params.dryWet)} value={props.params.dryWet} resetValue={DEFAULT_PARAMS.dryWet} min={SATURATOR_DRY_WET_MIN} max={SATURATOR_DRY_WET_MAX} step={0.01} disabled={!props.params.enabled} automationRange={automationRange('saturator.dryWet')} automated={!!automationRange('saturator.dryWet')} onAutomationSelect={() => props.onAutomationParameterTouch?.('saturator.dryWet')} onValueChange={(dryWet) => changeAutomated('saturator.dryWet', { dryWet })} />
        </div>
      </div>
    </EffectShell>
  )
}
