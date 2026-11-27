import { Match, Show, Switch, createSignal, onSettled } from 'solid-js'
import {
  createDefaultSpectralParams,
  getSpectralLatencyFrames,
  SPECTRAL_FFT_SIZES,
  SPECTRAL_MODES,
  SPECTRAL_OVERLAPS,
  type SpectralMode,
  type SpectralParams,
} from '@daw-browser/shared'
import type { Track } from '@daw-browser/timeline-core/types'
import EffectShell from '~/components/effects/EffectShell'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import { DeviceToggleButton, ChoiceMenu } from '~/components/ui/device-control'
import { getAudioEngine } from '~/lib/audio-engine-singleton'
import { formatDeviceLatency, formatDeviceMilliseconds, formatDevicePercent } from '~/lib/device-value-format'

type SpectralProps = {
  params: SpectralParams
  tracks: Track[]
  targetId: string
  sourceTrackId?: string
  onSourceChange: (sourceTrackId?: string) => void
  onChange: (updates: Partial<SpectralParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}

const defaults = createDefaultSpectralParams()

const modeLabels = {
  freeze: 'Freeze',
  gate: 'Gate',
  morph: 'Morph',
  'shift-blur': 'Shift/Blur',
  hpss: 'HPSS',
  'noise-reduce': 'Noise Reduce',
} satisfies Record<SpectralMode, string>

const modeChoices = SPECTRAL_MODES.map((mode) => ({ value: mode, label: modeLabels[mode] }))
const fftChoices = SPECTRAL_FFT_SIZES.map((size) => ({ value: size, label: String(size) }))
const overlapChoices = SPECTRAL_OVERLAPS.map((overlap) => ({ value: overlap, label: `${overlap}x` }))

const KNOB_SIZE = 32

// Each mode shows only the controls the engine reads in it; Dry/Wet acts in every mode.
export default function Spectral(props: SpectralProps) {
  const audioEngine = getAudioEngine()
  const [sampleRate, setSampleRate] = createSignal(audioEngine.getRuntimeSnapshot().sampleRate)
  const off = () => !props.params.enabled
  const percent = formatDevicePercent

  onSettled(() => audioEngine.subscribeRuntimeSnapshot(() => setSampleRate(audioEngine.getRuntimeSnapshot().sampleRate)))

  const sourceChoices = () => [
    { value: '', label: 'Internal' },
    ...props.tracks.filter((track) => track.id !== props.targetId).map((track) => ({ value: track.id, label: track.name })),
  ]

  return (
    <EffectShell
      title="Spectral"
      typeLabel={formatDeviceLatency(getSpectralLatencyFrames(props.params.fftSize, props.params.overlap), sampleRate())}
      enabled={props.params.enabled}
      onToggleEnabled={props.onToggleEnabled}
      onReset={props.onReset}
      class="w-[360px] min-w-[360px]"
    >
      <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_4.5rem] gap-3 px-3 py-2">
        <div class="flex min-w-0 flex-col gap-2">
          <div class="grid grid-cols-[minmax(0,1fr)_4rem_3.5rem] gap-1">
            <ChoiceMenu label="Mode" choices={modeChoices} value={props.params.mode} disabled={off()} onSelect={(mode) => props.onChange({ mode })} />
            <ChoiceMenu label="FFT Size" choices={fftChoices} value={props.params.fftSize} disabled={off()} onSelect={(fftSize) => props.onChange({ fftSize })} />
            <ChoiceMenu label="Overlap" choices={overlapChoices} value={props.params.overlap} disabled={off()} onSelect={(overlap) => props.onChange({ overlap })} />
          </div>
          <div class="grid grid-cols-3 content-start justify-items-center gap-y-2">
            <Switch>
              <Match when={props.params.mode === 'freeze'}>
                <DeviceToggleButton class="h-6 w-full self-center" label="Freeze" active={props.params.freeze > 0} disabled={off()} onClick={() => props.onChange({ freeze: props.params.freeze > 0 ? 0 : 1 })} />
              </Match>
              <Match when={props.params.mode === 'gate'}>
                <AutomatedKnob size={KNOB_SIZE} label="Threshold" value={props.params.gateThresholdDb} valueLabel={`${props.params.gateThresholdDb.toFixed(1)} dBFS`} resetValue={defaults.gateThresholdDb} min={-120} max={0} step={0.1} disabled={off()} parameterId="spectral.gateThresholdDb" automation={props} onValueChange={(gateThresholdDb) => props.onChange({ gateThresholdDb })} />
                <AutomatedKnob size={KNOB_SIZE} label="Attack" value={props.params.gateAttackMs} valueLabel={formatDeviceMilliseconds(props.params.gateAttackMs, 1)} resetValue={defaults.gateAttackMs} min={0.1} max={1000} step={0.1} logarithmic disabled={off()} parameterId="spectral.gateAttackMs" automation={props} onValueChange={(gateAttackMs) => props.onChange({ gateAttackMs })} />
                <AutomatedKnob size={KNOB_SIZE} label="Release" value={props.params.gateReleaseMs} valueLabel={formatDeviceMilliseconds(props.params.gateReleaseMs, 0)} resetValue={defaults.gateReleaseMs} min={1} max={5000} step={1} logarithmic disabled={off()} parameterId="spectral.gateReleaseMs" automation={props} onValueChange={(gateReleaseMs) => props.onChange({ gateReleaseMs })} />
              </Match>
              <Match when={props.params.mode === 'morph'}>
                <AutomatedKnob size={KNOB_SIZE} label="Morph" value={props.params.morph} valueLabel={percent(props.params.morph)} resetValue={defaults.morph} min={0} max={1} step={0.01} disabled={off()} parameterId="spectral.morph" automation={props} onValueChange={(morph) => props.onChange({ morph })} />
                <Show when={props.targetId !== 'master'}>
                  <div class="col-span-2 w-full self-center">
                    <ChoiceMenu label="Sidechain Source" choices={sourceChoices()} value={props.sourceTrackId ?? ''} disabled={off()} onSelect={(source) => props.onSourceChange(source || undefined)} />
                  </div>
                </Show>
              </Match>
              <Match when={props.params.mode === 'shift-blur'}>
                <AutomatedKnob size={KNOB_SIZE} label="Shift" value={props.params.binShift} valueLabel={`${Math.round(props.params.binShift)} bins`} resetValue={defaults.binShift} min={-2048} max={2048} step={1} bipolar disabled={off()} parameterId="spectral.binShift" automation={props} onValueChange={(binShift) => props.onChange({ binShift })} />
                <AutomatedKnob size={KNOB_SIZE} label="Blur" value={props.params.blur} valueLabel={percent(props.params.blur)} resetValue={defaults.blur} min={0} max={1} step={0.01} disabled={off()} parameterId="spectral.blur" automation={props} onValueChange={(blur) => props.onChange({ blur })} />
              </Match>
              <Match when={props.params.mode === 'hpss'}>
                <AutomatedKnob size={KNOB_SIZE} label="Balance" value={props.params.harmonicPercussiveBalance} valueLabel={props.params.harmonicPercussiveBalance.toFixed(2)} resetValue={defaults.harmonicPercussiveBalance} min={-1} max={1} step={0.01} bipolar disabled={off()} parameterId="spectral.harmonicPercussiveBalance" automation={props} onValueChange={(harmonicPercussiveBalance) => props.onChange({ harmonicPercussiveBalance })} />
              </Match>
              <Match when={props.params.mode === 'noise-reduce'}>
                <DeviceToggleButton class="h-6 w-full self-center" label="Learn" active={props.params.profileLearn > 0} disabled={off()} onClick={() => props.onChange({ profileLearn: props.params.profileLearn > 0 ? 0 : 1 })} />
                <AutomatedKnob size={KNOB_SIZE} label="Reduction" value={props.params.noiseReduction} valueLabel={percent(props.params.noiseReduction)} resetValue={defaults.noiseReduction} min={0} max={1} step={0.01} disabled={off()} parameterId="spectral.noiseReduction" automation={props} onValueChange={(noiseReduction) => props.onChange({ noiseReduction })} />
                <AutomatedKnob size={KNOB_SIZE} label="Floor" value={props.params.noiseFloorDb} valueLabel={`${props.params.noiseFloorDb.toFixed(1)} dB`} resetValue={defaults.noiseFloorDb} min={-60} max={-6} step={0.1} disabled={off()} parameterId="spectral.noiseFloorDb" automation={props} onValueChange={(noiseFloorDb) => props.onChange({ noiseFloorDb })} />
              </Match>
            </Switch>
          </div>
        </div>
        <div class="flex flex-col items-center justify-center border-l border-border pl-2">
          <AutomatedKnob size={KNOB_SIZE} label="Dry/Wet" value={props.params.mix} valueLabel={percent(props.params.mix)} resetValue={defaults.mix} min={0} max={1} step={0.01} disabled={off()} parameterId="spectral.mix" automation={props} onValueChange={(mix) => props.onChange({ mix })} />
        </div>
      </div>
    </EffectShell>
  )
}
