import { createDefaultEnsembleParams, type EnsembleParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { formatDeviceHertz, formatDeviceMilliseconds, formatDevicePercent } from '~/lib/device-value-format'

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
const percent = formatDevicePercent

export default function Ensemble(props: EnsembleProps) {
  return <EffectShell title="Ensemble" typeLabel="3 Voices" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-52 min-w-52"><div class="grid min-h-0 flex-1 grid-cols-2 grid-rows-3 items-center gap-x-8 px-4 py-3">
    <AutomatedKnob label="Delay" value={props.params.delayMs} valueLabel={formatDeviceMilliseconds(props.params.delayMs, 1)} resetValue={defaults.delayMs} min={10} max={30} step={0.1} disabled={!props.params.enabled} parameterId="ensemble.delayMs" automation={props} onValueChange={(delayMs) => props.onChange({ delayMs })} />
    <AutomatedKnob label="Depth" value={props.params.depthMs} valueLabel={formatDeviceMilliseconds(props.params.depthMs, 1)} resetValue={defaults.depthMs} min={1} max={12} step={0.1} disabled={!props.params.enabled} parameterId="ensemble.depthMs" automation={props} onValueChange={(depthMs) => props.onChange({ depthMs })} />
    <AutomatedKnob label="Rate" value={props.params.rateHz} valueLabel={formatDeviceHertz(props.params.rateHz, 2)} resetValue={defaults.rateHz} min={0.05} max={5} step={0.01} logarithmic disabled={!props.params.enabled} parameterId="ensemble.rateHz" automation={props} onValueChange={(rateHz) => props.onChange({ rateHz })} />
    <AutomatedKnob label="Spread" value={props.params.spread} valueLabel={percent(props.params.spread)} resetValue={defaults.spread} min={0} max={1} step={0.01} disabled={!props.params.enabled} parameterId="ensemble.spread" automation={props} onValueChange={(spread) => props.onChange({ spread })} />
    <AutomatedKnob label="Mix" value={props.params.mix} valueLabel={percent(props.params.mix)} resetValue={defaults.mix} min={0} max={1} step={0.01} disabled={!props.params.enabled} parameterId="ensemble.mix" automation={props} onValueChange={(mix) => props.onChange({ mix })} />
  </div></EffectShell>
}
