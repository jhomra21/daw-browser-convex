import EffectShell from '~/components/effects/EffectShell'
import { DeviceToggleButton } from '~/components/ui/device-control'
import Knob from '~/components/ui/knob'
import { For, createSignal, createUniqueId } from 'solid-js'
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
}

type ViewMode = 'transfer' | 'gain-reduction' | 'output'

const DEFAULT_PARAMS = createDefaultCompressorParams()
const DETECTOR_MODES: CompressorDetectorMode[] = ['peak', 'rms']
const DYNAMICS_MODES: CompressorDynamicsMode[] = ['compress', 'expand']
const ENVELOPE_CURVES: CompressorEnvelopeCurve[] = ['log', 'linear']
const VIEW_MODES: ViewMode[] = ['transfer', 'gain-reduction', 'output']

const formatDb = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`
const formatMs = (value: number) => `${value.toFixed(value < 10 ? 1 : 0)} ms`
const formatPercent = (value: number) => `${Math.round(value * 100)}%`
const formatRatio = (value: number) => value >= 100 ? 'inf:1' : `${value.toFixed(value < 10 ? 1 : 0)}:1`
const label = (value: string) => value[0].toUpperCase() + value.slice(1)

function CompressorGraph(props: { params: CompressorParams; viewMode: ViewMode }) {
  const patternId = createUniqueId()
  const points = () => {
    const values: string[] = []
    for (let index = 0; index <= 80; index++) {
      const inputDb = -60 + (index / 80) * 60
      const outputDb = computeCompressorStaticCurveDb(inputDb, props.params) + props.params.makeupDb
      const value = props.viewMode === 'gain-reduction'
        ? Math.max(-36, Math.min(0, outputDb - inputDb))
        : props.viewMode === 'output'
          ? outputDb
          : outputDb
      const y = props.viewMode === 'gain-reduction'
        ? 10 + (Math.abs(value) / 36) * 80
        : 100 - ((value + 60) / 60) * 100
      values.push(`${(index / 80) * 180},${Math.max(0, Math.min(100, y))}`)
    }
    return values.join(' ')
  }

  return (
    <div class="relative h-[128px] w-[230px] shrink-0 overflow-hidden bg-neutral-950">
      <svg viewBox="0 0 180 100" class="absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-label="Compressor transfer curve">
        <defs>
          <pattern id={patternId} width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#262626" stroke-width="1" />
          </pattern>
        </defs>
        <rect width="180" height="100" fill={`url(#${patternId})`} />
        <line x1="0" y1="100" x2="180" y2="0" stroke="#404040" stroke-width="1" />
        <line x1="0" y1="50" x2="180" y2="50" stroke="#525252" stroke-width="1" />
        <polyline points={points()} fill="none" stroke="#22d3ee" stroke-width="2.25" vector-effect="non-scaling-stroke" />
      </svg>
    </div>
  )
}

