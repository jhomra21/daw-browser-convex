import { For } from 'solid-js'
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
import { DeviceToggleButton } from '~/components/ui/device-control'
import Knob from '~/components/ui/knob'

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
const modeLabels: Record<SpectralMode, string> = {
  freeze: 'Freeze',
  gate: 'Gate',
  morph: 'Morph',
  'shift-blur': 'Shift/Blur',
  hpss: 'HPSS',
  'noise-reduce': 'Noise Reduce',
}
const percent = (value: number) => `${Math.round(value * 100)}%`
const formatLatency = (frames: number) => `${(frames / 48).toFixed(1)} ms @ 48 kHz`

export default function Spectral(props: SpectralProps) {
  const automationRange = (parameterId: string) => props.automationRangesByParameterId?.get(parameterId)
  const knob = (
    label: string,
    id: string,
    value: number,
    resetValue: number,
    min: number,
    max: number,
    step: number,
    valueLabel: string,
    update: (value: number) => Partial<SpectralParams>,
    logarithmic = false,
    bipolar = false,
  ) => (
    <Knob
      label={label}
      value={value}
      valueLabel={valueLabel}
      resetValue={resetValue}
      min={min}
      max={max}
      step={step}
      logarithmic={logarithmic}
      bipolar={bipolar}
      disabled={!props.params.enabled}
      automationRange={automationRange(id)}
      automated={automationRange(id) !== undefined}
      onAutomationSelect={() => props.onAutomationParameterTouch?.(id)}
      onValueChange={(next) => {
        props.onManualAutomationOverride?.(id)
        props.onChange(update(next))
      }}
    />
  )

  return (
    <EffectShell
      title="Spectral"
      typeLabel={formatLatency(getSpectralLatencyFrames(props.params.fftSize, props.params.overlap))}
      enabled={props.params.enabled}
      onToggleEnabled={props.onToggleEnabled}
      onReset={props.onReset}
      class="w-[620px] min-w-[620px]"
    >
      <div class="grid min-h-0 flex-1 grid-rows-[auto_1fr_auto] gap-2 px-3 py-2">
        <div class="grid grid-cols-[7rem_6rem_minmax(0,1fr)_7rem] gap-2 border-b border-border pb-2">
          <div class="grid grid-cols-2 content-start gap-1">
            <span class="col-span-2 text-2xs text-muted-foreground">FFT size</span>
            <For each={SPECTRAL_FFT_SIZES}>
              {(fftSize) => (
                <DeviceToggleButton
                  label={String(fftSize)}
                  active={props.params.fftSize === fftSize}
                  disabled={!props.params.enabled}
                  onClick={() => props.onChange({ fftSize })}
                />
              )}
            </For>
          </div>
          <div class="grid grid-cols-2 content-start gap-1">
            <span class="col-span-2 text-2xs text-muted-foreground">Overlap</span>
            <For each={SPECTRAL_OVERLAPS}>
              {(overlap) => (
                <DeviceToggleButton
                  label={`${overlap}x`}
                  active={props.params.overlap === overlap}
                  disabled={!props.params.enabled}
                  onClick={() => props.onChange({ overlap })}
                />
              )}
            </For>
          </div>
          <div class="grid grid-cols-3 gap-1">
            <For each={SPECTRAL_MODES}>
              {(mode) => (
                <DeviceToggleButton
                  label={modeLabels[mode]}
                  active={props.params.mode === mode}
                  disabled={!props.params.enabled}
                  onClick={() => props.onChange({ mode })}
                />
              )}
            </For>
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-2xs text-muted-foreground" for="spectral-sidechain-source">Sidechain</label>
            <select
              id="spectral-sidechain-source"
              class="h-7 border border-border bg-secondary px-1 text-xs"
              value={props.sourceTrackId ?? ''}
              disabled={!props.params.enabled || props.targetId === 'master'}
              onChange={(event) => props.onSourceChange(event.currentTarget.value || undefined)}
            >
              <option value="">Internal</option>
              <For each={props.tracks.filter((track) => track.id !== props.targetId)}>
                {(track) => <option value={track.id}>{track.name}</option>}
              </For>
            </select>
          </div>
        </div>

        <div class="grid grid-cols-6 place-content-center gap-x-3 gap-y-2">
          {knob('Freeze', 'spectral.freeze', props.params.freeze, defaults.freeze, 0, 1, 0.01, percent(props.params.freeze), (freeze) => ({ freeze }))}
          {knob('Gate', 'spectral.gateThresholdDb', props.params.gateThresholdDb, defaults.gateThresholdDb, -120, 0, 0.1, `${props.params.gateThresholdDb.toFixed(1)} dB`, (gateThresholdDb) => ({ gateThresholdDb }))}
          {knob('Gate Attack', 'spectral.gateAttackMs', props.params.gateAttackMs, defaults.gateAttackMs, 0.1, 1000, 0.1, `${props.params.gateAttackMs.toFixed(1)} ms`, (gateAttackMs) => ({ gateAttackMs }), true)}
          {knob('Gate Release', 'spectral.gateReleaseMs', props.params.gateReleaseMs, defaults.gateReleaseMs, 1, 5000, 1, `${Math.round(props.params.gateReleaseMs)} ms`, (gateReleaseMs) => ({ gateReleaseMs }), true)}
          {knob('Morph', 'spectral.morph', props.params.morph, defaults.morph, 0, 1, 0.01, percent(props.params.morph), (morph) => ({ morph }))}
          {knob('Shift', 'spectral.binShift', props.params.binShift, defaults.binShift, -2048, 2048, 1, `${Math.round(props.params.binShift)} bins`, (binShift) => ({ binShift }), false, true)}
          {knob('Blur', 'spectral.blur', props.params.blur, defaults.blur, 0, 1, 0.01, percent(props.params.blur), (blur) => ({ blur }))}
          {knob('HPSS', 'spectral.harmonicPercussiveBalance', props.params.harmonicPercussiveBalance, defaults.harmonicPercussiveBalance, -1, 1, 0.01, props.params.harmonicPercussiveBalance.toFixed(2), (harmonicPercussiveBalance) => ({ harmonicPercussiveBalance }), false, true)}
          {knob('Noise Reduce', 'spectral.noiseReduction', props.params.noiseReduction, defaults.noiseReduction, 0, 1, 0.01, percent(props.params.noiseReduction), (noiseReduction) => ({ noiseReduction }))}
          {knob('Learn', 'spectral.profileLearn', props.params.profileLearn, defaults.profileLearn, 0, 1, 0.01, percent(props.params.profileLearn), (profileLearn) => ({ profileLearn }))}
          {knob('Mix', 'spectral.mix', props.params.mix, defaults.mix, 0, 1, 0.01, percent(props.params.mix), (mix) => ({ mix }))}
        </div>
        <div class="flex items-center justify-between border-t border-border pt-2 text-2xs text-muted-foreground">
          <span>HPSS kernel {31} bins, history {31} frames max</span>
          <span>Latency {formatLatency(getSpectralLatencyFrames(props.params.fftSize, props.params.overlap))}</span>
        </div>
      </div>
    </EffectShell>
  )
}
