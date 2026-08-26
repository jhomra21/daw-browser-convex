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
  return <EffectShell title="Tremolo" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-52 min-w-52"><div class="device-controls-with-footer grid min-h-0 flex-1 gap-3 px-3 py-3">
    <div class="grid grid-cols-2 place-content-center gap-x-5 gap-y-5">
      <Knob label="Rate" value={props.params.rateHz} valueLabel={`${props.params.rateHz.toFixed(2)} Hz`} resetValue={defaults.rateHz} min={0.01} max={20} step={0.01} logarithmic disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("tremolo.rateHz")} automated={props.automationRangesByParameterId?.has("tremolo.rateHz")} onAutomationSelect={() => props.onAutomationParameterTouch?.("tremolo.rateHz")} onValueChange={(rateHz) => { props.onManualAutomationOverride?.("tremolo.rateHz"); props.onChange({ rateHz }) }} />
      <Knob label="Depth" value={props.params.depth} valueLabel={percent(props.params.depth)} resetValue={defaults.depth} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("tremolo.depth")} automated={props.automationRangesByParameterId?.has("tremolo.depth")} onAutomationSelect={() => props.onAutomationParameterTouch?.("tremolo.depth")} onValueChange={(depth) => { props.onManualAutomationOverride?.("tremolo.depth"); props.onChange({ depth }) }} />
      <Knob label="Shape" value={props.params["shape"]} valueLabel={percent(props.params["shape"])} resetValue={defaults["shape"]} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("tremolo.shape")} automated={props.automationRangesByParameterId?.has("tremolo.shape")} onAutomationSelect={() => props.onAutomationParameterTouch?.("tremolo.shape")} onValueChange={(amount) => { props.onManualAutomationOverride?.("tremolo.shape"); props.onChange({ ["shape"]: amount }) }} />
      <Knob label="Phase" value={props.params.phase} valueLabel={`${Math.round(props.params.phase * 360)}°`} resetValue={defaults.phase} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get("tremolo.phase")} automated={props.automationRangesByParameterId?.has("tremolo.phase")} onAutomationSelect={() => props.onAutomationParameterTouch?.("tremolo.phase")} onValueChange={(phase) => { props.onManualAutomationOverride?.("tremolo.phase"); props.onChange({ phase }) }} />
    </div>
    <div class="grid grid-cols-2 gap-1">
      <DeviceToggleButton label="Sine" active={props.params.waveform === 'sine'} disabled={!props.params.enabled} onClick={() => props.onChange({ waveform: 'sine' })} />
      <DeviceToggleButton label="Triangle" active={props.params.waveform === 'triangle'} disabled={!props.params.enabled} onClick={() => props.onChange({ waveform: 'triangle' })} />
    </div>
  </div></EffectShell>
}
