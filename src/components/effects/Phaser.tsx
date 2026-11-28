import { createDefaultPhaserParams, type PhaserParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { formatDeviceFrequency, formatDeviceHertz, formatDevicePercent } from '~/lib/device-value-format'

type PhaserProps = {
  params: PhaserParams
  onChange: (updates: Partial<PhaserParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}

const defaults = createDefaultPhaserParams()
const percent = formatDevicePercent

export default function Phaser(props: PhaserProps) {
  return <EffectShell title="Phaser" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="device-phaser"><div class="device-phaser-grid grid min-h-0 flex-1 gap-3 px-3 py-3">
    <div class="grid grid-cols-2 grid-rows-3 items-center gap-x-5 border-r border-border pr-3">
      <AutomatedKnob label="Center" value={props.params.centerHz} valueLabel={formatDeviceFrequency(props.params.centerHz, 1)} resetValue={defaults.centerHz} min={100} max={8000} step={1} logarithmic disabled={!props.params.enabled} parameterId="phaser.centerHz" automation={props} onValueChange={(centerHz) => props.onChange({ centerHz })} />
      <AutomatedKnob label="Depth" value={props.params.depthOctaves} valueLabel={`${props.params.depthOctaves.toFixed(2)} oct`} resetValue={defaults.depthOctaves} min={0} max={5} step={0.01} disabled={!props.params.enabled} parameterId="phaser.depthOctaves" automation={props} onValueChange={(depthOctaves) => props.onChange({ depthOctaves })} />
      <AutomatedKnob label="Rate" value={props.params.rateHz} valueLabel={formatDeviceHertz(props.params.rateHz, 2)} resetValue={defaults.rateHz} min={0.01} max={20} step={0.01} logarithmic disabled={!props.params.enabled} parameterId="phaser.rateHz" automation={props} onValueChange={(rateHz) => props.onChange({ rateHz })} />
      <AutomatedKnob label="Feedback" value={props.params.feedback} valueLabel={percent(props.params.feedback)} resetValue={defaults.feedback} min={-0.95} max={0.95} step={0.01} bipolar disabled={!props.params.enabled} parameterId="phaser.feedback" automation={props} onValueChange={(feedback) => props.onChange({ feedback })} />
      <AutomatedKnob label="Stereo" value={props.params.stereoPhase} valueLabel={percent(props.params.stereoPhase)} resetValue={defaults.stereoPhase} min={-0.5} max={0.5} step={0.01} bipolar disabled={!props.params.enabled} parameterId="phaser.stereoPhase" automation={props} onValueChange={(stereoPhase) => props.onChange({ stereoPhase })} />
      <AutomatedKnob label="Mix" value={props.params.mix} valueLabel={percent(props.params.mix)} resetValue={defaults.mix} min={0} max={1} step={0.01} disabled={!props.params.enabled} parameterId="phaser.mix" automation={props} onValueChange={(mix) => props.onChange({ mix })} />
    </div>
    <div class="grid content-center gap-1">
      <DeviceToggleButton label="4" active={props.params.stages === 4} disabled={!props.params.enabled} onClick={() => props.onChange({ stages: 4 })} />
      <DeviceToggleButton label="6" active={props.params.stages === 6} disabled={!props.params.enabled} onClick={() => props.onChange({ stages: 6 })} />
      <DeviceToggleButton label="8" active={props.params.stages === 8} disabled={!props.params.enabled} onClick={() => props.onChange({ stages: 8 })} />
      <DeviceToggleButton label="12" active={props.params.stages === 12} disabled={!props.params.enabled} onClick={() => props.onChange({ stages: 12 })} />
    </div>
  </div></EffectShell>
}
