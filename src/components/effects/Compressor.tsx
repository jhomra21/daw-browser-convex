import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import Knob from '~/components/ui/knob'
import { For, createEffect, createSignal, createUniqueId, onCleanup } from 'solid-js'
import type { AudioEngine, CompressorMeterFrame } from '@daw-browser/audio-engine/audio-engine'
import {
  COMPRESSOR_ATTACK_MS_MAX,
  COMPRESSOR_ATTACK_MS_MIN,
  COMPRESSOR_DRY_WET_MAX,
  COMPRESSOR_DRY_WET_MIN,
  COMPRESSOR_GAIN_DB_MAX,
  COMPRESSOR_GAIN_DB_MIN,
  COMPRESSOR_KNEE_DB_MAX,
  COMPRESSOR_KNEE_DB_MIN,
  COMPRESSOR_LOOKAHEAD_MS_MAX,
  COMPRESSOR_LOOKAHEAD_MS_MIN,
  COMPRESSOR_RATIO_MAX,
  COMPRESSOR_RATIO_MIN,
  COMPRESSOR_RELEASE_MS_MAX,
  COMPRESSOR_RELEASE_MS_MIN,
  COMPRESSOR_THRESHOLD_DB_MAX,
  COMPRESSOR_THRESHOLD_DB_MIN,
  computeCompressorStaticCurveDb,
  createDefaultCompressorParams,
  type CompressorDetectorMode,
  type CompressorDynamicsMode,
  type CompressorEnvelopeCurve,
  type CompressorParams,
} from '@daw-browser/shared'
import { cn } from '~/lib/utils'

type CompressorProps = {
  params: CompressorParams
  onChange: (updates: Partial<CompressorParams>) => void
  onToggleEnabled?: (enabled: boolean) => void
  onReset?: () => void
  class?: string
  audioEngine?: AudioEngine
  targetId?: string
}

type ViewMode = 'transfer' | 'gain-reduction' | 'output'

const DEFAULT_PARAMS = createDefaultCompressorParams()
const DETECTOR_MODES: CompressorDetectorMode[] = ['peak', 'rms']
const DYNAMICS_MODES: CompressorDynamicsMode[] = ['compress', 'expand']
const ENVELOPE_CURVES: CompressorEnvelopeCurve[] = ['log', 'linear']
const VIEW_MODES: ViewMode[] = ['transfer', 'gain-reduction', 'output']
const HISTORY_SIZE = 96

const formatDb = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`
const formatMs = (value: number) => `${value.toFixed(value < 10 ? 1 : 0)} ms`
const formatPercent = (value: number) => `${Math.round(value * 100)}%`
const formatRatio = (value: number) => value >= 100 ? 'inf:1' : `${value.toFixed(value < 10 ? 1 : 0)}:1`
const label = (value: string) => value[0].toUpperCase() + value.slice(1)

const normalizeDbY = (value: number) => Math.max(0, Math.min(100, 100 - ((value + 60) / 60) * 100))
const normalizeGainReductionY = (value: number) => Math.max(0, Math.min(100, 10 + (Math.abs(value) / 36) * 80))

function MiniStatus(props: { label: string; value: string; tone?: 'cyan' | 'yellow' }) {
  return (
    <div class="min-w-0 border border-neutral-800 bg-neutral-950/80 px-1.5 py-1">
      <div class="text-[9px] uppercase leading-none text-neutral-500">{props.label}</div>
      <div class={cn('truncate font-mono text-[10px] leading-tight', props.tone === 'yellow' ? 'text-yellow-300' : props.tone === 'cyan' ? 'text-cyan-300' : 'text-neutral-200')}>{props.value}</div>
    </div>
  )
}

function CompressorGraph(props: { params: CompressorParams; viewMode: ViewMode; history: CompressorMeterFrame[] }) {
  const patternId = createUniqueId()
  const transferPoints = () => {
    const values: string[] = []
    for (let index = 0; index <= 80; index++) {
      const inputDb = -60 + (index / 80) * 60
      const outputDb = computeCompressorStaticCurveDb(inputDb, props.params) + props.params.makeupDb
      values.push(`${(index / 80) * 180},${normalizeDbY(outputDb)}`)
    }
    return values.join(' ')
  }
  const historyPoints = (value: (frame: CompressorMeterFrame) => number, yForValue: (value: number) => number) => {
    const frames = props.history
    if (frames.length === 0) return ''
    return frames.map((frame, index) => {
      const denominator = Math.max(1, HISTORY_SIZE - 1)
      return `${(index / denominator) * 180},${yForValue(value(frame))}`
    }).join(' ')
  }
  const thresholdY = () => normalizeDbY(props.history.at(-1)?.thresholdDb ?? props.params.thresholdDb)

  return (
    <div class="relative min-h-0 flex-1 overflow-hidden border border-neutral-800 bg-neutral-950">
      <svg viewBox="0 0 180 100" class="absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-label="Compressor transfer curve">
        <defs>
          <pattern id={patternId} width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#262626" stroke-width="1" />
          </pattern>
        </defs>
        <rect width="180" height="100" fill={`url(#${patternId})`} />
        <line x1="0" y1="100" x2="180" y2="0" stroke="#404040" stroke-width="1" />
        <line x1="0" y1="50" x2="180" y2="50" stroke="#525252" stroke-width="1" />
        <line x1="0" y1={thresholdY()} x2="180" y2={thresholdY()} stroke="#22d3ee" stroke-width="1" opacity="0.75" vector-effect="non-scaling-stroke" />
        {props.viewMode === 'transfer' ? (
          <polyline points={transferPoints()} fill="none" stroke="#22d3ee" stroke-width="2.25" vector-effect="non-scaling-stroke" />
        ) : (
          <>
            <polyline points={historyPoints((frame) => props.viewMode === 'output' ? frame.outputDb : frame.inputDb, normalizeDbY)} fill="none" stroke="#a3a3a3" stroke-width="1.5" opacity="0.75" vector-effect="non-scaling-stroke" />
            <polyline points={historyPoints((frame) => frame.gainReductionDb, normalizeGainReductionY)} fill="none" stroke="#facc15" stroke-width="1.8" vector-effect="non-scaling-stroke" />
          </>
        )}
      </svg>
    </div>
  )
}

