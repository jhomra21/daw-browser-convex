import { createSignal, Show, type JSX } from 'solid-js'
import type {
  SynthAutomationParameterId,
  SynthEnvelopeParams,
  SynthFilterMode,
  SynthOscillatorParams,
  SynthParams,
  SynthParamsUpdate,
  SynthWave,
} from '@daw-browser/shared'
import { createDefaultSynthParams, isSynthFilterMode, isSynthWave } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import {
  createSynthEnvelopePath,
  createSynthFilterResponsePath,
  createSynthWavePath,
} from '~/components/effects/synth-visualizations'
import Knob from '~/components/ui/knob'
import { cn } from '~/lib/utils'

type SynthProps = {
  params: SynthParams
  onChange: (updates: SynthParamsUpdate) => void
  onReset?: () => void
  disabled?: boolean
  class?: string
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: SynthAutomationParameterId) => void
  onManualAutomationOverride?: (parameterId: SynthAutomationParameterId) => void
}

type AutomationProps = Pick<SynthProps,
  'automationRangesByParameterId' | 'onAutomationParameterTouch' | 'onManualAutomationOverride'
>
type DrawerSection = 'amp' | 'filter' | 'lfo' | 'voice' | null

const formatFrequency = (frequencyHz: number) => (
  frequencyHz >= 1000 ? `${(frequencyHz / 1000).toFixed(1)} kHz` : `${Math.round(frequencyHz)} Hz`
)
const formatSeconds = (seconds: number) => (
  seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(2)} s`
)
const formatPercent = (value: number) => `${Math.round(value * 100)}%`
const formatCents = (value: number) => `${value > 0 ? '+' : ''}${Math.round(value)} ct`
const formatOctaves = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} oct`

function SynthPanel(props: {
  title: string
  children: JSX.Element
  headerActions?: JSX.Element
  class?: string
}) {
  return (
    <section class={cn('flex min-w-0 flex-col bg-app-surface', props.class)}>
      <header class="flex min-h-7 items-center justify-between gap-1 border-b border-border bg-muted/40 px-2">
        <h3 class="truncate text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{props.title}</h3>
        {props.headerActions}
      </header>
      <div class="min-h-0 flex-1 p-2">{props.children}</div>
    </section>
  )
}

function WaveformIcon(props: { wave: SynthWave }) {
  return (
    <svg class="h-3 w-5" viewBox="0 0 24 12" aria-hidden="true">
      <path d={createSynthWavePath(props.wave, 24, 12)} fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  )
}

function WaveformButtons(props: {
  value: SynthWave
  label: string
  disabled?: boolean
  onChange: (wave: SynthWave) => void
}) {
  const buttonClass = (wave: SynthWave) => cn(
    'flex h-6 w-7 items-center justify-center border-l border-border first:border-l-0 hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50',
    props.value === wave ? 'bg-cyan-500/20 text-cyan-200' : 'bg-muted text-muted-foreground',
  )
  return (
    <div class="flex overflow-hidden border border-border" role="group" aria-label={props.label}>
      <button type="button" class={buttonClass('sine')} disabled={props.disabled} aria-pressed={props.value === 'sine'} aria-label={`${props.label}: sine`} onClick={() => props.onChange('sine')}><WaveformIcon wave="sine" /></button>
      <button type="button" class={buttonClass('square')} disabled={props.disabled} aria-pressed={props.value === 'square'} aria-label={`${props.label}: square`} onClick={() => props.onChange('square')}><WaveformIcon wave="square" /></button>
      <button type="button" class={buttonClass('sawtooth')} disabled={props.disabled} aria-pressed={props.value === 'sawtooth'} aria-label={`${props.label}: sawtooth`} onClick={() => props.onChange('sawtooth')}><WaveformIcon wave="sawtooth" /></button>
      <button type="button" class={buttonClass('triangle')} disabled={props.disabled} aria-pressed={props.value === 'triangle'} aria-label={`${props.label}: triangle`} onClick={() => props.onChange('triangle')}><WaveformIcon wave="triangle" /></button>
    </div>
  )
}

