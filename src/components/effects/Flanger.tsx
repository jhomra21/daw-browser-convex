import { createDefaultFlangerParams, type FlangerParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import Knob from '~/components/ui/knob'

type FlangerProps = {
  params: FlangerParams
  onChange: (updates: Partial<FlangerParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}
const defaults = createDefaultFlangerParams()
const percent = (value: number) => `${Math.round(value * 100)}%`
export default function Flanger(props: FlangerProps) {
  const knob = (label: string, id: string, value: number, resetValue: number, min: number, max: number, step: number, valueLabel: string, update: (value: number) => Partial<FlangerParams>, bipolar = false, logarithmic = false) => (
    <Knob label={label} value={value} valueLabel={valueLabel} resetValue={resetValue} min={min} max={max} step={step} bipolar={bipolar} logarithmic={logarithmic} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get(id)} automated={props.automationRangesByParameterId?.has(id)} onAutomationSelect={() => props.onAutomationParameterTouch?.(id)} onValueChange={(next) => { props.onManualAutomationOverride?.(id); props.onChange(update(next)) }} />
  )
  return <EffectShell title="Flanger" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-60 min-w-60"><div class="grid min-h-0 flex-1 grid-cols-2 grid-rows-3 items-center gap-x-8 px-4 py-3">
    {knob('Delay', 'flanger.delayMs', props.params.delayMs, defaults.delayMs, 0.1, 10, 0.1, `${props.params.delayMs.toFixed(1)} ms`, (delayMs) => ({ delayMs }))}
    {knob('Depth', 'flanger.depthMs', props.params.depthMs, defaults.depthMs, 0, 5, 0.1, `${props.params.depthMs.toFixed(1)} ms`, (depthMs) => ({ depthMs }))}
    {knob('Rate', 'flanger.rateHz', props.params.rateHz, defaults.rateHz, 0.01, 20, 0.01, `${props.params.rateHz.toFixed(2)} Hz`, (rateHz) => ({ rateHz }), false, true)}
    {knob('Feedback', 'flanger.feedback', props.params.feedback, defaults.feedback, -0.95, 0.95, 0.01, percent(props.params.feedback), (feedback) => ({ feedback }), true)}
    {knob('Stereo', 'flanger.stereoPhase', props.params.stereoPhase, defaults.stereoPhase, -0.5, 0.5, 0.01, percent(props.params.stereoPhase), (stereoPhase) => ({ stereoPhase }), true)}
    {knob('Mix', 'flanger.mix', props.params.mix, defaults.mix, 0, 1, 0.01, percent(props.params.mix), (mix) => ({ mix }))}
  </div></EffectShell>
}
