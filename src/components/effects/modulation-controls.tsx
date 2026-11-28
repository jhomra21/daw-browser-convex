import { Show } from 'solid-js'
import { MODULATION_WAVEFORMS, type ModulationWaveform } from '@daw-browser/shared'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { ChoiceMenu, DeviceToggleButton } from '~/components/ui/device-control'
import { formatDeviceDb, formatDeviceFrequency, formatDevicePercent } from '~/lib/device-value-format'

// Controls the six modulation devices share, each wired to `<parameterPrefix>.<param>` for automation.
export type ModulationAutomation = {
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}

const KNOB_SIZE = 32

const WAVEFORM_LABELS: Record<ModulationWaveform, string> = {
  sine: 'Sine',
  triangle: 'Triangle',
  sawDown: 'Saw Down',
  sawUp: 'Saw Up',
  square: 'Square',
  sampleHold: 'Sample & Hold',
  wander: 'Wander',
}

const WAVEFORM_CHOICES = MODULATION_WAVEFORMS.map((value) => ({ value, label: WAVEFORM_LABELS[value] }))

export const formatDegrees = (cycles: number) => `${Math.round(cycles * 360)}°`

export function WaveformChoice(props: { waveform: ModulationWaveform; disabled: boolean; onSelect: (waveform: ModulationWaveform) => void }) {
  return <ChoiceMenu label="Waveform" choices={WAVEFORM_CHOICES} value={props.waveform} disabled={props.disabled} onSelect={props.onSelect} />
}

type ParamsProps<Params extends { enabled: boolean }, Updates> = {
  parameterPrefix: string
  params: Params
  onChange: (updates: Updates) => void
  automation: ModulationAutomation
}

// Safe Bass: the toggle sits with the waveform row, the frequency only exists while it is on.
export function SafeBassToggle(props: { params: { enabled: boolean; safeBass: boolean }; onChange: (updates: { safeBass: boolean }) => void }) {
  return <DeviceToggleButton label="Safe Bass" active={props.params.safeBass} disabled={!props.params.enabled} onClick={() => props.onChange({ safeBass: !props.params.safeBass })} />
}

export function SafeBassKnob(props: ParamsProps<{ enabled: boolean; safeBass: boolean; safeBassHz: number }, { safeBassHz: number }>) {
  return (
    <Show when={props.params.safeBass}>
      <AutomatedKnob size={KNOB_SIZE} label="Bass Freq" valueLabel={formatDeviceFrequency(props.params.safeBassHz, 2)} value={props.params.safeBassHz} resetValue={100} min={20} max={1000} step={1} logarithmic disabled={!props.params.enabled} parameterId={`${props.parameterPrefix}.safeBassHz`} automation={props.automation} onValueChange={(safeBassHz) => props.onChange({ safeBassHz })} />
    </Show>
  )
}

export function WidthKnob(props: ParamsProps<{ enabled: boolean; width: number }, { width: number }>) {
  return <AutomatedKnob size={KNOB_SIZE} label="Width" valueLabel={formatDevicePercent(props.params.width)} value={props.params.width} resetValue={1} min={0} max={2} step={0.01} disabled={!props.params.enabled} parameterId={`${props.parameterPrefix}.width`} automation={props.automation} onValueChange={(width) => props.onChange({ width })} />
}

export function OutputKnob(props: ParamsProps<{ enabled: boolean; outputDb: number }, { outputDb: number }>) {
  return <AutomatedKnob size={KNOB_SIZE} label="Output" valueLabel={formatDeviceDb(props.params.outputDb, 1)} value={props.params.outputDb} resetValue={0} min={-24} max={12} step={0.1} bipolar disabled={!props.params.enabled} parameterId={`${props.parameterPrefix}.outputDb`} automation={props.automation} onValueChange={(outputDb) => props.onChange({ outputDb })} />
}

export function MixKnob(props: ParamsProps<{ enabled: boolean; mix: number }, { mix: number }> & { resetValue: number }) {
  return <AutomatedKnob size={KNOB_SIZE} label="Dry/Wet" valueLabel={formatDevicePercent(props.params.mix)} value={props.params.mix} resetValue={props.resetValue} min={0} max={1} step={0.01} disabled={!props.params.enabled} parameterId={`${props.parameterPrefix}.mix`} automation={props.automation} onValueChange={(mix) => props.onChange({ mix })} />
}

// The right channel's LFO offset, in degrees of the cycle.
export function StereoPhaseKnob(props: ParamsProps<{ enabled: boolean; stereoPhase: number }, { stereoPhase: number }> & { resetValue: number }) {
  return <AutomatedKnob size={KNOB_SIZE} label="Phase" valueLabel={formatDegrees(props.params.stereoPhase)} value={props.params.stereoPhase} resetValue={props.resetValue} min={-0.5} max={0.5} step={0.01} bipolar disabled={!props.params.enabled} parameterId={`${props.parameterPrefix}.stereoPhase`} automation={props.automation} onValueChange={(stereoPhase) => props.onChange({ stereoPhase })} />
}