function WavePreview(props: { wave: SynthWave; color: string }) {
  return (
    <svg class="h-9 w-full" viewBox="0 0 220 36" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1="18" x2="220" y2="18" stroke="rgba(255,255,255,0.2)" stroke-width="1" />
      <path d={createSynthWavePath(props.wave, 220, 36)} stroke={props.color} stroke-width="2" fill="none" />
    </svg>
  )
}

function EnvelopePreview(props: { envelope: SynthEnvelopeParams; color: string }) {
  return (
    <svg class="h-full min-h-0 w-full" viewBox="0 0 220 64" preserveAspectRatio="none" aria-hidden="true">
      <path
        d={createSynthEnvelopePath(props.envelope, 220, 64)}
        stroke={props.color}
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
        fill="none"
      />
    </svg>
  )
}

function FilterPreview(props: { mode: SynthFilterMode; frequencyHz: number; q: number }) {
  return (
    <svg class="h-9 w-full" viewBox="0 0 240 36" preserveAspectRatio="none" aria-hidden="true">
      <line x1="6" y1="18" x2="234" y2="18" stroke="rgba(255,255,255,0.2)" stroke-width="1" />
      <path d={createSynthFilterResponsePath(props.mode, props.frequencyHz, props.q, 240, 36)} stroke="#c084fc" stroke-width="2" fill="none" />
    </svg>
  )
}

function SynthKnob(props: {
  label: string
  visibleLabel?: string
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
      visibleLabel={props.visibleLabel}
      ariaLabel={props.label}
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
} & AutomationProps) {
  const oscillator = () => props.params.oscillators[props.index]
  const isFirst = () => props.index === 0
  const update = (updates: Partial<SynthOscillatorParams>) => (
    props.onChange({ oscillators: isFirst() ? [updates] : [undefined, updates] })
  )
  const defaults = () => isFirst()
    ? { level: 0.7, octave: 0, semitone: 0, detuneCents: -7 }
    : { level: 0.45, octave: 0, semitone: 0, detuneCents: 7 }
  const oscillatorLabel = () => `Oscillator ${props.index + 1}`
  const levelParameterId = (): SynthAutomationParameterId => isFirst() ? 'osc1.level' : 'osc2.level'
  const detuneParameterId = (): SynthAutomationParameterId => isFirst() ? 'osc1.detune' : 'osc2.detune'
  let waveformChangedByPointer = false

  return (
    <SynthPanel
      title={`Osc ${props.index + 1}`}
      headerActions={(
        <div class="flex items-center gap-1">
          <select
            class="h-6 max-w-13 border border-border bg-muted px-1 text-2xs text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={`${oscillatorLabel()} waveform`}
            disabled={props.disabled || !oscillator().enabled}
            value={oscillator().wave}
            onPointerDown={() => { waveformChangedByPointer = true }}
            onKeyDown={() => { waveformChangedByPointer = false }}
            onBlur={() => { waveformChangedByPointer = false }}
            onChange={(event) => {
              const { value } = event.currentTarget
              if (isSynthWave(value)) update({ wave: value })
              if (waveformChangedByPointer) event.currentTarget.blur()
              waveformChangedByPointer = false
            }}
          >
            <option value="sine">Sin</option>
            <option value="square">Sq</option>
            <option value="sawtooth">Saw</option>
            <option value="triangle">Tri</option>
          </select>
          <button type="button" class={cn(toggleClass(oscillator().enabled), 'w-9 shrink-0')} disabled={props.disabled} aria-pressed={oscillator().enabled} aria-label={`Enable ${oscillatorLabel()}`} onClick={() => update({ enabled: !oscillator().enabled })}>{oscillator().enabled ? 'On' : 'Off'}</button>
        </div>
      )}
    >
      <div class={cn('flex h-full flex-col gap-1.5', !oscillator().enabled && 'opacity-50')}>
        <div class="border-y border-border/60 bg-background/40"><WavePreview wave={oscillator().wave} color={isFirst() ? '#67e8f9' : '#86efac'} /></div>
        <div class="grid grid-cols-4 gap-1 justify-items-center">
          <SynthKnob label="Level" value={oscillator().level} valueLabel={formatPercent(oscillator().level)} resetValue={defaults().level} min={0} max={1} step={0.01} parameterId={levelParameterId()} disabled={props.disabled || !oscillator().enabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(level) => update({ level })} />
          <SynthKnob label="Octave" visibleLabel="Oct" value={oscillator().octave} valueLabel={`${oscillator().octave > 0 ? '+' : ''}${oscillator().octave} oct`} resetValue={defaults().octave} min={-3} max={3} step={1} bipolar disabled={props.disabled || !oscillator().enabled} onValueChange={(octave) => update({ octave })} />
          <SynthKnob label="Semitone" visibleLabel="Semi" value={oscillator().semitone} valueLabel={`${oscillator().semitone > 0 ? '+' : ''}${oscillator().semitone} st`} resetValue={defaults().semitone} min={-12} max={12} step={1} bipolar disabled={props.disabled || !oscillator().enabled} onValueChange={(semitone) => update({ semitone })} />
          <SynthKnob label="Detune" value={oscillator().detuneCents} valueLabel={formatCents(oscillator().detuneCents)} resetValue={defaults().detuneCents} min={-100} max={100} step={1} bipolar parameterId={detuneParameterId()} disabled={props.disabled || !oscillator().enabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(detuneCents) => update({ detuneCents })} />
        </div>
      </div>
    </SynthPanel>
  )
}

