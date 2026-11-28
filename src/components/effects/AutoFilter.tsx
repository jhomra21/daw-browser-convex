import { createDefaultAutoFilterParams, type AutoFilterParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { formatDeviceDb, formatDeviceFrequency, formatDeviceHertz, formatDeviceMilliseconds, formatDevicePercent } from '~/lib/device-value-format'

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
const percent = formatDevicePercent

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
        <AutomatedKnob label="Frequency" value={props.params.frequencyHz} valueLabel={formatDeviceFrequency(props.params.frequencyHz, 1)} resetValue={defaults.frequencyHz} min={20} max={20000} step={1} logarithmic disabled={!props.params.enabled} parameterId="autofilter.frequencyHz" automation={props} onValueChange={(frequencyHz) => props.onChange({ frequencyHz })} />
        <AutomatedKnob label="Resonance" value={props.params.resonance} valueLabel={percent(props.params.resonance)} resetValue={defaults.resonance} min={0} max={1} step={0.01} disabled={!props.params.enabled} parameterId="autofilter.resonance" automation={props} onValueChange={(resonance) => props.onChange({ resonance })} />
        <AutomatedKnob label="Drive" value={props.params.driveDb} valueLabel={formatDeviceDb(props.params.driveDb, 1)} resetValue={defaults.driveDb} min={0} max={24} step={0.1} disabled={!props.params.enabled} parameterId="autofilter.driveDb" automation={props} onValueChange={(driveDb) => props.onChange({ driveDb })} />
        <AutomatedKnob label="Mix" value={props.params.mix} valueLabel={percent(props.params.mix)} resetValue={defaults.mix} min={0} max={1} step={0.01} disabled={!props.params.enabled} parameterId="autofilter.mix" automation={props} onValueChange={(mix) => props.onChange({ mix })} />
      </div>
      <div class="grid grid-cols-4 place-items-center py-2">
        <AutomatedKnob label="Env Amt" value={props.params.envelope.amountOctaves} valueLabel={`${props.params.envelope.amountOctaves.toFixed(2)} oct`} resetValue={defaults.envelope.amountOctaves} min={-6} max={6} step={0.01} bipolar disabled={!props.params.enabled} parameterId="autofilter.envelope.amountOctaves" automation={props} onValueChange={(amountOctaves) => props.onChange({ envelope: { ...props.params.envelope, amountOctaves } })} />
        <AutomatedKnob label="Attack" value={props.params.envelope.attackMs} valueLabel={formatDeviceMilliseconds(props.params.envelope.attackMs, 1)} resetValue={defaults.envelope.attackMs} min={0.5} max={500} step={0.1} logarithmic disabled={!props.params.enabled} parameterId="autofilter.envelope.attackMs" automation={props} onValueChange={(attackMs) => props.onChange({ envelope: { ...props.params.envelope, attackMs } })} />
        <AutomatedKnob label="Release" value={props.params.envelope.releaseMs} valueLabel={formatDeviceMilliseconds(props.params.envelope.releaseMs, 0)} resetValue={defaults.envelope.releaseMs} min={5} max={2000} step={1} logarithmic disabled={!props.params.enabled} parameterId="autofilter.envelope.releaseMs" automation={props} onValueChange={(releaseMs) => props.onChange({ envelope: { ...props.params.envelope, releaseMs } })} />
      </div>
      <div class="grid grid-cols-5 place-items-center pt-2">
        <AutomatedKnob label="LFO Rate" value={props.params.lfo.rateHz} valueLabel={formatDeviceHertz(props.params.lfo.rateHz, 2)} resetValue={defaults.lfo.rateHz} min={0.01} max={20} step={0.01} logarithmic disabled={!props.params.enabled} parameterId="autofilter.lfo.rateHz" automation={props} onValueChange={(rateHz) => props.onChange({ lfo: { ...props.params.lfo, rateHz } })} />
        <AutomatedKnob label="LFO Depth" value={props.params.lfo.depthOctaves} valueLabel={`${props.params.lfo.depthOctaves.toFixed(2)} oct`} resetValue={defaults.lfo.depthOctaves} min={0} max={6} step={0.01} disabled={!props.params.enabled} parameterId="autofilter.lfo.depthOctaves" automation={props} onValueChange={(depthOctaves) => props.onChange({ lfo: { ...props.params.lfo, depthOctaves } })} />
        <AutomatedKnob label="Offset" value={props.params.lfo.phaseOffset} valueLabel={`${Math.round(props.params.lfo.phaseOffset * 360)}°`} resetValue={defaults.lfo.phaseOffset} min={0} max={1} step={0.01} disabled={!props.params.enabled} parameterId="autofilter.lfo.phaseOffset" automation={props} onValueChange={(phaseOffset) => props.onChange({ lfo: { ...props.params.lfo, phaseOffset } })} />
        <AutomatedKnob label="Stereo" value={props.params.lfo.stereoPhase} valueLabel={`${Math.round(props.params.lfo.stereoPhase * 360)}°`} resetValue={defaults.lfo.stereoPhase} min={-0.5} max={0.5} step={0.01} bipolar disabled={!props.params.enabled} parameterId="autofilter.lfo.stereoPhase" automation={props} onValueChange={(stereoPhase) => props.onChange({ lfo: { ...props.params.lfo, stereoPhase } })} />
        <div class="grid gap-1">
        <DeviceToggleButton label="Sine" active={props.params.lfo.waveform === 'sine'} disabled={!props.params.enabled} onClick={() => props.onChange({ lfo: { ...props.params.lfo, waveform: 'sine' } })} />
        <DeviceToggleButton label="Triangle" active={props.params.lfo.waveform === 'triangle'} disabled={!props.params.enabled} onClick={() => props.onChange({ lfo: { ...props.params.lfo, waveform: 'triangle' } })} />
        </div>
      </div>
    </div>
  </div></EffectShell>
}
