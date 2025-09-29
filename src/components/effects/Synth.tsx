import { Show, For } from 'solid-js'
import Knob from '~/components/ui/knob'

export type SynthParams = {
  wave: 'sine' | 'square' | 'sawtooth' | 'triangle'
  gain: number // 0..1.5
  attackMs: number // 0..200
  releaseMs: number // 0..200
}

export function createDefaultSynthParams(): SynthParams {
  return {
    wave: 'sawtooth',
    gain: 0.8,
    attackMs: 5,
    releaseMs: 30,
  }
}

export type SynthProps = {
  params: SynthParams
  onChange: (updates: Partial<SynthParams>) => void
  onReset?: () => void
  class?: string
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const WAVEFORMS: { value: SynthParams['wave']; label: string; icon: string }[] = [
  { value: 'sine', label: 'Sine', icon: '∿' },
  { value: 'square', label: 'Square', icon: '⊓' },
  { value: 'sawtooth', label: 'Sawtooth', icon: '⊿' },
  { value: 'triangle', label: 'Triangle', icon: '△' },
]

export default function Synth(props: SynthProps) {
  return (
    <div class={`rounded-md border border-neutral-800 bg-neutral-900 text-neutral-100 w-[30%] self-stretch flex flex-col ${props.class ?? ''}`}>
      {/* Header */}
      <div class="flex items-center justify-between px-2 py-1 border-b border-neutral-800">
        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold">Synth</span>
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

      {/* Waveform Selector */}
      <div class="px-2 py-2 border-b border-neutral-800/50">
        <div class="flex items-center justify-center gap-1">
          <For each={WAVEFORMS}>
            {(wf) => (
              <button
                class={`px-2 py-1 text-xs rounded border transition-colors ${
                  props.params.wave === wf.value
                    ? 'bg-blue-500/20 text-blue-300 border-blue-400/30'
                    : 'bg-neutral-800 text-neutral-300 border-neutral-700 hover:bg-neutral-700'
                }`}
                onClick={() => props.onChange({ wave: wf.value })}
                title={wf.label}
              >
                <span class="font-mono text-sm">{wf.icon}</span>
                <span class="ml-1">{wf.label}</span>
              </button>
            )}
          </For>
        </div>
      </div>

      {/* Controls */}
      <div class="px-3 py-3 flex flex-1 items-center justify-evenly gap-4">
        {/* Gain */}
        <div class="flex flex-col items-center gap-1">
          <div class="text-xs leading-none text-neutral-400">Gain</div>
          <Knob
            value={props.params.gain}
            min={0}
            max={1.5}
            step={0.05}
            size={28}
            label=""
            showValue={false}
            onValueChange={(v) => props.onChange({ gain: Math.round(clamp(v, 0, 1.5) * 100) / 100 })}
          />
          <div class="text-xs leading-none text-neutral-300 font-mono">{props.params.gain.toFixed(2)}</div>
        </div>

        {/* Attack */}
        <div class="flex flex-col items-center gap-1">
          <div class="text-xs leading-none text-neutral-400">Attack</div>
          <Knob
            value={props.params.attackMs}
            min={0}
            max={200}
            step={1}
            size={28}
            label=""
            unit="ms"
            showValue={false}
            onValueChange={(v) => props.onChange({ attackMs: Math.round(clamp(v, 0, 200)) })}
          />
          <div class="text-xs leading-none text-neutral-300 font-mono">{props.params.attackMs}ms</div>
        </div>

        {/* Release */}
        <div class="flex flex-col items-center gap-1">
          <div class="text-xs leading-none text-neutral-400">Release</div>
          <Knob
            value={props.params.releaseMs}
            min={0}
            max={200}
            step={1}
            size={28}
            label=""
            unit="ms"
            showValue={false}
            onValueChange={(v) => props.onChange({ releaseMs: Math.round(clamp(v, 0, 200)) })}
          />
          <div class="text-xs leading-none text-neutral-300 font-mono">{props.params.releaseMs}ms</div>
        </div>
      </div>
    </div>
  )
}