export default function Compressor(props: CompressorProps) {
  const [viewMode, setViewMode] = createSignal<ViewMode>('transfer')
  const [meter, setMeter] = createSignal<CompressorMeterFrame | null>(null)
  const [history, setHistory] = createSignal<CompressorMeterFrame[]>([])

  createEffect(() => {
    const audioEngine = props.audioEngine
    const targetId = props.targetId
    if (!audioEngine || !targetId) return
    const unsubscribe = targetId === 'master'
      ? audioEngine.subscribeMasterCompressorMeter((frame) => {
        setMeter(frame)
        setHistory((frames) => [...frames.slice(Math.max(0, frames.length - HISTORY_SIZE + 1)), frame])
      })
      : audioEngine.subscribeTrackCompressorMeter(targetId, (frame) => {
        setMeter(frame)
        setHistory((frames) => [...frames.slice(Math.max(0, frames.length - HISTORY_SIZE + 1)), frame])
      })
    onCleanup(unsubscribe)
  })

  return (
    <EffectShell title="Compressor" typeLabel="Audio" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class={cn('w-[560px] min-w-[560px]', props.class)}>
      <div class={cn('grid min-h-0 flex-1 grid-cols-[84px_1fr_96px] gap-2 px-3 py-2', !props.params.enabled && 'opacity-70')}>
        <div class="grid min-h-0 grid-rows-4 gap-2">
          <Knob label="Ratio" valueLabel={formatRatio(props.params.ratio)} value={props.params.ratio} resetValue={DEFAULT_PARAMS.ratio} min={COMPRESSOR_RATIO_MIN} max={COMPRESSOR_RATIO_MAX} step={0.1} disabled={!props.params.enabled} onValueChange={(ratio) => props.onChange({ ratio })} />
          <Knob label="Attack" valueLabel={formatMs(props.params.attackMs)} value={props.params.attackMs} resetValue={DEFAULT_PARAMS.attackMs} min={COMPRESSOR_ATTACK_MS_MIN} max={COMPRESSOR_ATTACK_MS_MAX} step={0.1} disabled={!props.params.enabled} onValueChange={(attackMs) => props.onChange({ attackMs })} />
          <Knob label="Release" valueLabel={formatMs(props.params.releaseMs)} value={props.params.releaseMs} resetValue={DEFAULT_PARAMS.releaseMs} min={COMPRESSOR_RELEASE_MS_MIN} max={COMPRESSOR_RELEASE_MS_MAX} step={1} disabled={!props.params.enabled || props.params.autoRelease} onValueChange={(releaseMs) => props.onChange({ releaseMs })} />
          <DeviceToggleButton class="h-7 self-center" label="Auto" active={props.params.autoRelease} disabled={!props.params.enabled} onClick={() => props.onChange({ autoRelease: !props.params.autoRelease })} />
        </div>
        <div class="flex min-w-0 flex-col gap-1.5">
          <div class="grid grid-cols-4 gap-1">
            <MiniStatus label="Thresh" value={formatDb(props.params.thresholdDb)} tone="cyan" />
            <MiniStatus label="GR" value={formatDb(meter()?.gainReductionDb ?? 0)} tone="yellow" />
            <MiniStatus label="Output" value={formatDb(meter()?.outputDb ?? -120)} />
            <MiniStatus label="Out" value={formatDb(props.params.outputDb)} />
          </div>
          <CompressorGraph params={props.params} viewMode={viewMode()} history={history()} />
          <div class="grid grid-cols-[auto_1fr] items-start gap-2">
            <div class="flex gap-1 pt-1">
              <For each={VIEW_MODES}>
                {(mode) => <DeviceToggleButton class="h-7 min-w-12 px-2" label={mode === 'gain-reduction' ? 'GR' : label(mode)} active={viewMode() === mode} disabled={!props.params.enabled} onClick={() => setViewMode(mode)} />}
              </For>
            </div>
            <div class="grid grid-cols-3 gap-1">
              <Knob label="Thresh" valueLabel={formatDb(props.params.thresholdDb)} value={props.params.thresholdDb} resetValue={DEFAULT_PARAMS.thresholdDb} min={COMPRESSOR_THRESHOLD_DB_MIN} max={COMPRESSOR_THRESHOLD_DB_MAX} step={0.1} disabled={!props.params.enabled} onValueChange={(thresholdDb) => props.onChange({ thresholdDb })} />
              <Knob label="Knee" valueLabel={formatDb(props.params.kneeDb)} value={props.params.kneeDb} resetValue={DEFAULT_PARAMS.kneeDb} min={COMPRESSOR_KNEE_DB_MIN} max={COMPRESSOR_KNEE_DB_MAX} step={0.1} disabled={!props.params.enabled} onValueChange={(kneeDb) => props.onChange({ kneeDb })} />
              <Knob label="Look" valueLabel={formatMs(props.params.lookaheadMs)} value={props.params.lookaheadMs} resetValue={DEFAULT_PARAMS.lookaheadMs} min={COMPRESSOR_LOOKAHEAD_MS_MIN} max={COMPRESSOR_LOOKAHEAD_MS_MAX} step={0.1} disabled={!props.params.enabled} onValueChange={(lookaheadMs) => props.onChange({ lookaheadMs })} />
            </div>
          </div>
        </div>
        <div class="flex min-h-0 flex-col gap-2">
          <Knob label="Makeup" valueLabel={formatDb(props.params.makeupDb)} value={props.params.makeupDb} resetValue={DEFAULT_PARAMS.makeupDb} min={COMPRESSOR_GAIN_DB_MIN} max={COMPRESSOR_GAIN_DB_MAX} step={0.1} bipolar disabled={!props.params.enabled} onValueChange={(makeupDb) => props.onChange({ makeupDb })} />
          <div class="grid grid-cols-2 gap-1">
            <For each={DETECTOR_MODES}>{(mode) => <DeviceToggleButton label={mode.toUpperCase()} active={props.params.detectorMode === mode} disabled={!props.params.enabled} onClick={() => props.onChange({ detectorMode: mode })} />}</For>
            <For each={DYNAMICS_MODES}>{(mode) => <DeviceToggleButton label={label(mode)} active={props.params.dynamicsMode === mode} disabled={!props.params.enabled} onClick={() => props.onChange({ dynamicsMode: mode })} />}</For>
            <For each={ENVELOPE_CURVES}>{(mode) => <DeviceToggleButton label={label(mode)} active={props.params.envelopeCurve === mode} disabled={!props.params.enabled} onClick={() => props.onChange({ envelopeCurve: mode })} />}</For>
          </div>
          <Knob label="Dry/Wet" valueLabel={formatPercent(props.params.dryWet)} value={props.params.dryWet} resetValue={DEFAULT_PARAMS.dryWet} min={COMPRESSOR_DRY_WET_MIN} max={COMPRESSOR_DRY_WET_MAX} step={0.01} disabled={!props.params.enabled} onValueChange={(dryWet) => props.onChange({ dryWet })} />
        </div>
      </div>
    </EffectShell>
  )
}
