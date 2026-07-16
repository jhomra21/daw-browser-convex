import type { JSX } from 'solid-js'
import EffectShell from '~/components/effects/EffectShell'
import Knob from '~/components/ui/knob'
import type {
  SynthAutomationParameterId,
  SynthEnvelopeParams,
  SynthFilterMode,
  SynthOscillatorParams,
  SynthParams,
  SynthParamsUpdate,
  SynthWave,
} from '@daw-browser/shared'
import { createDefaultSynthParams } from '@daw-browser/shared'
import { cn } from '~/lib/utils'
import {
  createSynthEnvelopePath,
  createSynthFilterResponsePath,
  createSynthWavePath,
} from '~/components/effects/synth-visualizations'


type SynthProps = {
  params: SynthParams
  onChange: (updates: SynthParamsUpdate) => void
  onReset?: () => void
  onExpand?: () => void
  disabled?: boolean
  variant?: 'compact' | 'expanded'
  class?: string
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: SynthAutomationParameterId) => void
  onManualAutomationOverride?: (parameterId: SynthAutomationParameterId) => void
}

const formatFrequency = (frequencyHz: number) => (
  frequencyHz >= 1000 ? `${(frequencyHz / 1000).toFixed(1)} kHz` : `${Math.round(frequencyHz)} Hz`
)
const formatSeconds = (seconds: number) => (
  seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(2)} s`
)
const formatPercent = (value: number) => `${Math.round(value * 100)}%`
const formatCents = (value: number) => `${value > 0 ? '+' : ''}${Math.round(value)} ct`
const formatOctaves = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} oct`

function SynthSection(props: { title: string; children: JSX.Element }) {
  return (
    <section class="border-b border-border/60 p-3">
      <h3 class="mb-3 text-xs font-semibold text-foreground">{props.title}</h3>
      {props.children}
    </section>
  )
}

function WaveformButtons(props: {
  value: SynthWave
  label: string
  disabled?: boolean
  onChange: (wave: SynthWave) => void
}) {
  const buttonClass = (wave: SynthWave) => cn(
    'min-h-7 border border-border px-2 font-mono text-xs hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50',
    props.value === wave ? 'border-cyan-400/40 bg-cyan-500/20 text-cyan-200' : 'bg-muted text-muted-foreground',
  )
  return (
    <div class="flex flex-wrap gap-1" role="group" aria-label={props.label}>
      <button type="button" class={buttonClass('sine')} disabled={props.disabled} aria-pressed={props.value === 'sine'} aria-label={`${props.label}: sine`} onClick={() => props.onChange('sine')}>~</button>
      <button type="button" class={buttonClass('square')} disabled={props.disabled} aria-pressed={props.value === 'square'} aria-label={`${props.label}: square`} onClick={() => props.onChange('square')}>[]</button>
      <button type="button" class={buttonClass('sawtooth')} disabled={props.disabled} aria-pressed={props.value === 'sawtooth'} aria-label={`${props.label}: sawtooth`} onClick={() => props.onChange('sawtooth')}>/|</button>
      <button type="button" class={buttonClass('triangle')} disabled={props.disabled} aria-pressed={props.value === 'triangle'} aria-label={`${props.label}: triangle`} onClick={() => props.onChange('triangle')}>/\</button>
    </div>
  )
}

function WavePreview(props: { wave: SynthWave; width: number; height: number; color?: string }) {
  return (
    <svg width={props.width} height={props.height} viewBox={`0 0 ${props.width} ${props.height}`} aria-hidden="true">
      <line x1="0" y1={props.height / 2} x2={props.width} y2={props.height / 2} stroke="rgba(255,255,255,0.2)" stroke-width="1" />
      <path d={createSynthWavePath(props.wave, props.width, props.height)} stroke={props.color ?? '#67e8f9'} stroke-width="2" fill="none" />
    </svg>
  )
}

