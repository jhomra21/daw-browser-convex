import { Show, For } from 'solid-js'
import Knob from '~/components/ui/knob'
import {
  type ArpeggiatorParams,
} from '~/lib/effects/params'
import { cn } from '~/lib/utils'


export type ArpeggiatorProps = {
  params: ArpeggiatorParams
  onChange: (updates: Partial<ArpeggiatorParams>) => void
  onToggleEnabled?: (enabled: boolean) => void
  onReset?: () => void
  class?: string
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const PATTERNS: { value: ArpeggiatorParams['pattern']; label: string }[] = [
  { value: 'up', label: 'Up' },
  { value: 'down', label: 'Down' },
  { value: 'updown', label: 'Up/Down' },
  { value: 'random', label: 'Random' },
]

const RATES: { value: ArpeggiatorParams['rate']; label: string }[] = [
  { value: '1/4', label: '1/4' },
  { value: '1/8', label: '1/8' },
  { value: '1/16', label: '1/16' },
  { value: '1/32', label: '1/32' },
]

export default function Arpeggiator(props: ArpeggiatorProps) {
  return (
    <div class={cn('flex flex-col rounded-md border border-neutral-800 bg-neutral-900 text-neutral-100', props.class)}>
      {/* Header */}
      <div class="flex items-center justify-between border-b border-neutral-800 px-2 py-1">
        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold">Arpeggiator</span>
          <Show when={props.onToggleEnabled}>
            <button
              class={cn(
                'rounded border border-neutral-700 px-1.5 py-0.5 text-2xs transition-colors',
                props.params.enabled
                  ? 'border-green-400/30 bg-green-500/20 text-green-300'
                  : 'bg-neutral-800 text-neutral-400',
              )}
              onClick={() => props.onToggleEnabled?.(!props.params.enabled)}
            >
              {props.params.enabled ? 'ON' : 'OFF'}
            </button>
          </Show>
          <button
            class={cn(
              'rounded border border-neutral-700 px-1.5 py-0.5 text-2xs transition-colors',
              props.params.hold
                ? 'border-blue-400/30 bg-blue-500/20 text-blue-300'
                : 'bg-neutral-800 text-neutral-400',
            )}
            onClick={() => props.onChange({ hold: !props.params.hold })}
            disabled={!props.params.enabled}
            title="Hold: Keep arpeggiation looping until clip ends"
          >
            HOLD
          </button>
        </div>
        <div class="flex items-center gap-2">
          <Show when={props.onReset}>
            <button
              class="rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700"
              onClick={() => props.onReset?.()}
            >Reset</button>
          </Show>
        </div>
      </div>

      {/* Pattern Selector */}
      <div class="px-2 py-2 border-b border-neutral-800/50">
        <div class="text-2xs text-neutral-400 mb-1 text-center">Pattern</div>
        <div class="flex items-center justify-center gap-1">
          <For each={PATTERNS}>
            {(pat) => (
              <button
                class={cn(
                  'rounded border border-neutral-700 px-2 py-1 text-xs transition-colors',
                  props.params.pattern === pat.value
                    ? 'border-blue-400/30 bg-blue-500/20 text-blue-300'
                    : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700',
                )}
                onClick={() => props.onChange({ pattern: pat.value })}
                disabled={!props.params.enabled}
              >
                {pat.label}
              </button>
            )}
          </For>
        </div>
      </div>

      {/* Rate Selector */}
      <div class="px-2 py-2 border-b border-neutral-800/50">
        <div class="text-2xs text-neutral-400 mb-1 text-center">Rate</div>
        <div class="flex items-center justify-center gap-1">
          <For each={RATES}>
            {(r) => (
              <button
                class={cn(
                  'rounded border border-neutral-700 px-2 py-1 font-mono text-xs transition-colors',
                  props.params.rate === r.value
                    ? 'border-blue-400/30 bg-blue-500/20 text-blue-300'
                    : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700',
                )}
                onClick={() => props.onChange({ rate: r.value })}
                disabled={!props.params.enabled}
              >
                {r.label}
              </button>
            )}
          </For>
        </div>
      </div>

      {/* Controls */}
      <div class="px-3 py-3 flex flex-1 items-center justify-evenly gap-4">
        {/* Octaves */}
        <div class="flex flex-col items-center gap-1">
          <div class="text-xs leading-none text-neutral-400">Octaves</div>
          <Knob
            value={props.params.octaves}
            min={1}
            max={4}
            step={1}
            size={28}
            label=""
            showValue={false}
            onValueChange={(v) => props.onChange({ octaves: Math.round(clamp(v, 1, 4)) })}
            disabled={!props.params.enabled}
          />
          <div class="text-xs leading-none text-neutral-300 font-mono">{props.params.octaves}</div>
        </div>

        {/* Gate */}
        <div class="flex flex-col items-center gap-1">
          <div class="text-xs leading-none text-neutral-400">Gate</div>
          <Knob
            value={props.params.gate}
            min={0.1}
            max={1.0}
            step={0.05}
            size={28}
            label=""
            showValue={false}
            onValueChange={(v) => props.onChange({ gate: Math.round(clamp(v, 0.1, 1.0) * 100) / 100 })}
            disabled={!props.params.enabled}
          />
          <div class="text-xs leading-none text-neutral-300 font-mono">{(props.params.gate * 100).toFixed(0)}%</div>
        </div>
      </div>
    </div>
  )
}
