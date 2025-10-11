// Lightweight waveform peaks computation with caching
// Default export returns interleaved [min, max] mono peaks in [-1, 1] for a given number of bins.

// Mono cache: AudioBuffer -> bins -> Float32Array([min,max] interleaved)
const monoCache: WeakMap<AudioBuffer, Map<number, Float32Array>> = new WeakMap()

// Per-channel cache entries
type PerChannelEntry = {
  mins: Float32Array[]
  maxs: Float32Array[]
}
// AudioBuffer -> bins -> per-channel peaks
const perChannelCache: WeakMap<AudioBuffer, Map<number, PerChannelEntry>> = new WeakMap()

// Optional extremum position cache (per bin, indices into buffer sample space)
type WithPosEntry = {
  data: Float32Array // interleaved mono [min,max]
  minPos: Uint32Array // per-bin index of min (first occurrence) in buffer sample index
  maxPos: Uint32Array // per-bin index of max (first occurrence) in buffer sample index
}
const monoWithPosCache: WeakMap<AudioBuffer, Map<number, WithPosEntry>> = new WeakMap()

export function computePeaks(buffer: AudioBuffer, bins: number): Float32Array {
  const b = Math.max(1, Math.floor(bins))

  let byRes = monoCache.get(buffer)
  if (!byRes) {
    byRes = new Map<number, Float32Array>()
    monoCache.set(buffer, byRes)
  }
  const cached = byRes.get(b)
  if (cached) return cached

  const channels = buffer.numberOfChannels
  const length = buffer.length
  const samplesPerBin = length / b

  const data: Float32Array[] = []
  for (let ch = 0; ch < channels; ch++) data.push(buffer.getChannelData(ch))

  const peaks = new Float32Array(b * 2)
  for (let i = 0; i < b; i++) {
    const start = Math.floor(i * samplesPerBin)
    const end = Math.min(length, Math.floor((i + 1) * samplesPerBin))
    if (end <= start) { peaks[i * 2] = 0; peaks[i * 2 + 1] = 0; continue }
    let min = Infinity, max = -Infinity
    for (let ch = 0; ch < channels; ch++) {
      const arr = data[ch]
      for (let s = start; s < end; s++) {
        const v = arr[s]
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    if (min === Infinity) min = 0
    if (max === -Infinity) max = 0
    peaks[i * 2] = min
    peaks[i * 2 + 1] = max
  }
  byRes.set(b, peaks)
  return peaks
}

// Per-channel peaks: returns { mins[], maxs[] } arrays of Float32Array sized [bins]
export function computePeaksPerChannel(buffer: AudioBuffer, bins: number): PerChannelEntry {
  const b = Math.max(1, Math.floor(bins))
  let byRes = perChannelCache.get(buffer)
  if (!byRes) { byRes = new Map(); perChannelCache.set(buffer, byRes) }
  const cached = byRes.get(b)
  if (cached) return cached

  const channels = Math.max(1, buffer.numberOfChannels)
  const length = buffer.length
  const samplesPerBin = length / b
  const mins: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(b))
  const maxs: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(b))
  const data: Float32Array[] = []
  for (let ch = 0; ch < channels; ch++) data.push(buffer.getChannelData(ch))

  for (let i = 0; i < b; i++) {
    const start = Math.floor(i * samplesPerBin)
    const end = Math.min(length, Math.floor((i + 1) * samplesPerBin))
    for (let ch = 0; ch < channels; ch++) {
      if (end <= start) { mins[ch][i] = 0; maxs[ch][i] = 0; continue }
      let min = Infinity, max = -Infinity
      const arr = data[ch]
      for (let s = start; s < end; s++) {
        const v = arr[s]
        if (v < min) min = v
        if (v > max) max = v
      }
      if (min === Infinity) min = 0
      if (max === -Infinity) max = 0
      mins[ch][i] = min
      maxs[ch][i] = max
    }
  }

  const entry: PerChannelEntry = { mins, maxs }
  byRes.set(b, entry)
  return entry
}

