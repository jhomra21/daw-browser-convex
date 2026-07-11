import { createDefaultTremoloParams, type TremoloParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import Knob from '~/components/ui/knob'

type TremoloProps = {
  params: TremoloParams
  onChange: (updates: Partial<TremoloParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}
const defaults = createDefaultTremoloParams()
const percent = (value: number) => `${Math.round(value * 100)}%`
export default function Tremolo(props: TremoloProps) {
  const knob = (label: string, id: string, value: number, resetValue: number, min: number, max: number, step: number, valueLabel: string, update: (value: number) => Partial<TremoloParams>) => (
    <Knob label={label} value={value} valueLabel={valueLabel} resetValue={resetValue} min={min} max={max} step={step} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get(id)} automated={props.automationRangesByParameterId?.has(id)} onAutomationSelect={() => props.onAutomationParameterTouch?.(id)} onValueChange={(next) => { props.onManualAutomationOverride?.(id); props.onChange(update(next)) }} />
  )
  return <EffectShell title="Tremolo" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-[350px] min-w-[350px]"><div class="flex flex-1 gap-3 px-3 py-2">
    <div class="grid grid-cols-4 gap-2">
      {knob('Rate', 'tremolo.rateHz', props.params.rateHz, defaults.rateHz, 0.01, 20, 0.01, `${props.params.rateHz.toFixed(2)} Hz`, (rateHz) => ({ rateHz }))}
      {knob('Depth', 'tremolo.depth', props.params.depth, defaults.depth, 0, 1, 0.01, percent(props.params.depth), (depth) => ({ depth }))}
      {knob('Shape', 'tremolo.shape', props.params.shape, defaults.shape, 0, 1, 0.01, percent(props.params.shape), (shape) => ({ shape }))}
      {knob('Phase', 'tremolo.phase', props.params.phase, defaults.phase, 0, 1, 0.01, `${Math.round(props.params.phase * 360)}°`, (phase) => ({ phase }))}
    </div>
    <div class="grid w-20 grid-cols-1 gap-1 content-start">
      <DeviceToggleButton label="Sine" active={props.params.waveform === 'sine'} disabled={!props.params.enabled} onClick={() => props.onChange({ waveform: 'sine' })} />
      <DeviceToggleButton label="Triangle" active={props.params.waveform === 'triangle'} disabled={!props.params.enabled} onClick={() => props.onChange({ waveform: 'triangle' })} />
    </div>
  </div></EffectShell>
}
