import {
  GATE_LOOKAHEAD_STEPS_MS,
  GATE_SIDECHAIN_GAIN_DB_MAX,
  GATE_SIDECHAIN_GAIN_DB_MIN,
  createDefaultGateParams,
  type CompressorSidechainFilterType,
  type GateParams,
} from '@daw-browser/shared'
import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import type { Track } from '@daw-browser/timeline-core/types'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { For, createEffect, createSignal } from 'solid-js'
import { cn } from '~/lib/utils'
import { formatDeviceDb, formatDeviceFrequency, formatDeviceMilliseconds, formatDevicePercent } from '~/lib/device-value-format'

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

const SIDECHAIN_FILTER_TYPES: { type: CompressorSidechainFilterType; label: string }[] = [
  { type: 'highpass', label: 'HP' },
  { type: 'lowpass', label: 'LP' },
  { type: 'bandpass', label: 'BP' },
]

const formatDb = (value: number) => formatDeviceDb(value, 1)
const formatMs = (value: number) => formatDeviceMilliseconds(value, value < 10 ? 1 : 0)

export default function Gate(props: GateProps) {
  const externalKey = () => props.sourceTrackId !== undefined
  const [gainReductionDb, setGainReductionDb] = createSignal(0)
  createEffect(
    () => {
      const audioEngine = props.audioEngine

      if (!audioEngine) return undefined

      return { audioEngine, targetId: props.targetId, effectInstanceId: props.effectInstanceId }
    },
    (meter) => {
      setGainReductionDb(0)

      if (!meter) return

      const { audioEngine, targetId, effectInstanceId } = meter

      const unsubscribe = targetId === 'master'
        ? audioEngine.masterFx.subscribeGateMeter(effectInstanceId, (frame) => setGainReductionDb(frame.gainReductionDb))
        : audioEngine.mixer.subscribeTrackGateMeter(targetId, effectInstanceId, (frame) => setGainReductionDb(frame.gainReductionDb))

      return unsubscribe
    },
  )

  return (
    <EffectShell title="Gate" typeLabel="Audio" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-[700px] min-w-[700px]">
      <div class={cn('grid min-h-0 flex-1 grid-cols-[84px_1fr_128px] gap-2 px-3 py-2', !props.params.enabled && 'opacity-70')}>
        <div class="flex min-h-0 flex-col items-stretch gap-2">
          <AutomatedKnob label="Thresh" value={props.params.thresholdDb} valueLabel={formatDb(props.params.thresholdDb)} resetValue={defaults.thresholdDb} min={-80} max={0} step={0.1} disabled={!props.params.enabled} parameterId="gate.thresholdDb" automation={props} onValueChange={(thresholdDb) => props.onChange({ thresholdDb })} />
          <AutomatedKnob label="Return" value={props.params.hysteresisDb} valueLabel={formatDb(props.params.hysteresisDb)} resetValue={defaults.hysteresisDb} min={0} max={24} step={0.1} disabled={!props.params.enabled} parameterId="gate.hysteresisDb" automation={props} onValueChange={(hysteresisDb) => props.onChange({ hysteresisDb })} />
          <DeviceToggleButton class="mt-auto h-6 py-0" label="Flip" active={props.params.flip} disabled={!props.params.enabled} onClick={() => props.onChange({ flip: !props.params.flip })} />
          <div class="grid gap-1">
            <span class="text-center text-2xs uppercase leading-none text-muted-foreground">Look</span>
            <div class="grid grid-cols-3 gap-1">
              <For each={GATE_LOOKAHEAD_STEPS_MS}>{(lookaheadMs) => (
                <DeviceToggleButton class="px-0" label={String(lookaheadMs)} ariaLabel={`Lookahead ${lookaheadMs} ms`} active={props.params.lookaheadMs === lookaheadMs} disabled={!props.params.enabled} onClick={() => props.onChange({ lookaheadMs })} />
              )}</For>
            </div>
          </div>
        </div>
        <div class="flex min-w-0 flex-col gap-2">
          <div class="grid grid-cols-[6rem_1fr] items-start gap-2">
            <div class="border border-border bg-background/80 px-1.5 py-1">
              <div class="text-2xs uppercase leading-none text-muted-foreground">Gain reduction</div>
              <div class="font-mono text-2xs leading-tight text-yellow-700 dark:text-yellow-300">{formatDb(-gainReductionDb())}</div>
            </div>
            <div class="grid grid-cols-4 gap-1">
              <DeviceToggleButton label="Gate" active={props.params.mode === 'gate'} disabled={!props.params.enabled} onClick={() => props.onChange({ mode: 'gate' })} />
              <DeviceToggleButton label="Expand" active={props.params.mode === 'expander'} disabled={!props.params.enabled} onClick={() => props.onChange({ mode: 'expander' })} />
              <DeviceToggleButton label="Peak" active={props.params.detector === 'peak'} disabled={!props.params.enabled} onClick={() => props.onChange({ detector: 'peak' })} />
              <DeviceToggleButton label="RMS" active={props.params.detector === 'rms'} disabled={!props.params.enabled} onClick={() => props.onChange({ detector: 'rms' })} />
            </div>
          </div>
          <div class="grid grid-cols-2 gap-x-4 gap-y-2 px-4">
            <AutomatedKnob label="Ratio" value={props.params.ratio} valueLabel={`${props.params.ratio.toFixed(1)}:1`} resetValue={defaults.ratio} min={1} max={20} step={0.1} disabled={!props.params.enabled} parameterId="gate.ratio" automation={props} onValueChange={(ratio) => props.onChange({ ratio })} />
            <AutomatedKnob label="Link" value={props.params.link} valueLabel={formatDevicePercent(props.params.link)} resetValue={defaults.link} min={0} max={1} step={0.01} disabled={!props.params.enabled} parameterId="gate.link" automation={props} onValueChange={(link) => props.onChange({ link })} />
          </div>
          <div class="mt-auto grid grid-cols-4 gap-2 border-t border-border pt-2">
            <AutomatedKnob label="Attack" value={props.params.attackMs} valueLabel={formatMs(props.params.attackMs)} resetValue={defaults.attackMs} min={0.1} max={100} step={0.1} disabled={!props.params.enabled} parameterId="gate.attackMs" automation={props} onValueChange={(attackMs) => props.onChange({ attackMs })} />
            <AutomatedKnob label="Hold" value={props.params.holdMs} valueLabel={formatMs(props.params.holdMs)} resetValue={defaults.holdMs} min={0} max={500} step={1} disabled={!props.params.enabled} parameterId="gate.holdMs" automation={props} onValueChange={(holdMs) => props.onChange({ holdMs })} />
            <AutomatedKnob label="Release" value={props.params.releaseMs} valueLabel={formatMs(props.params.releaseMs)} resetValue={defaults.releaseMs} min={5} max={2000} step={1} logarithmic disabled={!props.params.enabled} parameterId="gate.releaseMs" automation={props} onValueChange={(releaseMs) => props.onChange({ releaseMs })} />
            <AutomatedKnob label="Floor" value={props.params.rangeDb} valueLabel={formatDb(props.params.rangeDb)} resetValue={defaults.rangeDb} min={-80} max={0} step={0.1} disabled={!props.params.enabled} parameterId="gate.rangeDb" automation={props} onValueChange={(rangeDb) => props.onChange({ rangeDb })} />
          </div>
        </div>
        <div class="flex min-h-0 flex-col gap-1.5 border-l border-border pl-2">
          <span class="text-2xs uppercase leading-none text-muted-foreground">Sidechain</span>
          <select class="h-7 border border-border bg-secondary px-1 text-xs" aria-label="Sidechain source" value={props.sourceTrackId ?? ''} disabled={!props.params.enabled || props.targetId === 'master'} onChange={(event) => props.onSourceChange(event.currentTarget.value || undefined)}>
            <option value="">Internal</option>
            <For each={props.tracks.filter((track) => track.id !== props.targetId)}>{(track) => <option value={track.id}>{track.name}</option>}</For>
          </select>
          <div class="grid grid-cols-2 gap-1">
            <AutomatedKnob size={28} label="Gain" value={props.params.sidechain.gainDb} valueLabel={formatDb(props.params.sidechain.gainDb)} resetValue={defaults.sidechain.gainDb} min={GATE_SIDECHAIN_GAIN_DB_MIN} max={GATE_SIDECHAIN_GAIN_DB_MAX} step={0.1} disabled={!props.params.enabled || !externalKey()} parameterId="gate.sidechain.gainDb" automation={props} onValueChange={(gainDb) => props.onChange({ sidechain: { ...props.params.sidechain, gainDb } })} />
            <AutomatedKnob size={28} label="D/W" value={props.params.sidechain.mix} valueLabel={formatDevicePercent(props.params.sidechain.mix)} resetValue={defaults.sidechain.mix} min={0} max={1} step={0.01} disabled={!props.params.enabled || !externalKey()} parameterId="gate.sidechain.mix" automation={props} onValueChange={(mix) => props.onChange({ sidechain: { ...props.params.sidechain, mix } })} />
          </div>
          <DeviceToggleButton class="h-6 py-0" label="Filter" active={props.params.sidechain.enabled} disabled={!props.params.enabled} onClick={() => props.onChange({ sidechain: { ...props.params.sidechain, enabled: !props.params.sidechain.enabled } })} />
          <div class="grid grid-cols-3 gap-1">
            <For each={SIDECHAIN_FILTER_TYPES}>{(filter) => (
              <DeviceToggleButton class="px-0" label={filter.label} active={props.params.sidechain.filterType === filter.type} disabled={!props.params.enabled || !props.params.sidechain.enabled} onClick={() => props.onChange({ sidechain: { ...props.params.sidechain, filterType: filter.type } })} />
            )}</For>
          </div>
          <div class="grid grid-cols-2 gap-1">
            <AutomatedKnob size={28} label="Freq" value={props.params.sidechain.frequencyHz} valueLabel={formatDeviceFrequency(props.params.sidechain.frequencyHz, 1)} resetValue={defaults.sidechain.frequencyHz} min={20} max={20000} step={1} logarithmic disabled={!props.params.enabled || !props.params.sidechain.enabled} parameterId="gate.sidechain.frequencyHz" automation={props} onValueChange={(frequencyHz) => props.onChange({ sidechain: { ...props.params.sidechain, frequencyHz } })} />
            <AutomatedKnob size={28} label="Q" value={props.params.sidechain.q} resetValue={defaults.sidechain.q} min={0.1} max={18} step={0.01} disabled={!props.params.enabled || !props.params.sidechain.enabled} parameterId="gate.sidechain.q" automation={props} onValueChange={(q) => props.onChange({ sidechain: { ...props.params.sidechain, q } })} />
          </div>
        </div>
      </div>
    </EffectShell>
  )
}
