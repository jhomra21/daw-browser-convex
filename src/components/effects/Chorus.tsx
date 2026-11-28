import { createDefaultChorusParams, type ChorusParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { formatDeviceHertz, formatDeviceMilliseconds, formatDevicePercent } from '~/lib/device-value-format'

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
const percent = formatDevicePercent

export default function Chorus(props: ChorusProps) {
  return (
    <EffectShell title="Chorus" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-60 min-w-60">
      <div class="grid min-h-0 flex-1 grid-cols-2 grid-rows-3 items-center gap-x-8 px-4 py-3">
        <AutomatedKnob label="Delay" value={props.params.delayMs} valueLabel={formatDeviceMilliseconds(props.params.delayMs, 1)} resetValue={defaults.delayMs} min={5} max={30} step={0.1} disabled={!props.params.enabled} parameterId="chorus.delayMs" automation={props} onValueChange={(delayMs) => props.onChange({ delayMs })} />
        <AutomatedKnob label="Depth" value={props.params.depthMs} valueLabel={formatDeviceMilliseconds(props.params.depthMs, 1)} resetValue={defaults.depthMs} min={0} max={10} step={0.1} disabled={!props.params.enabled} parameterId="chorus.depthMs" automation={props} onValueChange={(depthMs) => props.onChange({ depthMs })} />
        <AutomatedKnob label="Rate" value={props.params.rateHz} valueLabel={formatDeviceHertz(props.params.rateHz, 2)} resetValue={defaults.rateHz} min={0.01} max={20} step={0.01} logarithmic disabled={!props.params.enabled} parameterId="chorus.rateHz" automation={props} onValueChange={(rateHz) => props.onChange({ rateHz })} />
        <AutomatedKnob label="Feedback" value={props.params.feedback} valueLabel={percent(props.params.feedback)} resetValue={defaults.feedback} min={0} max={0.5} step={0.01} disabled={!props.params.enabled} parameterId="chorus.feedback" automation={props} onValueChange={(feedback) => props.onChange({ feedback })} />
        <AutomatedKnob label="Stereo" value={props.params.stereoPhase} valueLabel={percent(props.params.stereoPhase)} resetValue={defaults.stereoPhase} min={-0.5} max={0.5} step={0.01} bipolar disabled={!props.params.enabled} parameterId="chorus.stereoPhase" automation={props} onValueChange={(stereoPhase) => props.onChange({ stereoPhase })} />
        <AutomatedKnob label="Mix" value={props.params.mix} valueLabel={percent(props.params.mix)} resetValue={defaults.mix} min={0} max={1} step={0.01} disabled={!props.params.enabled} parameterId="chorus.mix" automation={props} onValueChange={(mix) => props.onChange({ mix })} />
      </div>
    </EffectShell>
  )
}
