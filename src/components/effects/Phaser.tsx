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
  const knob = (label: string, id: string, value: number, resetValue: number, min: number, max: number, step: number, valueLabel: string, update: (value: number) => Partial<PhaserParams>, bipolar = false, logarithmic = false) => (
    <Knob label={label} value={value} valueLabel={valueLabel} resetValue={resetValue} min={min} max={max} step={step} bipolar={bipolar} logarithmic={logarithmic} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get(id)} automated={props.automationRangesByParameterId?.has(id)} onAutomationSelect={() => props.onAutomationParameterTouch?.(id)} onValueChange={(next) => { props.onManualAutomationOverride?.(id); props.onChange(update(next)) }} />
  )
  return <EffectShell title="Phaser" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-[280px] min-w-[280px]"><div class="grid min-h-0 flex-1 grid-cols-[1fr_3rem] gap-3 px-3 py-3">
    <div class="grid grid-cols-2 grid-rows-3 items-center gap-x-5 border-r border-border pr-3">
      {knob('Center', 'phaser.centerHz', props.params.centerHz, defaults.centerHz, 100, 8000, 1, `${Math.round(props.params.centerHz)} Hz`, (centerHz) => ({ centerHz }), false, true)}
      {knob('Depth', 'phaser.depthOctaves', props.params.depthOctaves, defaults.depthOctaves, 0, 5, 0.01, `${props.params.depthOctaves.toFixed(2)} oct`, (depthOctaves) => ({ depthOctaves }))}
      {knob('Rate', 'phaser.rateHz', props.params.rateHz, defaults.rateHz, 0.01, 20, 0.01, `${props.params.rateHz.toFixed(2)} Hz`, (rateHz) => ({ rateHz }), false, true)}
      {knob('Feedback', 'phaser.feedback', props.params.feedback, defaults.feedback, -0.95, 0.95, 0.01, percent(props.params.feedback), (feedback) => ({ feedback }), true)}
      {knob('Stereo', 'phaser.stereoPhase', props.params.stereoPhase, defaults.stereoPhase, -0.5, 0.5, 0.01, percent(props.params.stereoPhase), (stereoPhase) => ({ stereoPhase }), true)}
      {knob('Mix', 'phaser.mix', props.params.mix, defaults.mix, 0, 1, 0.01, percent(props.params.mix), (mix) => ({ mix }))}
    </div>
    <div class="grid content-center gap-1">
      <DeviceToggleButton label="4" active={props.params.stages === 4} disabled={!props.params.enabled} onClick={() => props.onChange({ stages: 4 })} />
      <DeviceToggleButton label="6" active={props.params.stages === 6} disabled={!props.params.enabled} onClick={() => props.onChange({ stages: 6 })} />
      <DeviceToggleButton label="8" active={props.params.stages === 8} disabled={!props.params.enabled} onClick={() => props.onChange({ stages: 8 })} />
      <DeviceToggleButton label="12" active={props.params.stages === 12} disabled={!props.params.enabled} onClick={() => props.onChange({ stages: 12 })} />
    </div>
  </div></EffectShell>
}
