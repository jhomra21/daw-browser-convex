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
  return <EffectShell title="Auto Filter" typeLabel="2x" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="device-autofilter"><div class="device-autofilter-grid grid min-h-0 flex-1 gap-3 px-3 py-3">
    <div class="grid content-center gap-1 border-r border-border pr-3">
      <span class="mb-1 text-2xs uppercase text-muted-foreground">Filter</span>
      <DeviceToggleButton label="Low Pass" active={props.params.mode === 'lowpass'} disabled={!props.params.enabled} onClick={() => props.onChange({ mode: 'lowpass' })} />
      <DeviceToggleButton label="High Pass" active={props.params.mode === 'highpass'} disabled={!props.params.enabled} onClick={() => props.onChange({ mode: 'highpass' })} />
      <DeviceToggleButton label="Band Pass" active={props.params.mode === 'bandpass'} disabled={!props.params.enabled} onClick={() => props.onChange({ mode: 'bandpass' })} />
      <DeviceToggleButton label="Notch" active={props.params.mode === 'notch'} disabled={!props.params.enabled} onClick={() => props.onChange({ mode: 'notch' })} />
      <DeviceToggleButton label="Peak" active={props.params.mode === 'peak'} disabled={!props.params.enabled} onClick={() => props.onChange({ mode: 'peak' })} />
    </div>
    <div class="grid min-h-0 grid-rows-3 divide-y divide-border">
      <div class="grid grid-cols-4 place-items-center pb-2">
        <Knob label="Frequency" value={props.params.frequencyHz} valueLabel={`${Math.round(props.params.frequencyHz)} Hz`} resetValue={defaults.frequencyHz} min={20} max={20000} step={1} logarithmic disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('autofilter.frequencyHz')} automated={props.automationRangesByParameterId?.has('autofilter.frequencyHz')} onAutomationSelect={() => props.onAutomationParameterTouch?.('autofilter.frequencyHz')} onValueChange={(frequencyHz) => { props.onManualAutomationOverride?.('autofilter.frequencyHz'); props.onChange({ frequencyHz }) }} />
        <Knob label="Resonance" value={props.params.resonance} valueLabel={percent(props.params.resonance)} resetValue={defaults.resonance} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('autofilter.resonance')} automated={props.automationRangesByParameterId?.has('autofilter.resonance')} onAutomationSelect={() => props.onAutomationParameterTouch?.('autofilter.resonance')} onValueChange={(resonance) => { props.onManualAutomationOverride?.('autofilter.resonance'); props.onChange({ resonance }) }} />
        <Knob label="Drive" value={props.params.driveDb} valueLabel={`${props.params.driveDb.toFixed(1)} dB`} resetValue={defaults.driveDb} min={0} max={24} step={0.1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('autofilter.driveDb')} automated={props.automationRangesByParameterId?.has('autofilter.driveDb')} onAutomationSelect={() => props.onAutomationParameterTouch?.('autofilter.driveDb')} onValueChange={(driveDb) => { props.onManualAutomationOverride?.('autofilter.driveDb'); props.onChange({ driveDb }) }} />
        <Knob label="Mix" value={props.params.mix} valueLabel={percent(props.params.mix)} resetValue={defaults.mix} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('autofilter.mix')} automated={props.automationRangesByParameterId?.has('autofilter.mix')} onAutomationSelect={() => props.onAutomationParameterTouch?.('autofilter.mix')} onValueChange={(mix) => { props.onManualAutomationOverride?.('autofilter.mix'); props.onChange({ mix }) }} />
      </div>
      <div class="grid grid-cols-4 place-items-center py-2">
        <Knob label="Env Amt" value={props.params.envelope.amountOctaves} valueLabel={`${props.params.envelope.amountOctaves.toFixed(2)} oct`} resetValue={defaults.envelope.amountOctaves} min={-6} max={6} step={0.01} bipolar disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('autofilter.envelope.amountOctaves')} automated={props.automationRangesByParameterId?.has('autofilter.envelope.amountOctaves')} onAutomationSelect={() => props.onAutomationParameterTouch?.('autofilter.envelope.amountOctaves')} onValueChange={(amountOctaves) => { props.onManualAutomationOverride?.('autofilter.envelope.amountOctaves'); props.onChange({ envelope: { ...props.params.envelope, amountOctaves } }) }} />
        <Knob label="Attack" value={props.params.envelope.attackMs} valueLabel={`${props.params.envelope.attackMs.toFixed(1)} ms`} resetValue={defaults.envelope.attackMs} min={0.5} max={500} step={0.1} logarithmic disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('autofilter.envelope.attackMs')} automated={props.automationRangesByParameterId?.has('autofilter.envelope.attackMs')} onAutomationSelect={() => props.onAutomationParameterTouch?.('autofilter.envelope.attackMs')} onValueChange={(attackMs) => { props.onManualAutomationOverride?.('autofilter.envelope.attackMs'); props.onChange({ envelope: { ...props.params.envelope, attackMs } }) }} />
        <Knob label="Release" value={props.params.envelope.releaseMs} valueLabel={`${Math.round(props.params.envelope.releaseMs)} ms`} resetValue={defaults.envelope.releaseMs} min={5} max={2000} step={1} logarithmic disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('autofilter.envelope.releaseMs')} automated={props.automationRangesByParameterId?.has('autofilter.envelope.releaseMs')} onAutomationSelect={() => props.onAutomationParameterTouch?.('autofilter.envelope.releaseMs')} onValueChange={(releaseMs) => { props.onManualAutomationOverride?.('autofilter.envelope.releaseMs'); props.onChange({ envelope: { ...props.params.envelope, releaseMs } }) }} />
      </div>
      <div class="grid grid-cols-5 place-items-center pt-2">
        <Knob label="LFO Rate" value={props.params.lfo.rateHz} valueLabel={`${props.params.lfo.rateHz.toFixed(2)} Hz`} resetValue={defaults.lfo.rateHz} min={0.01} max={20} step={0.01} logarithmic disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('autofilter.lfo.rateHz')} automated={props.automationRangesByParameterId?.has('autofilter.lfo.rateHz')} onAutomationSelect={() => props.onAutomationParameterTouch?.('autofilter.lfo.rateHz')} onValueChange={(rateHz) => { props.onManualAutomationOverride?.('autofilter.lfo.rateHz'); props.onChange({ lfo: { ...props.params.lfo, rateHz } }) }} />
        <Knob label="LFO Depth" value={props.params.lfo.depthOctaves} valueLabel={`${props.params.lfo.depthOctaves.toFixed(2)} oct`} resetValue={defaults.lfo.depthOctaves} min={0} max={6} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('autofilter.lfo.depthOctaves')} automated={props.automationRangesByParameterId?.has('autofilter.lfo.depthOctaves')} onAutomationSelect={() => props.onAutomationParameterTouch?.('autofilter.lfo.depthOctaves')} onValueChange={(depthOctaves) => { props.onManualAutomationOverride?.('autofilter.lfo.depthOctaves'); props.onChange({ lfo: { ...props.params.lfo, depthOctaves } }) }} />
        <Knob label="Offset" value={props.params.lfo.phaseOffset} valueLabel={`${Math.round(props.params.lfo.phaseOffset * 360)}°`} resetValue={defaults.lfo.phaseOffset} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('autofilter.lfo.phaseOffset')} automated={props.automationRangesByParameterId?.has('autofilter.lfo.phaseOffset')} onAutomationSelect={() => props.onAutomationParameterTouch?.('autofilter.lfo.phaseOffset')} onValueChange={(phaseOffset) => { props.onManualAutomationOverride?.('autofilter.lfo.phaseOffset'); props.onChange({ lfo: { ...props.params.lfo, phaseOffset } }) }} />
        <Knob label="Stereo" value={props.params.lfo.stereoPhase} valueLabel={`${Math.round(props.params.lfo.stereoPhase * 360)}°`} resetValue={defaults.lfo.stereoPhase} min={-0.5} max={0.5} step={0.01} bipolar disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('autofilter.lfo.stereoPhase')} automated={props.automationRangesByParameterId?.has('autofilter.lfo.stereoPhase')} onAutomationSelect={() => props.onAutomationParameterTouch?.('autofilter.lfo.stereoPhase')} onValueChange={(stereoPhase) => { props.onManualAutomationOverride?.('autofilter.lfo.stereoPhase'); props.onChange({ lfo: { ...props.params.lfo, stereoPhase } }) }} />
        <div class="grid gap-1">
        <DeviceToggleButton label="Sine" active={props.params.lfo.waveform === 'sine'} disabled={!props.params.enabled} onClick={() => props.onChange({ lfo: { ...props.params.lfo, waveform: 'sine' } })} />
        <DeviceToggleButton label="Triangle" active={props.params.lfo.waveform === 'triangle'} disabled={!props.params.enabled} onClick={() => props.onChange({ lfo: { ...props.params.lfo, waveform: 'triangle' } })} />
        </div>
      </div>
    </div>
  </div></EffectShell>
}
