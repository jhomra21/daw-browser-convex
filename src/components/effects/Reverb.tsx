import { createEffect, Show, type JSX } from 'solid-js'
import Knob from '~/components/ui/knob'
import {
  normalizeReverbParams,
  REVERB_DECAY_SEC_MAX,
  REVERB_DECAY_SEC_MIN,
  REVERB_HIGH_CUT_HZ_MAX,
  REVERB_HIGH_CUT_HZ_MIN,
  REVERB_LOW_CUT_HZ_MAX,
  REVERB_LOW_CUT_HZ_MIN,
  REVERB_PRE_DELAY_MS_MAX,
  REVERB_PRE_DELAY_MS_MIN,
  type ReverbParams,
  REVERB_STEREO_WIDTH_MAX,
  REVERB_STEREO_WIDTH_MIN,
  REVERB_UNIT_PARAM_MAX,
  REVERB_UNIT_PARAM_MIN,
  REVERB_WET_MAX,
  REVERB_WET_MIN,
} from '@daw-browser/shared'
import { cn } from '~/lib/utils'


type ReverbProps = {
  params: ReverbParams
  onChange: (updates: Partial<ReverbParams>) => void
  onToggleEnabled?: (enabled: boolean) => void
  onReset?: () => void
  class?: string
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const normalizeWet = (value: number) => Math.round(clamp(value, REVERB_WET_MIN, REVERB_WET_MAX) * 100) / 100
const normalizeDecay = (value: number) => Math.round(clamp(value, REVERB_DECAY_SEC_MIN, REVERB_DECAY_SEC_MAX) * 10) / 10
const normalizePreDelay = (value: number) => Math.round(clamp(value, REVERB_PRE_DELAY_MS_MIN, REVERB_PRE_DELAY_MS_MAX))
const normalizeUnitParam = (value: number) => Math.round(clamp(value, REVERB_UNIT_PARAM_MIN, REVERB_UNIT_PARAM_MAX) * 100) / 100
const normalizeLowCut = (value: number) => Math.round(clamp(value, REVERB_LOW_CUT_HZ_MIN, REVERB_LOW_CUT_HZ_MAX))
const normalizeHighCut = (value: number) => Math.round(clamp(value, REVERB_HIGH_CUT_HZ_MIN, REVERB_HIGH_CUT_HZ_MAX) / 100) * 100
const normalizeStereoWidth = (value: number) => Math.round(clamp(value, REVERB_STEREO_WIDTH_MIN, REVERB_STEREO_WIDTH_MAX) * 100) / 100

const formatPercent = (value: number) => `${Math.round(normalizeWet(value) * 100)}%`
const formatUnitPercent = (value: number) => `${Math.round(normalizeUnitParam(value) * 100)}%`
const formatSeconds = (value: number) => `${normalizeDecay(value).toFixed(1)}s`
const formatMilliseconds = (value: number) => `${normalizePreDelay(value)}ms`
const formatFrequency = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${Math.round(value)}`
const formatStereoWidth = (value: number) => `${normalizeStereoWidth(value).toFixed(2)}x`

function ReverbSection(props: {
  title: string
  class?: string
  children: JSX.Element
}) {
  return (
    <div class={cn('flex min-w-0 flex-col border-r border-neutral-800 bg-neutral-950/30 last:border-r-0', props.class)}>
      <div class="border-b border-neutral-800 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
        {props.title}
      </div>
      <div class="flex min-h-0 flex-1 items-center justify-center p-2">
        {props.children}
      </div>
    </div>
  )
}

function ReverbKnobControl(props: {
  label: string
  valueLabel: string
  children: JSX.Element
}) {
  return (
    <div class="flex flex-col items-center gap-1">
      <div class="text-[10px] leading-none text-neutral-400">{props.label}</div>
      {props.children}
      <div class="font-mono text-[10px] leading-none text-cyan-300">{props.valueLabel}</div>
    </div>
  )
}

function ReverbParamControl(props: {
  title: string
  label: string
  valueLabel: string
  value: number
  min: number
  max: number
  step: number
  disabled: boolean
  unit?: string
  onValueChange: (value: number) => void
}) {
  return (
    <ReverbSection title={props.title}>
      <ReverbKnobControl label={props.label} valueLabel={props.valueLabel}>
        <Knob
          value={props.value}
          min={props.min}
          max={props.max}
          step={props.step}
          size={28}
          label=""
          unit={props.unit}
          disabled={props.disabled}
          showValue={false}
          onValueChange={props.onValueChange}
        />
      </ReverbKnobControl>
    </ReverbSection>
  )
}

function ReverbDecayDisplay(props: { params: ReverbParams }) {
  let canvasRef: HTMLCanvasElement | undefined

  createEffect(() => {
    const canvas = canvasRef
    if (!canvas) return

    const width = 150
    const height = 74
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.fillStyle = '#111111'
    ctx.fillRect(0, 0, width, height)

    ctx.strokeStyle = '#2a2a2a'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = 0; x <= width; x += 25) {
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
    }
    for (let y = 0; y <= height; y += 18) {
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
    }
    ctx.stroke()

    const size = normalizeUnitParam(props.params.size)
    const diffusion = normalizeUnitParam(props.params.diffusion)
    const density = normalizeUnitParam(props.params.density)
    const widthAmount = normalizeStereoWidth(props.params.stereoWidth) / 2
    const normalizedDecay = clamp(props.params.decaySec / REVERB_DECAY_SEC_MAX, 0.05, 1)
    const preDelayX = clamp(props.params.preDelayMs / REVERB_PRE_DELAY_MS_MAX, 0, 1) * width * 0.25
    const highCut = 1 - clamp((props.params.highCutHz - REVERB_HIGH_CUT_HZ_MIN) / (REVERB_HIGH_CUT_HZ_MAX - REVERB_HIGH_CUT_HZ_MIN), 0, 1)
    const lowCut = clamp((props.params.lowCutHz - REVERB_LOW_CUT_HZ_MIN) / (REVERB_LOW_CUT_HZ_MAX - REVERB_LOW_CUT_HZ_MIN), 0, 1)

    ctx.fillStyle = props.params.enabled ? 'rgba(103,232,249,0.08)' : 'rgba(115,115,115,0.08)'
    ctx.beginPath()
    ctx.moveTo(preDelayX, height / 2)
    const tailWidth = width - preDelayX - 8
    for (let x = 0; x <= tailWidth; x++) {
      const t = x / Math.max(1, tailWidth)
      const envelope = Math.exp(-t / normalizedDecay)
      const spread = (8 + size * 22 + density * 10) * envelope
      const modulation = Math.sin(t * Math.PI * (3 + diffusion * 7)) * 3 * diffusion * envelope
      ctx.lineTo(preDelayX + x, height / 2 - spread * (0.7 + widthAmount * 0.6) + modulation)
    }
    for (let x = tailWidth; x >= 0; x--) {
      const t = x / Math.max(1, tailWidth)
      const envelope = Math.exp(-t / normalizedDecay)
      const spread = (8 + size * 22 + density * 10) * envelope
      const modulation = Math.sin(t * Math.PI * (3 + diffusion * 7)) * 3 * diffusion * envelope
      ctx.lineTo(preDelayX + x, height / 2 + spread * (1.3 - widthAmount * 0.4) + modulation)
    }
    ctx.closePath()
    ctx.fill()

    ctx.strokeStyle = props.params.enabled ? '#67e8f9' : '#525252'
    ctx.lineWidth = 2
    ctx.beginPath()

    const denominator = width - 1
    for (let x = 0; x < width; x++) {
      const t = x / denominator
      const amplitude = Math.exp(-t / normalizedDecay) * (0.55 + density * 0.45)
      const dampingTilt = (highCut - lowCut * 0.4) * t * 10
      const y = 8 + (1 - amplitude) * (height - 16) + dampingTilt
      if (x === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }

    ctx.stroke()

    ctx.fillStyle = props.params.enabled ? '#67e8f9' : '#737373'
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'
    ctx.fillText(formatSeconds(props.params.decaySec), width - 6, height - 5)
  })

  return <canvas ref={(el) => (canvasRef = el)} class="h-[74px] w-[150px] border border-neutral-800" />
}

export default function Reverb(props: ReverbProps) {
  const updateParam = (updates: Partial<ReverbParams>) => {
    const normalized = normalizeReverbParams({ ...props.params, ...updates })
    if (updates.wet !== undefined && props.params.wet !== normalized.wet) props.onChange({ wet: normalized.wet })
    if (updates.decaySec !== undefined && props.params.decaySec !== normalized.decaySec) props.onChange({ decaySec: normalized.decaySec })
    if (updates.preDelayMs !== undefined && props.params.preDelayMs !== normalized.preDelayMs) props.onChange({ preDelayMs: normalized.preDelayMs })
    if (updates.size !== undefined && props.params.size !== normalized.size) props.onChange({ size: normalized.size })
    if (updates.diffusion !== undefined && props.params.diffusion !== normalized.diffusion) props.onChange({ diffusion: normalized.diffusion })
    if (updates.density !== undefined && props.params.density !== normalized.density) props.onChange({ density: normalized.density })
    if (updates.lowCutHz !== undefined && props.params.lowCutHz !== normalized.lowCutHz) props.onChange({ lowCutHz: normalized.lowCutHz })
    if (updates.highCutHz !== undefined && props.params.highCutHz !== normalized.highCutHz) props.onChange({ highCutHz: normalized.highCutHz })
    if (updates.stereoWidth !== undefined && props.params.stereoWidth !== normalized.stereoWidth) props.onChange({ stereoWidth: normalized.stereoWidth })
  }

  const updateWet = (value: number) => {
    updateParam({ wet: normalizeWet(value) })
  }
  const updateDecay = (value: number) => {
    updateParam({ decaySec: normalizeDecay(value) })
  }
  const updatePreDelay = (value: number) => {
    updateParam({ preDelayMs: normalizePreDelay(value) })
  }
  const updateSize = (value: number) => {
    updateParam({ size: normalizeUnitParam(value) })
  }
  const updateDiffusion = (value: number) => {
    updateParam({ diffusion: normalizeUnitParam(value) })
  }
  const updateDensity = (value: number) => {
    updateParam({ density: normalizeUnitParam(value) })
  }
  const updateLowCut = (value: number) => {
    updateParam({ lowCutHz: normalizeLowCut(value) })
  }
  const updateHighCut = (value: number) => {
    updateParam({ highCutHz: normalizeHighCut(value) })
  }
  const updateStereoWidth = (value: number) => {
    updateParam({ stereoWidth: normalizeStereoWidth(value) })
  }

  return (
    <div class={cn('flex flex-col border border-neutral-800 bg-neutral-900 text-neutral-100', props.class)}>
      {/* Header */}
      <div class="flex items-center justify-between border-b border-neutral-800 px-2 py-1">
        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold">Reverb</span>
        </div>
        <div class="flex items-center gap-2">
          <Show when={props.onToggleEnabled} keyed>
            {(onToggleEnabled) => (
              <button
                class={cn(
                  'px-2 py-0.5 text-xs',
                  props.params.enabled ? 'bg-green-500/20 text-green-400 ring-1 ring-green-500/30' : 'bg-neutral-800 text-neutral-400',
                )}
                onClick={() => onToggleEnabled(!props.params.enabled)}
                title={props.params.enabled ? 'Disable Reverb' : 'Enable Reverb'}
              >
                {props.params.enabled ? 'On' : 'Off'}
              </button>
            )}
          </Show>
          <Show when={props.onReset} keyed>
            {(onReset) => (
              <button
                class="border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700"
                onClick={() => onReset()}
              >Reset</button>
            )}
          </Show>
        </div>
      </div>

      {/* Controls */}
      <div class={cn('grid min-h-28 flex-1 grid-cols-[160px_68px_68px_68px_68px_68px_68px_68px_68px_68px]', !props.params.enabled && 'opacity-70')}>
        <ReverbSection title="Shape">
          <ReverbDecayDisplay params={props.params} />
        </ReverbSection>

        <ReverbParamControl
          title="Input"
          label="LoCut"
          valueLabel={formatFrequency(props.params.lowCutHz)}
          value={props.params.lowCutHz}
          min={REVERB_LOW_CUT_HZ_MIN}
          max={REVERB_LOW_CUT_HZ_MAX}
          step={10}
          unit="Hz"
          disabled={!props.params.enabled}
          onValueChange={updateLowCut}
        />
        <ReverbParamControl
          title="Filter"
          label="HiCut"
          valueLabel={formatFrequency(props.params.highCutHz)}
          value={props.params.highCutHz}
          min={REVERB_HIGH_CUT_HZ_MIN}
          max={REVERB_HIGH_CUT_HZ_MAX}
          step={100}
          unit="Hz"
          disabled={!props.params.enabled}
          onValueChange={updateHighCut}
        />
        <ReverbParamControl
          title="Early"
          label="Pre"
          valueLabel={formatMilliseconds(props.params.preDelayMs)}
          value={props.params.preDelayMs}
          min={REVERB_PRE_DELAY_MS_MIN}
          max={REVERB_PRE_DELAY_MS_MAX}
          step={1}
          unit="ms"
          disabled={!props.params.enabled}
          onValueChange={updatePreDelay}
        />
        <ReverbParamControl
          title="Space"
          label="Size"
          valueLabel={formatUnitPercent(props.params.size)}
          value={props.params.size}
          min={REVERB_UNIT_PARAM_MIN}
          max={REVERB_UNIT_PARAM_MAX}
          step={0.01}
          disabled={!props.params.enabled}
          onValueChange={updateSize}
        />
        <ReverbParamControl
          title="Time"
          label="Decay"
          valueLabel={formatSeconds(props.params.decaySec)}
          value={props.params.decaySec}
          min={REVERB_DECAY_SEC_MIN}
          max={REVERB_DECAY_SEC_MAX}
          step={0.1}
          unit="s"
          disabled={!props.params.enabled}
          onValueChange={updateDecay}
        />
        <ReverbParamControl
          title="Diffuse"
          label="Diff"
          valueLabel={formatUnitPercent(props.params.diffusion)}
          value={props.params.diffusion}
          min={REVERB_UNIT_PARAM_MIN}
          max={REVERB_UNIT_PARAM_MAX}
          step={0.01}
          disabled={!props.params.enabled}
          onValueChange={updateDiffusion}
        />
        <ReverbParamControl
          title="Network"
          label="Dens"
          valueLabel={formatUnitPercent(props.params.density)}
          value={props.params.density}
          min={REVERB_UNIT_PARAM_MIN}
          max={REVERB_UNIT_PARAM_MAX}
          step={0.01}
          disabled={!props.params.enabled}
          onValueChange={updateDensity}
        />
        <ReverbParamControl
          title="Width"
          label="Stereo"
          valueLabel={formatStereoWidth(props.params.stereoWidth)}
          value={props.params.stereoWidth}
          min={REVERB_STEREO_WIDTH_MIN}
          max={REVERB_STEREO_WIDTH_MAX}
          step={0.01}
          disabled={!props.params.enabled}
          onValueChange={updateStereoWidth}
        />
        <ReverbParamControl
          title="Output"
          label="Wet"
          valueLabel={formatPercent(props.params.wet)}
          value={props.params.wet}
          min={REVERB_WET_MIN}
          max={REVERB_WET_MAX}
          step={0.01}
          disabled={!props.params.enabled}
          onValueChange={updateWet}
        />
      </div>
    </div>
  )
}
