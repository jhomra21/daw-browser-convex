import { Show } from 'solid-js'
import { AUTO_FILTER_LFO_DIVISIONS, createDefaultAutoFilterParams, type AutoFilterParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import AutoFilterGraph from '~/components/effects/AutoFilterGraph'
import { autoFilterLfoRateLabel } from '~/components/effects/auto-filter-view'
import { ChoiceMenu, DeviceToggleButton } from '~/components/ui/device-control'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { formatDeviceDb, formatDeviceFrequency, formatDeviceMilliseconds, formatDevicePercent } from '~/lib/device-value-format'

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

const FILTER_TYPES = [
  { value: 'lowpass', label: 'Low Pass' },
  { value: 'highpass', label: 'High Pass' },
  { value: 'bandpass', label: 'Band Pass' },
  { value: 'notch', label: 'Notch' },
  { value: 'peak', label: 'Peak' },
] as const

const WAVEFORMS = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'sawDown', label: 'Saw Down' },
  { value: 'sawUp', label: 'Saw Up' },
  { value: 'square', label: 'Square' },
  { value: 'sampleHold', label: 'S&H' },
] as const

const DIVISIONS = AUTO_FILTER_LFO_DIVISIONS.map((label, index) => ({ value: index, label }))

export default function AutoFilter(props: AutoFilterProps) {
  const off = () => !props.params.enabled
  const spin = () => props.params.lfo.stereoMode === 'spin'
  const changeLfo = (updates: Partial<AutoFilterParams['lfo']>) => props.onChange({ lfo: { ...props.params.lfo, ...updates } })
  const changeEnvelope = (updates: Partial<AutoFilterParams['envelope']>) => props.onChange({ envelope: { ...props.params.envelope, ...updates } })

  return <EffectShell
    title="Auto Filter"
    enabled={props.params.enabled}
    onToggleEnabled={props.onToggleEnabled}
    onReset={props.onReset}
    class="device-autofilter"
    titleActions={<DeviceToggleButton label="HQ" ariaLabel="Hi-Quality: 2x oversampling, adds 63 frames of latency" active={props.params.hiQuality} disabled={off()} class="px-2" onClick={() => props.onChange({ hiQuality: !props.params.hiQuality })} />}
  ><div class="device-autofilter-grid grid min-h-0 flex-1 gap-2 px-3 py-3">
    <div class="grid content-between justify-items-center gap-2 border-r border-border pr-2">
      <AutomatedKnob label="Freq" value={props.params.frequencyHz} valueLabel={formatDeviceFrequency(props.params.frequencyHz, 1)} resetValue={defaults.frequencyHz} min={20} max={20000} step={1} logarithmic disabled={off()} parameterId="autofilter.frequencyHz" automation={props} onValueChange={(frequencyHz) => props.onChange({ frequencyHz })} />
      <div class="grid w-full gap-1">
        <ChoiceMenu label="Filter type" choices={FILTER_TYPES} value={props.params.mode} disabled={off()} onSelect={(mode) => props.onChange({ mode })} />
        <div class="grid grid-cols-2 gap-1">
          <DeviceToggleButton label="12" ariaLabel="12 dB per octave" active={props.params.slope === 12} disabled={off()} onClick={() => props.onChange({ slope: 12 })} />
          <DeviceToggleButton label="24" ariaLabel="24 dB per octave" active={props.params.slope === 24} disabled={off()} onClick={() => props.onChange({ slope: 24 })} />
        </div>
      </div>
      <AutomatedKnob label="Res" value={props.params.resonance} valueLabel={percent(props.params.resonance)} resetValue={defaults.resonance} min={0} max={1} step={0.01} disabled={off()} parameterId="autofilter.resonance" automation={props} onValueChange={(resonance) => props.onChange({ resonance })} />
    </div>
    <div class="grid min-h-0 min-w-0 content-start gap-2">
      <AutoFilterGraph params={props.params} disabled={off()} onChange={props.onChange} />
      <div class="flex items-center gap-1 bg-muted px-1 py-1 text-2xs">
        <span class="px-1 font-semibold">LFO</span>
        <DeviceToggleButton label="Phase" active={!spin()} disabled={off()} onClick={() => changeLfo({ stereoMode: 'phase' })} />
        <DeviceToggleButton label="Spin" active={spin()} disabled={off()} onClick={() => changeLfo({ stereoMode: 'spin' })} />
        <div class="w-20"><ChoiceMenu label="LFO wave" choices={WAVEFORMS} value={props.params.lfo.waveform} disabled={off()} onSelect={(waveform) => changeLfo({ waveform })} /></div>
        <DeviceToggleButton label="Sync" ariaLabel="Sync the LFO rate to the tempo" active={props.params.lfo.sync} disabled={off()} class="ml-auto" onClick={() => changeLfo({ sync: !props.params.lfo.sync })} />
      </div>
      <div class="grid grid-cols-4 place-items-center">
        <AutomatedKnob label="LFO Amt" value={props.params.lfo.depthOctaves} valueLabel={`${props.params.lfo.depthOctaves.toFixed(2)} oct`} resetValue={defaults.lfo.depthOctaves} min={0} max={6} step={0.01} disabled={off()} parameterId="autofilter.lfo.depthOctaves" automation={props} onValueChange={(depthOctaves) => changeLfo({ depthOctaves })} />
        <Show
          when={props.params.lfo.sync}
          fallback={<AutomatedKnob label="Rate" value={props.params.lfo.rateHz} valueLabel={autoFilterLfoRateLabel(props.params.lfo)} resetValue={defaults.lfo.rateHz} min={0.01} max={20} step={0.01} logarithmic disabled={off()} parameterId="autofilter.lfo.rateHz" automation={props} onValueChange={(rateHz) => changeLfo({ rateHz })} />}
        >
          <div class="grid w-16 gap-1 text-center text-2xs text-muted-foreground">
            <ChoiceMenu label="LFO rate division" choices={DIVISIONS} value={props.params.lfo.division} disabled={off()} onSelect={(division) => changeLfo({ division })} />
            Rate
          </div>
        </Show>
        <AutomatedKnob label="Offset" value={props.params.lfo.phaseOffset} valueLabel={`${Math.round(props.params.lfo.phaseOffset * 360)}°`} resetValue={defaults.lfo.phaseOffset} min={0} max={1} step={0.01} disabled={off()} parameterId="autofilter.lfo.phaseOffset" automation={props} onValueChange={(phaseOffset) => changeLfo({ phaseOffset })} />
        <AutomatedKnob label={spin() ? 'Spin' : 'Phase'} value={props.params.lfo.stereoPhase} valueLabel={spin() ? `${(props.params.lfo.stereoPhase * 100).toFixed(1)}%` : `${Math.round(props.params.lfo.stereoPhase * 360)}°`} resetValue={defaults.lfo.stereoPhase} min={-0.5} max={0.5} step={0.01} bipolar disabled={off()} parameterId="autofilter.lfo.stereoPhase" automation={props} onValueChange={(stereoPhase) => changeLfo({ stereoPhase })} />
      </div>
      <div class="grid grid-cols-[1fr_1fr_1fr_4.5rem] place-items-center border-t border-border pt-2">
        <AutomatedKnob label="Env Amt" value={props.params.envelope.amountOctaves} valueLabel={`${props.params.envelope.amountOctaves.toFixed(2)} oct`} resetValue={defaults.envelope.amountOctaves} min={-6} max={6} step={0.01} bipolar disabled={off()} parameterId="autofilter.envelope.amountOctaves" automation={props} onValueChange={(amountOctaves) => changeEnvelope({ amountOctaves })} />
        <AutomatedKnob label="Attack" value={props.params.envelope.attackMs} valueLabel={formatDeviceMilliseconds(props.params.envelope.attackMs, 1)} resetValue={defaults.envelope.attackMs} min={0.5} max={500} step={0.1} logarithmic disabled={off()} parameterId="autofilter.envelope.attackMs" automation={props} onValueChange={(attackMs) => changeEnvelope({ attackMs })} />
        <AutomatedKnob label="Release" value={props.params.envelope.releaseMs} valueLabel={formatDeviceMilliseconds(props.params.envelope.releaseMs, 0)} resetValue={defaults.envelope.releaseMs} min={5} max={2000} step={1} logarithmic disabled={off()} parameterId="autofilter.envelope.releaseMs" automation={props} onValueChange={(releaseMs) => changeEnvelope({ releaseMs })} />
        <div class="grid w-full gap-1">
          <DeviceToggleButton label="Hold" ariaLabel="Envelope hold: finish the attack before releasing" active={props.params.envelope.hold} disabled={off()} onClick={() => changeEnvelope({ hold: !props.params.envelope.hold })} />
          <DeviceToggleButton label="Link" ariaLabel="Link the envelope of both channels" active={props.params.envelope.link} disabled={off()} onClick={() => changeEnvelope({ link: !props.params.envelope.link })} />
        </div>
      </div>
    </div>
    <div class="grid content-between justify-items-center gap-2 border-l border-border pl-2">
      <AutomatedKnob label="Drive" value={props.params.driveDb} valueLabel={formatDeviceDb(props.params.driveDb, 1)} resetValue={defaults.driveDb} min={0} max={24} step={0.1} disabled={off()} parameterId="autofilter.driveDb" automation={props} onValueChange={(driveDb) => props.onChange({ driveDb })} />
      <DeviceToggleButton label="Clip" ariaLabel="Soft-clip the output to tame resonance peaks" active={props.params.clip} disabled={off()} class="w-full" onClick={() => props.onChange({ clip: !props.params.clip })} />
      <AutomatedKnob label="Output" value={props.params.outputDb} valueLabel={formatDeviceDb(props.params.outputDb, 1, true)} resetValue={defaults.outputDb} min={-24} max={24} step={0.1} bipolar disabled={off()} parameterId="autofilter.outputDb" automation={props} onValueChange={(outputDb) => props.onChange({ outputDb })} />
      <AutomatedKnob label="Dry/Wet" value={props.params.mix} valueLabel={percent(props.params.mix)} resetValue={defaults.mix} min={0} max={1} step={0.01} disabled={off()} parameterId="autofilter.mix" automation={props} onValueChange={(mix) => props.onChange({ mix })} />
    </div>
  </div></EffectShell>
}