export default function Compressor(props: CompressorProps) {
  const [viewMode, setViewMode] = createSignal<ViewMode>('transfer')
  return (
    <EffectShell title="Compressor" typeLabel="Audio" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class={cn('w-[470px] min-w-[470px]', props.class)}>
      <div class={cn('flex min-h-0 flex-1 gap-3 px-3 py-2', !props.params.enabled && 'opacity-70')}>
        <div class="grid w-20 shrink-0 grid-rows-4 gap-2">
          <Knob label="Ratio" valueLabel={formatRatio(props.params.ratio)} value={props.params.ratio} resetValue={DEFAULT_PARAMS.ratio} min={COMPRESSOR_RATIO_MIN} max={COMPRESSOR_RATIO_MAX} step={0.1} disabled={!props.params.enabled} onValueChange={(ratio) => props.onChange({ ratio })} />
          <Knob label="Attack" valueLabel={formatMs(props.params.attackMs)} value={props.params.attackMs} resetValue={DEFAULT_PARAMS.attackMs} min={COMPRESSOR_ATTACK_MS_MIN} max={COMPRESSOR_ATTACK_MS_MAX} step={0.1} disabled={!props.params.enabled} onValueChange={(attackMs) => props.onChange({ attackMs })} />
          <Knob label="Release" valueLabel={formatMs(props.params.releaseMs)} value={props.params.releaseMs} resetValue={DEFAULT_PARAMS.releaseMs} min={COMPRESSOR_RELEASE_MS_MIN} max={COMPRESSOR_RELEASE_MS_MAX} step={1} disabled={!props.params.enabled || props.params.autoRelease} onValueChange={(releaseMs) => props.onChange({ releaseMs })} />
          <DeviceToggleButton label="Auto" active={props.params.autoRelease} disabled={!props.params.enabled} onClick={() => props.onChange({ autoRelease: !props.params.autoRelease })} />
        </div>
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <div class="grid grid-cols-3 gap-1">
            <For each={VIEW_MODES}>
              {(mode) => <DeviceToggleButton label={label(mode.replace('-', ' '))} active={viewMode() === mode} disabled={!props.params.enabled} onClick={() => setViewMode(mode)} />}
            </For>
          </div>
          <CompressorGraph params={props.params} viewMode={viewMode()} />
          <div class="grid grid-cols-3 gap-2">
            <Knob label="Thresh" valueLabel={formatDb(props.params.thresholdDb)} value={props.params.thresholdDb} resetValue={DEFAULT_PARAMS.thresholdDb} min={COMPRESSOR_THRESHOLD_DB_MIN} max={COMPRESSOR_THRESHOLD_DB_MAX} step={0.1} disabled={!props.params.enabled} onValueChange={(thresholdDb) => props.onChange({ thresholdDb })} />
            <Knob label="Knee" valueLabel={formatDb(props.params.kneeDb)} value={props.params.kneeDb} resetValue={DEFAULT_PARAMS.kneeDb} min={COMPRESSOR_KNEE_DB_MIN} max={COMPRESSOR_KNEE_DB_MAX} step={0.1} disabled={!props.params.enabled} onValueChange={(kneeDb) => props.onChange({ kneeDb })} />
            <Knob label="Look" valueLabel={formatMs(props.params.lookaheadMs)} value={props.params.lookaheadMs} resetValue={DEFAULT_PARAMS.lookaheadMs} min={COMPRESSOR_LOOKAHEAD_MS_MIN} max={COMPRESSOR_LOOKAHEAD_MS_MAX} step={0.1} disabled={!props.params.enabled} onValueChange={(lookaheadMs) => props.onChange({ lookaheadMs })} />
          </div>
        </div>
        <div class="flex w-24 shrink-0 flex-col gap-2">
          <Knob label="Makeup" valueLabel={formatDb(props.params.makeupDb)} value={props.params.makeupDb} resetValue={DEFAULT_PARAMS.makeupDb} min={COMPRESSOR_GAIN_DB_MIN} max={COMPRESSOR_GAIN_DB_MAX} step={0.1} bipolar disabled={!props.params.enabled} onValueChange={(makeupDb) => props.onChange({ makeupDb })} />
          <Knob label="Output" valueLabel={formatDb(props.params.outputDb)} value={props.params.outputDb} resetValue={DEFAULT_PARAMS.outputDb} min={COMPRESSOR_GAIN_DB_MIN} max={COMPRESSOR_GAIN_DB_MAX} step={0.1} bipolar disabled={!props.params.enabled} onValueChange={(outputDb) => props.onChange({ outputDb })} />
          <Knob label="Dry/Wet" valueLabel={formatPercent(props.params.dryWet)} value={props.params.dryWet} resetValue={DEFAULT_PARAMS.dryWet} min={COMPRESSOR_DRY_WET_MIN} max={COMPRESSOR_DRY_WET_MAX} step={0.01} disabled={!props.params.enabled} onValueChange={(dryWet) => props.onChange({ dryWet })} />
          <div class="grid grid-cols-2 gap-1">
            <For each={DETECTOR_MODES}>{(mode) => <DeviceToggleButton label={mode.toUpperCase()} active={props.params.detectorMode === mode} disabled={!props.params.enabled} onClick={() => props.onChange({ detectorMode: mode })} />}</For>
            <For each={DYNAMICS_MODES}>{(mode) => <DeviceToggleButton label={label(mode)} active={props.params.dynamicsMode === mode} disabled={!props.params.enabled} onClick={() => props.onChange({ dynamicsMode: mode })} />}</For>
            <For each={ENVELOPE_CURVES}>{(mode) => <DeviceToggleButton label={label(mode)} active={props.params.envelopeCurve === mode} disabled={!props.params.enabled} onClick={() => props.onChange({ envelopeCurve: mode })} />}</For>
          </div>
        </div>
      </div>
    </EffectShell>
  )
}
