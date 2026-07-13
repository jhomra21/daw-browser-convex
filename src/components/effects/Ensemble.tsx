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
  return <EffectShell title="Ensemble" typeLabel="3 Voices" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-52 min-w-52"><div class="grid min-h-0 flex-1 grid-cols-2 grid-rows-3 items-center gap-x-8 px-4 py-3">
    <Knob label="Delay" value={props.params.delayMs} valueLabel={`${props.params.delayMs.toFixed(1)} ms`} resetValue={defaults.delayMs} min={10} max={30} step={0.1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("ensemble.delayMs")} automated={props.automationRangesByParameterId?.has("ensemble.delayMs")} onAutomationSelect={() => props.onAutomationParameterTouch?.("ensemble.delayMs")} onValueChange={(delayMs) => { props.onManualAutomationOverride?.("ensemble.delayMs"); props.onChange({ delayMs }) }} />
    <Knob label="Depth" value={props.params.depthMs} valueLabel={`${props.params.depthMs.toFixed(1)} ms`} resetValue={defaults.depthMs} min={1} max={12} step={0.1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("ensemble.depthMs")} automated={props.automationRangesByParameterId?.has("ensemble.depthMs")} onAutomationSelect={() => props.onAutomationParameterTouch?.("ensemble.depthMs")} onValueChange={(depthMs) => { props.onManualAutomationOverride?.("ensemble.depthMs"); props.onChange({ depthMs }) }} />
    <Knob label="Rate" value={props.params.rateHz} valueLabel={`${props.params.rateHz.toFixed(2)} Hz`} resetValue={defaults.rateHz} min={0.05} max={5} step={0.01} logarithmic disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("ensemble.rateHz")} automated={props.automationRangesByParameterId?.has("ensemble.rateHz")} onAutomationSelect={() => props.onAutomationParameterTouch?.("ensemble.rateHz")} onValueChange={(rateHz) => { props.onManualAutomationOverride?.("ensemble.rateHz"); props.onChange({ rateHz }) }} />
    <Knob label="Spread" value={props.params.spread} valueLabel={percent(props.params.spread)} resetValue={defaults.spread} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("ensemble.spread")} automated={props.automationRangesByParameterId?.has("ensemble.spread")} onAutomationSelect={() => props.onAutomationParameterTouch?.("ensemble.spread")} onValueChange={(spread) => { props.onManualAutomationOverride?.("ensemble.spread"); props.onChange({ spread }) }} />
    <Knob label="Mix" value={props.params.mix} valueLabel={percent(props.params.mix)} resetValue={defaults.mix} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("ensemble.mix")} automated={props.automationRangesByParameterId?.has("ensemble.mix")} onAutomationSelect={() => props.onAutomationParameterTouch?.("ensemble.mix")} onValueChange={(mix) => { props.onManualAutomationOverride?.("ensemble.mix"); props.onChange({ mix }) }} />
  </div></EffectShell>
}
