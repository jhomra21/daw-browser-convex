import { Show, For, createSignal, onMount, onCleanup, createEffect } from 'solid-js'
import Knob from '~/components/ui/knob'
import type { SpectrumFrame } from '~/lib/audio-engine'

// ===== Types (used to inform Convex schema later) =====
export type EqBandParams = {
  id: string
  frequency: number // Hz (20..20000)
  gainDb: number // dB (-24..+24)
  q: number // Q factor (0.2..18)
  enabled: boolean
  type: BiquadFilterType // 'peaking' | 'lowshelf' | 'highshelf' | 'lowpass' | 'highpass' | 'bandpass' | 'notch'
}

export type EqParams = {
  bands: EqBandParams[]
  enabled: boolean
}

// Create 8 default bands (Ableton-style layout)
export function createDefaultEqParams(): EqParams {
  // Log-spaced defaults roughly across spectrum
  const defaults = [
    40, 100, 200, 500, 1000, 2500, 6000, 12000,
  ]
  const bands: EqBandParams[] = defaults.map((f, i) => ({
    id: `b${i + 1}`,
    frequency: f,
    gainDb: 0,
    q: 1.0,
    enabled: true,
    type: i === 0 ? 'lowshelf' : i === defaults.length - 1 ? 'highshelf' : 'peaking',
  }))
  return { bands, enabled: true }
}

// ===== Component =====

export type EqProps = {
  bands: EqBandParams[]
  enabled: boolean
  onBandChange: (bandId: string, updates: Partial<EqBandParams>) => void
  onBandToggle?: (bandId: string) => void
  onToggleEnabled?: (enabled: boolean) => void
  onReset?: () => void
  class?: string
  spectrumData?: SpectrumFrame | null
}

const FREQ_MIN = 20
const FREQ_MAX = 20000
const GAIN_MIN = -24
const GAIN_MAX = 24
const Q_MIN = 0.2
const Q_MAX = 18

const FILTER_TYPES: { value: BiquadFilterType; label: string; short: string }[] = [
  { value: 'lowpass', label: 'Low Pass', short: 'LP' },
  { value: 'highpass', label: 'High Pass', short: 'HP' },
  { value: 'bandpass', label: 'Band Pass', short: 'BP' },
  { value: 'notch', label: 'Notch', short: 'NT' },
  { value: 'lowshelf', label: 'Low Shelf', short: 'LS' },
  { value: 'highshelf', label: 'High Shelf', short: 'HS' },
  { value: 'peaking', label: 'Peaking', short: 'PK' },
]

