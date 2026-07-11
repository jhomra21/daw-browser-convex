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
  const knob = (label: string, id: string, value: number, resetValue: number, min: number, max: number, step: number, valueLabel: string, update: (value: number) => Partial<ChorusParams>, bipolar = false) => (
    <Knob label={label} value={value} valueLabel={valueLabel} resetValue={resetValue} min={min} max={max} step={step} bipolar={bipolar} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get(id)} automated={props.automationRangesByParameterId?.has(id)} onAutomationSelect={() => props.onAutomationParameterTouch?.(id)} onValueChange={(next) => { props.onManualAutomationOverride?.(id); props.onChange(update(next)) }} />
  )
  return (
    <EffectShell title="Chorus" typeLabel="Modulation" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-[430px] min-w-[430px]">
      <div class="grid flex-1 grid-cols-6 gap-2 px-3 py-2">
        {knob('Delay', 'chorus.delayMs', props.params.delayMs, defaults.delayMs, 5, 30, 0.1, `${props.params.delayMs.toFixed(1)} ms`, (delayMs) => ({ delayMs }))}
        {knob('Depth', 'chorus.depthMs', props.params.depthMs, defaults.depthMs, 0, 10, 0.1, `${props.params.depthMs.toFixed(1)} ms`, (depthMs) => ({ depthMs }))}
        {knob('Rate', 'chorus.rateHz', props.params.rateHz, defaults.rateHz, 0.01, 20, 0.01, `${props.params.rateHz.toFixed(2)} Hz`, (rateHz) => ({ rateHz }))}
        {knob('Feedback', 'chorus.feedback', props.params.feedback, defaults.feedback, 0, 0.5, 0.01, percent(props.params.feedback), (feedback) => ({ feedback }))}
        {knob('Stereo', 'chorus.stereoPhase', props.params.stereoPhase, defaults.stereoPhase, -0.5, 0.5, 0.01, percent(props.params.stereoPhase), (stereoPhase) => ({ stereoPhase }), true)}
        {knob('Mix', 'chorus.mix', props.params.mix, defaults.mix, 0, 1, 0.01, percent(props.params.mix), (mix) => ({ mix }))}
      </div>
    </EffectShell>
  )
}