function FilterPanel(props: {
  params: SynthParams
  defaults: SynthParams
  onChange: (updates: SynthParamsUpdate) => void
  disabled?: boolean
} & AutomationProps) {
  const filterDisabled = () => props.disabled || !props.params.filter.enabled
  let modeChangedByPointer = false
  return (
    <SynthPanel
      title="Filter"
      headerActions={(
        <div class="flex items-center gap-1">
          <select
            class="h-6 max-w-15 border border-border bg-muted px-1 text-2xs text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Filter mode"
            disabled={props.disabled}
            value={props.params.filter.mode}
            onPointerDown={() => { modeChangedByPointer = true }}
            onKeyDown={() => { modeChangedByPointer = false }}
            onBlur={() => { modeChangedByPointer = false }}
            onChange={(event) => {
              const { value } = event.currentTarget
              if (isSynthFilterMode(value)) props.onChange({ filter: { mode: value } })
              if (modeChangedByPointer) event.currentTarget.blur()
              modeChangedByPointer = false
            }}
          >
            <option value="lowpass">Low</option>
            <option value="highpass">High</option>
            <option value="bandpass">Band</option>
            <option value="notch">Notch</option>
          </select>
          <button type="button" class={cn(toggleClass(props.params.filter.enabled), 'w-9 shrink-0')} disabled={props.disabled} aria-pressed={props.params.filter.enabled} aria-label="Enable filter" onClick={() => props.onChange({ filter: { enabled: !props.params.filter.enabled } })}>{props.params.filter.enabled ? 'On' : 'Off'}</button>
        </div>
      )}
    >
      <div class="flex h-full flex-col gap-1.5">
        <div class="border-y border-border/60 bg-background/40"><FilterPreview mode={props.params.filter.mode} frequencyHz={props.params.filter.frequencyHz} q={props.params.filter.q} /></div>
        <div class="grid grid-cols-4 gap-1 justify-items-center">
          <SynthKnob label="Cutoff" value={props.params.filter.frequencyHz} valueLabel={formatFrequency(props.params.filter.frequencyHz)} resetValue={props.defaults.filter.frequencyHz} min={20} max={20_000} step={1} logarithmic parameterId="filter.frequency" disabled={filterDisabled()} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(frequencyHz) => props.onChange({ filter: { frequencyHz } })} />
          <SynthKnob label="Resonance" visibleLabel="Q" value={props.params.filter.q} valueLabel={props.params.filter.q.toFixed(2)} resetValue={props.defaults.filter.q} min={0.0001} max={30} step={0.01} logarithmic parameterId="filter.q" disabled={filterDisabled()} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(q) => props.onChange({ filter: { q } })} />
          <SynthKnob label="Key tracking" visibleLabel="Key" value={props.params.filter.keyTracking} valueLabel={formatPercent(props.params.filter.keyTracking)} resetValue={props.defaults.filter.keyTracking} min={0} max={1} step={0.01} disabled={filterDisabled()} onValueChange={(keyTracking) => props.onChange({ filter: { keyTracking } })} />
          <SynthKnob label="Envelope amount" visibleLabel="Env" value={props.params.filter.envelopeAmountOctaves} valueLabel={formatOctaves(props.params.filter.envelopeAmountOctaves)} resetValue={props.defaults.filter.envelopeAmountOctaves} min={-6} max={6} step={0.01} bipolar parameterId="filter.envAmount" disabled={filterDisabled()} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(envelopeAmountOctaves) => props.onChange({ filter: { envelopeAmountOctaves } })} />
        </div>
      </div>
    </SynthPanel>
  )
}