export default function Eq(props: EqProps) {
  const [selectedId, setSelectedId] = createSignal<string>(props.bands[0]?.id ?? '')
  const [draggedId, setDraggedId] = createSignal<string | null>(null)
  const [canvasSize, setCanvasSize] = createSignal({ width: 640, height: 160 })

  // canvas + container refs
  let canvasRef: HTMLCanvasElement | undefined
  let containerRef: HTMLDivElement | undefined
  let resizeObs: ResizeObserver | undefined

  onMount(() => {
    // Initialize size based on container (very compact)
    const update = () => {
      const el = containerRef
      if (!el) return
      const rect = el.getBoundingClientRect()
      const width = Math.floor(rect.width)
      const height = Math.max(120, Math.min(220, Math.floor(width * 0.35)))
      setCanvasSize({ width, height })
    }
    update()
    resizeObs = new ResizeObserver(() => update())
    containerRef && resizeObs.observe(containerRef)
  })

  onCleanup(() => {
    try { resizeObs?.disconnect() } catch {}
  })

  // Helpers: mapping
  const freqToX = (freq: number) => {
    const min = Math.log10(FREQ_MIN)
    const max = Math.log10(FREQ_MAX)
    const logf = Math.log10(Math.max(FREQ_MIN, Math.min(FREQ_MAX, freq)))
    const { width } = canvasSize()
    const L = 6, R = 6
    const inner = Math.max(1, width - (L + R))
    return L + ((logf - min) / (max - min)) * inner
  }
  const xToFreq = (x: number) => {
    const { width } = canvasSize()
    const L = 6, R = 6
    const inner = Math.max(1, width - (L + R))
    const clamped = Math.min(Math.max(x, L), width - R)
    const t = (clamped - L) / inner
    const logf = Math.log10(FREQ_MIN) + t * (Math.log10(FREQ_MAX) - Math.log10(FREQ_MIN))
    return Math.pow(10, logf)
  }
  const gainToY = (g: number) => {
    const { height } = canvasSize()
    const top = 4, bottom = 8
    const h = Math.max(1, height - (top + bottom))
    const t = (GAIN_MAX - Math.max(GAIN_MIN, Math.min(GAIN_MAX, g))) / (GAIN_MAX - GAIN_MIN)
    return top + t * h
  }
  const yToGain = (y: number) => {
    const { height } = canvasSize()
    const top = 6, bottom = 12
    const h = Math.max(1, height - (top + bottom))
    const clamped = Math.min(Math.max(y, top), height - bottom)
    const t = (clamped - top) / h
    return GAIN_MAX - t * (GAIN_MAX - GAIN_MIN)
  }

  // Helpers
  const supportsGain = (t: BiquadFilterType) => (t === 'peaking' || t === 'lowshelf' || t === 'highshelf')

  // Simple response model per type. This is an approximation for visualization only.
  const responseAt = (freq: number) => {
    let total = 0
    const A = 24 // attenuation depth for non-gain filters (dB)
    for (const b of props.bands) {
      if (!b.enabled) continue
      const ratio = Math.max(1e-6, freq / b.frequency)
      const l = Math.log(ratio)
      const q = Math.max(0.1, b.q)

      switch (b.type) {
        case 'peaking': {
          if (Math.abs(b.gainDb) < 0.05) break
          const resp = b.gainDb * Math.exp(-Math.pow(l * q, 2))
          total += resp
          break
        }
        case 'lowshelf': {
          if (Math.abs(b.gainDb) < 0.05) break
          const k = Math.min(6, Math.max(0.2, q))
          const sigmoid = 1 / (1 + Math.exp(+k * l)) // ~1 below cutoff, ~0 above
          const resp = b.gainDb * sigmoid
          total += resp
          break
        }
        case 'highshelf': {
          if (Math.abs(b.gainDb) < 0.05) break
          const k = Math.min(6, Math.max(0.2, q))
          const sigmoid = 1 / (1 + Math.exp(-k * l)) // ~0 below cutoff, ~1 above
          const resp = b.gainDb * sigmoid
          total += resp
          break
        }
        case 'lowpass': {
          const k = Math.min(6, Math.max(0.2, q))
          const sigmoid = 1 / (1 + Math.exp(-k * l)) // rises above cutoff
          const resp = -A * sigmoid // attenuate highs
          total += resp
          break
        }
        case 'highpass': {
          const k = Math.min(6, Math.max(0.2, q))
          const sigmoid = 1 / (1 + Math.exp(-k * l)) // rises above cutoff
          const resp = -A * (1 - sigmoid) // attenuate lows
          total += resp
          break
        }
        case 'bandpass': {
          const resp = -A * (1 - Math.exp(-Math.pow(l * q, 2))) // attenuate away from center
          total += resp
          break
        }
        case 'notch': {
          const resp = -A * Math.exp(-Math.pow(l * q, 2)) // attenuate at center
          total += resp
          break
        }
        default:
          break
      }
    }
    return total
  }

  // Drawing
  const draw = () => {
    const cvs = canvasRef
    if (!cvs) return
    const ctx = cvs.getContext('2d')
    if (!ctx) return

    const { width, height } = canvasSize()
    if (cvs.width !== width || cvs.height !== height) {
      cvs.width = width
      cvs.height = height
    }

    // BG
    ctx.fillStyle = '#0b0b0b'
    ctx.fillRect(0, 0, width, height)

    // Grid
    ctx.strokeStyle = '#262626'
    ctx.lineWidth = 1

    // Horizontal lines at gains
    for (let g = GAIN_MIN; g <= GAIN_MAX; g += 6) {
      const y = gainToY(g)
      ctx.beginPath()
      ctx.moveTo(6, y)
      ctx.lineTo(width - 6, y)
      ctx.stroke()

      // labels
      if (g % 12 === 0) {
        ctx.fillStyle = '#6b7280'
        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
        ctx.textAlign = 'left'
        ctx.fillText(`${g >= 0 ? '+' : ''}${g} dB`, 12, y - 2)
      }
    }

    // Vertical log freqs
    const marks = [20, 100, 200, 500, 1000, 2000, 5000, 10000]
    for (const f of marks) {
      const x = freqToX(f)
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()
      ctx.fillStyle = '#6b7280'
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.textAlign = 'center'
      ctx.fillText(f >= 1000 ? `${(f / 1000).toFixed(0)}k` : `${f}`, x, height - 4)
    }

    // Zero line
    ctx.strokeStyle = '#404040'
    ctx.lineWidth = 2
    const zy = gainToY(0)
    ctx.beginPath()
    ctx.moveTo(6, zy)
    ctx.lineTo(width - 6, zy)
    ctx.stroke()

    // Live spectrum (if available)
    const frame = props.spectrumData
    const spec = frame?.data
    if (spec && spec.length > 0) {
      const grad = ctx.createLinearGradient(6, 0, width - 6, 0)
      grad.addColorStop(0, '#22c55e')
      grad.addColorStop(1, '#ef4444')
      ctx.beginPath()
      ctx.moveTo(6, height)
      const L = 6, R = 6
      const nyquist = Math.max(1, (frame?.sampleRate ?? 44100) / 2)
      for (let x = L; x <= width - R; x += 2) {
        const inner = Math.max(1, width - (L + R))
        const t = (x - L) / inner
        const freq = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t)
        const bin = Math.min(spec.length - 1, Math.max(0, Math.floor((freq / nyquist) * spec.length)))
        let mag = spec[bin] || 0
        if (bin > 0 && bin < spec.length - 1) {
          mag = (spec[bin - 1] + spec[bin] + spec[bin + 1]) / 3
        }
        const scaled = Math.pow(mag, 0.7)
        const y = height - (scaled * height * 0.5)
        ctx.lineTo(x, y)
      }
      ctx.lineTo(width - R, height)
      ctx.closePath()
      ctx.globalAlpha = 0.3
      ctx.fillStyle = grad
      ctx.fill()
      ctx.globalAlpha = 0.6
      ctx.strokeStyle = grad
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // Response curve
    if (props.enabled) {
      ctx.strokeStyle = '#22c55e'
      ctx.lineWidth = 2.5
      ctx.beginPath()
      const L = 6, R = 6
      for (let x = L; x <= width - R; x += 2) {
        const inner = Math.max(1, width - (L + R))
        const t = (x - L) / inner
        const freq = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t)
        const y = gainToY(responseAt(freq))
        if (x === L) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }

    // Nodes
    for (const b of props.bands) {
      if (!b.enabled) continue
      const x = freqToX(b.frequency)
      const y = gainToY(supportsGain(b.type) ? b.gainDb : 0)
      const isSel = selectedId() === b.id
      ctx.beginPath()
      ctx.arc(x, y, isSel ? 4 : 3, 0, Math.PI * 2)
      ctx.fillStyle = isSel ? '#3b82f6' : '#e5e7eb'
      ctx.strokeStyle = isSel ? '#1d4ed8' : '#9ca3af'
      ctx.lineWidth = isSel ? 1.25 : 1
      ctx.fill(); ctx.stroke()
    }
  }

  // Redraw when relevant inputs change
  createEffect(() => {
    const bandSignature = props.bands.map(b => `${b.id}:${b.frequency}:${b.gainDb}:${b.q}:${b.enabled}:${b.type}`).join('|')
    const _enabled = props.enabled
    const _selected = selectedId()
    const _size = canvasSize()
    void bandSignature
    void _enabled
    void _selected
    void _size
    draw()
  })

  // Redraw when spectrum data updates
  createEffect(() => {
    void props.spectrumData
    draw()
  })

  // Interaction: drag nodes to set freq/gain
  const onCanvasMouseDown = (ev: MouseEvent) => {
    if (!props.enabled || !canvasRef) return
    const rect = canvasRef.getBoundingClientRect()
    const x = ev.clientX - rect.left
    const y = ev.clientY - rect.top

    // find nearest enabled band within 24px
    let closest: { id: string; d: number } | null = null
    for (const b of props.bands) {
      if (!b.enabled) continue
      const dx = x - freqToX(b.frequency)
      const yCenter = gainToY(supportsGain(b.type) ? b.gainDb : 0)
      const dy = y - yCenter
      const d = Math.hypot(dx, dy)
      if (d < 24 && (!closest || d < closest.d)) closest = { id: b.id, d }
    }
    if (!closest) return
    setSelectedId(closest.id)
    setDraggedId(closest.id)

    // Apply immediately
    const nf = Math.max(FREQ_MIN, Math.min(FREQ_MAX, xToFreq(x)))
    const band = props.bands.find(b => b.id === closest.id)
    if (band && supportsGain(band.type)) {
      const ng = Math.max(GAIN_MIN, Math.min(GAIN_MAX, yToGain(y)))
      props.onBandChange(closest.id, { gainDb: Math.round(ng * 10) / 10, frequency: Math.round(nf) })
    } else {
      props.onBandChange(closest.id, { frequency: Math.round(nf) })
    }
  }

  const onCanvasMouseMove = (ev: MouseEvent) => {
    const id = draggedId(); if (!id || !canvasRef) return
    const rect = canvasRef.getBoundingClientRect()
    const x = ev.clientX - rect.left
    const y = ev.clientY - rect.top
    const nf = Math.max(FREQ_MIN, Math.min(FREQ_MAX, xToFreq(x)))
    const band = props.bands.find(b => b.id === id)
    if (band && supportsGain(band.type)) {
      const ng = Math.max(GAIN_MIN, Math.min(GAIN_MAX, yToGain(y)))
      props.onBandChange(id, { gainDb: Math.round(ng * 10) / 10, frequency: Math.round(nf) })
    } else {
      props.onBandChange(id, { frequency: Math.round(nf) })
    }
  }

  const onCanvasMouseUp = () => setDraggedId(null)

  // UI helpers
  const selBand = () => props.bands.find(b => b.id === selectedId())

  return (
    <div class={`rounded-md border border-neutral-800 bg-neutral-900 text-neutral-100 flex flex-col ${props.class ?? ''}`}>
      {/* Header */}
      <div class="flex items-center justify-between px-2 py-1 border-b border-neutral-800">
        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold">EQ</span>
          <Show when={props.onToggleEnabled}>
            <button
              class={`ml-2 text-xs px-2 py-0.5 rounded ${props.enabled ? 'bg-green-500/20 text-green-400 ring-1 ring-green-500/30' : 'bg-neutral-800 text-neutral-400'}`}
              onClick={() => props.onToggleEnabled?.(!props.enabled)}
              title={props.enabled ? 'Disable EQ' : 'Enable EQ'}
            >
              {props.enabled ? 'On' : 'Off'}
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

      {/* Band selectors */}
      <div class="px-2 py-1">
        <div class="flex items-center gap-1">
          <For each={props.bands}>
            {(b, i) => (
              <button
                class={`w-4 h-4 rounded text-[9px] font-bold flex items-center justify-center transition-colors ${
                  selectedId() === b.id ? 'bg-blue-500 text-white' : (b.enabled ? 'bg-neutral-700 text-neutral-200 hover:bg-neutral-600' : 'bg-neutral-800 text-neutral-500')
                }`}
                onClick={() => setSelectedId(b.id)}
                title={`Band ${i() + 1}`}
              >{i() + 1}</button>
            )}
          </For>
          <Show when={props.onBandToggle && selBand()}>
            <button
              class={`ml-1 text-[8px] px-1 py-0.5 rounded ${selBand()?.enabled ? 'bg-neutral-300 text-black' : 'bg-neutral-800 text-neutral-300'}`}
              onClick={() => selBand() && props.onBandToggle?.(selBand()!.id)}
              title={selBand()?.enabled ? 'Disable band' : 'Enable band'}
            >{selBand()?.enabled ? 'On' : 'Off'}</button>
          </Show>
        </div>
      </div>

      {/* Controls + Graph (compact) */}
      <div class="px-2 pb-1">
        <div class="grid grid-cols-[44px_1fr] gap-1.5 items-start">
          {/* Left: vertical controls */}
          <div class="flex flex-col gap-1">
            {/* Frequency */}
            <div class="flex flex-col items-center gap-1">
              <div class="text-[8px] leading-none text-neutral-400">Freq</div>
              <Knob
                value={selBand()?.frequency ?? 1000}
                min={FREQ_MIN}
                max={FREQ_MAX}
                step={1}
                size={20}
                label=""
                unit="Hz"
                disabled={!props.enabled || !selBand()?.enabled}
                logarithmic={true}
                showValue={false}
                onValueChange={(v) => selBand() && props.onBandChange(selBand()!.id, { frequency: Math.round(v) })}
              />
              <div class="text-[8px] leading-none text-neutral-300 font-mono">
                {(() => { const f = selBand()?.frequency ?? 0; return f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : `${f} Hz` })()}
              </div>
            </div>

            {/* Gain */}
            <div class="flex flex-col items-center gap-1">
              <div class="text-[8px] leading-none text-neutral-400">Gain</div>
              <Knob
                value={selBand()?.gainDb ?? 0}
                min={GAIN_MIN}
                max={GAIN_MAX}
                step={0.1}
                size={20}
                label=""
                unit="dB"
                disabled={!props.enabled || !selBand()?.enabled || (selBand() ? !supportsGain(selBand()!.type) : false)}
                bipolar={true}
                showValue={false}
                onValueChange={(v) => selBand() && props.onBandChange(selBand()!.id, { gainDb: Math.round(v * 10) / 10 })}
              />
              <div class="text-[8px] text-neutral-300 font-mono">
                {(() => { const g = selBand()?.gainDb ?? 0; const disabled = selBand() ? !supportsGain(selBand()!.type) : false; return disabled ? '—' : `${g >= 0 ? '+' : ''}${g.toFixed(1)} dB` })()}
              </div>
            </div>

            {/* Q */}
            <div class="flex flex-col items-center gap-1">
              <div class="text-[8px] leading-none text-neutral-400">Q</div>
              <Knob
                value={selBand()?.q ?? 1}
                min={Q_MIN}
                max={Q_MAX}
                step={0.1}
                size={20}
                label=""
                disabled={!props.enabled || !selBand()?.enabled}
                showValue={false}
                onValueChange={(v) => selBand() && props.onBandChange(selBand()!.id, { q: Math.round(v * 10) / 10 })}
              />
              <div class="text-[8px] leading-none text-neutral-300 font-mono">{selBand()?.q?.toFixed(1) ?? '0.0'}</div>
            </div>
          </div>

          {/* Right: Graph */}
          <div ref={containerRef}>
            <canvas
              ref={(el) => (canvasRef = el || undefined)}
              width={canvasSize().width}
              height={canvasSize().height}
              class={`w-full rounded-md ${props.enabled ? 'cursor-crosshair' : 'cursor-not-allowed opacity-60'}`}
              onMouseDown={onCanvasMouseDown}
              onMouseMove={onCanvasMouseMove}
              onMouseUp={onCanvasMouseUp}
              onMouseLeave={onCanvasMouseUp}
            />
          </div>
        </div>
      </div>

      {/* Type selector for selected band */}
      <div class="px-2 pt-1 pb-2">
        <div class="flex items-center justify-center gap-1 flex-wrap">
          <For each={FILTER_TYPES}>
            {(ft) => (
              <button
                class={`px-1 py-0.5 text-[9px] rounded border ${
                  selBand()?.type === ft.value
                    ? 'bg-blue-500/20 text-blue-300 border-blue-400/30'
                    : 'bg-neutral-800 text-neutral-300 border-neutral-700 hover:bg-neutral-700'
                }`}
                disabled={!props.enabled || !selBand()?.enabled}
                onClick={() => selBand() && props.onBandChange(selBand()!.id, { type: ft.value })}
                title={ft.label}
              >
                {ft.short}
              </button>
            )}
          </For>
        </div>
      </div>

      {/* (Moved controls to the left of graph) */}
    </div>
  )
}
