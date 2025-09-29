import { Show } from 'solid-js'
import Knob from '~/components/ui/knob'

export type ReverbParams = {
  enabled: boolean
  wet: number // 0..1
  decaySec: number // 0.1..10
  preDelayMs: number // 0..200
}

export function createDefaultReverbParams(): ReverbParams {
  return {
    enabled: true,
    wet: 0.25,
    decaySec: 2.2,
    preDelayMs: 20,
  }
}

export type ReverbProps = {
  params: ReverbParams
  onChange: (updates: Partial<ReverbParams>) => void
  onToggleEnabled?: (enabled: boolean) => void
  onReset?: () => void
  class?: string
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export default function Reverb(props: ReverbProps) {
  return (
    <div class={`rounded-md border border-neutral-800 bg-neutral-900 text-neutral-100 flex flex-col ${props.class ?? ''}`}>
      {/* Header */}
      <div class="flex items-center justify-between px-2 py-1 border-b border-neutral-800">
        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold">Reverb</span>
          <Show when={props.onToggleEnabled}>
            <button
              class={`ml-2 text-xs px-2 py-0.5 rounded ${props.params.enabled ? 'bg-green-500/20 text-green-400 ring-1 ring-green-500/30' : 'bg-neutral-800 text-neutral-400'}`}
              onClick={() => props.onToggleEnabled?.(!props.params.enabled)}
              title={props.params.enabled ? 'Disable Reverb' : 'Enable Reverb'}
            >
              {props.params.enabled ? 'On' : 'Off'}
            </button>
          </Show>
        </div>
        <div class="flex items-center gap-2">
          <Show when={props.onReset}>
            <button
              class="text-xs px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300 border border-neutral-700"
              onClick={() => props.onReset?.()}
            >Reset</button>
          </Show>
        </div>
      </div>

      {/* Controls */}
      <div class="px-3 py-3 flex flex-1 items-center justify-evenly gap-6">
        {/* Wet */}
        <div class="flex flex-col items-center gap-1">
          <div class="text-xs leading-none text-neutral-400">Wet</div>
          <Knob
            value={props.params.wet}
            min={0}
            max={1}
            step={0.01}
            size={28}
            label=""
            disabled={!props.params.enabled}
            showValue={false}
            onValueChange={(v) => props.onChange({ wet: Math.round(clamp(v, 0, 1) * 100) / 100 })}
          />
          <div class="text-xs leading-none text-neutral-300 font-mono">{Math.round(props.params.wet * 100)}%</div>
        </div>

        {/* Decay */}
        <div class="flex flex-col items-center gap-1">
          <div class="text-xs leading-none text-neutral-400">Decay</div>
          <Knob
            value={props.params.decaySec}
            min={0.1}
            max={10}
            step={0.1}
            size={28}
            label=""
            unit="s"
            disabled={!props.params.enabled}
            showValue={false}
            onValueChange={(v) => props.onChange({ decaySec: Math.round(clamp(v, 0.1, 10) * 10) / 10 })}
          />
          <div class="text-xs leading-none text-neutral-300 font-mono">{props.params.decaySec.toFixed(1)}s</div>
        </div>

        {/* PreDelay */}
        <div class="flex flex-col items-center gap-1">
          <div class="text-xs leading-none text-neutral-400">Pre</div>
          <Knob
            value={props.params.preDelayMs}
            min={0}
            max={200}
            step={1}
            size={28}
            label=""
            unit="ms"
            disabled={!props.params.enabled}
            showValue={false}
            onValueChange={(v) => props.onChange({ preDelayMs: Math.round(clamp(v, 0, 200)) })}
          />
          <div class="text-xs leading-none text-neutral-300 font-mono">{props.params.preDelayMs}ms</div>
        </div>
      </div>
    </div>
  )
}
