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
  const updateWet = (value: number) => {
    const wet = normalizeReverbParams({ ...props.params, wet: normalizeWet(value) }).wet
    if (props.params.wet !== wet) props.onChange({ wet })
  }
  const updateDecay = (value: number) => {
    const decaySec = normalizeReverbParams({ ...props.params, decaySec: normalizeDecay(value) }).decaySec
    if (props.params.decaySec !== decaySec) props.onChange({ decaySec })
  }
  const updatePreDelay = (value: number) => {
    const preDelayMs = normalizeReverbParams({ ...props.params, preDelayMs: normalizePreDelay(value) }).preDelayMs
    if (props.params.preDelayMs !== preDelayMs) props.onChange({ preDelayMs })
  }
  const updateSize = (value: number) => {
    const size = normalizeReverbParams({ ...props.params, size: normalizeUnitParam(value) }).size
    if (props.params.size !== size) props.onChange({ size })
  }
  const updateDiffusion = (value: number) => {
    const diffusion = normalizeReverbParams({ ...props.params, diffusion: normalizeUnitParam(value) }).diffusion
    if (props.params.diffusion !== diffusion) props.onChange({ diffusion })
  }
  const updateDensity = (value: number) => {
    const density = normalizeReverbParams({ ...props.params, density: normalizeUnitParam(value) }).density
    if (props.params.density !== density) props.onChange({ density })
  }
  const updateLowCut = (value: number) => {
    const lowCutHz = normalizeReverbParams({ ...props.params, lowCutHz: normalizeLowCut(value) }).lowCutHz
    if (props.params.lowCutHz !== lowCutHz) props.onChange({ lowCutHz })
  }
  const updateHighCut = (value: number) => {
    const highCutHz = normalizeReverbParams({ ...props.params, highCutHz: normalizeHighCut(value) }).highCutHz
    if (props.params.highCutHz !== highCutHz) props.onChange({ highCutHz })
  }
  const updateStereoWidth = (value: number) => {
    const stereoWidth = normalizeReverbParams({ ...props.params, stereoWidth: normalizeStereoWidth(value) }).stereoWidth
    if (props.params.stereoWidth !== stereoWidth) props.onChange({ stereoWidth })
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

        <ReverbSection title="Input">
          <ReverbKnobControl label="LoCut" valueLabel={formatFrequency(props.params.lowCutHz)}>
            <Knob
              value={props.params.lowCutHz}
              min={REVERB_LOW_CUT_HZ_MIN}
              max={REVERB_LOW_CUT_HZ_MAX}
              step={10}
              size={28}
              label=""
              unit="Hz"
              disabled={!props.params.enabled}
              showValue={false}
              onValueChange={updateLowCut}
            />
          </ReverbKnobControl>
        </ReverbSection>

        <ReverbSection title="Filter">
          <ReverbKnobControl label="HiCut" valueLabel={formatFrequency(props.params.highCutHz)}>
            <Knob
              value={props.params.highCutHz}
              min={REVERB_HIGH_CUT_HZ_MIN}
              max={REVERB_HIGH_CUT_HZ_MAX}
              step={100}
              size={28}
              label=""
              unit="Hz"
              disabled={!props.params.enabled}
              showValue={false}
              onValueChange={updateHighCut}
            />
          </ReverbKnobControl>
        </ReverbSection>

        <ReverbSection title="Early">
          <ReverbKnobControl label="Pre" valueLabel={formatMilliseconds(props.params.preDelayMs)}>
            <Knob
              value={props.params.preDelayMs}
              min={REVERB_PRE_DELAY_MS_MIN}
              max={REVERB_PRE_DELAY_MS_MAX}
              step={1}
              size={28}
              label=""
              unit="ms"
              disabled={!props.params.enabled}
              showValue={false}
              onValueChange={updatePreDelay}
            />
          </ReverbKnobControl>
        </ReverbSection>

        <ReverbSection title="Space">
          <ReverbKnobControl label="Size" valueLabel={formatUnitPercent(props.params.size)}>
            <Knob
              value={props.params.size}
              min={REVERB_UNIT_PARAM_MIN}
              max={REVERB_UNIT_PARAM_MAX}
              step={0.01}
              size={28}
              label=""
              disabled={!props.params.enabled}
              showValue={false}
              onValueChange={updateSize}
            />
          </ReverbKnobControl>
        </ReverbSection>

        <ReverbSection title="Time">
          <ReverbKnobControl label="Decay" valueLabel={formatSeconds(props.params.decaySec)}>
            <Knob
              value={props.params.decaySec}
              min={REVERB_DECAY_SEC_MIN}
              max={REVERB_DECAY_SEC_MAX}
              step={0.1}
              size={28}
              label=""
              unit="s"
              disabled={!props.params.enabled}
              showValue={false}
              onValueChange={updateDecay}
            />
          </ReverbKnobControl>
        </ReverbSection>

        <ReverbSection title="Diffuse">
          <ReverbKnobControl label="Diff" valueLabel={formatUnitPercent(props.params.diffusion)}>
            <Knob
              value={props.params.diffusion}
              min={REVERB_UNIT_PARAM_MIN}
              max={REVERB_UNIT_PARAM_MAX}
              step={0.01}
              size={28}
              label=""
              disabled={!props.params.enabled}
              showValue={false}
              onValueChange={updateDiffusion}
            />
          </ReverbKnobControl>
        </ReverbSection>

        <ReverbSection title="Network">
          <ReverbKnobControl label="Dens" valueLabel={formatUnitPercent(props.params.density)}>
            <Knob
              value={props.params.density}
              min={REVERB_UNIT_PARAM_MIN}
              max={REVERB_UNIT_PARAM_MAX}
              step={0.01}
              size={28}
              label=""
              disabled={!props.params.enabled}
              showValue={false}
              onValueChange={updateDensity}
            />
          </ReverbKnobControl>
        </ReverbSection>

        <ReverbSection title="Width">
          <ReverbKnobControl label="Stereo" valueLabel={formatStereoWidth(props.params.stereoWidth)}>
            <Knob
              value={props.params.stereoWidth}
              min={REVERB_STEREO_WIDTH_MIN}
              max={REVERB_STEREO_WIDTH_MAX}
              step={0.01}
              size={28}
              label=""
              disabled={!props.params.enabled}
              showValue={false}
              onValueChange={updateStereoWidth}
            />
          </ReverbKnobControl>
        </ReverbSection>

        <ReverbSection title="Output">
          <ReverbKnobControl label="Wet" valueLabel={formatPercent(props.params.wet)}>
            <Knob
              value={props.params.wet}
              min={REVERB_WET_MIN}
              max={REVERB_WET_MAX}
              step={0.01}
              size={28}
              label=""
              disabled={!props.params.enabled}
              showValue={false}
              onValueChange={updateWet}
            />
          </ReverbKnobControl>
        </ReverbSection>
      </div>
    </div>
  )
}
