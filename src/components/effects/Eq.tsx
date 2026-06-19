import { Show, For, createSignal, createMemo, onMount, onCleanup, createEffect, type JSX } from 'solid-js'
import type { SpectrumFrame } from '@daw-browser/audio-engine/audio-engine'
import Knob from '~/components/ui/knob'
import {
  supportsGain,
  type EqBandParams,
  type EqBandType,
} from '@daw-browser/shared'
import { cn } from '~/lib/utils'


// ===== Component =====
type EqProps = {
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

const FILTER_TYPE_DEFINITIONS: { value: EqBandType; label: string; path: string; cycles: boolean }[] = [
  { value: 'lowpass', label: 'Low Pass', path: 'M2 4 H17 C22 4 22 12 30 12', cycles: true },
  { value: 'highpass', label: 'High Pass', path: 'M2 12 C10 12 10 4 15 4 H30', cycles: true },
  { value: 'bandpass', label: 'Band Pass', path: 'M2 12 C8 12 9 4 16 4 C23 4 24 12 30 12', cycles: true },
  { value: 'notch', label: 'Notch', path: 'M2 4 H12 C14 4 14 12 16 12 C18 12 18 4 20 4 H30', cycles: true },
  { value: 'lowshelf', label: 'Low Shelf', path: 'M2 10 H10 C15 10 15 5 20 5 H30', cycles: true },
  { value: 'highshelf', label: 'High Shelf', path: 'M2 5 H12 C17 5 17 10 22 10 H30', cycles: true },
  { value: 'peaking', label: 'Peaking', path: 'M2 10 C8 10 10 5 16 5 C22 5 24 10 30 10', cycles: true },
  { value: 'allpass', label: 'All Pass', path: 'M2 8 H30', cycles: false },
]

const filterDefinition = (type: EqBandType) =>
  FILTER_TYPE_DEFINITIONS.find((definition) => definition.value === type) ?? FILTER_TYPE_DEFINITIONS[6]

const CYCLE_FILTER_TYPES = FILTER_TYPE_DEFINITIONS.filter((definition) => definition.cycles).map((definition) => definition.value)

const nextFilterType = (type: EqBandType): EqBandType => {
  const index = CYCLE_FILTER_TYPES.indexOf(type)
  return CYCLE_FILTER_TYPES[(index + 1) % CYCLE_FILTER_TYPES.length] ?? 'peaking'
}

const formatFrequency = (frequency: number) =>
  frequency >= 1000 ? `${(frequency / 1000).toFixed(2)} kHz` : `${Math.round(frequency)} Hz`

const formatDb = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)} dB`

const formatQ = (value: number) => value.toFixed(2)

function AbletonKnobControl(props: {
  label: string
  valueLabel: string
  children: JSX.Element
}) {
  return (
    <div class="flex flex-col items-center gap-1 border-b border-neutral-800 px-1 py-2 last:border-b-0">
      <div class="text-[10px] leading-none text-neutral-400">{props.label}</div>
      {props.children}
      <div class="max-w-full truncate font-mono text-[10px] leading-none text-cyan-300">
        {props.valueLabel}
      </div>
    </div>
  )
}

function EqFilterIcon(props: { type: EqBandType; active: boolean }) {
  const stroke = () => props.active ? '#67e8f9' : '#737373'

  return (
    <svg viewBox="0 0 32 16" class="h-4 w-8" aria-hidden="true">
      <path d={filterDefinition(props.type).path} fill="none" stroke={stroke()} stroke-width="2" />
    </svg>
  )
}

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
      setCanvasSize((current) => current.width === width && current.height === height ? current : { width, height })
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
      const inner = Math.max(1, width - (L + R))
      const nyquist = Math.max(1, (frame?.sampleRate ?? 44100) / 2)
      for (let x = L; x <= width - R; x += 2) {
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
      const inner = Math.max(1, width - (L + R))
      for (let x = L; x <= width - R; x += 2) {
        const t = (x - L) / inner
        const freq = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t)
        const y = gainToY(responseAt(freq))
        if (x === L) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }

    // Nodes
    ctx.font = 'bold 9px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let index = 0; index < props.bands.length; index++) {
      const b = props.bands[index]
      if (!b.enabled) continue
      const x = freqToX(b.frequency)
      const y = gainToY(supportsGain(b.type) ? b.gainDb : 0)
      const isSel = selectedId() === b.id
      ctx.beginPath()
      ctx.arc(x, y, isSel ? 8 : 7, 0, Math.PI * 2)
      ctx.fillStyle = isSel ? '#facc15' : '#d97706'
      ctx.strokeStyle = '#0a0a0a'
      ctx.lineWidth = 2
      ctx.fill()
      ctx.stroke()

      ctx.fillStyle = '#111827'
      ctx.fillText(String(index + 1), x, y + 0.5)
    }
  }

  // Redraw when relevant inputs change
  createEffect(() => {
    for (const band of props.bands) {
      void band.id
      void band.frequency
      void band.gainDb
      void band.q
      void band.enabled
      void band.type
    }
    void props.enabled
    void selectedId()
    void canvasSize()
    void props.spectrumData
    draw()
  })

  // Interaction: drag nodes to set freq/gain
  const onCanvasPointerDown = (ev: PointerEvent) => {
    if (!props.enabled || !canvasRef) return
    if (ev.currentTarget instanceof HTMLCanvasElement) {
      ev.currentTarget.setPointerCapture(ev.pointerId)
    }
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

    applyBandPointerValue(closest.id, x, y)
  }

  const onCanvasPointerMove = (ev: PointerEvent) => {
    const id = draggedId(); if (!id || !canvasRef) return
    const rect = canvasRef.getBoundingClientRect()
    const x = ev.clientX - rect.left
    const y = ev.clientY - rect.top
    applyBandPointerValue(id, x, y)
  }

  const applyBandPointerValue = (id: string, x: number, y: number) => {
    const nf = Math.max(FREQ_MIN, Math.min(FREQ_MAX, xToFreq(x)))
    const band = props.bands.find(b => b.id === id)
    if (band && supportsGain(band.type)) {
      const ng = Math.max(GAIN_MIN, Math.min(GAIN_MAX, yToGain(y)))
      const gainDb = Math.round(ng * 10) / 10
      const frequency = Math.round(nf)
      if (band.gainDb !== gainDb || band.frequency !== frequency) {
        props.onBandChange(id, { gainDb, frequency })
      }
    } else {
      const frequency = Math.round(nf)
      if (band?.frequency !== frequency) props.onBandChange(id, { frequency })
    }
  }

  const onCanvasPointerUp = () => setDraggedId(null)

  // UI helpers
  const selectedBand = createMemo(() => props.bands.find(b => b.id === selectedId()))

  const selectedFrequencyLabel = () => formatFrequency(selectedBand()?.frequency ?? 0)

  const selectedGainLabel = () => {
    const band = selectedBand()
    const gain = band?.gainDb ?? 0
    const gainDisabled = band ? !supportsGain(band.type) : false
    return gainDisabled ? '-' : formatDb(gain)
  }

  const selectedQLabel = () => formatQ(selectedBand()?.q ?? 0)

  return (
    <div class={cn('flex flex-col border border-neutral-800 bg-neutral-900 text-neutral-100', props.class)}>
      <div class="flex items-center justify-between border-b border-neutral-800 px-2 py-1">
        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold">EQ Eight</span>
          <span class="text-[10px] text-neutral-500">Stereo</span>
        </div>
        <Show when={props.onToggleEnabled}>
          <button
            class={cn(
              'px-2 py-0.5 text-xs',
              props.enabled ? 'bg-cyan-500/20 text-cyan-300 ring-1 ring-cyan-500/30' : 'bg-neutral-800 text-neutral-400',
            )}
            onClick={() => props.onToggleEnabled?.(!props.enabled)}
            title={props.enabled ? 'Disable EQ' : 'Enable EQ'}
          >
            {props.enabled ? 'On' : 'Off'}
          </button>
        </Show>
      </div>

      <div class="grid min-h-0 flex-1" style={{ 'grid-template-columns': '72px minmax(220px, 1fr) 72px' }}>
        <div class="flex flex-col border-r border-neutral-800 bg-neutral-950/30">
          <AbletonKnobControl label="Freq" valueLabel={selectedFrequencyLabel()}>
            <Knob
              value={selectedBand()?.frequency ?? 1000}
              min={FREQ_MIN}
              max={FREQ_MAX}
              step={1}
              size={28}
              label=""
              unit="Hz"
              disabled={!props.enabled || !selectedBand()?.enabled}
              logarithmic={true}
              showValue={false}
              onValueChange={(v) => {
                const band = selectedBand()
                if (!band) return
                props.onBandChange(band.id, { frequency: Math.round(v) })
              }}
            />
          </AbletonKnobControl>

          <AbletonKnobControl label="Gain" valueLabel={selectedGainLabel()}>
            <Knob
              value={selectedBand()?.gainDb ?? 0}
              min={GAIN_MIN}
              max={GAIN_MAX}
              step={0.1}
              size={28}
              label=""
              unit="dB"
              disabled={!props.enabled || !selectedBand()?.enabled || !supportsGain(selectedBand()?.type ?? 'peaking')}
              bipolar={true}
              showValue={false}
              onValueChange={(v) => {
                const band = selectedBand()
                if (!band) return
                props.onBandChange(band.id, { gainDb: Math.round(v * 10) / 10 })
              }}
            />
          </AbletonKnobControl>

          <AbletonKnobControl label="Q" valueLabel={selectedQLabel()}>
            <Knob
              value={selectedBand()?.q ?? 1}
              min={Q_MIN}
              max={Q_MAX}
              step={0.1}
              size={28}
              label=""
              disabled={!props.enabled || !selectedBand()?.enabled}
              showValue={false}
              onValueChange={(v) => {
                const band = selectedBand()
                if (!band) return
                props.onBandChange(band.id, { q: Math.round(v * 10) / 10 })
              }}
            />
          </AbletonKnobControl>
        </div>

        <div ref={containerRef} class="min-w-0 bg-neutral-950">
          <canvas
            ref={(el) => (canvasRef = el || undefined)}
            width={canvasSize().width}
            height={canvasSize().height}
            class={cn('block w-full', props.enabled ? 'cursor-crosshair' : 'cursor-not-allowed opacity-60')}
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onCanvasPointerMove}
            onPointerUp={onCanvasPointerUp}
            onPointerCancel={onCanvasPointerUp}
          />
        </div>

        <div class="flex flex-col border-l border-neutral-800 bg-neutral-950/40 px-1 py-2 text-[10px]">
          <div class="mb-1 text-neutral-500">Mode</div>
          <div class="mb-3 border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-neutral-300">Stereo</div>
          <div class="mb-1 text-neutral-500">Edit</div>
          <div class="mb-3 border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-neutral-300">A</div>
          <Show when={props.onReset}>
            <button
              class="mt-auto border border-neutral-700 bg-neutral-800 px-1 py-1 text-neutral-300 hover:bg-neutral-700"
              onClick={() => props.onReset?.()}
            >
              Reset
            </button>
          </Show>
        </div>
      </div>

      <div class="flex border-t border-neutral-800 bg-neutral-950/50">
        <For each={props.bands}>
          {(band, index) => (
            <div class="flex min-w-12 flex-1 items-center gap-1 border-r border-neutral-800 px-1 py-1 last:border-r-0">
              <button
                class={cn(
                  'flex h-7 min-w-0 flex-1 items-center justify-center border border-neutral-700 bg-neutral-800 text-neutral-300',
                  selectedId() === band.id && 'border-cyan-400 bg-cyan-500/15 text-cyan-200',
                )}
                disabled={!props.enabled}
                onClick={() => setSelectedId(band.id)}
                title={`Select band ${index() + 1}`}
              >
                <EqFilterIcon type={band.type} active={band.enabled} />
              </button>

              <button
                class={cn(
                  'h-3 w-3 border border-neutral-600',
                  band.enabled ? 'bg-cyan-400' : 'bg-neutral-900',
                )}
                disabled={!props.enabled || !props.onBandToggle}
                onClick={() => props.onBandToggle?.(band.id)}
                title={band.enabled ? 'Disable band' : 'Enable band'}
              />

              <button
                class={cn(
                  'flex h-5 w-5 items-center justify-center border text-[10px] font-semibold',
                  selectedId() === band.id
                    ? 'border-amber-400 bg-amber-400 text-black'
                    : 'border-neutral-600 bg-neutral-900 text-neutral-300',
                )}
                disabled={!props.enabled || !band.enabled}
                onClick={() => props.onBandChange(band.id, { type: nextFilterType(band.type) })}
                title={`${filterDefinition(band.type).label}: click to cycle filter type`}
              >
                {index() + 1}
              </button>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
