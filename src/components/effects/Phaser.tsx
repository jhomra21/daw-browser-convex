import { createDefaultPhaserParams, type PhaserParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import Knob from '~/components/ui/knob'

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
const percent = (value: number) => `${Math.round(value * 100)}%`
export default function Phaser(props: PhaserProps) {
  return <EffectShell title="Phaser" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="device-phaser"><div class="device-phaser-grid grid min-h-0 flex-1 gap-3 px-3 py-3">
    <div class="grid grid-cols-2 grid-rows-3 items-center gap-x-5 border-r border-border pr-3">
      <Knob label="Center" value={props.params.centerHz} valueLabel={`${Math.round(props.params.centerHz)} Hz`} resetValue={defaults.centerHz} min={100} max={8000} step={1} logarithmic disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('phaser.centerHz')} automated={props.automationRangesByParameterId?.has('phaser.centerHz')} onAutomationSelect={() => props.onAutomationParameterTouch?.('phaser.centerHz')} onValueChange={(centerHz) => { props.onManualAutomationOverride?.('phaser.centerHz'); props.onChange({ centerHz }) }} />
      <Knob label="Depth" value={props.params.depthOctaves} valueLabel={`${props.params.depthOctaves.toFixed(2)} oct`} resetValue={defaults.depthOctaves} min={0} max={5} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('phaser.depthOctaves')} automated={props.automationRangesByParameterId?.has('phaser.depthOctaves')} onAutomationSelect={() => props.onAutomationParameterTouch?.('phaser.depthOctaves')} onValueChange={(depthOctaves) => { props.onManualAutomationOverride?.('phaser.depthOctaves'); props.onChange({ depthOctaves }) }} />
      <Knob label="Rate" value={props.params.rateHz} valueLabel={`${props.params.rateHz.toFixed(2)} Hz`} resetValue={defaults.rateHz} min={0.01} max={20} step={0.01} logarithmic disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('phaser.rateHz')} automated={props.automationRangesByParameterId?.has('phaser.rateHz')} onAutomationSelect={() => props.onAutomationParameterTouch?.('phaser.rateHz')} onValueChange={(rateHz) => { props.onManualAutomationOverride?.('phaser.rateHz'); props.onChange({ rateHz }) }} />
      <Knob label="Feedback" value={props.params.feedback} valueLabel={percent(props.params.feedback)} resetValue={defaults.feedback} min={-0.95} max={0.95} step={0.01} bipolar disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('phaser.feedback')} automated={props.automationRangesByParameterId?.has('phaser.feedback')} onAutomationSelect={() => props.onAutomationParameterTouch?.('phaser.feedback')} onValueChange={(feedback) => { props.onManualAutomationOverride?.('phaser.feedback'); props.onChange({ feedback }) }} />
      <Knob label="Stereo" value={props.params.stereoPhase} valueLabel={percent(props.params.stereoPhase)} resetValue={defaults.stereoPhase} min={-0.5} max={0.5} step={0.01} bipolar disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('phaser.stereoPhase')} automated={props.automationRangesByParameterId?.has('phaser.stereoPhase')} onAutomationSelect={() => props.onAutomationParameterTouch?.('phaser.stereoPhase')} onValueChange={(stereoPhase) => { props.onManualAutomationOverride?.('phaser.stereoPhase'); props.onChange({ stereoPhase }) }} />
      <Knob label="Mix" value={props.params.mix} valueLabel={percent(props.params.mix)} resetValue={defaults.mix} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('phaser.mix')} automated={props.automationRangesByParameterId?.has('phaser.mix')} onAutomationSelect={() => props.onAutomationParameterTouch?.('phaser.mix')} onValueChange={(mix) => { props.onManualAutomationOverride?.('phaser.mix'); props.onChange({ mix }) }} />
    </div>
    <div class="grid content-center gap-1">
      <DeviceToggleButton label="4" active={props.params.stages === 4} disabled={!props.params.enabled} onClick={() => props.onChange({ stages: 4 })} />
      <DeviceToggleButton label="6" active={props.params.stages === 6} disabled={!props.params.enabled} onClick={() => props.onChange({ stages: 6 })} />
      <DeviceToggleButton label="8" active={props.params.stages === 8} disabled={!props.params.enabled} onClick={() => props.onChange({ stages: 8 })} />
      <DeviceToggleButton label="12" active={props.params.stages === 12} disabled={!props.params.enabled} onClick={() => props.onChange({ stages: 12 })} />
    </div>
  </div></EffectShell>
}
