import { createDefaultChorusParams, type ChorusParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import Knob from '~/components/ui/knob'

type ChorusProps = {
  params: ChorusParams
  onChange: (updates: Partial<ChorusParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}

const defaults = createDefaultChorusParams()
const percent = (value: number) => `${Math.round(value * 100)}%`

export default function Chorus(props: ChorusProps) {
  return (
    <EffectShell title="Chorus" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-60 min-w-60">
      <div class="grid min-h-0 flex-1 grid-cols-2 grid-rows-3 items-center gap-x-8 px-4 py-3">
        <Knob label="Delay" value={props.params.delayMs} valueLabel={`${props.params.delayMs.toFixed(1)} ms`} resetValue={defaults.delayMs} min={5} max={30} step={0.1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("chorus.delayMs")} automated={props.automationRangesByParameterId?.has("chorus.delayMs")} onAutomationSelect={() => props.onAutomationParameterTouch?.("chorus.delayMs")} onValueChange={(delayMs) => { props.onManualAutomationOverride?.("chorus.delayMs"); props.onChange({ delayMs }) }} />
        <Knob label="Depth" value={props.params.depthMs} valueLabel={`${props.params.depthMs.toFixed(1)} ms`} resetValue={defaults.depthMs} min={0} max={10} step={0.1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("chorus.depthMs")} automated={props.automationRangesByParameterId?.has("chorus.depthMs")} onAutomationSelect={() => props.onAutomationParameterTouch?.("chorus.depthMs")} onValueChange={(depthMs) => { props.onManualAutomationOverride?.("chorus.depthMs"); props.onChange({ depthMs }) }} />
        <Knob label="Rate" value={props.params.rateHz} valueLabel={`${props.params.rateHz.toFixed(2)} Hz`} resetValue={defaults.rateHz} min={0.01} max={20} step={0.01} logarithmic disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("chorus.rateHz")} automated={props.automationRangesByParameterId?.has("chorus.rateHz")} onAutomationSelect={() => props.onAutomationParameterTouch?.("chorus.rateHz")} onValueChange={(rateHz) => { props.onManualAutomationOverride?.("chorus.rateHz"); props.onChange({ rateHz }) }} />
        <Knob label="Feedback" value={props.params.feedback} valueLabel={percent(props.params.feedback)} resetValue={defaults.feedback} min={0} max={0.5} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("chorus.feedback")} automated={props.automationRangesByParameterId?.has("chorus.feedback")} onAutomationSelect={() => props.onAutomationParameterTouch?.("chorus.feedback")} onValueChange={(feedback) => { props.onManualAutomationOverride?.("chorus.feedback"); props.onChange({ feedback }) }} />
        <Knob label="Stereo" value={props.params.stereoPhase} valueLabel={percent(props.params.stereoPhase)} resetValue={defaults.stereoPhase} min={-0.5} max={0.5} step={0.01} bipolar disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("chorus.stereoPhase")} automated={props.automationRangesByParameterId?.has("chorus.stereoPhase")} onAutomationSelect={() => props.onAutomationParameterTouch?.("chorus.stereoPhase")} onValueChange={(stereoPhase) => { props.onManualAutomationOverride?.("chorus.stereoPhase"); props.onChange({ stereoPhase }) }} />
        <Knob label="Mix" value={props.params.mix} valueLabel={percent(props.params.mix)} resetValue={defaults.mix} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("chorus.mix")} automated={props.automationRangesByParameterId?.has("chorus.mix")} onAutomationSelect={() => props.onAutomationParameterTouch?.("chorus.mix")} onValueChange={(mix) => { props.onManualAutomationOverride?.("chorus.mix"); props.onChange({ mix }) }} />
      </div>
    </EffectShell>
  )
}
