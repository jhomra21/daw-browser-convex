import type { SpectrumFrame } from '@daw-browser/audio-engine/audio-engine'

export const SPECTRUM_MIN_HZ = 20
export const SPECTRUM_MAX_HZ = 20000
const HISTORY_COLUMNS = 320
const HISTORY_ROWS = 128

// Frame levels are already normalised to 0..1 across the analyser's dB range; this resamples
// them onto `count` log-spaced bands between 20 Hz and 20 kHz, taking the peak when a band
// spans several bins and interpolating when it falls between two.
export const logBandLevels = (frame: SpectrumFrame, count: number, out: Float32Array = new Float32Array(count)) => {
  const bins = frame.data.length
  const nyquist = frame.sampleRate / 2
  const ratio = SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ
  const binAt = (frequency: number) => Math.min(bins - 1, (frequency / nyquist) * (bins - 1))
  for (let band = 0; band < count; band++) {
    const low = binAt(SPECTRUM_MIN_HZ * ratio ** (band / count))
    const high = binAt(SPECTRUM_MIN_HZ * ratio ** ((band + 1) / count))
    if (high - low < 1) {
      const center = (low + high) / 2
      const lower = Math.floor(center)
      const upper = Math.min(bins - 1, lower + 1)
      out[band] = frame.data[lower] + (frame.data[upper] - frame.data[lower]) * (center - lower)
      continue
    }
    let peak = 0
    for (let bin = Math.floor(low); bin <= Math.ceil(high); bin++) peak = Math.max(peak, frame.data[bin])
    out[band] = peak
  }
  return out
}

const HEAT_STOPS: readonly (readonly [number, number, number])[] = [
  [8, 8, 20],
  [56, 18, 96],
  [186, 48, 72],
  [250, 160, 40],
  [255, 240, 190],
]

// Dark to warm, one RGB triple per 8-bit level.
const HEAT_LUT = Uint8ClampedArray.from({ length: 256 * 3 }, (_, index) => {
  const position = (Math.floor(index / 3) / 255) * (HEAT_STOPS.length - 1)
  const lower = Math.min(HEAT_STOPS.length - 2, Math.floor(position))
  const mix = position - lower
  return HEAT_STOPS[lower][index % 3] * (1 - mix) + HEAT_STOPS[lower + 1][index % 3] * mix
})

// A fixed ring of frame columns; the newest column is on the right, high frequencies on top.
export const createSpectrogramHistory = () => {
  const levels = new Uint8Array(HISTORY_COLUMNS * HISTORY_ROWS)
  const image = new ImageData(HISTORY_COLUMNS, HISTORY_ROWS)
  const rows = new Float32Array(HISTORY_ROWS)
  const strip = document.createElement('canvas')
  strip.width = HISTORY_COLUMNS
  strip.height = HISTORY_ROWS
  const stripContext = strip.getContext('2d')
  let next = 0
  let columns = 0

  return {
    columns: () => columns,
    clear: () => {
      levels.fill(0)
      columns = 0
    },
    push: (frame: SpectrumFrame) => {
      logBandLevels(frame, HISTORY_ROWS, rows)
      for (let row = 0; row < HISTORY_ROWS; row++) {
        levels[next * HISTORY_ROWS + row] = Math.round(Math.min(1, Math.max(0, rows[row])) * 255)
      }
      next = (next + 1) % HISTORY_COLUMNS
      columns = Math.min(HISTORY_COLUMNS, columns + 1)
    },
    paint: (context: CanvasRenderingContext2D, width: number, height: number) => {
      for (let x = 0; x < HISTORY_COLUMNS; x++) {
        const source = ((next + x) % HISTORY_COLUMNS) * HISTORY_ROWS
        for (let y = 0; y < HISTORY_ROWS; y++) {
          const level = levels[source + HISTORY_ROWS - 1 - y] * 3
          const target = (y * HISTORY_COLUMNS + x) * 4
          image.data[target] = HEAT_LUT[level]
          image.data[target + 1] = HEAT_LUT[level + 1]
          image.data[target + 2] = HEAT_LUT[level + 2]
          image.data[target + 3] = 255
        }
      }
      stripContext?.putImageData(image, 0, 0)
      context.imageSmoothingEnabled = true
      context.drawImage(strip, 0, 0, width, height)
    },
  }
}

export const drawSpectrumCurve = (
  context: CanvasRenderingContext2D,
  frame: SpectrumFrame | null,
  width: number,
  height: number,
  colors: { background: string; grid: string; line: string },
) => {
  context.fillStyle = colors.background
  context.fillRect(0, 0, width, height)
  context.strokeStyle = colors.grid
  context.lineWidth = 1
  context.beginPath()
  for (const frequency of [100, 1000, 10000]) {
    const x = Math.round((Math.log(frequency / SPECTRUM_MIN_HZ) / Math.log(SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ)) * width) + 0.5
    context.moveTo(x, 0)
    context.lineTo(x, height)
  }
  context.stroke()
  if (!frame) return
  const bands = logBandLevels(frame, Math.max(2, Math.floor(width)))
  context.strokeStyle = colors.line
  context.lineWidth = 1.5
  context.beginPath()
  bands.forEach((level, x) => {
    const y = height - Math.min(1, Math.max(0, level)) * (height - 2) - 1
    if (x === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  })
  context.stroke()
}