function EnvelopePreview(props: { envelope: SynthEnvelopeParams; width: number; height: number; color?: string }) {
  return (
    <svg width={props.width} height={props.height} viewBox={`0 0 ${props.width} ${props.height}`} aria-hidden="true">
      <path d={createSynthEnvelopePath(props.envelope, props.width, props.height)} stroke={props.color ?? '#a3e635'} stroke-width="2" fill="none" />
    </svg>
  )
}

function FilterPreview(props: { mode: SynthFilterMode; frequencyHz: number; q: number; width: number; height: number }) {
  return (
    <svg width={props.width} height={props.height} viewBox={`0 0 ${props.width} ${props.height}`} aria-hidden="true">
      <line x1="6" y1={props.height / 2} x2={props.width - 6} y2={props.height / 2} stroke="rgba(255,255,255,0.2)" stroke-width="1" />
      <path d={createSynthFilterResponsePath(props.mode, props.frequencyHz, props.q, props.width, props.height)} stroke="#c084fc" stroke-width="2" fill="none" />
    </svg>
  )
}

function SynthKnob(props: {
  label: string
  value: number
  valueLabel: string
  resetValue: number
  min: number
  max: number
  step: number
  parameterId?: SynthAutomationParameterId
  logarithmic?: boolean
  zeroAwareLogarithmic?: boolean
  bipolar?: boolean
  disabled?: boolean
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: SynthAutomationParameterId) => void
  onManualAutomationOverride?: (parameterId: SynthAutomationParameterId) => void
  onValueChange: (value: number) => void
}) {
  const automationRange = () => props.parameterId ? props.automationRangesByParameterId?.get(props.parameterId) : undefined
  return (
    <Knob
      label={props.label}
      value={props.value}
      valueLabel={props.valueLabel}
      resetValue={props.resetValue}
      min={props.min}
      max={props.max}
      step={props.step}
      logarithmic={props.logarithmic}
      zeroAwareLogarithmic={props.zeroAwareLogarithmic}
      bipolar={props.bipolar}
      disabled={props.disabled}
      automationRange={automationRange()}
      automated={Boolean(automationRange())}
      onAutomationSelect={() => {
        if (props.parameterId) props.onAutomationParameterTouch?.(props.parameterId)
      }}
      onValueChange={(value) => {
        if (props.parameterId) props.onManualAutomationOverride?.(props.parameterId)
        props.onValueChange(value)
      }}
    />
  )
}

function OscillatorPanel(props: {
  index: 0 | 1
  params: SynthParams
  onChange: (updates: SynthParamsUpdate) => void
  disabled?: boolean
  compact?: boolean
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: SynthAutomationParameterId) => void
  onManualAutomationOverride?: (parameterId: SynthAutomationParameterId) => void
}) {
  const oscillator = () => props.params.oscillators[props.index]
  const isFirst = () => props.index === 0
  const indexLabel = () => props.index + 1
  const update = (updates: Partial<SynthOscillatorParams>) => (
    props.onChange({ oscillators: isFirst() ? [updates] : [undefined, updates] })
  )
  const defaults = () => isFirst()
    ? { level: 0.7, octave: 0, semitone: 0, detuneCents: -7 }
    : { level: 0.45, octave: 0, semitone: 0, detuneCents: 7 }
  const levelParameterId = (): SynthAutomationParameterId => isFirst() ? 'osc1.level' : 'osc2.level'
  const detuneParameterId = (): SynthAutomationParameterId => isFirst() ? 'osc1.detune' : 'osc2.detune'
  return (
    <div class={cn('min-w-0 border border-border/60 bg-muted/20 p-2', props.compact ? 'flex items-center gap-2' : 'space-y-2')}>
      <div class={cn('flex min-w-0 items-center justify-between gap-2', props.compact && 'flex-col items-start')}>
        <span class="text-2xs font-semibold text-muted-foreground">Osc {indexLabel()}</span>
        <WaveformButtons value={oscillator().wave} label={`Oscillator ${indexLabel()} waveform`} disabled={props.disabled} onChange={(wave) => update({ wave })} />
      </div>
      {!props.compact && (
        <div class="overflow-hidden border border-border/60 bg-background/40">
          <WavePreview wave={oscillator().wave} width={196} height={38} color={isFirst() ? '#67e8f9' : '#86efac'} />
        </div>
      )}
      <div class="flex flex-wrap justify-around gap-2">
        <SynthKnob label="Level" value={oscillator().level} valueLabel={formatPercent(oscillator().level)} resetValue={defaults().level} min={0} max={1} step={0.01} parameterId={levelParameterId()} disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(level) => update({ level })} />
        <SynthKnob label="Octave" value={oscillator().octave} valueLabel={`${oscillator().octave > 0 ? '+' : ''}${oscillator().octave} oct`} resetValue={defaults().octave} min={-3} max={3} step={1} bipolar disabled={props.disabled} onValueChange={(octave) => update({ octave })} />
        {!props.compact && <SynthKnob label="Semi" value={oscillator().semitone} valueLabel={`${oscillator().semitone > 0 ? '+' : ''}${oscillator().semitone} st`} resetValue={defaults().semitone} min={-12} max={12} step={1} bipolar disabled={props.disabled} onValueChange={(semitone) => update({ semitone })} />}
        <SynthKnob label="Detune" value={oscillator().detuneCents} valueLabel={formatCents(oscillator().detuneCents)} resetValue={defaults().detuneCents} min={-100} max={100} step={1} bipolar parameterId={detuneParameterId()} disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(detuneCents) => update({ detuneCents })} />
      </div>
    </div>
  )
}

