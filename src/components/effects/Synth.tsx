import { Show, For, createMemo } from 'solid-js'
import Knob from '~/components/ui/knob'

export type SynthParams = {
  wave1: 'sine' | 'square' | 'sawtooth' | 'triangle'
  wave2: 'sine' | 'square' | 'sawtooth' | 'triangle'
  gain: number // 0..1.5
  attackMs: number // 0..200
  releaseMs: number // 0..200
  wave?: WaveType
}

export function createDefaultSynthParams(): SynthParams {
  return {
    wave1: 'sawtooth',
    wave2: 'sawtooth',
    gain: 0.8,
    attackMs: 5,
    releaseMs: 30,
    wave: 'sawtooth',
  }
}

export type SynthProps = {
  params: SynthParams
  onChange: (updates: Partial<SynthParams>) => void
  onReset?: () => void
  onExpand?: () => void
  variant?: 'compact' | 'expanded'
  class?: string
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

type WaveType = 'sine' | 'square' | 'sawtooth' | 'triangle'
const WAVEFORMS: { value: WaveType; label: string; icon: string }[] = [
  { value: 'sine', label: 'Sine', icon: '∿' },
  { value: 'square', label: 'Square', icon: '⊓' },
  { value: 'sawtooth', label: 'Sawtooth', icon: '⊿' },
  { value: 'triangle', label: 'Triangle', icon: '△' },
]

export default function Synth(props: SynthProps) {
  const variant = () => props.variant ?? 'compact'
  const wvW = () => (variant() === 'expanded' ? 240 : 120)
  const wvH = () => (variant() === 'expanded' ? 64 : 28)
  const envW = () => (variant() === 'expanded' ? 360 : 220)
  const envH = () => (variant() === 'expanded' ? 80 : 48)
  return (
    <div class={`rounded-md border border-neutral-800 bg-neutral-900 text-neutral-100 flex flex-col ${props.class ?? ''}`}>
      {/* Header */}
      <div class="flex items-center justify-between px-2 py-1 border-b border-neutral-800">
        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold">Synth</span>
        </div>
        <div class="flex items-center gap-2">
          <Show when={props.onExpand}>
            <button
              class="text-xs px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300 border border-neutral-700"
              onClick={() => props.onExpand?.()}
            >Expand</button>
          </Show>
          <Show when={props.onReset}>
            <button
              class="text-xs px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300 border border-neutral-700"
              onClick={() => props.onReset?.()}
            >Reset</button>
          </Show>
        </div>
      </div>

      {/* Oscillator controls */}
      <div class="px-2 py-2 border-b border-neutral-800/50">
        <div class="grid gap-3" style={{ 'grid-template-columns': '1fr 1fr' }}>
          {/* Osc 1 */}
          <div class="flex flex-col gap-1">
            <div class="text-[11px] text-neutral-400">Osc 1</div>
            <div class="flex items-center gap-1 flex-wrap">
              <For each={WAVEFORMS}>{(wf) => (
                <button
                  class={`px-2 py-0.5 text-[11px] rounded border transition-colors ${props.params.wave1 === wf.value ? 'bg-blue-500/20 text-blue-300 border-blue-400/30' : 'bg-neutral-800 text-neutral-300 border-neutral-700 hover:bg-neutral-700'}`}
                  onClick={() => props.onChange({ wave1: wf.value, wave: wf.value })}
                  title={wf.label}
                >
                  <span class="font-mono text-sm">{wf.icon}</span>
                </button>
              )}</For>
            </div>
            <div class="mt-1 flex items-center">
              <div class="rounded bg-neutral-800/70 border border-neutral-700/70 flex items-center justify-center" style={{ width: `${wvW()}px`, height: `${wvH()}px` }}>
                <WavePreview wave={props.params.wave1} width={wvW()} height={wvH()} />
              </div>
            </div>
          </div>
          {/* Osc 2 */}
          <div class="flex flex-col gap-1">
            <div class="text-[11px] text-neutral-400">Osc 2</div>
            <div class="flex items-center gap-1 flex-wrap">
              <For each={WAVEFORMS}>{(wf) => (
                <button
                  class={`px-2 py-0.5 text-[11px] rounded border transition-colors ${props.params.wave2 === wf.value ? 'bg-green-500/20 text-green-300 border-green-400/30' : 'bg-neutral-800 text-neutral-300 border-neutral-700 hover:bg-neutral-700'}`}
                  onClick={() => props.onChange({ wave2: wf.value })}
                  title={wf.label}
                >
                  <span class="font-mono text-sm">{wf.icon}</span>
                </button>
              )}</For>
            </div>
            <div class="mt-1 flex items-center">
              <div class="rounded bg-neutral-800/70 border border-neutral-700/70 flex items-center justify-center" style={{ width: `${wvW()}px`, height: `${wvH()}px` }}>
                <WavePreview wave={props.params.wave2} width={wvW()} height={wvH()} />
              </div>
            </div>
          </div>
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

      {/* Envelope preview */}
      <div class="px-2 pb-2">
        <div class="flex items-center justify-center">
          <div class="rounded bg-neutral-800/70 border border-neutral-700/70" style={{ width: `${envW()}px`, height: `${envH()}px` }}>
            <EnvelopePreview attackMs={props.params.attackMs} releaseMs={props.params.releaseMs} width={envW()} height={envH()} />
          </div>
        </div>
      </div>
    </div>
  )
}

function WavePreview(props: { wave: WaveType; width?: number; height?: number }) {
  const w = props.width ?? 180
  const h = props.height ?? 36
  const pad = 4
  const mid = h / 2
  const amp = (h - pad * 2) / 2
  const N = 80
  const makePath = (phase: number) => {
    const points: Array<[number, number]> = []
    for (let i = 0; i <= N; i++) {
      let t = i / N
      t = (t + phase) % 1
      let yNorm = 0
      switch (props.wave) {
        case 'sine': yNorm = Math.sin(t * Math.PI * 2); break
        case 'square': yNorm = t < 0.5 ? 1 : -1; break
        case 'sawtooth': yNorm = 2 * t - 1; break
        default: yNorm = 1 - 4 * Math.abs(t - 0.5) // triangle
      }
      const x = pad + (i / N) * (w - pad * 2)
      const y = mid - yNorm * amp
      points.push([x, y])
    }
    return points.map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  }
  const d1 = createMemo(() => makePath(0))
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <path d={d1()} stroke="#60a5fa" stroke-opacity="0.9" stroke-width="2" fill="none" />
      <line x1="0" y1={mid} x2={w} y2={mid} stroke="rgba(255,255,255,0.25)" stroke-width="1" />
    </svg>
  )
}