function EnvelopeDrawer(props: {
  envelope: SynthEnvelopeParams
  defaults: SynthEnvelopeParams
  disabled?: boolean
  previewColor: string
  parameterPrefix: 'amp' | 'filter'
  onChange: (updates: Partial<SynthEnvelopeParams>) => void
} & AutomationProps) {
  const parameterId = (field: 'attack' | 'decay' | 'sustain' | 'release'): SynthAutomationParameterId => `${props.parameterPrefix}.${field}`
  return (
    <div class="grid h-28 grid-cols-[minmax(13rem,1fr)_auto] gap-3 px-2 py-1.5">
      <div class="h-full min-h-0 min-w-0 border-y border-border/60 bg-background/40"><EnvelopePreview envelope={props.envelope} color={props.previewColor} /></div>
      <div class="grid grid-cols-4 gap-1 justify-items-center">
        <SynthKnob label="Attack" visibleLabel="A" value={props.envelope.attackSec} valueLabel={formatSeconds(props.envelope.attackSec)} resetValue={props.defaults.attackSec} min={0} max={60} step={0.001} logarithmic zeroAwareLogarithmic parameterId={parameterId('attack')} disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(attackSec) => props.onChange({ attackSec })} />
        <SynthKnob label="Decay" visibleLabel="D" value={props.envelope.decaySec} valueLabel={formatSeconds(props.envelope.decaySec)} resetValue={props.defaults.decaySec} min={0} max={60} step={0.001} logarithmic zeroAwareLogarithmic parameterId={parameterId('decay')} disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(decaySec) => props.onChange({ decaySec })} />
        <SynthKnob label="Sustain" visibleLabel="S" value={props.envelope.sustain} valueLabel={formatPercent(props.envelope.sustain)} resetValue={props.defaults.sustain} min={0} max={1} step={0.01} parameterId={parameterId('sustain')} disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(sustain) => props.onChange({ sustain })} />
        <SynthKnob label="Release" visibleLabel="R" value={props.envelope.releaseSec} valueLabel={formatSeconds(props.envelope.releaseSec)} resetValue={props.defaults.releaseSec} min={0} max={60} step={0.001} logarithmic zeroAwareLogarithmic parameterId={parameterId('release')} disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(releaseSec) => props.onChange({ releaseSec })} />
      </div>
    </div>
  )
}