export default function Synth(props: SynthProps) {
  const compact = () => (props.variant ?? 'compact') === 'compact'
  const defaults = createDefaultSynthParams()

  return (
    <EffectShell
      title="Synth"
      typeLabel="Instrument"
      onReset={props.onReset}
      disabled={props.disabled}
      class={cn(compact() ? 'min-w-[32rem]' : 'min-w-[34rem]', props.class)}
      actionsBeforeReset={
        props.onExpand ? (
          <button
            class="bg-transparent px-2 text-xs text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            disabled={props.disabled}
            onClick={() => props.onExpand?.()}
          >
            Expand
          </button>
        ) : undefined
      }
    >
      {compact() ? (
        <div class="space-y-2 p-2">
          <div class="grid grid-cols-2 gap-2">
            <OscillatorPanel index={0} params={props.params} onChange={props.onChange} disabled={props.disabled} compact automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} />
            <OscillatorPanel index={1} params={props.params} onChange={props.onChange} disabled={props.disabled} compact automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} />
          </div>
          <div class="flex flex-wrap justify-around gap-3 border-y border-border/60 py-2">
            <SynthKnob label="Cutoff" value={props.params.filter.frequencyHz} valueLabel={formatFrequency(props.params.filter.frequencyHz)} resetValue={defaults.filter.frequencyHz} min={20} max={20_000} step={1} logarithmic parameterId="filter.frequency" disabled={props.disabled || !props.params.filter.enabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(frequencyHz) => props.onChange({ filter: { frequencyHz } })} />
            <SynthKnob label="Resonance" value={props.params.filter.q} valueLabel={props.params.filter.q.toFixed(2)} resetValue={defaults.filter.q} min={0.0001} max={30} step={0.01} logarithmic parameterId="filter.q" disabled={props.disabled || !props.params.filter.enabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(q) => props.onChange({ filter: { q } })} />
            <SynthKnob label="Attack" value={props.params.ampEnvelope.attackSec} valueLabel={formatSeconds(props.params.ampEnvelope.attackSec)} resetValue={defaults.ampEnvelope.attackSec} min={0} max={60} step={0.001} logarithmic zeroAwareLogarithmic parameterId="amp.attack" disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(attackSec) => props.onChange({ ampEnvelope: { attackSec } })} />
            <SynthKnob label="Release" value={props.params.ampEnvelope.releaseSec} valueLabel={formatSeconds(props.params.ampEnvelope.releaseSec)} resetValue={defaults.ampEnvelope.releaseSec} min={0} max={60} step={0.001} logarithmic zeroAwareLogarithmic parameterId="amp.release" disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(releaseSec) => props.onChange({ ampEnvelope: { releaseSec } })} />
          </div>
        </div>
      ) : (
        <div>
          <SynthSection title="Oscillators">
            <div class="grid gap-3 lg:grid-cols-2">
              <OscillatorPanel index={0} params={props.params} onChange={props.onChange} disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} />
              <OscillatorPanel index={1} params={props.params} onChange={props.onChange} disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} />
            </div>
          </SynthSection>
          <SynthSection title="Filter">
            <div class="mb-3 flex flex-wrap items-center gap-1" role="group" aria-label="Filter mode">
              <button type="button" class={filterModeClass(props.params.filter.mode, 'lowpass')} disabled={props.disabled} aria-pressed={props.params.filter.mode === 'lowpass'} onClick={() => props.onChange({ filter: { mode: 'lowpass' } })}>Low pass</button>
              <button type="button" class={filterModeClass(props.params.filter.mode, 'highpass')} disabled={props.disabled} aria-pressed={props.params.filter.mode === 'highpass'} onClick={() => props.onChange({ filter: { mode: 'highpass' } })}>High pass</button>
              <button type="button" class={filterModeClass(props.params.filter.mode, 'bandpass')} disabled={props.disabled} aria-pressed={props.params.filter.mode === 'bandpass'} onClick={() => props.onChange({ filter: { mode: 'bandpass' } })}>Band pass</button>
              <button type="button" class={filterModeClass(props.params.filter.mode, 'notch')} disabled={props.disabled} aria-pressed={props.params.filter.mode === 'notch'} onClick={() => props.onChange({ filter: { mode: 'notch' } })}>Notch</button>
              <button type="button" class={cn('ml-auto min-h-7 border border-border px-2 text-xs', props.params.filter.enabled ? 'bg-cyan-500/20 text-cyan-200' : 'bg-muted text-muted-foreground')} disabled={props.disabled} aria-pressed={props.params.filter.enabled} aria-label="Enable filter" onClick={() => props.onChange({ filter: { enabled: !props.params.filter.enabled } })}>{props.params.filter.enabled ? 'On' : 'Off'}</button>
            </div>
            <div class="mb-3 overflow-hidden border border-border/60 bg-background/40"><FilterPreview mode={props.params.filter.mode} frequencyHz={props.params.filter.frequencyHz} q={props.params.filter.q} width={480} height={72} /></div>
            <div class="flex flex-wrap justify-around gap-3">
              <SynthKnob label="Cutoff" value={props.params.filter.frequencyHz} valueLabel={formatFrequency(props.params.filter.frequencyHz)} resetValue={defaults.filter.frequencyHz} min={20} max={20_000} step={1} logarithmic parameterId="filter.frequency" disabled={props.disabled || !props.params.filter.enabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(frequencyHz) => props.onChange({ filter: { frequencyHz } })} />
              <SynthKnob label="Q" value={props.params.filter.q} valueLabel={props.params.filter.q.toFixed(2)} resetValue={defaults.filter.q} min={0.0001} max={30} step={0.01} logarithmic parameterId="filter.q" disabled={props.disabled || !props.params.filter.enabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(q) => props.onChange({ filter: { q } })} />
              <SynthKnob label="Key track" value={props.params.filter.keyTracking} valueLabel={formatPercent(props.params.filter.keyTracking)} resetValue={defaults.filter.keyTracking} min={0} max={1} step={0.01} disabled={props.disabled || !props.params.filter.enabled} onValueChange={(keyTracking) => props.onChange({ filter: { keyTracking } })} />
              <SynthKnob label="Env amount" value={props.params.filter.envelopeAmountOctaves} valueLabel={formatOctaves(props.params.filter.envelopeAmountOctaves)} resetValue={defaults.filter.envelopeAmountOctaves} min={-6} max={6} step={0.01} bipolar parameterId="filter.envAmount" disabled={props.disabled || !props.params.filter.enabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(envelopeAmountOctaves) => props.onChange({ filter: { envelopeAmountOctaves } })} />
            </div>
          </SynthSection>
          <SynthSection title="Envelopes">
            <div class="grid gap-3 lg:grid-cols-2">
              <EnvelopeControls title="Amp envelope" envelope={props.params.ampEnvelope} defaults={defaults.ampEnvelope} disabled={props.disabled} previewColor="#a3e635" parameterPrefix="amp" onChange={(ampEnvelope) => props.onChange({ ampEnvelope })} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} />
              <EnvelopeControls title="Filter envelope" envelope={props.params.filter.envelope} defaults={defaults.filter.envelope} disabled={props.disabled || !props.params.filter.enabled} previewColor="#c084fc" parameterPrefix="filter" onChange={(envelope) => props.onChange({ filter: { envelope } })} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} />
            </div>
          </SynthSection>
          <SynthSection title="LFO">
            <div class="mb-3 flex flex-wrap items-center gap-2">
              <WaveformButtons value={props.params.lfo.wave} label="LFO waveform" disabled={props.disabled || !props.params.lfo.enabled} onChange={(wave) => props.onChange({ lfo: { wave } })} />
              <button type="button" class={cn('min-h-7 border border-border px-2 text-xs', props.params.lfo.enabled ? 'bg-cyan-500/20 text-cyan-200' : 'bg-muted text-muted-foreground')} disabled={props.disabled} aria-pressed={props.params.lfo.enabled} aria-label="Enable LFO" onClick={() => props.onChange({ lfo: { enabled: !props.params.lfo.enabled } })}>{props.params.lfo.enabled ? 'On' : 'Off'}</button>
            </div>
            <div class="flex flex-wrap justify-around gap-3">
              <SynthKnob label="Rate" value={props.params.lfo.frequencyHz} valueLabel={formatFrequency(props.params.lfo.frequencyHz)} resetValue={defaults.lfo.frequencyHz} min={0.01} max={100} step={0.01} logarithmic parameterId="lfo.rate" disabled={props.disabled || !props.params.lfo.enabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(frequencyHz) => props.onChange({ lfo: { frequencyHz } })} />
              <SynthKnob label="Pitch" value={props.params.lfo.pitchCents} valueLabel={formatCents(props.params.lfo.pitchCents)} resetValue={defaults.lfo.pitchCents} min={-1200} max={1200} step={1} bipolar parameterId="lfo.pitchDepth" disabled={props.disabled || !props.params.lfo.enabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(pitchCents) => props.onChange({ lfo: { pitchCents } })} />
              <SynthKnob label="Filter" value={props.params.lfo.filterOctaves} valueLabel={formatOctaves(props.params.lfo.filterOctaves)} resetValue={defaults.lfo.filterOctaves} min={-6} max={6} step={0.01} bipolar parameterId="lfo.filterDepth" disabled={props.disabled || !props.params.lfo.enabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(filterOctaves) => props.onChange({ lfo: { filterOctaves } })} />
              <SynthKnob label="Amp" value={props.params.lfo.amp} valueLabel={formatPercent(props.params.lfo.amp)} resetValue={defaults.lfo.amp} min={0} max={1} step={0.01} parameterId="lfo.ampDepth" disabled={props.disabled || !props.params.lfo.enabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(amp) => props.onChange({ lfo: { amp } })} />
              <SynthKnob label="Pan" value={props.params.lfo.pan} valueLabel={formatPercent(props.params.lfo.pan)} resetValue={defaults.lfo.pan} min={0} max={1} step={0.01} parameterId="lfo.panDepth" disabled={props.disabled || !props.params.lfo.enabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(pan) => props.onChange({ lfo: { pan } })} />
            </div>
          </SynthSection>
          <SynthSection title="Voice / Output">
            <div class="flex flex-wrap items-center justify-around gap-3">
              <SynthKnob label="Polyphony" value={props.params.polyphony} valueLabel={`${props.params.polyphony} voices`} resetValue={defaults.polyphony} min={1} max={128} step={1} disabled={props.disabled} onValueChange={(polyphony) => props.onChange({ polyphony })} />
              <SynthKnob label="Gain" value={props.params.gain} valueLabel={formatPercent(props.params.gain)} resetValue={defaults.gain} min={0} max={1.5} step={0.01} parameterId="output.gain" disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(gain) => props.onChange({ gain })} />
              <SynthKnob label="Pan" value={props.params.pan} valueLabel={formatPercent((props.params.pan + 1) / 2)} resetValue={defaults.pan} min={-1} max={1} step={0.01} bipolar parameterId="output.pan" disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(pan) => props.onChange({ pan })} />
              <button type="button" class={cn('min-h-8 border border-border px-3 text-xs', props.params.retrigger ? 'bg-cyan-500/20 text-cyan-200' : 'bg-muted text-muted-foreground')} disabled={props.disabled} aria-pressed={props.params.retrigger} onClick={() => props.onChange({ retrigger: !props.params.retrigger })}>Retrigger {props.params.retrigger ? 'On' : 'Off'}</button>
            </div>
          </SynthSection>
        </div>
      )}
    </EffectShell>
  )
}

