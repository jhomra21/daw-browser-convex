// Lightweight waveform peaks computation with caching
// Returns interleaved [min, max] pairs in the range [-1, 1] for a given number of bins.

const bufferCache: WeakMap<AudioBuffer, Map<number, Float32Array>> = new WeakMap()

export function computePeaks(buffer: AudioBuffer, bins: number): Float32Array {
  const b = Math.max(1, Math.floor(bins))

  let byRes = bufferCache.get(buffer)
  if (!byRes) {
    byRes = new Map<number, Float32Array>()
    bufferCache.set(buffer, byRes)
  }

  const cached = byRes.get(b)
  if (cached) return cached

  const channels = buffer.numberOfChannels
  const length = buffer.length
  const samplesPerBin = length / b

  // Preload channel data arrays once
  const data: Float32Array[] = []
  for (let ch = 0; ch < channels; ch++) data.push(buffer.getChannelData(ch))

  const peaks = new Float32Array(b * 2)

  for (let i = 0; i < b; i++) {
    const start = Math.floor(i * samplesPerBin)
    const end = Math.min(length, Math.floor((i + 1) * samplesPerBin))
    if (end <= start) {
      peaks[i * 2] = 0
      peaks[i * 2 + 1] = 0
      continue
    }

    let min = Infinity
    let max = -Infinity

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

export function clearPeaksCacheFor(buffer: AudioBuffer) {
  bufferCache.delete(buffer)
}