function EnvelopePreview(props: { attackMs: number; releaseMs: number; holdMs?: number; width?: number; height?: number }) {
  const w = props.width ?? 220
  const h = props.height ?? 48
  const pad = 6
  const computed = createMemo(() => {
    const attack = Math.max(0, props.attackMs || 0)
    const release = Math.max(0, props.releaseMs || 0)
    const totalTarget = 800
    const baseHold = typeof props.holdMs === 'number' ? Math.max(0, props.holdMs) : totalTarget
    const hold = Math.max(0, (baseHold > 0 ? baseHold : totalTarget) - attack - release)
    const total = Math.max(1, attack + hold + release)
    const x = (ms: number) => pad + (ms / total) * (w - pad * 2)
    const y = (amp: number) => pad + (1 - Math.max(0, Math.min(1, amp))) * (h - pad * 2)
    const pts: Array<[number, number]> = []
    const A_STEPS = 24
    for (let i = 0; i <= A_STEPS; i++) {
      const t = A_STEPS === 0 ? 1 : i / A_STEPS
      const amp = Math.pow(t, 0.5)
      pts.push([x(t * attack), y(amp)])
    }
    pts.push([x(attack + hold), y(1)])
    const R_STEPS = 24
    for (let i = 1; i <= R_STEPS; i++) {
      const t = i / R_STEPS
      const amp = Math.pow(1 - t, 0.5)
      pts.push([x(attack + hold + t * release), y(amp)])
    }
    const d = pts.map(([xx, yy], idx) => `${idx === 0 ? 'M' : 'L'}${xx.toFixed(2)},${yy.toFixed(2)}`).join(' ')
    return { d, y0: y(0), y1: y(1) }
  })
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <rect x={0} y={0} width={w} height={h} fill="none" />
      <path d={computed().d} stroke="#a3e635" stroke-width="2" fill="none" />
      <line x1={pad} y1={computed().y0} x2={w - pad} y2={computed().y0} stroke="rgba(255,255,255,0.25)" stroke-width="1" />
      <line x1={pad} y1={computed().y1} x2={w - pad} y2={computed().y1} stroke="rgba(255,255,255,0.15)" stroke-width="1" />
    </svg>
  )
}
