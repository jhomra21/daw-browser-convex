import { createDefaultAutoPanParams, type AutoPanParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import Knob from '~/components/ui/knob'

type AutoPanProps = {
  params: AutoPanParams
  onChange: (updates: Partial<AutoPanParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}
const defaults = createDefaultAutoPanParams()
const percent = (value: number) => `${Math.round(value * 100)}%`
export default function AutoPan(props: AutoPanProps) {
  const knob = (label: string, id: string, value: number, resetValue: number, min: number, max: number, step: number, valueLabel: string, update: (value: number) => Partial<AutoPanParams>, logarithmic = false) => (
    <Knob label={label} value={value} valueLabel={valueLabel} resetValue={resetValue} min={min} max={max} step={step} logarithmic={logarithmic} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get(id)} automated={props.automationRangesByParameterId?.has(id)} onAutomationSelect={() => props.onAutomationParameterTouch?.(id)} onValueChange={(next) => { props.onManualAutomationOverride?.(id); props.onChange(update(next)) }} />
  )
  return <EffectShell title="Auto Pan" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-52 min-w-52"><div class="grid min-h-0 flex-1 grid-rows-[1fr_auto] gap-3 px-3 py-3">
    <div class="grid grid-cols-2 place-content-center gap-x-5 gap-y-5">
      {knob('Rate', 'autopan.rateHz', props.params.rateHz, defaults.rateHz, 0.01, 20, 0.01, `${props.params.rateHz.toFixed(2)} Hz`, (rateHz) => ({ rateHz }), true)}
      {knob('Depth', 'autopan.depth', props.params.depth, defaults.depth, 0, 1, 0.01, percent(props.params.depth), (depth) => ({ depth }))}
      {knob('Shape', 'autopan.shape', props.params.shape, defaults.shape, 0, 1, 0.01, percent(props.params.shape), (shape) => ({ shape }))}
      {knob('Phase', 'autopan.phase', props.params.phase, defaults.phase, 0, 1, 0.01, `${Math.round(props.params.phase * 360)}°`, (phase) => ({ phase }))}
    </div>
    <div class="grid grid-cols-2 gap-1">
      <DeviceToggleButton label="Sine" active={props.params.waveform === 'sine'} disabled={!props.params.enabled} onClick={() => props.onChange({ waveform: 'sine' })} />
      <DeviceToggleButton label="Triangle" active={props.params.waveform === 'triangle'} disabled={!props.params.enabled} onClick={() => props.onChange({ waveform: 'triangle' })} />
    </div>
  </div></EffectShell>
}
