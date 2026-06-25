import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import Knob from '~/components/ui/knob'
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
}

const DEFAULT_PARAMS = createDefaultSaturatorParams()
const CURVES: SaturatorCurve[] = ['soft', 'medium', 'hard', 'clip']

const formatDb = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`
const formatPercent = (value: number) => `${Math.round(value * 100)}%`
const formatFrequency = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${Math.round(value)} Hz`
const formatCurve = (curve: SaturatorCurve) => curve[0].toUpperCase() + curve.slice(1)

export default function Saturator(props: SaturatorProps) {
  return (
    <EffectShell
      title="Saturator"
      typeLabel="Audio"
      enabled={props.params.enabled}
      onToggleEnabled={props.onToggleEnabled}
      onReset={props.onReset}
      class={cn('w-[420px] min-w-[420px]', props.class)}
    >
      <div class={cn('grid min-h-0 flex-1 grid-cols-[96px_repeat(6,48px)] items-end gap-3 px-3 py-3', !props.params.enabled && 'opacity-70')}>
        <div class="flex h-full flex-col justify-between gap-2">
          <div class="text-xs font-semibold text-neutral-400">Curve</div>
          <div class="grid grid-cols-1 gap-1">
            {CURVES.map((curve) => (
              <DeviceToggleButton
                label={formatCurve(curve)}
                active={props.params.curve === curve}
                disabled={!props.params.enabled}
                onClick={() => props.onChange({ curve })}
              />
            ))}
          </div>
        </div>
        <Knob label="Drive" valueLabel={formatDb(props.params.driveDb)} value={props.params.driveDb} resetValue={DEFAULT_PARAMS.driveDb} min={SATURATOR_DRIVE_DB_MIN} max={SATURATOR_DRIVE_DB_MAX} step={0.1} disabled={!props.params.enabled} onValueChange={(driveDb) => props.onChange({ driveDb })} />
        <Knob label="Output" valueLabel={formatDb(props.params.outputDb)} value={props.params.outputDb} resetValue={DEFAULT_PARAMS.outputDb} min={SATURATOR_OUTPUT_DB_MIN} max={SATURATOR_OUTPUT_DB_MAX} step={0.1} bipolar disabled={!props.params.enabled} onValueChange={(outputDb) => props.onChange({ outputDb })} />
        <Knob label="Dry/Wet" valueLabel={formatPercent(props.params.dryWet)} value={props.params.dryWet} resetValue={DEFAULT_PARAMS.dryWet} min={SATURATOR_DRY_WET_MIN} max={SATURATOR_DRY_WET_MAX} step={0.01} disabled={!props.params.enabled} onValueChange={(dryWet) => props.onChange({ dryWet })} />
        <div class="flex h-full flex-col justify-end gap-3">
          <DeviceToggleButton label="Color" active={props.params.color} disabled={!props.params.enabled} onClick={() => props.onChange({ color: !props.params.color })} />
        </div>
        <Knob label="Freq" valueLabel={formatFrequency(props.params.colorFrequencyHz)} value={props.params.colorFrequencyHz} resetValue={DEFAULT_PARAMS.colorFrequencyHz} min={SATURATOR_COLOR_FREQUENCY_HZ_MIN} max={SATURATOR_COLOR_FREQUENCY_HZ_MAX} step={1} logarithmic disabled={!props.params.enabled || !props.params.color} onValueChange={(colorFrequencyHz) => props.onChange({ colorFrequencyHz })} />
        <Knob label="Amount" valueLabel={formatPercent(props.params.colorAmount)} value={props.params.colorAmount} resetValue={DEFAULT_PARAMS.colorAmount} min={SATURATOR_COLOR_AMOUNT_MIN} max={SATURATOR_COLOR_AMOUNT_MAX} step={0.01} disabled={!props.params.enabled || !props.params.color} onValueChange={(colorAmount) => props.onChange({ colorAmount })} />
      </div>
    </EffectShell>
  )
}
