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
  return (
    <EffectShell title="Gate" typeLabel="Audio" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="device-gate">
      <div class="device-gate-grid grid min-h-0 flex-1 gap-3 px-3 py-3">
        <div class="grid grid-cols-3 place-content-center gap-x-4 gap-y-3 border-r border-border pr-3">
          <Knob label="Thresh" value={props.params.thresholdDb} valueLabel={formatDb(props.params.thresholdDb)} resetValue={defaults.thresholdDb} min={-80} max={0} step={0.1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('gate.thresholdDb')} automated={props.automationRangesByParameterId?.has('gate.thresholdDb')} onAutomationSelect={() => props.onAutomationParameterTouch?.('gate.thresholdDb')} onValueChange={(thresholdDb) => { props.onManualAutomationOverride?.('gate.thresholdDb'); props.onChange({ thresholdDb }) }} />
          <Knob label="Ratio" value={props.params.ratio} valueLabel={`${props.params.ratio.toFixed(1)}:1`} resetValue={defaults.ratio} min={1} max={20} step={0.1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('gate.ratio')} automated={props.automationRangesByParameterId?.has('gate.ratio')} onAutomationSelect={() => props.onAutomationParameterTouch?.('gate.ratio')} onValueChange={(ratio) => { props.onManualAutomationOverride?.('gate.ratio'); props.onChange({ ratio }) }} />
          <Knob label="Attack" value={props.params.attackMs} valueLabel={formatMs(props.params.attackMs)} resetValue={defaults.attackMs} min={0.1} max={100} step={0.1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('gate.attackMs')} automated={props.automationRangesByParameterId?.has('gate.attackMs')} onAutomationSelect={() => props.onAutomationParameterTouch?.('gate.attackMs')} onValueChange={(attackMs) => { props.onManualAutomationOverride?.('gate.attackMs'); props.onChange({ attackMs }) }} />
          <Knob label="Hold" value={props.params.holdMs} valueLabel={formatMs(props.params.holdMs)} resetValue={defaults.holdMs} min={0} max={500} step={1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('gate.holdMs')} automated={props.automationRangesByParameterId?.has('gate.holdMs')} onAutomationSelect={() => props.onAutomationParameterTouch?.('gate.holdMs')} onValueChange={(holdMs) => { props.onManualAutomationOverride?.('gate.holdMs'); props.onChange({ holdMs }) }} />
          <Knob label="Release" value={props.params.releaseMs} valueLabel={formatMs(props.params.releaseMs)} resetValue={defaults.releaseMs} min={5} max={2000} step={1} logarithmic disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('gate.releaseMs')} automated={props.automationRangesByParameterId?.has('gate.releaseMs')} onAutomationSelect={() => props.onAutomationParameterTouch?.('gate.releaseMs')} onValueChange={(releaseMs) => { props.onManualAutomationOverride?.('gate.releaseMs'); props.onChange({ releaseMs }) }} />
          <Knob label="Hysteresis" value={props.params.hysteresisDb} valueLabel={formatDb(props.params.hysteresisDb)} resetValue={defaults.hysteresisDb} min={0} max={24} step={0.1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('gate.hysteresisDb')} automated={props.automationRangesByParameterId?.has('gate.hysteresisDb')} onAutomationSelect={() => props.onAutomationParameterTouch?.('gate.hysteresisDb')} onValueChange={(hysteresisDb) => { props.onManualAutomationOverride?.('gate.hysteresisDb'); props.onChange({ hysteresisDb }) }} />
          <Knob label="Range" value={props.params.rangeDb} valueLabel={formatDb(props.params.rangeDb)} resetValue={defaults.rangeDb} min={-80} max={0} step={0.1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('gate.rangeDb')} automated={props.automationRangesByParameterId?.has('gate.rangeDb')} onAutomationSelect={() => props.onAutomationParameterTouch?.('gate.rangeDb')} onValueChange={(rangeDb) => { props.onManualAutomationOverride?.('gate.rangeDb'); props.onChange({ rangeDb }) }} />
          <Knob label="Lookahead" value={props.params.lookaheadMs} valueLabel={formatMs(props.params.lookaheadMs)} resetValue={defaults.lookaheadMs} min={0} max={2} step={0.1} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('gate.lookaheadMs')} automated={props.automationRangesByParameterId?.has('gate.lookaheadMs')} onAutomationSelect={() => props.onAutomationParameterTouch?.('gate.lookaheadMs')} onValueChange={(lookaheadMs) => { props.onManualAutomationOverride?.('gate.lookaheadMs'); props.onChange({ lookaheadMs }) }} />
          <Knob label="Link" value={props.params.link} valueLabel={`${Math.round(props.params.link * 100)}%`} resetValue={defaults.link} min={0} max={1} step={0.01} disabled={!props.params.enabled} automationRange={props.automationRangesByParameterId?.get('gate.link')} automated={props.automationRangesByParameterId?.has('gate.link')} onAutomationSelect={() => props.onAutomationParameterTouch?.('gate.link')} onValueChange={(link) => { props.onManualAutomationOverride?.('gate.link'); props.onChange({ link }) }} />
        </div>
        <div class="grid content-center gap-1">
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
          <div class="grid grid-cols-2 gap-1">
            <DeviceToggleButton label="Filter" active={props.params.sidechain.enabled} onClick={() => props.onChange({ sidechain: { ...props.params.sidechain, enabled: !props.params.sidechain.enabled } })} />
            <DeviceToggleButton label="Highpass" active onClick={() => props.onChange({ sidechain: { ...props.params.sidechain, filterType: 'highpass' } })} />
            <Knob size={28} label="Freq" value={props.params.sidechain.frequencyHz} valueLabel={`${Math.round(props.params.sidechain.frequencyHz)} Hz`} resetValue={defaults.sidechain.frequencyHz} min={20} max={20000} step={1} logarithmic disabled={!props.params.sidechain.enabled} onValueChange={(frequencyHz) => props.onChange({ sidechain: { ...props.params.sidechain, frequencyHz } })} />
            <Knob size={28} label="Q" value={props.params.sidechain.q} resetValue={defaults.sidechain.q} min={0.1} max={18} step={0.01} disabled={!props.params.sidechain.enabled} onValueChange={(q) => props.onChange({ sidechain: { ...props.params.sidechain, q } })} />
          </div>
        </div>
      </div>
    </EffectShell>
  )
}
