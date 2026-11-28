import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import AutomatedKnob from '~/components/effects/AutomatedKnob'
import type { Track } from '@daw-browser/timeline-core/types'
import { For, createEffect, createSignal, createUniqueId } from 'solid-js'
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
  COMPRESSOR_LOOKAHEAD_STEPS_MS,
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
  type CompressorSidechainFilterType,
} from '@daw-browser/shared'
import { cn } from '~/lib/utils'
import { formatDeviceDb, formatDeviceFrequency, formatDeviceMilliseconds, formatDevicePercent } from '~/lib/device-value-format'

type CompressorProps = {
  params: CompressorParams
  onChange: (updates: Partial<CompressorParams>) => void
  onToggleEnabled?: (enabled: boolean) => void
  onReset?: () => void
  class?: string
  audioEngine?: AudioEngine
  targetId?: string
  effectInstanceId?: string
  tracks?: Track[]
  sourceTrackId?: string
  onSourceChange?: (sourceTrackId?: string) => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: string) => void
  onManualAutomationOverride?: (parameterId: string) => void
}

type ViewMode = 'transfer' | 'gain-reduction' | 'output'

const DEFAULT_PARAMS = createDefaultCompressorParams()
const DETECTOR_MODES: CompressorDetectorMode[] = ['peak', 'rms']
const DYNAMICS_MODES: CompressorDynamicsMode[] = ['compress', 'expand']
const ENVELOPE_CURVES: CompressorEnvelopeCurve[] = ['log', 'linear']

const SIDECHAIN_FILTER_TYPES: { type: CompressorSidechainFilterType; label: string }[] = [
  { type: 'highpass', label: 'HP' },
  { type: 'lowpass', label: 'LP' },
  { type: 'bandpass', label: 'BP' },
]

const VIEW_MODES: ViewMode[] = ['transfer', 'gain-reduction', 'output']
const HISTORY_SIZE = 96

const formatDb = (value: number) => formatDeviceDb(value, 1, true)
const formatMs = (value: number) => formatDeviceMilliseconds(value, value < 10 ? 1 : 0)
const formatPercent = formatDevicePercent
const formatRatio = (value: number) => value >= 100 ? 'inf:1' : `${value.toFixed(value < 10 ? 1 : 0)}:1`
const label = (value: string) => value[0].toUpperCase() + value.slice(1)

const normalizeDbY = (value: number) => Math.max(0, Math.min(100, 100 - ((value + 60) / 60) * 100))
const normalizeGainReductionY = (value: number) => Math.max(0, Math.min(100, 10 + (Math.abs(value) / 36) * 80))

function MiniStatus(props: { label: string; value: string; tone?: 'cyan' | 'yellow' }) {
  return (
    <div class="min-w-0 border border-border bg-background/80 px-1.5 py-1">
      <div class="text-2xs uppercase leading-none text-muted-foreground">{props.label}</div>
      <div class={cn('truncate font-mono text-2xs leading-tight', props.tone === 'yellow' ? 'text-yellow-700 dark:text-yellow-300' : props.tone === 'cyan' ? 'text-cyan-700 dark:text-cyan-300' : 'text-foreground')}>{props.value}</div>
    </div>
  )
}

