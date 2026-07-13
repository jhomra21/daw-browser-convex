import { createDefaultEnsembleParams, type EnsembleParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import Knob from '~/components/ui/knob'

type EnsembleProps = {
  params: EnsembleParams
  onChange: (updates: Partial<EnsembleParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}
const defaults = createDefaultEnsembleParams()
const percent = (value: number) => `${Math.round(value * 100)}%`
export default function Ensemble(props: EnsembleProps) {
  const knob = (label: string, id: string, value: number, resetValue: number, min: number, max: number, step: number, valueLabel: string, update: (value: number) => Partial<EnsembleParams>, logarithmic = false) => (
    <Knob label={label} value={value} valueLabel={valueLabel} resetValue={resetValue} min={min} max={max} step={step} logarithmic={logarithmic} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get(id)} automated={props.automationRangesByParameterId?.has(id)} onAutomationSelect={() => props.onAutomationParameterTouch?.(id)} onValueChange={(next) => { props.onManualAutomationOverride?.(id); props.onChange(update(next)) }} />
  )
  return <EffectShell title="Ensemble" typeLabel="3 Voices" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-52 min-w-52"><div class="grid min-h-0 flex-1 grid-cols-2 grid-rows-3 items-center gap-x-8 px-4 py-3">
    {knob('Delay', 'ensemble.delayMs', props.params.delayMs, defaults.delayMs, 10, 30, 0.1, `${props.params.delayMs.toFixed(1)} ms`, (delayMs) => ({ delayMs }))}
    {knob('Depth', 'ensemble.depthMs', props.params.depthMs, defaults.depthMs, 1, 12, 0.1, `${props.params.depthMs.toFixed(1)} ms`, (depthMs) => ({ depthMs }))}
    {knob('Rate', 'ensemble.rateHz', props.params.rateHz, defaults.rateHz, 0.05, 5, 0.01, `${props.params.rateHz.toFixed(2)} Hz`, (rateHz) => ({ rateHz }), true)}
    {knob('Spread', 'ensemble.spread', props.params.spread, defaults.spread, 0, 1, 0.01, percent(props.params.spread), (spread) => ({ spread }))}
    {knob('Mix', 'ensemble.mix', props.params.mix, defaults.mix, 0, 1, 0.01, percent(props.params.mix), (mix) => ({ mix }))}
  </div></EffectShell>
}
