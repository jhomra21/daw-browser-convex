import { For, createSignal, createMemo, onMount, onCleanup, createEffect } from 'solid-js'
import type { SpectrumFrame } from '@daw-browser/audio-engine/audio-engine'
import EffectShell from '~/components/effects/EffectShell'
import Knob from '~/components/ui/knob'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
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
const SPECTRUM_DECAY_GRACE_MS = 90
const SPECTRUM_DECAY_PER_SECOND = 0.04
const SPECTRUM_SILENCE_THRESHOLD = 0.003
const SPECTRUM_MIN_SMOOTHING_PX = 3
const SPECTRUM_MAX_SMOOTHING_PX = 18

const FILTER_TYPE_DEFINITIONS: { value: EqBandType; label: string; path: string }[] = [
  { value: 'lowpass', label: 'Low Pass', path: 'M2 4 H17 C22 4 22 12 30 12' },
  { value: 'highpass', label: 'High Pass', path: 'M2 12 C10 12 10 4 15 4 H30' },
  { value: 'bandpass', label: 'Band Pass', path: 'M2 12 C8 12 9 4 16 4 C23 4 24 12 30 12' },
  { value: 'notch', label: 'Notch', path: 'M2 4 H12 C14 4 14 12 16 12 C18 12 18 4 20 4 H30' },
  { value: 'lowshelf', label: 'Low Shelf', path: 'M2 10 H10 C15 10 15 5 20 5 H30' },
  { value: 'highshelf', label: 'High Shelf', path: 'M2 5 H12 C17 5 17 10 22 10 H30' },
  { value: 'peaking', label: 'Peaking', path: 'M2 10 C8 10 10 5 16 5 C22 5 24 10 30 10' },
  { value: 'allpass', label: 'All Pass', path: 'M2 8 H30' },
]

const filterDefinition = (type: EqBandType) =>
  FILTER_TYPE_DEFINITIONS.find((definition) => definition.value === type) ?? FILTER_TYPE_DEFINITIONS[6]

const formatFrequency = (frequency: number) =>
  frequency >= 1000 ? `${(frequency / 1000).toFixed(2)} kHz` : `${Math.round(frequency)} Hz`

