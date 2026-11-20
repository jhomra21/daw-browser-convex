import { createDefaultFlangerParams, type FlangerParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { formatDeviceHertz, formatDeviceMilliseconds, formatDevicePercent } from '~/lib/device-value-format'

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
const percent = formatDevicePercent

export default function Flanger(props: FlangerProps) {
  return <EffectShell title="Flanger" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-60 min-w-60"><div class="grid min-h-0 flex-1 grid-cols-2 grid-rows-3 items-center gap-x-8 px-4 py-3">
    <AutomatedKnob label="Delay" value={props.params.delayMs} valueLabel={formatDeviceMilliseconds(props.params.delayMs, 1)} resetValue={defaults.delayMs} min={0.1} max={10} step={0.1} disabled={!props.params.enabled} parameterId="flanger.delayMs" automation={props} onValueChange={(delayMs) => props.onChange({ delayMs })} />
    <AutomatedKnob label="Depth" value={props.params.depthMs} valueLabel={formatDeviceMilliseconds(props.params.depthMs, 1)} resetValue={defaults.depthMs} min={0} max={5} step={0.1} disabled={!props.params.enabled} parameterId="flanger.depthMs" automation={props} onValueChange={(depthMs) => props.onChange({ depthMs })} />
    <AutomatedKnob label="Rate" value={props.params.rateHz} valueLabel={formatDeviceHertz(props.params.rateHz, 2)} resetValue={defaults.rateHz} min={0.01} max={20} step={0.01} logarithmic disabled={!props.params.enabled} parameterId="flanger.rateHz" automation={props} onValueChange={(rateHz) => props.onChange({ rateHz })} />
    <AutomatedKnob label="Feedback" value={props.params.feedback} valueLabel={percent(props.params.feedback)} resetValue={defaults.feedback} min={-0.95} max={0.95} step={0.01} bipolar disabled={!props.params.enabled} parameterId="flanger.feedback" automation={props} onValueChange={(feedback) => props.onChange({ feedback })} />
    <AutomatedKnob label="Stereo" value={props.params.stereoPhase} valueLabel={percent(props.params.stereoPhase)} resetValue={defaults.stereoPhase} min={-0.5} max={0.5} step={0.01} bipolar disabled={!props.params.enabled} parameterId="flanger.stereoPhase" automation={props} onValueChange={(stereoPhase) => props.onChange({ stereoPhase })} />
    <AutomatedKnob label="Mix" value={props.params.mix} valueLabel={percent(props.params.mix)} resetValue={defaults.mix} min={0} max={1} step={0.01} disabled={!props.params.enabled} parameterId="flanger.mix" automation={props} onValueChange={(mix) => props.onChange({ mix })} />
  </div></EffectShell>
}