function CompressorGraph(props: { params: CompressorParams; makeupDb: number; viewMode: ViewMode; history: CompressorMeterFrame[] }) {
  const patternId = createUniqueId()

  const transferPoints = () => {
    const values: string[] = []

    for (let index = 0; index <= 80; index++) {
      const inputDb = -60 + (index / 80) * 60
      const outputDb = computeCompressorStaticCurveDb(inputDb, props.params) + props.makeupDb
      values.push(`${(index / 80) * 180},${normalizeDbY(outputDb)}`)
    }

    return values.join(' ')
  }

  const historyPoints = (value: (frame: CompressorMeterFrame) => number, yForValue: (value: number) => number) => {
    const denominator = HISTORY_SIZE - 1

    return props.history.map((frame, index) => {
      return `${(index / denominator) * 180},${yForValue(value(frame))}`
    }).join(' ')
  }

  const thresholdY = () => normalizeDbY(props.history.at(-1)?.thresholdDb ?? props.params.thresholdDb)

  return (
    <div class="relative min-h-0 flex-1 overflow-hidden border border-border bg-device-graph-background">
      <svg viewBox="0 0 180 100" class="absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-label="Compressor transfer curve">
        <defs>
          <pattern id={patternId} width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="var(--device-graph-grid)" stroke-width="1" />
          </pattern>
        </defs>
        <rect width="180" height="100" fill={`url(#${patternId})`} />
        <line x1="0" y1="100" x2="180" y2="0" stroke="var(--device-graph-grid)" stroke-width="1" />
        <line x1="0" y1="50" x2="180" y2="50" stroke="var(--device-graph-grid)" stroke-width="1" />
        <line x1="0" y1={thresholdY()} x2="180" y2={thresholdY()} stroke="var(--device-graph-accent)" stroke-width="1" opacity="0.75" vector-effect="non-scaling-stroke" />
        {props.viewMode === 'transfer' ? (
          <polyline points={transferPoints()} fill="none" stroke="var(--device-graph-accent)" stroke-width="2.25" vector-effect="non-scaling-stroke" />
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
  const externalKey = () => props.sourceTrackId !== undefined
  // Auto Makeup gives back what the curve takes at 0 dB in, so the level stays put as Threshold and Ratio move. It is a
  // Compress-mode feature without an external key; in Expand and with a key the Makeup knob applies.
  const autoMakeupActive = () => props.params.autoMakeup && !externalKey() && props.params.dynamicsMode === 'compress'
  const makeupDb = () => autoMakeupActive() ? -computeCompressorStaticCurveDb(0, props.params) : props.params.makeupDb

  const [viewMode, setViewMode] = createSignal<ViewMode>('transfer')
  const [meter, setMeter] = createSignal<CompressorMeterFrame | null>(null)
  const [history, setHistory] = createSignal<CompressorMeterFrame[]>([])

  createEffect(
    () => {
      const audioEngine = props.audioEngine
      const targetId = props.targetId

      return { audioEngine, targetId, effectInstanceId: audioEngine && targetId ? props.effectInstanceId : undefined }
    },
    ({ audioEngine, targetId, effectInstanceId }) => {
      setMeter(null)
      setHistory([])

      if (!audioEngine || !targetId || !effectInstanceId) return

      const unsubscribe = targetId === 'master'
        ? audioEngine.masterFx.subscribeCompressorMeter(effectInstanceId, (frame) => {
          setMeter(frame)
          setHistory((frames) => [...frames.slice(1 - HISTORY_SIZE), frame])
        })
        : audioEngine.mixer.subscribeTrackCompressorMeter(targetId, effectInstanceId, (frame) => {
          setMeter(frame)
          setHistory((frames) => [...frames.slice(1 - HISTORY_SIZE), frame])
        })

      return unsubscribe
    },
  )

  return (
    <EffectShell title="Compressor" typeLabel="Audio" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset}  class={cn('w-[700px] min-w-[700px]', props.class)}>
      <div class={cn('grid min-h-0 flex-1 grid-cols-[84px_1fr_124px_112px] gap-2 px-3 py-2', !props.params.enabled && 'opacity-70')}>
        <div class="flex min-h-0 flex-col items-stretch gap-2">
          <AutomatedKnob label="Ratio" valueLabel={formatRatio(props.params.ratio)} value={props.params.ratio} resetValue={DEFAULT_PARAMS.ratio} min={COMPRESSOR_RATIO_MIN} max={COMPRESSOR_RATIO_MAX} step={0.1} disabled={!props.params.enabled} parameterId="compressor.ratio" automation={props} onValueChange={(ratio) => props.onChange({ ratio })} />
          <AutomatedKnob label="Attack" valueLabel={formatMs(props.params.attackMs)} value={props.params.attackMs} resetValue={DEFAULT_PARAMS.attackMs} min={COMPRESSOR_ATTACK_MS_MIN} max={COMPRESSOR_ATTACK_MS_MAX} step={0.1} disabled={!props.params.enabled} parameterId="compressor.attackMs" automation={props} onValueChange={(attackMs) => props.onChange({ attackMs })} />
          <AutomatedKnob label="Release" valueLabel={formatMs(props.params.releaseMs)} value={props.params.releaseMs} resetValue={DEFAULT_PARAMS.releaseMs} min={COMPRESSOR_RELEASE_MS_MIN} max={COMPRESSOR_RELEASE_MS_MAX} step={1} disabled={!props.params.enabled || props.params.autoRelease} parameterId="compressor.releaseMs" automation={props} onValueChange={(releaseMs) => props.onChange({ releaseMs })} />
          <DeviceToggleButton class="mt-auto h-6 py-0" label="Auto" active={props.params.autoRelease} disabled={!props.params.enabled} onClick={() => props.onChange({ autoRelease: !props.params.autoRelease })} />
        </div>
        <div class="flex min-w-0 flex-col gap-1.5">
          <div class="grid grid-cols-3 gap-1">
            <MiniStatus label="Thresh" value={formatDb(props.params.thresholdDb)} tone="cyan" />
            <MiniStatus label="GR" value={formatDb(meter()?.gainReductionDb ?? 0)} tone="yellow" />
            <MiniStatus label="Output" value={formatDb(meter()?.outputDb ?? -120)} />
          </div>
          <CompressorGraph params={props.params} makeupDb={makeupDb()} viewMode={viewMode()} history={history()} />
          <div class="grid grid-cols-[auto_1fr] items-start gap-2">
            <div class="flex items-start gap-1 pt-2">
              <For each={VIEW_MODES}>
                {(mode) => <DeviceToggleButton class="h-6 min-w-10 px-1.5 py-0" label={mode === 'gain-reduction' ? 'GR' : label(mode)} active={viewMode() === mode} disabled={!props.params.enabled} onClick={() => setViewMode(mode)} />}
              </For>
            </div>
            <div class="grid grid-cols-3 gap-1">
              <AutomatedKnob label="Thresh" valueLabel={formatDb(props.params.thresholdDb)} value={props.params.thresholdDb} resetValue={DEFAULT_PARAMS.thresholdDb} min={COMPRESSOR_THRESHOLD_DB_MIN} max={COMPRESSOR_THRESHOLD_DB_MAX} step={0.1} disabled={!props.params.enabled} parameterId="compressor.thresholdDb" automation={props} onValueChange={(thresholdDb) => props.onChange({ thresholdDb })} />
              <AutomatedKnob label="Knee" valueLabel={formatDb(props.params.kneeDb)} value={props.params.kneeDb} resetValue={DEFAULT_PARAMS.kneeDb} min={COMPRESSOR_KNEE_DB_MIN} max={COMPRESSOR_KNEE_DB_MAX} step={0.1} disabled={!props.params.enabled} parameterId="compressor.kneeDb" automation={props} onValueChange={(kneeDb) => props.onChange({ kneeDb })} />
              <div class="grid gap-1">
                <span class="text-center text-2xs uppercase leading-none text-muted-foreground">Look</span>
                <div class="grid grid-cols-3 gap-1">
                  <For each={COMPRESSOR_LOOKAHEAD_STEPS_MS}>{(lookaheadMs) => (
                    <DeviceToggleButton class="px-0" label={String(lookaheadMs)} ariaLabel={`Lookahead ${lookaheadMs} ms`} active={props.params.lookaheadMs === lookaheadMs} disabled={!props.params.enabled} onClick={() => props.onChange({ lookaheadMs })} />
                  )}</For>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="flex min-h-0 flex-col gap-2">
          <AutomatedKnob label="Makeup" valueLabel={formatDb(makeupDb())} value={props.params.makeupDb} resetValue={DEFAULT_PARAMS.makeupDb} min={COMPRESSOR_GAIN_DB_MIN} max={COMPRESSOR_GAIN_DB_MAX} step={0.1} bipolar disabled={!props.params.enabled || autoMakeupActive()} parameterId="compressor.makeupDb" automation={props} onValueChange={(makeupDb) => props.onChange({ makeupDb })} />
          <DeviceToggleButton class="h-6 py-0" label="Auto Makeup" active={autoMakeupActive()} disabled={!props.params.enabled || externalKey() || props.params.dynamicsMode === 'expand'} onClick={() => props.onChange({ autoMakeup: !props.params.autoMakeup })} />
          <div class="grid grid-cols-2 gap-1">
            <For each={DETECTOR_MODES}>{(mode) => <DeviceToggleButton label={mode.toUpperCase()} active={props.params.detectorMode === mode} disabled={!props.params.enabled} onClick={() => props.onChange({ detectorMode: mode })} />}</For>
            <For each={DYNAMICS_MODES}>{(mode) => <DeviceToggleButton label={label(mode)} active={props.params.dynamicsMode === mode} disabled={!props.params.enabled} onClick={() => props.onChange({ dynamicsMode: mode })} />}</For>
            <For each={ENVELOPE_CURVES}>{(mode) => <DeviceToggleButton label={label(mode)} active={props.params.envelopeCurve === mode} disabled={!props.params.enabled} onClick={() => props.onChange({ envelopeCurve: mode })} />}</For>
          </div>
          <div class="grid grid-cols-2 gap-1">
            <AutomatedKnob size={32} label="Dry/Wet" valueLabel={formatPercent(props.params.dryWet)} value={props.params.dryWet} resetValue={DEFAULT_PARAMS.dryWet} min={COMPRESSOR_DRY_WET_MIN} max={COMPRESSOR_DRY_WET_MAX} step={0.01} disabled={!props.params.enabled} parameterId="compressor.dryWet" automation={props} onValueChange={(dryWet) => props.onChange({ dryWet })} />
            <AutomatedKnob size={32} label="Output" valueLabel={formatDb(props.params.outputDb)} value={props.params.outputDb} resetValue={DEFAULT_PARAMS.outputDb} min={COMPRESSOR_GAIN_DB_MIN} max={COMPRESSOR_GAIN_DB_MAX} step={0.1} bipolar disabled={!props.params.enabled} parameterId="compressor.outputDb" automation={props} onValueChange={(outputDb) => props.onChange({ outputDb })} />
          </div>
        </div>
        <div class="flex min-h-0 flex-col gap-1.5 border-l border-border pl-2">
          <span class="text-2xs uppercase leading-none text-muted-foreground">Sidechain</span>
          <select class="h-7 border border-border bg-secondary px-1 text-xs" aria-label="Sidechain source" value={props.sourceTrackId ?? ''} disabled={!props.params.enabled || props.targetId === 'master' || !props.onSourceChange} onChange={(event) => props.onSourceChange?.(event.currentTarget.value || undefined)}>
            <option value="">Internal</option>
            <For each={(props.tracks ?? []).filter((track) => track.id !== props.targetId)}>{(track) => <option value={track.id}>{track.name}</option>}</For>
          </select>
          <DeviceToggleButton class="h-6 py-0" label="Filter" active={props.params.sidechain.enabled} disabled={!props.params.enabled} onClick={() => props.onChange({ sidechain: { ...props.params.sidechain, enabled: !props.params.sidechain.enabled } })} />
          <div class="grid grid-cols-3 gap-1">
            <For each={SIDECHAIN_FILTER_TYPES}>{(filter) => (
              <DeviceToggleButton class="px-0" label={filter.label} active={props.params.sidechain.filterType === filter.type} disabled={!props.params.enabled || !props.params.sidechain.enabled} onClick={() => props.onChange({ sidechain: { ...props.params.sidechain, filterType: filter.type } })} />
            )}</For>
          </div>
          <div class="grid grid-cols-2 gap-1">
            <AutomatedKnob size={32} label="Freq" value={props.params.sidechain.frequencyHz} valueLabel={formatDeviceFrequency(props.params.sidechain.frequencyHz, 1)} resetValue={DEFAULT_PARAMS.sidechain.frequencyHz} min={20} max={20000} step={1} logarithmic disabled={!props.params.enabled || !props.params.sidechain.enabled} parameterId="compressor.sidechain.frequencyHz" automation={props} onValueChange={(frequencyHz) => props.onChange({ sidechain: { ...props.params.sidechain, frequencyHz } })} />
            <AutomatedKnob size={32} label="Q" value={props.params.sidechain.q} resetValue={DEFAULT_PARAMS.sidechain.q} min={0.1} max={18} step={0.01} disabled={!props.params.enabled || !props.params.sidechain.enabled} parameterId="compressor.sidechain.q" automation={props} onValueChange={(q) => props.onChange({ sidechain: { ...props.params.sidechain, q } })} />
          </div>
        </div>
      </div>
    </EffectShell>
  )
}