const formatDb = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)} dB`

const formatQ = (value: number) => value.toFixed(2)

const hasAudibleSpectrum = (data: Float32Array) => {
  for (let i = 0; i < data.length; i++) {
    if (data[i] > SPECTRUM_SILENCE_THRESHOLD) return true
  }
  return false
}

const sampleSpectrumMagnitude = (data: Float32Array, frequency: number, nyquist: number) => {
  const binPosition = Math.min(data.length - 1, Math.max(0, (frequency / nyquist) * (data.length - 1)))
  const center = Math.floor(binPosition)
  let total = 0
  let weightTotal = 0

  for (let bin = center - 2; bin <= center + 2; bin++) {
    if (bin < 0 || bin >= data.length) continue
    const distance = Math.abs(bin - binPosition)
    const weight = Math.max(0, 1 - distance / 3)
    total += (data[bin] || 0) * weight
    weightTotal += weight
  }

  return weightTotal > 0 ? total / weightTotal : 0
}

const smoothSpectrumY = (values: Float32Array, index: number) => {
  const t = values.length <= 1 ? 1 : index / (values.length - 1)
  const radius = Math.round(SPECTRUM_MIN_SMOOTHING_PX + (1 - t) * (SPECTRUM_MAX_SMOOTHING_PX - SPECTRUM_MIN_SMOOTHING_PX))
  let total = 0
  let weightTotal = 0

  for (let offset = -radius; offset <= radius; offset++) {
    const nextIndex = index + offset
    if (nextIndex < 0 || nextIndex >= values.length) continue
    const weight = radius === 0 ? 1 : 1 - Math.abs(offset) / (radius + 1)
    total += values[nextIndex] * weight
    weightTotal += weight
  }

  return weightTotal > 0 ? total / weightTotal : values[index]
}

function applyEqResponseBandParams(filter: BiquadFilterNode, band: EqBandParams) {
  filter.type = band.type
  filter.frequency.value = Math.max(FREQ_MIN, Math.min(FREQ_MAX, band.frequency))
  filter.Q.value = Math.max(0.001, band.q)
  filter.gain.value = supportsGain(band.type) ? band.gainDb : 0
}

function EqFilterIcon(props: { type: EqBandType; active: boolean; class?: string }) {
  const stroke = () => props.active ? '#67e8f9' : '#737373'

  return (
    <svg viewBox="0 0 32 16" class={cn('h-4 w-8', props.class)} aria-hidden="true">
      <path d={filterDefinition(props.type).path} fill="none" stroke={stroke()} stroke-width="2" />
    </svg>
  )
}

function EqBandFilterMenu(props: {
  band: EqBandParams
  enabled: boolean
  selected: boolean
  onSelectBand: () => void
  onTypeChange: (type: EqBandType) => void
}) {
  const canEdit = () => props.enabled && props.band.enabled

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        class={cn(
          'flex h-4 w-full items-center justify-between border border-neutral-700 bg-neutral-800 px-1 text-neutral-300',
          props.selected && 'border-cyan-400 bg-cyan-500/15 text-cyan-200',
          !props.enabled && 'cursor-not-allowed opacity-60',
          props.enabled && !props.band.enabled && 'opacity-60',
        )}
        disabled={!props.enabled}
        onClick={props.onSelectBand}
        title={`${filterDefinition(props.band.type).label} filter`}
      >
        <EqFilterIcon type={props.band.type} active={props.band.enabled} class="h-2.5 w-6" />
        <svg viewBox="0 0 8 8" class="h-1.5 w-1.5 shrink-0 text-neutral-400" aria-hidden="true">
          <path d="M1 3 L4 6 L7 3 Z" fill="currentColor" />
        </svg>
      </DropdownMenuTrigger>
      <DropdownMenuContent class="w-max min-w-28 border-neutral-700 bg-neutral-900 p-1">
        <For each={FILTER_TYPE_DEFINITIONS}>
          {(definition) => (
            <DropdownMenuItem
              class={cn(
                'h-7 cursor-pointer gap-2 px-2 py-1 text-xs text-neutral-200 focus:bg-neutral-800 focus:text-neutral-50',
                definition.value === props.band.type && 'bg-cyan-500/20 text-cyan-100',
              )}
              disabled={!canEdit()}
              onSelect={() => {
                props.onSelectBand()
                props.onTypeChange(definition.value)
              }}
            >
              <EqFilterIcon type={definition.value} active={definition.value === props.band.type} />
              <span class="min-w-0 flex-1 truncate">{definition.label}</span>
            </DropdownMenuItem>
          )}
        </For>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default function Eq(props: EqProps) {
  const [selectedId, setSelectedId] = createSignal<string>(props.bands[0]?.id ?? '')
  const [draggedId, setDraggedId] = createSignal<string | null>(null)
  const [canvasSize, setCanvasSize] = createSignal({ width: 640, height: 160 })
  const [spectrumTick, setSpectrumTick] = createSignal(0)

  // canvas + container refs
  let canvasRef: HTMLCanvasElement | undefined
  let containerRef: HTMLDivElement | undefined
  let resizeObs: ResizeObserver | undefined
  let displayedSpectrum: Float32Array | undefined
  let spectrumYBuf: Float32Array | undefined
  let smoothedYBuf: Float32Array | undefined
  let responseFilter: BiquadFilterNode | undefined
  let responseFrequencies: Float32Array<ArrayBuffer> | undefined
  let responseMagnitudes: Float32Array<ArrayBuffer> | undefined
  let responsePhases: Float32Array<ArrayBuffer> | undefined
  let responseDb: Float32Array | undefined
  let displayedSpectrumSampleRate = 44100
  let lastFreshSpectrumAt = 0
  let lastSpectrumDecayAt = 0
  let spectrumDecayFrame: number | null = null

  onMount(() => {
    // Initialize size based on container (very compact)
    const update = () => {
      const el = containerRef
      if (!el) return
      const rect = el.getBoundingClientRect()
      const width = Math.floor(rect.width)
      const height = Math.max(120, Math.floor(rect.height))
      setCanvasSize((current) => current.width === width && current.height === height ? current : { width, height })
    }
    update()
    resizeObs = new ResizeObserver(() => update())
    containerRef && resizeObs.observe(containerRef)
    const responseContext = new OfflineAudioContext(1, 1, 44100)
    responseFilter = responseContext.createBiquadFilter()
  })

  onCleanup(() => {
    try { resizeObs?.disconnect() } catch {}
    if (spectrumDecayFrame !== null) cancelAnimationFrame(spectrumDecayFrame)
    responseFilter = undefined
  })

  const runSpectrumDecay = (time: number) => {
    spectrumDecayFrame = null
    const data = displayedSpectrum
    if (!data) return

    const elapsedSinceFresh = time - lastFreshSpectrumAt
    const elapsed = Math.max(0, time - lastSpectrumDecayAt) / 1000
    lastSpectrumDecayAt = time

    if (elapsedSinceFresh > SPECTRUM_DECAY_GRACE_MS) {
      const decay = Math.pow(SPECTRUM_DECAY_PER_SECOND, elapsed)
      for (let index = 0; index < data.length; index++) data[index] *= decay
      setSpectrumTick((tick) => tick + 1)
    }

    if (hasAudibleSpectrum(data)) spectrumDecayFrame = requestAnimationFrame(runSpectrumDecay)
  }

  const startSpectrumDecay = () => {
    if (spectrumDecayFrame !== null) return
    // The analyser stops producing fresh frames when transport pauses; this visual-only RAF lets the displayed spectrum decay to silence instead of freezing.
    lastSpectrumDecayAt = performance.now()
    spectrumDecayFrame = requestAnimationFrame(runSpectrumDecay)
  }

  createEffect(() => {
    const frame = props.spectrumData
    const data = frame?.data
    if (!data || data.length === 0) {
      startSpectrumDecay()
      return
    }

    if (!displayedSpectrum || displayedSpectrum.length !== data.length) {
      displayedSpectrum = new Float32Array(data.length)
    }
    displayedSpectrum.set(data)
    displayedSpectrumSampleRate = frame.sampleRate
    lastFreshSpectrumAt = performance.now()
    startSpectrumDecay()
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
    const top = 18, bottom = 18
    const h = Math.max(1, height - (top + bottom))
    const t = (GAIN_MAX - Math.max(GAIN_MIN, Math.min(GAIN_MAX, g))) / (GAIN_MAX - GAIN_MIN)
    return top + t * h
  }
  const yToGain = (y: number) => {
    const { height } = canvasSize()
    const top = 18, bottom = 18
    const h = Math.max(1, height - (top + bottom))
    const clamped = Math.min(Math.max(y, top), height - bottom)
    const t = (clamped - top) / h
    return GAIN_MAX - t * (GAIN_MAX - GAIN_MIN)
  }

  const ensureResponseBuffers = (length: number) => {
    if (!responseFrequencies || responseFrequencies.length !== length) responseFrequencies = new Float32Array(length)
    if (!responseMagnitudes || responseMagnitudes.length !== length) responseMagnitudes = new Float32Array(length)
    if (!responsePhases || responsePhases.length !== length) responsePhases = new Float32Array(length)
    if (!responseDb || responseDb.length !== length) responseDb = new Float32Array(length)
    return {
      frequencies: responseFrequencies,
      magnitudes: responseMagnitudes,
      phases: responsePhases,
      dbValues: responseDb,
    }
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
    const spec = displayedSpectrum
    if (spec && spec.length > 0) {
      const grad = ctx.createLinearGradient(6, 0, width - 6, 0)
      grad.addColorStop(0, '#22c55e')
      grad.addColorStop(1, '#ef4444')
      const L = 6, R = 6
      const inner = Math.max(1, width - (L + R))
      const nyquist = Math.max(1, displayedSpectrumSampleRate / 2)
      const sampleCount = Math.max(1, width - R - L + 1)
      if (!spectrumYBuf || spectrumYBuf.length !== sampleCount) spectrumYBuf = new Float32Array(sampleCount)
      if (!smoothedYBuf || smoothedYBuf.length !== sampleCount) smoothedYBuf = new Float32Array(sampleCount)
      const spectrumY = spectrumYBuf
      const smoothedSpectrumY = smoothedYBuf
      for (let index = 0; index < sampleCount; index++) {
        const x = L + index
        const t = (x - L) / inner
        const freq = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t)
        const mag = sampleSpectrumMagnitude(spec, freq, nyquist)
        const scaled = Math.pow(mag, 0.7)
        spectrumY[index] = height - (scaled * height * 0.5)
      }
      for (let index = 0; index < sampleCount; index++) {
        smoothedSpectrumY[index] = smoothSpectrumY(spectrumY, index)
      }
      let previousX = L
      let previousY = height
      for (let index = 0; index < sampleCount; index++) {
        const x = L + index
        const y = smoothedSpectrumY[index]
        if (x === L) {
          ctx.beginPath()
          ctx.moveTo(L, height)
          ctx.lineTo(x, y)
        } else {
          ctx.quadraticCurveTo(previousX, previousY, (previousX + x) / 2, (previousY + y) / 2)
        }
        previousX = x
        previousY = y
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
      const L = 6, R = 6
      const inner = Math.max(1, width - (L + R))
      let pointCount = 0
      for (let x = L; x <= width - R; x += 2) pointCount++
      const { frequencies, magnitudes, phases, dbValues } = ensureResponseBuffers(pointCount)
      const filter = responseFilter
      if (filter) {
        let pointIndex = 0
        for (let x = L; x <= width - R; x += 2) {
          const t = (x - L) / inner
          frequencies[pointIndex] = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t)
          dbValues[pointIndex] = 0
          pointIndex++
        }
        for (const band of props.bands) {
          if (!band.enabled) continue
          applyEqResponseBandParams(filter, band)
          filter.getFrequencyResponse(frequencies, magnitudes, phases)
          for (let index = 0; index < pointCount; index++) {
            dbValues[index] += 20 * Math.log10(Math.max(0.000001, magnitudes[index] ?? 1))
          }
        }

        ctx.strokeStyle = '#22c55e'
        ctx.lineWidth = 2.5
        ctx.beginPath()
        pointIndex = 0
        for (let x = L; x <= width - R; x += 2) {
          const y = gainToY(dbValues[pointIndex] ?? 0)
          if (x === L) ctx.moveTo(x, y); else ctx.lineTo(x, y)
          pointIndex++
        }
        ctx.stroke()
      }
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
    void spectrumTick()
    draw()
  })

  createEffect(() => {
    const current = selectedId()
    if (props.bands.some((band) => band.id === current)) return
    const next = props.bands[0]?.id ?? ''
    if (current !== next) setSelectedId(next)
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
    if (!band) return
    if (supportsGain(band.type)) {
      const ng = Math.max(GAIN_MIN, Math.min(GAIN_MAX, yToGain(y)))
      const gainDb = Math.round(ng * 10) / 10
      const frequency = Math.round(nf)
      if (band.gainDb !== gainDb || band.frequency !== frequency) {
        props.onBandChange(id, { gainDb, frequency })
      }
    } else {
      const frequency = Math.round(nf)
      if (band.frequency !== frequency) props.onBandChange(id, { frequency })
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
    <EffectShell
      title="EQ Eight"
      typeLabel="Stereo"
      enabled={props.enabled}
      onToggleEnabled={props.onToggleEnabled}
      onReset={props.onReset}
      class={cn('w-[704px] min-w-[704px]', props.class)}
    >
      <div
        class="grid min-h-0 flex-1 overflow-hidden"
        style={{
          'grid-template-columns': '72px minmax(220px, 1fr) 72px',
          'grid-template-rows': 'minmax(0, 1fr) 52px',
        }}
      >
        <div class="row-span-2 flex flex-col border-r border-neutral-800 bg-neutral-950/30">
          <Knob
            class="border-b border-neutral-800 px-1 py-2"
            label="Freq"
            valueLabel={selectedFrequencyLabel()}
            value={selectedBand()?.frequency ?? 1000}
            min={FREQ_MIN}
            max={FREQ_MAX}
            step={1}
            unit="Hz"
            disabled={!props.enabled || !selectedBand()?.enabled}
            logarithmic={true}
            onValueChange={(v) => {
              const band = selectedBand()
              if (!band) return
              props.onBandChange(band.id, { frequency: v })
            }}
          />

          <Knob
            class="border-b border-neutral-800 px-1 py-2"
            label="Gain"
            valueLabel={selectedGainLabel()}
            value={selectedBand()?.gainDb ?? 0}
            min={GAIN_MIN}
            max={GAIN_MAX}
            step={0.1}
            unit="dB"
            disabled={!props.enabled || !selectedBand()?.enabled || !supportsGain(selectedBand()?.type ?? 'peaking')}
            bipolar={true}
            onValueChange={(v) => {
              const band = selectedBand()
              if (!band) return
              props.onBandChange(band.id, { gainDb: v })
            }}
          />

          <Knob
            class="px-1 py-2"
            label="Q"
            valueLabel={selectedQLabel()}
            value={selectedBand()?.q ?? 1}
            min={Q_MIN}
            max={Q_MAX}
            step={0.1}
            disabled={!props.enabled || !selectedBand()?.enabled}
            onValueChange={(v) => {
              const band = selectedBand()
              if (!band) return
              props.onBandChange(band.id, { q: v })
            }}
          />
        </div>

        <div ref={containerRef} class="relative min-w-0 overflow-hidden bg-neutral-950">
          <canvas
            ref={(el) => (canvasRef = el || undefined)}
            width={canvasSize().width}
            height={canvasSize().height}
            class={cn('absolute inset-0 block h-full w-full', props.enabled ? 'cursor-crosshair' : 'cursor-not-allowed opacity-60')}
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onCanvasPointerMove}
            onPointerUp={onCanvasPointerUp}
            onPointerCancel={onCanvasPointerUp}
          />
        </div>

        <div class="row-span-2 flex flex-col border-l border-neutral-800 bg-neutral-950/40 px-1 py-2 text-[10px]">
          <div class="mb-1 text-neutral-500">Mode</div>
          <div class="mb-3 border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-neutral-300">Stereo</div>
          <div class="mb-1 text-neutral-500">Edit</div>
          <div class="mb-3 border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-neutral-300">A</div>
        </div>

        <div class="relative z-10 flex min-w-0 border-t border-neutral-800 bg-neutral-950">
          <For each={props.bands}>
            {(band, index) => (
              <div class="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 border-r border-neutral-800 p-1 last:border-r-0">
                <EqBandFilterMenu
                  band={band}
                  enabled={props.enabled}
                  selected={selectedId() === band.id}
                  onSelectBand={() => setSelectedId(band.id)}
                  onTypeChange={(type) => props.onBandChange(band.id, { type })}
                />

                <div class="flex h-5 items-center justify-center gap-2">
                  <button
                    class={cn(
                      'h-3.5 w-3.5 border border-neutral-600',
                      band.enabled ? 'bg-cyan-400' : 'bg-neutral-900',
                    )}
                    disabled={!props.enabled || !props.onBandToggle}
                    onClick={() => props.onBandToggle?.(band.id)}
                    title={band.enabled ? 'Disable band' : 'Enable band'}
                  />
                  <span
                    class={cn(
                      'w-3 text-center text-[11px] font-semibold leading-none',
                      selectedId() === band.id ? 'text-amber-300' : 'text-neutral-300',
                      !band.enabled && 'text-neutral-500',
                    )}
                  >
                    {index() + 1}
                  </span>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </EffectShell>
  )
}