function EnvelopeControls(props: {
  title: string
  envelope: SynthEnvelopeParams
  defaults: SynthEnvelopeParams
  disabled?: boolean
  previewColor: string
  parameterPrefix: 'amp' | 'filter'
  onChange: (updates: Partial<SynthEnvelopeParams>) => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: SynthAutomationParameterId) => void
  onManualAutomationOverride?: (parameterId: SynthAutomationParameterId) => void
}) {
  const isAmp = () => props.parameterPrefix === 'amp'
  const attackId = (): SynthAutomationParameterId => isAmp() ? 'amp.attack' : 'filter.attack'
  const decayId = (): SynthAutomationParameterId => isAmp() ? 'amp.decay' : 'filter.decay'
  const sustainId = (): SynthAutomationParameterId => isAmp() ? 'amp.sustain' : 'filter.sustain'
  const releaseId = (): SynthAutomationParameterId => isAmp() ? 'amp.release' : 'filter.release'
  return (
    <div class="border border-border/60 bg-muted/20 p-2">
      <h4 class="mb-2 text-2xs font-semibold text-muted-foreground">{props.title}</h4>
      <div class="mb-2 overflow-hidden border border-border/60 bg-background/40"><EnvelopePreview envelope={props.envelope} width={220} height={52} color={props.previewColor} /></div>
      <div class="flex flex-wrap justify-around gap-2">
        <SynthKnob label="Attack" value={props.envelope.attackSec} valueLabel={formatSeconds(props.envelope.attackSec)} resetValue={props.defaults.attackSec} min={0} max={60} step={0.001} logarithmic zeroAwareLogarithmic parameterId={attackId()} disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(attackSec) => props.onChange({ attackSec })} />
        <SynthKnob label="Decay" value={props.envelope.decaySec} valueLabel={formatSeconds(props.envelope.decaySec)} resetValue={props.defaults.decaySec} min={0} max={60} step={0.001} logarithmic zeroAwareLogarithmic parameterId={decayId()} disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(decaySec) => props.onChange({ decaySec })} />
        <SynthKnob label="Sustain" value={props.envelope.sustain} valueLabel={formatPercent(props.envelope.sustain)} resetValue={props.defaults.sustain} min={0} max={1} step={0.01} parameterId={sustainId()} disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(sustain) => props.onChange({ sustain })} />
        <SynthKnob label="Release" value={props.envelope.releaseSec} valueLabel={formatSeconds(props.envelope.releaseSec)} resetValue={props.defaults.releaseSec} min={0} max={60} step={0.001} logarithmic zeroAwareLogarithmic parameterId={releaseId()} disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(releaseSec) => props.onChange({ releaseSec })} />
      </div>
    </div>
  )
}

function filterModeClass(current: SynthFilterMode, candidate: SynthFilterMode): string {
  return cn(
    'min-h-7 border border-border px-2 text-xs hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50',
    current === candidate ? 'border-purple-400/40 bg-purple-500/20 text-purple-200' : 'bg-muted text-muted-foreground',
  )
}