// Mono peaks with extremum positions (indices into buffer sample space per bin)
export function computePeaksWithPositions(buffer: AudioBuffer, bins: number): WithPosEntry {
  const b = Math.max(1, Math.floor(bins))
  let byRes = monoWithPosCache.get(buffer)
  if (!byRes) { byRes = new Map(); monoWithPosCache.set(buffer, byRes) }
  const cached = byRes.get(b)
  if (cached) return cached

  const channels = buffer.numberOfChannels
  const length = buffer.length
  const samplesPerBin = length / b
  const data: Float32Array[] = []
  for (let ch = 0; ch < channels; ch++) data.push(buffer.getChannelData(ch))

  const peaks = new Float32Array(b * 2)
  const minPos = new Uint32Array(b)
  const maxPos = new Uint32Array(b)

  for (let i = 0; i < b; i++) {
    const start = Math.floor(i * samplesPerBin)
    const end = Math.min(length, Math.floor((i + 1) * samplesPerBin))
    if (end <= start) { peaks[i * 2] = 0; peaks[i * 2 + 1] = 0; minPos[i] = start; maxPos[i] = start; continue }
    let min = Infinity, max = -Infinity
    let minIdx = start, maxIdx = start
    for (let ch = 0; ch < channels; ch++) {
      const arr = data[ch]
      for (let s = start; s < end; s++) {
        const v = arr[s]
        if (v < min) { min = v; minIdx = s }
        if (v > max) { max = v; maxIdx = s }
      }
    }
    if (min === Infinity) { min = 0; minIdx = start }
    if (max === -Infinity) { max = 0; maxIdx = start }
    peaks[i * 2] = min
    peaks[i * 2 + 1] = max
    minPos[i] = minIdx >>> 0
    maxPos[i] = maxIdx >>> 0
  }

  const entry: WithPosEntry = { data: peaks, minPos, maxPos }
  byRes.set(b, entry)
  return entry
}

// Simple multi-resolution pyramid builder (1x, 1/2x, 1/4x ...)
export function buildPeaksPyramid(buffer: AudioBuffer, baseBins: number, levels = 3) {
  const bins = Math.max(1, Math.floor(baseBins))
  const out: { bins: number; data: Float32Array }[] = []
  let b = bins
  for (let i = 0; i < Math.max(1, levels); i++) {
    out.push({ bins: b, data: computePeaks(buffer, b) })
    if (b <= 1) break
    b = Math.max(1, Math.floor(b / 2))
  }
  return out
}

export function clearPeaksCacheFor(buffer: AudioBuffer) {
  monoCache.delete(buffer)
  perChannelCache.delete(buffer)
  monoWithPosCache.delete(buffer)
}

// Sprite cache: pre-rendered waveform images per buffer and resolution
const spriteCache: WeakMap<AudioBuffer, Map<string, HTMLCanvasElement>> = new WeakMap()

export function getWaveformSprite(buffer: AudioBuffer, bins: number, height: number): HTMLCanvasElement | null {
  // Avoid SSR usage
  if (typeof document === 'undefined') return null
  const b = Math.max(1, Math.floor(bins))
  const h = Math.max(1, Math.floor(height))
  let byRes = spriteCache.get(buffer)
  if (!byRes) { byRes = new Map(); spriteCache.set(buffer, byRes) }
  const key = `${b}x${h}`
  const cached = byRes.get(key)
  if (cached) return cached

  // Compute peaks once (cached by computePeaks)
  const peaks = computePeaks(buffer, b)
  // Auto-gain normalize like ClipComponent
  let peak = 0
  for (let i = 0; i < b; i++) {
    const min = peaks[i * 2]
    const max = peaks[i * 2 + 1]
    const a = Math.max(Math.abs(min), Math.abs(max))
    if (a > peak) peak = a
  }
  const amp = h / 2
  const gain = Math.min(0.98 / (peak || 1), 4.0)

  const canvas = document.createElement('canvas')
  canvas.width = b
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.clearRect(0, 0, b, h)

  // Fill bars mirrored around midline in white
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  const midY = h / 2
  for (let i = 0; i < b; i++) {
    const min = peaks[i * 2]
    const max = peaks[i * 2 + 1]
    const a = Math.max(Math.abs(min), Math.abs(max))
    const hh = Math.min(a * amp * gain, h / 2)
    if (hh <= 0.5) continue
    // top half
    ctx.fillRect(i, Math.floor(midY - hh), 1, Math.ceil(hh))
    // bottom half
    ctx.fillRect(i, Math.floor(midY), 1, Math.ceil(hh))
  }

  // Optional outlines for visual clarity
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'
  ctx.lineWidth = 1
  // top outline
  ctx.beginPath()
  for (let i = 0; i < b; i++) {
    const min = peaks[i * 2]
    const max = peaks[i * 2 + 1]
    const a = Math.max(Math.abs(min), Math.abs(max))
    const yTop = midY - Math.min(a * amp * gain, h / 2)
    const x = i + 0.5
    if (i === 0) ctx.moveTo(x, yTop)
    else ctx.lineTo(x, yTop)
  }
  ctx.stroke()
  // bottom outline
  ctx.beginPath()
  for (let i = 0; i < b; i++) {
    const min = peaks[i * 2]
    const max = peaks[i * 2 + 1]
    const a = Math.max(Math.abs(min), Math.abs(max))
    const yBottom = midY + Math.min(a * amp * gain, h / 2)
    const x = i + 0.5
    if (i === 0) ctx.moveTo(x, yBottom)
    else ctx.lineTo(x, yBottom)
  }
  ctx.stroke()

  // Midline
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, Math.floor(midY) + 0.5)
  ctx.lineTo(b, Math.floor(midY) + 0.5)
  ctx.stroke()

  byRes.set(key, canvas)
  return canvas
}
