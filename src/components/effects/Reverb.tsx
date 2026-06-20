import { createEffect, Show, type JSX } from 'solid-js'
import Knob from '~/components/ui/knob'
import {
  type ReverbParams,
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
const WET_MIN = 0
const WET_MAX = 1
const DECAY_MIN = 0.1
const DECAY_MAX = 10
const PRE_DELAY_MIN = 0
const PRE_DELAY_MAX = 200

const normalizeWet = (value: number) => Math.round(clamp(value, WET_MIN, WET_MAX) * 100) / 100
const normalizeDecay = (value: number) => Math.round(clamp(value, DECAY_MIN, DECAY_MAX) * 10) / 10
const normalizePreDelay = (value: number) => Math.round(clamp(value, PRE_DELAY_MIN, PRE_DELAY_MAX))

const formatPercent = (value: number) => `${Math.round(normalizeWet(value) * 100)}%`
const formatSeconds = (value: number) => `${normalizeDecay(value).toFixed(1)}s`
const formatMilliseconds = (value: number) => `${normalizePreDelay(value)}ms`

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

function ReverbDecayDisplay(props: { decaySec: number; enabled: boolean }) {
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

    ctx.strokeStyle = props.enabled ? '#67e8f9' : '#525252'
    ctx.lineWidth = 2
    ctx.beginPath()

    const normalizedDecay = clamp(props.decaySec / 10, 0.05, 1)
    const denominator = width - 1
    for (let x = 0; x < width; x++) {
      const t = x / denominator
      const amplitude = Math.exp(-t / normalizedDecay)
      const y = 8 + (1 - amplitude) * (height - 16)
      if (x === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }

    ctx.stroke()

    ctx.fillStyle = props.enabled ? '#67e8f9' : '#737373'
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'
    ctx.fillText(formatSeconds(props.decaySec), width - 6, height - 5)
  })

  return <canvas ref={(el) => (canvasRef = el)} class="h-[74px] w-[150px] border border-neutral-800" />
}

export default function Reverb(props: ReverbProps) {
  const updateWet = (value: number) => {
    const wet = normalizeWet(value)
    if (props.params.wet !== wet) props.onChange({ wet })
  }
  const updateDecay = (value: number) => {
    const decaySec = normalizeDecay(value)
    if (props.params.decaySec !== decaySec) props.onChange({ decaySec })
  }
  const updatePreDelay = (value: number) => {
    const preDelayMs = normalizePreDelay(value)
    if (props.params.preDelayMs !== preDelayMs) props.onChange({ preDelayMs })
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
      <div class={cn('grid min-h-28 flex-1 grid-cols-[170px_86px_86px_86px]', !props.params.enabled && 'opacity-70')}>
        <ReverbSection title="Decay Display">
          <ReverbDecayDisplay decaySec={props.params.decaySec} enabled={props.params.enabled} />
        </ReverbSection>

        <ReverbSection title="Global">
          <ReverbKnobControl label="Pre" valueLabel={formatMilliseconds(props.params.preDelayMs)}>
            <Knob
              value={props.params.preDelayMs}
              min={PRE_DELAY_MIN}
              max={PRE_DELAY_MAX}
              step={1}
              size={32}
              label=""
              unit="ms"
              disabled={!props.params.enabled}
              showValue={false}
              onValueChange={updatePreDelay}
            />
          </ReverbKnobControl>
        </ReverbSection>

        <ReverbSection title="Space">
          <ReverbKnobControl label="Decay" valueLabel={formatSeconds(props.params.decaySec)}>
            <Knob
              value={props.params.decaySec}
              min={DECAY_MIN}
              max={DECAY_MAX}
              step={0.1}
              size={32}
              label=""
              unit="s"
              disabled={!props.params.enabled}
              showValue={false}
              onValueChange={updateDecay}
            />
          </ReverbKnobControl>
        </ReverbSection>

        <ReverbSection title="Output">
          <ReverbKnobControl label="Wet" valueLabel={formatPercent(props.params.wet)}>
            <Knob
              value={props.params.wet}
              min={WET_MIN}
              max={WET_MAX}
              step={0.01}
              size={32}
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
