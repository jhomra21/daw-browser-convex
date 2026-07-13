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
  return <EffectShell title="Auto Pan" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-52 min-w-52"><div class="device-controls-with-footer grid min-h-0 flex-1 gap-3 px-3 py-3">
    <div class="grid grid-cols-2 place-content-center gap-x-5 gap-y-5">
      <Knob label="Rate" value={props.params.rateHz} valueLabel={`${props.params.rateHz.toFixed(2)} Hz`} resetValue={defaults.rateHz} min={0.01} max={20} step={0.01} logarithmic disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("autopan.rateHz")} automated={props.automationRangesByParameterId?.has("autopan.rateHz")} onAutomationSelect={() => props.onAutomationParameterTouch?.("autopan.rateHz")} onValueChange={(rateHz) => { props.onManualAutomationOverride?.("autopan.rateHz"); props.onChange({ rateHz }) }} />
      <Knob label="Depth" value={props.params.depth} valueLabel={percent(props.params.depth)} resetValue={defaults.depth} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("autopan.depth")} automated={props.automationRangesByParameterId?.has("autopan.depth")} onAutomationSelect={() => props.onAutomationParameterTouch?.("autopan.depth")} onValueChange={(depth) => { props.onManualAutomationOverride?.("autopan.depth"); props.onChange({ depth }) }} />
      <Knob label="Shape" value={props.params.shape} valueLabel={percent(props.params.shape)} resetValue={defaults.shape} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("autopan.shape")} automated={props.automationRangesByParameterId?.has("autopan.shape")} onAutomationSelect={() => props.onAutomationParameterTouch?.("autopan.shape")} onValueChange={(shape) => { props.onManualAutomationOverride?.("autopan.shape"); props.onChange({ shape }) }} />
      <Knob label="Phase" value={props.params.phase} valueLabel={`${Math.round(props.params.phase * 360)}°`} resetValue={defaults.phase} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("autopan.phase")} automated={props.automationRangesByParameterId?.has("autopan.phase")} onAutomationSelect={() => props.onAutomationParameterTouch?.("autopan.phase")} onValueChange={(phase) => { props.onManualAutomationOverride?.("autopan.phase"); props.onChange({ phase }) }} />
    </div>
    <div class="grid grid-cols-2 gap-1">
      <DeviceToggleButton label="Sine" active={props.params.waveform === 'sine'} disabled={!props.params.enabled} onClick={() => props.onChange({ waveform: 'sine' })} />
      <DeviceToggleButton label="Triangle" active={props.params.waveform === 'triangle'} disabled={!props.params.enabled} onClick={() => props.onChange({ waveform: 'triangle' })} />
    </div>
  </div></EffectShell>
}
