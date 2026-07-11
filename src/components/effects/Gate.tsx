import { createDefaultGateParams, type GateParams } from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import Knob from '~/components/ui/knob'
import type { Track } from '@daw-browser/timeline-core/types'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { For, createEffect, createSignal, onCleanup } from 'solid-js'

type GateProps = {
  params: GateParams
  tracks: Track[]
  targetId: string
  effectInstanceId: string
  audioEngine?: AudioEngine
  sourceTrackId?: string
  onSourceChange: (sourceTrackId?: string) => void
  onChange: (updates: Partial<GateParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}

const defaults = createDefaultGateParams()
const formatDb = (value: number) => `${value.toFixed(1)} dB`
const formatMs = (value: number) => `${value.toFixed(value < 10 ? 1 : 0)} ms`

export default function Gate(props: GateProps) {
  const [gainReductionDb, setGainReductionDb] = createSignal(0)
  createEffect(() => {
    setGainReductionDb(0)
    if (!props.audioEngine) return
    const unsubscribe = props.targetId === 'master'
      ? props.audioEngine.subscribeMasterGateMeter(props.effectInstanceId, (frame) => setGainReductionDb(frame.gainReductionDb))
      : props.audioEngine.subscribeTrackGateMeter(props.targetId, props.effectInstanceId, (frame) => setGainReductionDb(frame.gainReductionDb))
    onCleanup(unsubscribe)
  })
  const knob = (label: string, id: string, value: number, resetValue: number, min: number, max: number, step: number, valueLabel: string, update: (value: number) => Partial<GateParams>) => (
    <Knob label={label} value={value} valueLabel={valueLabel} resetValue={resetValue} min={min} max={max} step={step} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get(id)} automated={props.automationRangesByParameterId?.has(id)} onAutomationSelect={() => props.onAutomationParameterTouch?.(id)} onValueChange={(next) => { props.onManualAutomationOverride?.(id); props.onChange(update(next)) }} />
  )
  return (
    <EffectShell title="Gate" typeLabel="Audio" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-[620px] min-w-[620px]">
      <div class="flex flex-1 gap-3 px-3 py-2">
        <div class="grid grid-cols-5 gap-2">
          {knob('Thresh', 'gate.thresholdDb', props.params.thresholdDb, defaults.thresholdDb, -80, 0, 0.1, formatDb(props.params.thresholdDb), (thresholdDb) => ({ thresholdDb }))}
          {knob('Ratio', 'gate.ratio', props.params.ratio, defaults.ratio, 1, 20, 0.1, `${props.params.ratio.toFixed(1)}:1`, (ratio) => ({ ratio }))}
          {knob('Attack', 'gate.attackMs', props.params.attackMs, defaults.attackMs, 0.1, 100, 0.1, formatMs(props.params.attackMs), (attackMs) => ({ attackMs }))}
          {knob('Hold', 'gate.holdMs', props.params.holdMs, defaults.holdMs, 0, 500, 1, formatMs(props.params.holdMs), (holdMs) => ({ holdMs }))}
          {knob('Release', 'gate.releaseMs', props.params.releaseMs, defaults.releaseMs, 5, 2000, 1, formatMs(props.params.releaseMs), (releaseMs) => ({ releaseMs }))}
          {knob('Hysteresis', 'gate.hysteresisDb', props.params.hysteresisDb, defaults.hysteresisDb, 0, 24, 0.1, formatDb(props.params.hysteresisDb), (hysteresisDb) => ({ hysteresisDb }))}
          {knob('Range', 'gate.rangeDb', props.params.rangeDb, defaults.rangeDb, -80, 0, 0.1, formatDb(props.params.rangeDb), (rangeDb) => ({ rangeDb }))}
          {knob('Lookahead', 'gate.lookaheadMs', props.params.lookaheadMs, defaults.lookaheadMs, 0, 2, 0.1, formatMs(props.params.lookaheadMs), (lookaheadMs) => ({ lookaheadMs }))}
          {knob('Link', 'gate.link', props.params.link, defaults.link, 0, 1, 0.01, `${Math.round(props.params.link * 100)}%`, (link) => ({ link }))}
        </div>
        <div class="flex w-36 flex-col gap-1">
          <div class="border border-border bg-background/80 px-1.5 py-1">
            <div class="text-3xs uppercase leading-none text-muted-foreground">Gain reduction</div>
            <div class="font-mono text-2xs leading-tight text-yellow-300">{formatDb(-gainReductionDb())}</div>
          </div>
          <div class="grid grid-cols-2 gap-1">
            <DeviceToggleButton label="Gate" active={props.params.mode === 'gate'} onClick={() => props.onChange({ mode: 'gate' })} />
            <DeviceToggleButton label="Expand" active={props.params.mode === 'expander'} onClick={() => props.onChange({ mode: 'expander' })} />
            <DeviceToggleButton label="Peak" active={props.params.detector === 'peak'} onClick={() => props.onChange({ detector: 'peak' })} />
            <DeviceToggleButton label="RMS" active={props.params.detector === 'rms'} onClick={() => props.onChange({ detector: 'rms' })} />
          </div>
          <label class="mt-1 text-2xs text-muted-foreground">Sidechain source</label>
          <select class="h-7 border border-border bg-secondary px-1 text-xs" value={props.sourceTrackId ?? ''} disabled={props.targetId === 'master'} onChange={(event) => props.onSourceChange(event.currentTarget.value || undefined)}>
            <option value="">Internal</option>
            <For each={props.tracks.filter((track) => track.id !== props.targetId)}>{(track) => <option value={track.id}>{track.name}</option>}</For>
          </select>
          <DeviceToggleButton label="Filter" active={props.params.sidechain.enabled} onClick={() => props.onChange({ sidechain: { ...props.params.sidechain, enabled: !props.params.sidechain.enabled } })} />
          <DeviceToggleButton label="Highpass" active onClick={() => props.onChange({ sidechain: { ...props.params.sidechain, filterType: 'highpass' } })} />
          <Knob size={28} label="Freq" value={props.params.sidechain.frequencyHz} valueLabel={`${Math.round(props.params.sidechain.frequencyHz)} Hz`} resetValue={defaults.sidechain.frequencyHz} min={20} max={20000} step={1} logarithmic disabled={!props.params.sidechain.enabled} onValueChange={(frequencyHz) => props.onChange({ sidechain: { ...props.params.sidechain, frequencyHz } })} />
          <Knob size={28} label="Q" value={props.params.sidechain.q} resetValue={defaults.sidechain.q} min={0.1} max={18} step={0.01} disabled={!props.params.sidechain.enabled} onValueChange={(q) => props.onChange({ sidechain: { ...props.params.sidechain, q } })} />
        </div>
      </div>
    </EffectShell>
  )
}