function LfoDrawer(props: {
  params: SynthParams
  defaults: SynthParams
  onChange: (updates: SynthParamsUpdate) => void
  disabled?: boolean
} & AutomationProps) {
  const lfoDisabled = () => props.disabled || !props.params.lfo.enabled
  return (
    <div class="flex h-28 items-center gap-3 px-2 py-1.5">
      <WaveformButtons value={props.params.lfo.wave} label="LFO waveform" disabled={lfoDisabled()} onChange={(wave) => props.onChange({ lfo: { wave } })} />
      <button type="button" class={toggleClass(props.params.lfo.enabled)} disabled={props.disabled} aria-pressed={props.params.lfo.enabled} aria-label="Enable LFO" onClick={() => props.onChange({ lfo: { enabled: !props.params.lfo.enabled } })}>{props.params.lfo.enabled ? 'On' : 'Off'}</button>
      <div class="grid flex-1 grid-cols-5 gap-1 justify-items-center">
        <SynthKnob label="Rate" value={props.params.lfo.frequencyHz} valueLabel={formatFrequency(props.params.lfo.frequencyHz)} resetValue={props.defaults.lfo.frequencyHz} min={0.01} max={100} step={0.01} logarithmic parameterId="lfo.rate" disabled={lfoDisabled()} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(frequencyHz) => props.onChange({ lfo: { frequencyHz } })} />
        <SynthKnob label="Pitch" value={props.params.lfo.pitchCents} valueLabel={formatCents(props.params.lfo.pitchCents)} resetValue={props.defaults.lfo.pitchCents} min={-1200} max={1200} step={1} bipolar parameterId="lfo.pitchDepth" disabled={lfoDisabled()} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(pitchCents) => props.onChange({ lfo: { pitchCents } })} />
        <SynthKnob label="Filter depth" visibleLabel="Filter" value={props.params.lfo.filterOctaves} valueLabel={formatOctaves(props.params.lfo.filterOctaves)} resetValue={props.defaults.lfo.filterOctaves} min={-6} max={6} step={0.01} bipolar parameterId="lfo.filterDepth" disabled={lfoDisabled()} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(filterOctaves) => props.onChange({ lfo: { filterOctaves } })} />
        <SynthKnob label="Amp depth" visibleLabel="Amp" value={props.params.lfo.amp} valueLabel={formatPercent(props.params.lfo.amp)} resetValue={props.defaults.lfo.amp} min={0} max={1} step={0.01} parameterId="lfo.ampDepth" disabled={lfoDisabled()} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(amp) => props.onChange({ lfo: { amp } })} />
        <SynthKnob label="Pan depth" visibleLabel="Pan" value={props.params.lfo.pan} valueLabel={formatPercent(props.params.lfo.pan)} resetValue={props.defaults.lfo.pan} min={0} max={1} step={0.01} parameterId="lfo.panDepth" disabled={lfoDisabled()} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(pan) => props.onChange({ lfo: { pan } })} />
      </div>
    </div>
  )
}

function VoiceDrawer(props: {
  params: SynthParams
  defaults: SynthParams
  onChange: (updates: SynthParamsUpdate) => void
  disabled?: boolean
} & AutomationProps) {
  return (
    <div class="flex h-28 items-center gap-3 px-2 py-1.5">
      <div class="grid flex-1 grid-cols-3 gap-1 justify-items-center">
        <SynthKnob label="Polyphony" visibleLabel="Voices" value={props.params.polyphony} valueLabel={`${props.params.polyphony} voices`} resetValue={props.defaults.polyphony} min={1} max={128} step={1} disabled={props.disabled} onValueChange={(polyphony) => props.onChange({ polyphony })} />
        <SynthKnob label="Gain" value={props.params.gain} valueLabel={formatPercent(props.params.gain)} resetValue={props.defaults.gain} min={0} max={1.5} step={0.01} parameterId="output.gain" disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(gain) => props.onChange({ gain })} />
        <SynthKnob label="Pan" value={props.params.pan} valueLabel={formatPercent((props.params.pan + 1) / 2)} resetValue={props.defaults.pan} min={-1} max={1} step={0.01} bipolar parameterId="output.pan" disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} onValueChange={(pan) => props.onChange({ pan })} />
      </div>
      <button type="button" class={toggleClass(props.params.retrigger)} disabled={props.disabled} aria-pressed={props.params.retrigger} aria-label="Retrigger voices" onClick={() => props.onChange({ retrigger: !props.params.retrigger })}>Retrig {props.params.retrigger ? 'On' : 'Off'}</button>
    </div>
  )
}

