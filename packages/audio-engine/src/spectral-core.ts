import type { SpectralFftSize, SpectralMode, SpectralOverlap } from '@daw-browser/shared'

export type ComplexSpectrum = { real: Float64Array; imaginary: Float64Array }

export const fftInPlace = (real: Float64Array, imaginary: Float64Array, inverse = false) => {
  const size = real.length
  if (size !== imaginary.length || size < 2 || (size & (size - 1)) !== 0) throw new Error('FFT size must be equal power-of-two arrays')
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1
    while (reversed & bit) {
      reversed ^= bit
      bit >>= 1
    }
    reversed ^= bit
    if (index < reversed) {
      const realValue = real[index]
      real[index] = real[reversed]
      real[reversed] = realValue
      const imaginaryValue = imaginary[index]
      imaginary[index] = imaginary[reversed]
      imaginary[reversed] = imaginaryValue
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / length
    const stepReal = Math.cos(angle)
    const stepImaginary = Math.sin(angle)
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1
      let twiddleImaginary = 0
      for (let offset = 0; offset < length / 2; offset += 1) {
        const even = start + offset
        const odd = even + length / 2
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal
        real[odd] = real[even] - oddReal
        imaginary[odd] = imaginary[even] - oddImaginary
        real[even] += oddReal
        imaginary[even] += oddImaginary
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal
        twiddleReal = nextReal
      }
    }
  }
  if (inverse) {
    for (let index = 0; index < size; index += 1) {
      real[index] /= size
      imaginary[index] /= size
    }
  }
}

export const createSqrtHannWindow = (size: number) => {
  const window = new Float64Array(size)
  for (let index = 0; index < size; index += 1) window[index] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * index / size))
  return window
}

export type SpectralTransformState = {
  frozenMagnitude: Float64Array
  frozenPhase: Float64Array
  gateGain: Float64Array
  noiseProfile: Float64Array
  scratch: Float64Array
  hpssHistory: Float64Array[]
  hpssIndex: number
  freezeCaptured: boolean
}

export const createSpectralTransformState = (fftSize: SpectralFftSize): SpectralTransformState => {
  const bins = fftSize / 2 + 1
  return {
    frozenMagnitude: new Float64Array(bins),
    frozenPhase: new Float64Array(bins),
    gateGain: new Float64Array(bins).fill(1),
    noiseProfile: new Float64Array(bins),
    scratch: new Float64Array(bins),
    hpssHistory: Array.from({ length: 31 }, () => new Float64Array(bins)),
    hpssIndex: 0,
    freezeCaptured: false,
  }
}

export type SpectralTransformParams = {
  mode: SpectralMode
  freeze: number
  gateThresholdDb: number
  gateAttackMs: number
  gateReleaseMs: number
  morph: number
  binShift: number
  blur: number
  harmonicPercussiveBalance: number
  noiseReduction: number
  profileLearn: number
}

const magnitudeAt = (spectrum: ComplexSpectrum, bin: number) => Math.hypot(spectrum.real[bin], spectrum.imaginary[bin])
const median = (values: Float64Array, count: number) => {
  for (let index = 1; index < count; index += 1) {
    const value = values[index]
    let cursor = index - 1
    while (cursor >= 0 && values[cursor] > value) {
      values[cursor + 1] = values[cursor]
      cursor -= 1
    }
    values[cursor + 1] = value
  }
  return values[Math.floor(count / 2)]
}

