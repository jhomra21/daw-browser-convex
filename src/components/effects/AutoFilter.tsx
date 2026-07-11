import { createDefaultAutoFilterParams, type AutoFilterParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import Knob from '~/components/ui/knob'

type AutoFilterProps = {
  params: AutoFilterParams
  onChange: (updates: Partial<AutoFilterParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}
const defaults = createDefaultAutoFilterParams()
const percent = (value: number) => `${Math.round(value * 100)}%`
export default function AutoFilter(props: AutoFilterProps) {
  const knob = (label: string, id: string, value: number, resetValue: number, min: number, max: number, step: number, valueLabel: string, update: (value: number) => Partial<AutoFilterParams>, logarithmic = false, bipolar = false) => (
    <Knob label={label} value={value} valueLabel={valueLabel} resetValue={resetValue} min={min} max={max} step={step} logarithmic={logarithmic} bipolar={bipolar} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get(id)} automated={props.automationRangesByParameterId?.has(id)} onAutomationSelect={() => props.onAutomationParameterTouch?.(id)} onValueChange={(next) => { props.onManualAutomationOverride?.(id); props.onChange(update(next)) }} />
  )
  return <EffectShell title="Auto Filter" typeLabel="2x" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-[700px] min-w-[700px]"><div class="flex flex-1 gap-3 px-3 py-2">
    <div class="grid w-20 grid-cols-1 gap-1 content-start">
      <DeviceToggleButton label="Low Pass" active={props.params.mode === 'lowpass'} disabled={!props.params.enabled} onClick={() => props.onChange({ mode: 'lowpass' })} />
      <DeviceToggleButton label="High Pass" active={props.params.mode === 'highpass'} disabled={!props.params.enabled} onClick={() => props.onChange({ mode: 'highpass' })} />
      <DeviceToggleButton label="Band Pass" active={props.params.mode === 'bandpass'} disabled={!props.params.enabled} onClick={() => props.onChange({ mode: 'bandpass' })} />
      <DeviceToggleButton label="Notch" active={props.params.mode === 'notch'} disabled={!props.params.enabled} onClick={() => props.onChange({ mode: 'notch' })} />
      <DeviceToggleButton label="Peak" active={props.params.mode === 'peak'} disabled={!props.params.enabled} onClick={() => props.onChange({ mode: 'peak' })} />
    </div>
    <div class="grid grid-cols-4 gap-2">
      {knob('Frequency', 'autofilter.frequencyHz', props.params.frequencyHz, defaults.frequencyHz, 20, 20000, 1, `${Math.round(props.params.frequencyHz)} Hz`, (frequencyHz) => ({ frequencyHz }), true)}
      {knob('Resonance', 'autofilter.resonance', props.params.resonance, defaults.resonance, 0, 1, 0.01, percent(props.params.resonance), (resonance) => ({ resonance }))}
      {knob('Drive', 'autofilter.driveDb', props.params.driveDb, defaults.driveDb, 0, 24, 0.1, `${props.params.driveDb.toFixed(1)} dB`, (driveDb) => ({ driveDb }))}
      {knob('Mix', 'autofilter.mix', props.params.mix, defaults.mix, 0, 1, 0.01, percent(props.params.mix), (mix) => ({ mix }))}
      {knob('Env Amt', 'autofilter.envelope.amountOctaves', props.params.envelope.amountOctaves, defaults.envelope.amountOctaves, -6, 6, 0.01, `${props.params.envelope.amountOctaves.toFixed(2)} oct`, (amountOctaves) => ({ envelope: { ...props.params.envelope, amountOctaves } }), false, true)}
      {knob('Attack', 'autofilter.envelope.attackMs', props.params.envelope.attackMs, defaults.envelope.attackMs, 0.5, 500, 0.1, `${props.params.envelope.attackMs.toFixed(1)} ms`, (attackMs) => ({ envelope: { ...props.params.envelope, attackMs } }), true)}
      {knob('Release', 'autofilter.envelope.releaseMs', props.params.envelope.releaseMs, defaults.envelope.releaseMs, 5, 2000, 1, `${Math.round(props.params.envelope.releaseMs)} ms`, (releaseMs) => ({ envelope: { ...props.params.envelope, releaseMs } }), true)}
      {knob('LFO Rate', 'autofilter.lfo.rateHz', props.params.lfo.rateHz, defaults.lfo.rateHz, 0.01, 20, 0.01, `${props.params.lfo.rateHz.toFixed(2)} Hz`, (rateHz) => ({ lfo: { ...props.params.lfo, rateHz } }))}
      {knob('LFO Depth', 'autofilter.lfo.depthOctaves', props.params.lfo.depthOctaves, defaults.lfo.depthOctaves, 0, 6, 0.01, `${props.params.lfo.depthOctaves.toFixed(2)} oct`, (depthOctaves) => ({ lfo: { ...props.params.lfo, depthOctaves } }))}
      {knob('Offset', 'autofilter.lfo.phaseOffset', props.params.lfo.phaseOffset, defaults.lfo.phaseOffset, 0, 1, 0.01, `${Math.round(props.params.lfo.phaseOffset * 360)}°`, (phaseOffset) => ({ lfo: { ...props.params.lfo, phaseOffset } }))}
      {knob('Stereo', 'autofilter.lfo.stereoPhase', props.params.lfo.stereoPhase, defaults.lfo.stereoPhase, -0.5, 0.5, 0.01, `${Math.round(props.params.lfo.stereoPhase * 360)}°`, (stereoPhase) => ({ lfo: { ...props.params.lfo, stereoPhase } }), false, true)}
      <div class="grid grid-cols-1 gap-1 content-start">
        <DeviceToggleButton label="Sine" active={props.params.lfo.waveform === 'sine'} disabled={!props.params.enabled} onClick={() => props.onChange({ lfo: { ...props.params.lfo, waveform: 'sine' } })} />
        <DeviceToggleButton label="Triangle" active={props.params.lfo.waveform === 'triangle'} disabled={!props.params.enabled} onClick={() => props.onChange({ lfo: { ...props.params.lfo, waveform: 'triangle' } })} />
      </div>
    </div>
  </div></EffectShell>
}