export default function Synth(props: SynthProps) {
  const defaults = createDefaultSynthParams()
  const [openDrawer, setOpenDrawer] = createSignal<DrawerSection>('amp')
  const toggleDrawer = (section: Exclude<DrawerSection, null>) => {
    setOpenDrawer((current) => current === section ? null : section)
  }
  const drawerTabClass = (section: Exclude<DrawerSection, null>) => cn(
    'border-r border-border px-2 py-1 text-2xs font-semibold uppercase tracking-wide hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50',
    openDrawer() === section ? 'bg-cyan-500/15 text-cyan-200' : 'text-muted-foreground',
  )

  return (
    <EffectShell title="Synth" typeLabel="Instrument" onReset={props.onReset} disabled={props.disabled} class={cn('min-w-[53rem] max-w-[56rem]', props.class)}>
      <div class="flex min-h-0 flex-1 flex-col">
        <div class="grid min-h-0 grid-cols-3 divide-x divide-border">
          <OscillatorPanel index={0} params={props.params} onChange={props.onChange} disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} />
          <OscillatorPanel index={1} params={props.params} onChange={props.onChange} disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} />
          <FilterPanel params={props.params} defaults={defaults} onChange={props.onChange} disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} />
        </div>
        <div class="border-t border-border">
          <div class="flex border-b border-border" role="group" aria-label="Synth advanced controls">
            <button id="synth-amp-env-toggle" type="button" class={drawerTabClass('amp')} aria-expanded={openDrawer() === 'amp'} aria-controls="synth-amp-env" onClick={() => toggleDrawer('amp')}>Amp Env</button>
            <button id="synth-filter-env-toggle" type="button" class={drawerTabClass('filter')} aria-expanded={openDrawer() === 'filter'} aria-controls="synth-filter-env" onClick={() => toggleDrawer('filter')}>Filter Env</button>
            <button id="synth-lfo-toggle" type="button" class={drawerTabClass('lfo')} aria-expanded={openDrawer() === 'lfo'} aria-controls="synth-lfo" onClick={() => toggleDrawer('lfo')}>LFO</button>
            <button id="synth-voice-out-toggle" type="button" class={drawerTabClass('voice')} aria-expanded={openDrawer() === 'voice'} aria-controls="synth-voice-out" onClick={() => toggleDrawer('voice')}>Voice / Out</button>
          </div>
          <Show when={openDrawer() === 'amp'}><div id="synth-amp-env" role="region" aria-labelledby="synth-amp-env-toggle"><EnvelopeDrawer envelope={props.params.ampEnvelope} defaults={defaults.ampEnvelope} disabled={props.disabled} previewColor="#a3e635" parameterPrefix="amp" onChange={(ampEnvelope) => props.onChange({ ampEnvelope })} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} /></div></Show>
          <Show when={openDrawer() === 'filter'}><div id="synth-filter-env" role="region" aria-labelledby="synth-filter-env-toggle"><EnvelopeDrawer envelope={props.params.filter.envelope} defaults={defaults.filter.envelope} disabled={props.disabled || !props.params.filter.enabled} previewColor="#c084fc" parameterPrefix="filter" onChange={(envelope) => props.onChange({ filter: { envelope } })} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} /></div></Show>
          <Show when={openDrawer() === 'lfo'}><div id="synth-lfo" role="region" aria-labelledby="synth-lfo-toggle"><LfoDrawer params={props.params} defaults={defaults} onChange={props.onChange} disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} /></div></Show>
          <Show when={openDrawer() === 'voice'}><div id="synth-voice-out" role="region" aria-labelledby="synth-voice-out-toggle"><VoiceDrawer params={props.params} defaults={defaults} onChange={props.onChange} disabled={props.disabled} automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} /></div></Show>
        </div>
      </div>
    </EffectShell>
  )
}

function toggleClass(enabled: boolean): string {
  return cn(
    'min-h-6 border border-border px-1.5 text-2xs disabled:cursor-not-allowed disabled:opacity-50',
    enabled ? 'bg-cyan-500/20 text-cyan-200' : 'bg-muted text-muted-foreground',
  )
}
