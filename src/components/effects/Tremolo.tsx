import { createDefaultTremoloParams, type TremoloParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { formatDeviceHertz, formatDevicePercent } from '~/lib/device-value-format'

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
const percent = formatDevicePercent

export default function Tremolo(props: TremoloProps) {
  return <EffectShell title="Tremolo" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-52 min-w-52"><div class="device-controls-with-footer grid min-h-0 flex-1 gap-3 px-3 py-3">
    <div class="grid grid-cols-2 place-content-center gap-x-5 gap-y-5">
      <AutomatedKnob label="Rate" value={props.params.rateHz} valueLabel={formatDeviceHertz(props.params.rateHz, 2)} resetValue={defaults.rateHz} min={0.01} max={20} step={0.01} logarithmic disabled={!props.params.enabled} parameterId="tremolo.rateHz" automation={props} onValueChange={(rateHz) => props.onChange({ rateHz })} />
      <AutomatedKnob label="Depth" value={props.params.depth} valueLabel={percent(props.params.depth)} resetValue={defaults.depth} min={0} max={1} step={0.01} disabled={!props.params.enabled} parameterId="tremolo.depth" automation={props} onValueChange={(depth) => props.onChange({ depth })} />
      <AutomatedKnob label="Shape" value={props.params["shape"]} valueLabel={percent(props.params["shape"])} resetValue={defaults["shape"]} min={0} max={1} step={0.01} disabled={!props.params.enabled} parameterId="tremolo.shape" automation={props} onValueChange={(amount) => props.onChange({ ["shape"]: amount })} />
      <AutomatedKnob label="Phase" value={props.params.phase} valueLabel={`${Math.round(props.params.phase * 360)}°`} resetValue={defaults.phase} min={0} max={1} step={0.01} disabled={!props.params.enabled} parameterId="tremolo.phase" automation={props} onValueChange={(phase) => props.onChange({ phase })} />
    </div>
    <div class="grid grid-cols-2 gap-1">
      <DeviceToggleButton label="Sine" active={props.params.waveform === 'sine'} disabled={!props.params.enabled} onClick={() => props.onChange({ waveform: 'sine' })} />
      <DeviceToggleButton label="Triangle" active={props.params.waveform === 'triangle'} disabled={!props.params.enabled} onClick={() => props.onChange({ waveform: 'triangle' })} />
    </div>
  </div></EffectShell>
}
