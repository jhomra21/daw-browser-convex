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
  return <EffectShell title="Flanger" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-60 min-w-60"><div class="grid min-h-0 flex-1 grid-cols-2 grid-rows-3 items-center gap-x-8 px-4 py-3">
    <Knob label="Delay" value={props.params.delayMs} valueLabel={`${props.params.delayMs.toFixed(1)} ms`} resetValue={defaults.delayMs} min={0.1} max={10} step={0.1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("flanger.delayMs")} automated={props.automationRangesByParameterId?.has("flanger.delayMs")} onAutomationSelect={() => props.onAutomationParameterTouch?.("flanger.delayMs")} onValueChange={(delayMs) => { props.onManualAutomationOverride?.("flanger.delayMs"); props.onChange({ delayMs }) }} />
    <Knob label="Depth" value={props.params.depthMs} valueLabel={`${props.params.depthMs.toFixed(1)} ms`} resetValue={defaults.depthMs} min={0} max={5} step={0.1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("flanger.depthMs")} automated={props.automationRangesByParameterId?.has("flanger.depthMs")} onAutomationSelect={() => props.onAutomationParameterTouch?.("flanger.depthMs")} onValueChange={(depthMs) => { props.onManualAutomationOverride?.("flanger.depthMs"); props.onChange({ depthMs }) }} />
    <Knob label="Rate" value={props.params.rateHz} valueLabel={`${props.params.rateHz.toFixed(2)} Hz`} resetValue={defaults.rateHz} min={0.01} max={20} step={0.01} logarithmic disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("flanger.rateHz")} automated={props.automationRangesByParameterId?.has("flanger.rateHz")} onAutomationSelect={() => props.onAutomationParameterTouch?.("flanger.rateHz")} onValueChange={(rateHz) => { props.onManualAutomationOverride?.("flanger.rateHz"); props.onChange({ rateHz }) }} />
    <Knob label="Feedback" value={props.params.feedback} valueLabel={percent(props.params.feedback)} resetValue={defaults.feedback} min={-0.95} max={0.95} step={0.01} bipolar disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("flanger.feedback")} automated={props.automationRangesByParameterId?.has("flanger.feedback")} onAutomationSelect={() => props.onAutomationParameterTouch?.("flanger.feedback")} onValueChange={(feedback) => { props.onManualAutomationOverride?.("flanger.feedback"); props.onChange({ feedback }) }} />
    <Knob label="Stereo" value={props.params.stereoPhase} valueLabel={percent(props.params.stereoPhase)} resetValue={defaults.stereoPhase} min={-0.5} max={0.5} step={0.01} bipolar disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("flanger.stereoPhase")} automated={props.automationRangesByParameterId?.has("flanger.stereoPhase")} onAutomationSelect={() => props.onAutomationParameterTouch?.("flanger.stereoPhase")} onValueChange={(stereoPhase) => { props.onManualAutomationOverride?.("flanger.stereoPhase"); props.onChange({ stereoPhase }) }} />
    <Knob label="Mix" value={props.params.mix} valueLabel={percent(props.params.mix)} resetValue={defaults.mix} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("flanger.mix")} automated={props.automationRangesByParameterId?.has("flanger.mix")} onAutomationSelect={() => props.onAutomationParameterTouch?.("flanger.mix")} onValueChange={(mix) => { props.onManualAutomationOverride?.("flanger.mix"); props.onChange({ mix }) }} />
  </div></EffectShell>
}
