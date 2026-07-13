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
  return (
    <EffectShell
      title="Spectral"
      typeLabel={formatLatency(getSpectralLatencyFrames(props.params.fftSize, props.params.overlap))}
      enabled={props.params.enabled}
      onToggleEnabled={props.onToggleEnabled}
      onReset={props.onReset}
      class="device-spectral"
    >
      <div class="device-spectral-grid grid min-h-0 flex-1 gap-2 px-3 py-2">
        <div class="device-spectral-header-grid grid gap-2 border-b border-border pb-2">
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
          <Knob label="Freeze" value={props.params.freeze} valueLabel={percent(props.params.freeze)} resetValue={defaults.freeze} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('spectral.freeze')} automated={props.automationRangesByParameterId?.has('spectral.freeze')} onAutomationSelect={() => props.onAutomationParameterTouch?.('spectral.freeze')} onValueChange={(freeze) => { props.onManualAutomationOverride?.('spectral.freeze'); props.onChange({ freeze }) }} />
          <Knob label="Gate" value={props.params.gateThresholdDb} valueLabel={`${props.params.gateThresholdDb.toFixed(1)} dB`} resetValue={defaults.gateThresholdDb} min={-120} max={0} step={0.1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('spectral.gateThresholdDb')} automated={props.automationRangesByParameterId?.has('spectral.gateThresholdDb')} onAutomationSelect={() => props.onAutomationParameterTouch?.('spectral.gateThresholdDb')} onValueChange={(gateThresholdDb) => { props.onManualAutomationOverride?.('spectral.gateThresholdDb'); props.onChange({ gateThresholdDb }) }} />
          <Knob label="Gate Attack" value={props.params.gateAttackMs} valueLabel={`${props.params.gateAttackMs.toFixed(1)} ms`} resetValue={defaults.gateAttackMs} min={0.1} max={1000} step={0.1} logarithmic disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('spectral.gateAttackMs')} automated={props.automationRangesByParameterId?.has('spectral.gateAttackMs')} onAutomationSelect={() => props.onAutomationParameterTouch?.('spectral.gateAttackMs')} onValueChange={(gateAttackMs) => { props.onManualAutomationOverride?.('spectral.gateAttackMs'); props.onChange({ gateAttackMs }) }} />
          <Knob label="Gate Release" value={props.params.gateReleaseMs} valueLabel={`${Math.round(props.params.gateReleaseMs)} ms`} resetValue={defaults.gateReleaseMs} min={1} max={5000} step={1} logarithmic disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('spectral.gateReleaseMs')} automated={props.automationRangesByParameterId?.has('spectral.gateReleaseMs')} onAutomationSelect={() => props.onAutomationParameterTouch?.('spectral.gateReleaseMs')} onValueChange={(gateReleaseMs) => { props.onManualAutomationOverride?.('spectral.gateReleaseMs'); props.onChange({ gateReleaseMs }) }} />
          <Knob label="Morph" value={props.params.morph} valueLabel={percent(props.params.morph)} resetValue={defaults.morph} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('spectral.morph')} automated={props.automationRangesByParameterId?.has('spectral.morph')} onAutomationSelect={() => props.onAutomationParameterTouch?.('spectral.morph')} onValueChange={(morph) => { props.onManualAutomationOverride?.('spectral.morph'); props.onChange({ morph }) }} />
          <Knob label="Shift" value={props.params.binShift} valueLabel={`${Math.round(props.params.binShift)} bins`} resetValue={defaults.binShift} min={-2048} max={2048} step={1} bipolar disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('spectral.binShift')} automated={props.automationRangesByParameterId?.has('spectral.binShift')} onAutomationSelect={() => props.onAutomationParameterTouch?.('spectral.binShift')} onValueChange={(binShift) => { props.onManualAutomationOverride?.('spectral.binShift'); props.onChange({ binShift }) }} />
          <Knob label="Blur" value={props.params.blur} valueLabel={percent(props.params.blur)} resetValue={defaults.blur} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('spectral.blur')} automated={props.automationRangesByParameterId?.has('spectral.blur')} onAutomationSelect={() => props.onAutomationParameterTouch?.('spectral.blur')} onValueChange={(blur) => { props.onManualAutomationOverride?.('spectral.blur'); props.onChange({ blur }) }} />
          <Knob label="HPSS" value={props.params.harmonicPercussiveBalance} valueLabel={props.params.harmonicPercussiveBalance.toFixed(2)} resetValue={defaults.harmonicPercussiveBalance} min={-1} max={1} step={0.01} bipolar disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('spectral.harmonicPercussiveBalance')} automated={props.automationRangesByParameterId?.has('spectral.harmonicPercussiveBalance')} onAutomationSelect={() => props.onAutomationParameterTouch?.('spectral.harmonicPercussiveBalance')} onValueChange={(harmonicPercussiveBalance) => { props.onManualAutomationOverride?.('spectral.harmonicPercussiveBalance'); props.onChange({ harmonicPercussiveBalance }) }} />
          <Knob label="Noise Reduce" value={props.params.noiseReduction} valueLabel={percent(props.params.noiseReduction)} resetValue={defaults.noiseReduction} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('spectral.noiseReduction')} automated={props.automationRangesByParameterId?.has('spectral.noiseReduction')} onAutomationSelect={() => props.onAutomationParameterTouch?.('spectral.noiseReduction')} onValueChange={(noiseReduction) => { props.onManualAutomationOverride?.('spectral.noiseReduction'); props.onChange({ noiseReduction }) }} />
          <Knob label="Learn" value={props.params.profileLearn} valueLabel={percent(props.params.profileLearn)} resetValue={defaults.profileLearn} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('spectral.profileLearn')} automated={props.automationRangesByParameterId?.has('spectral.profileLearn')} onAutomationSelect={() => props.onAutomationParameterTouch?.('spectral.profileLearn')} onValueChange={(profileLearn) => { props.onManualAutomationOverride?.('spectral.profileLearn'); props.onChange({ profileLearn }) }} />
          <Knob label="Mix" value={props.params.mix} valueLabel={percent(props.params.mix)} resetValue={defaults.mix} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('spectral.mix')} automated={props.automationRangesByParameterId?.has('spectral.mix')} onAutomationSelect={() => props.onAutomationParameterTouch?.('spectral.mix')} onValueChange={(mix) => { props.onManualAutomationOverride?.('spectral.mix'); props.onChange({ mix }) }} />
        </div>
        <div class="flex items-center justify-between border-t border-border pt-2 text-2xs text-muted-foreground">
          <span>HPSS kernel {31} bins, history {31} frames max</span>
          <span>Latency {formatLatency(getSpectralLatencyFrames(props.params.fftSize, props.params.overlap))}</span>
        </div>
      </div>
    </EffectShell>
  )
}