export const transformSpectrum = (
  spectrum: ComplexSpectrum,
  sidechain: ComplexSpectrum | undefined,
  params: SpectralTransformParams,
  state: SpectralTransformState,
  sampleRate: number,
  hopSize: number,
) => {
  const bins = spectrum.real.length / 2 + 1
  if (params.mode === 'freeze') {
    if (params.freeze > 0 && !state.freezeCaptured) {
      for (let bin = 0; bin < bins; bin += 1) {
        state.frozenMagnitude[bin] = magnitudeAt(spectrum, bin)
        state.frozenPhase[bin] = Math.atan2(spectrum.imaginary[bin], spectrum.real[bin])
      }
      state.freezeCaptured = true
    } else if (params.freeze === 0) state.freezeCaptured = false
    if (state.freezeCaptured) {
      for (let bin = 0; bin < bins; bin += 1) {
        const magnitude = state.frozenMagnitude[bin]
        const phase = state.frozenPhase[bin]
        spectrum.real[bin] = magnitude * Math.cos(phase)
        spectrum.imaginary[bin] = magnitude * Math.sin(phase)
      }
    }
  } else if (params.mode === 'gate') {
    const threshold = 10 ** (params.gateThresholdDb / 20)
    const attack = Math.exp(-hopSize / Math.max(1, params.gateAttackMs * sampleRate / 1000))
    const release = Math.exp(-hopSize / Math.max(1, params.gateReleaseMs * sampleRate / 1000))
    for (let bin = 0; bin < bins; bin += 1) {
      const target = magnitudeAt(spectrum, bin) >= threshold ? 1 : 0
      const coefficient = target > state.gateGain[bin] ? attack : release
      state.gateGain[bin] = target + coefficient * (state.gateGain[bin] - target)
      spectrum.real[bin] *= state.gateGain[bin]
      spectrum.imaginary[bin] *= state.gateGain[bin]
    }
  } else if (params.mode === 'morph' && sidechain) {
    for (let bin = 0; bin < bins; bin += 1) {
      const phase = Math.atan2(spectrum.imaginary[bin], spectrum.real[bin])
      const magnitude = magnitudeAt(spectrum, bin) * (1 - params.morph) + magnitudeAt(sidechain, bin) * params.morph
      spectrum.real[bin] = magnitude * Math.cos(phase)
      spectrum.imaginary[bin] = magnitude * Math.sin(phase)
    }
  } else if (params.mode === 'shift-blur') {
    for (let bin = 0; bin < bins; bin += 1) state.scratch[bin] = magnitudeAt(spectrum, bin)
    for (let bin = 0; bin < bins; bin += 1) {
      const source = bin - params.binShift
      const lower = Math.floor(source)
      const fraction = source - lower
      const shifted = lower >= 0 && lower + 1 < bins
        ? state.scratch[lower] * (1 - fraction) + state.scratch[lower + 1] * fraction
        : 0
      const radius = Math.min(15, Math.ceil(params.blur * 15))
      let blurred = 0
      let count = 0
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sourceBin = lower + offset
        if (sourceBin >= 0 && sourceBin < bins) {
          blurred += state.scratch[sourceBin]
          count += 1
        }
      }
      const magnitude = shifted * (1 - params.blur) + (count > 0 ? blurred / count : 0) * params.blur
      const phase = Math.atan2(spectrum.imaginary[bin], spectrum.real[bin])
      spectrum.real[bin] = magnitude * Math.cos(phase)
      spectrum.imaginary[bin] = magnitude * Math.sin(phase)
    }
  } else if (params.mode === 'hpss') {
    const history = state.hpssHistory[state.hpssIndex]
    for (let bin = 0; bin < bins; bin += 1) history[bin] = magnitudeAt(spectrum, bin)
    state.hpssIndex = (state.hpssIndex + 1) % state.hpssHistory.length
    for (let bin = 0; bin < bins; bin += 1) {
      let count = 0
      for (let offset = -15; offset <= 15; offset += 1) {
        const candidate = bin + offset
        if (candidate >= 0 && candidate < bins) state.scratch[count++] = history[candidate]
      }
      const percussive = median(state.scratch, count)
      for (let frame = 0; frame < state.hpssHistory.length; frame += 1) state.scratch[frame] = state.hpssHistory[frame][bin]
      const harmonic = median(state.scratch, state.hpssHistory.length)
      const balance = (params.harmonicPercussiveBalance + 1) / 2
      const mask = (harmonic * balance + percussive * (1 - balance)) / Math.max(1e-12, harmonic + percussive)
      spectrum.real[bin] *= mask
      spectrum.imaginary[bin] *= mask
    }
  } else if (params.mode === 'noise-reduce') {
    for (let bin = 0; bin < bins; bin += 1) {
      const magnitude = magnitudeAt(spectrum, bin)
      state.noiseProfile[bin] += (magnitude - state.noiseProfile[bin]) * params.profileLearn
      const gain = magnitude > 0 ? Math.max(0, 1 - params.noiseReduction * state.noiseProfile[bin] / magnitude) : 0
      spectrum.real[bin] *= gain
      spectrum.imaginary[bin] *= gain
    }
  }
  for (let bin = 1; bin < spectrum.real.length / 2; bin += 1) {
    spectrum.real[spectrum.real.length - bin] = spectrum.real[bin]
    spectrum.imaginary[spectrum.imaginary.length - bin] = -spectrum.imaginary[bin]
  }
}

export type StftOptions = {
  fftSize: SpectralFftSize
  overlap: SpectralOverlap
  centered?: boolean
  transform?: (spectrum: ComplexSpectrum, frameIndex: number) => void
}

export const processStft = (input: Float64Array, options: StftOptions) => {
  const hopSize = options.fftSize / options.overlap
  const padding = options.centered ? options.fftSize / 2 : 0
  const frameCount = Math.max(1, Math.ceil((input.length + padding * 2 - options.fftSize) / hopSize) + 1)
  const outputLength = (frameCount - 1) * hopSize + options.fftSize
  const output = new Float64Array(outputLength)
  const normalization = new Float64Array(outputLength)
  const window = createSqrtHannWindow(options.fftSize)
  const real = new Float64Array(options.fftSize)
  const imaginary = new Float64Array(options.fftSize)
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * hopSize
    for (let index = 0; index < options.fftSize; index += 1) {
      const source = start + index - padding
      real[index] = (source >= 0 && source < input.length ? input[source] : 0) * window[index]
      imaginary[index] = 0
    }
    fftInPlace(real, imaginary)
    options.transform?.({ real, imaginary }, frame)
    fftInPlace(real, imaginary, true)
    for (let index = 0; index < options.fftSize; index += 1) {
      const target = start + index
      output[target] += real[index] * window[index]
      normalization[target] += window[index] * window[index]
    }
  }
  const result = new Float64Array(input.length)
  for (let index = 0; index < result.length; index += 1) {
    const source = index + padding
    result[index] = normalization[source] > 1e-12 ? output[source] / normalization[source] : 0
  }
  return result
}
