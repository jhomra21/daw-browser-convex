// Mirrors native/audio-core/src/spectral_kernel.h and processor_spectral.cpp statement for statement (the worklet must stay
// within the parity tolerances of the core), so keep the three in step. Math.fround stands where the core rounds to float: the
// input, sidechain and dry rings, the per-bin state a stage publishes and every value crossing the processor boundary are
// float; the transform and everything between those stores is double.
const f = Math.fround

const MAX_FFT_SIZE = 4096
const MAX_BINS = MAX_FFT_SIZE / 2 + 1
const MEDIAN_FRAMES = 31
const MEDIAN_BINS = 31
const PI = Math.PI
const MODES = ['freeze', 'gate', 'morph', 'shift-blur', 'hpss', 'noise-reduce']
const FREEZE = 0
const GATE = 1
const MORPH = 2
const SHIFT_BLUR = 3
const HPSS = 4
const NOISE_REDUCE = 5
const DENORMAL_FLOOR_DOUBLE = 1e-154

const flushDouble = (value) => Math.abs(value) < DENORMAL_FLOOR_DOUBLE ? 0 : value
const wrapPhase = (phase) => phase - 2 * PI * Math.round(phase / (2 * PI))
const roundHalfAway = (value) => value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5)

const bypassStep = (current, target, step) => {
  if (target > current + step) return f(current + step)

  if (target < current - step) return f(current - step)

  return target
}

// First index in sorted[0, count) that is not less than value.
const lowerBound = (sorted, count, value) => {
  let low = 0
  let high = count

  while (low < high) {
    const middle = (low + high) >> 1

    if (sorted[middle] < value) low = middle + 1
    else high = middle
  }

  return low
}

const sortedInsert = (sorted, count, value) => {
  let at = count

  while (at > 0 && sorted[at - 1] > value) {
    sorted[at] = sorted[at - 1]
    at -= 1
  }

  sorted[at] = value
}

const sortedErase = (sorted, count, value) => {
  for (let at = lowerBound(sorted, count, value); at + 1 < count; at += 1) sorted[at] = sorted[at + 1]
}

const sortedReplace = (sorted, count, oldValue, value) => {
  let at = lowerBound(sorted, count, oldValue)

  if (value > oldValue) {
    while (at + 1 < count && sorted[at + 1] < value) {
      sorted[at] = sorted[at + 1]
      at += 1
    }
  } else {
    while (at > 0 && sorted[at - 1] > value) {
      sorted[at] = sorted[at - 1]
      at -= 1
    }
  }

  sorted[at] = value
}

const parameter = (name, minValue, maxValue, defaultValue) => ({
  name, minValue, maxValue, defaultValue, automationRate: 'a-rate',
})

// Everything one channel keeps between frames: the stage's published per-bin state (float) and the kernel's own memory.
class Channel {
  constructor() {
    this.frozenMagnitude = new Float32Array(MAX_BINS)
    this.frozenPhase = new Float32Array(MAX_BINS)
    this.frozenAdvance = new Float32Array(MAX_BINS)
    this.gateGain = new Float32Array(MAX_BINS).fill(1)
    this.noiseProfile = new Float32Array(MAX_BINS)
    this.noiseFrames = 0
    this.freezeCaptured = false
    this.previousPhase = new Float64Array(MAX_BINS)
    this.runningPhase = new Float64Array(MAX_BINS)
    this.noisePrior = new Float64Array(MAX_BINS)
    this.noiseGain = new Float64Array(MAX_BINS).fill(1)
    this.previousPeakBin = new Uint32Array(MAX_BINS)
    this.previousPeakOffset = new Float64Array(MAX_BINS)
    this.hpssRing = new Float32Array(MAX_BINS * MEDIAN_FRAMES)
    this.hpssSorted = new Float32Array(MAX_BINS * MEDIAN_FRAMES)
    this.previousPeakCount = 0
    this.hpssIndex = 0
    this.hpssCount = 0
    this.previousPhaseValid = false
    this.runningValid = false
  }
}

class DawSpectralProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      parameter('spectral.freeze', 0, 1, 0),
      parameter('spectral.gateThresholdDb', -120, 0, -60),
      parameter('spectral.gateAttackMs', 0.1, 1000, 10),
      parameter('spectral.gateReleaseMs', 1, 5000, 100),
      parameter('spectral.morph', 0, 1, 0),
      parameter('spectral.binShift', -2048, 2048, 0),
      parameter('spectral.blur', 0, 1, 0),
      parameter('spectral.harmonicPercussiveBalance', -1, 1, 0),
      parameter('spectral.noiseReduction', 0, 1, 0),
      parameter('spectral.noiseFloorDb', -60, -6, -30),
      parameter('spectral.profileLearn', 0, 1, 0),
      parameter('spectral.mix', 0, 1, 1),
    ]
  }

  constructor(options) {
    super()
    this.released = false
    this.enabled = true
    this.bypass = 0
    this.mode = FREEZE
    this.size = 0
    this.overlap = 0
    this.window = new Float64Array(MAX_FFT_SIZE)
    this.cosine = new Float64Array(MAX_FFT_SIZE / 2)
    this.sine = new Float64Array(MAX_FFT_SIZE / 2)
    this.reverse = new Uint16Array(MAX_FFT_SIZE)
    this.re = new Float64Array(MAX_FFT_SIZE)
    this.im = new Float64Array(MAX_FFT_SIZE)
    this.binRe = [new Float64Array(MAX_BINS), new Float64Array(MAX_BINS)]
    this.binIm = [new Float64Array(MAX_BINS), new Float64Array(MAX_BINS)]
    this.sideRe = [new Float64Array(MAX_BINS), new Float64Array(MAX_BINS)]
    this.sideIm = [new Float64Array(MAX_BINS), new Float64Array(MAX_BINS)]
    this.magnitude = new Float64Array(MAX_BINS)
    this.phase = new Float64Array(MAX_BINS)
    this.previous = new Float64Array(MAX_BINS)
    this.offset = new Float64Array(MAX_BINS)
    this.current = new Float32Array(MAX_BINS)
    this.peaks = new Uint32Array(MAX_BINS)
    this.peakOf = new Uint32Array(MAX_BINS)
    this.medianWindow = new Float32Array(MEDIAN_BINS + 1)
    this.peakCount = 0
    this.normalization = 1
    this.leakage = 0
    this.inputRing = [new Float32Array(MAX_FFT_SIZE), new Float32Array(MAX_FFT_SIZE)]
    this.sideRing = [new Float32Array(MAX_FFT_SIZE), new Float32Array(MAX_FFT_SIZE)]
    this.outputRing = [new Float64Array(MAX_FFT_SIZE * 2), new Float64Array(MAX_FFT_SIZE * 2)]
    this.dryRing = [new Float32Array(MAX_FFT_SIZE * 2), new Float32Array(MAX_FFT_SIZE * 2)]
    this.bypassFrames = Math.floor((sampleRate + 50) / 100)
    this.reconfigure(options?.processorOptions?.fftSize, options?.processorOptions?.overlap)
    this.port.onmessage = (event) => this.onMessage(event.data)
  }

  onMessage(message) {
    if (!message || message.version !== 1) {
      this.port.postMessage({ type: 'fault', version: 1, code: 'unsupported-protocol' })

      return
    }

    if (message.type === 'release' || message.type === 'dispose') {
      this.released = true

      return
    }

    if (message.type === 'reconfigure') {
      this.reconfigure(message.fftSize, message.overlap)

      return
    }

    if (message.type === 'reset') {
      this.reset()

      return
    }

    if (message.type === 'configure' && message.state) {
      // Disabling only bypasses (the 10 ms ramp in process()); the rings, noise
      // profile and a frozen capture are kept so enabling again resumes them, as the
      // portable core does.
      this.enabled = message.state.enabled !== false
      this.mode = Math.max(0, MODES.indexOf(message.state.mode))
    }
  }

  reset() {
    this.writeIndex = 0
    this.samplesUntilFrame = this.size
    this.bypass = this.enabled ? 0 : 1
    this.channels = [new Channel(), new Channel()]

    for (let channel = 0; channel < 2; channel += 1) {
      this.inputRing[channel].fill(0)
      this.sideRing[channel].fill(0)
      this.outputRing[channel].fill(0)
      this.dryRing[channel].fill(0)
    }
  }

  // Builds the window and FFT tables, as SpectralKernel::prepare does.
  reconfigure(fftSize, overlap) {
    if (fftSize !== 512 && fftSize !== 1024 && fftSize !== 2048 && fftSize !== 4096) fftSize = 2048

    if (overlap !== 2 && overlap !== 4) overlap = 4

    if (this.size === fftSize && this.overlap === overlap) return
    const size = fftSize
    this.size = size
    this.overlap = overlap
    this.hopSize = size / overlap
    let sum = 0
    let firstBin = 0

    for (let index = 0; index < size; index += 1) {
      this.window[index] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * PI * index / size))
      sum += this.window[index]
      firstBin += this.window[index] * Math.cos(2 * PI * index / size)
    }

    this.leakage = Math.abs(firstBin / sum)
    this.normalization = 2 / sum

    for (let index = 0; index < size / 2; index += 1) {
      this.cosine[index] = Math.cos(2 * PI * index / size)
      this.sine[index] = Math.sin(2 * PI * index / size)
    }

    let bits = 0

    while ((1 << bits) < size) bits += 1

    for (let index = 0; index < size; index += 1) {
      let reversed = 0

      for (let bit = 0; bit < bits; bit += 1) reversed |= ((index >> bit) & 1) << (bits - 1 - bit)

      this.reverse[index] = reversed
    }

    this.reset()
  }

  // In-place iterative radix-2 FFT of re and im with table twiddles; the inverse is unscaled.
  fft(inverse) {
    const { re, im, size } = this

    for (let index = 0; index < size; index += 1) {
      const other = this.reverse[index]

      if (index < other) {
        let value = re[index]; re[index] = re[other]; re[other] = value
        value = im[index]; im[index] = im[other]; im[other] = value
      }
    }

    for (let index = 0; index < size; index += 2) {
      const a = re[index]
      const b = re[index + 1]
      const c = im[index]
      const d = im[index + 1]
      re[index] = a + b; re[index + 1] = a - b
      im[index] = c + d; im[index + 1] = c - d
    }

    for (let index = 0; index < size; index += 4) {
      const a = re[index]
      const b = re[index + 1]
      const c = re[index + 2]
      const d = re[index + 3]
      const e = im[index]
      const g1 = im[index + 1]
      const g = im[index + 2]
      const h = im[index + 3]
      re[index] = a + c; re[index + 2] = a - c
      im[index] = e + g; im[index + 2] = e - g
      const rotatedRe = inverse ? -h : h
      const rotatedIm = inverse ? d : -d
      re[index + 1] = b + rotatedRe; re[index + 3] = b - rotatedRe
      im[index + 1] = g1 + rotatedIm; im[index + 3] = g1 - rotatedIm
    }

    const direction = inverse ? 1 : -1

    for (let length = 8; length <= size; length <<= 1) {
      const half = length / 2
      const step = size / length

      for (let start = 0; start < size; start += length) {
        for (let offset = 0; offset < half; offset += 1) {
          const wr = this.cosine[offset * step]
          const wi = direction * this.sine[offset * step]
          const even = start + offset
          const odd = even + half
          const productRe = re[odd] * wr - im[odd] * wi
          const productIm = re[odd] * wi + im[odd] * wr
          re[odd] = re[even] - productRe
          im[odd] = im[even] - productIm
          re[even] += productRe
          im[even] += productIm
        }
      }
    }
  }

  // Separates the packed transform in re/im (left + j right) into the two channel spectra.
  split(bins, outRe, outIm) {
    const { re, im, size } = this

    for (let bin = 0; bin < bins; bin += 1) {
      const mirror = (size - bin) & (size - 1)

      outRe[0][bin] = 0.5 * (re[bin] + re[mirror])
      outIm[0][bin] = 0.5 * (im[bin] - im[mirror])
      outRe[1][bin] = 0.5 * (im[bin] + im[mirror])
      outIm[1][bin] = -0.5 * (re[bin] - re[mirror])
    }
  }

  // Peaks are local maxima over +-2 bins; every bin belongs to the peak whose valley-bounded region holds it.
  assignPeaks(bins) {
    const { magnitude, peaks, peakOf } = this
    this.peakCount = 0

    for (let bin = 0; bin < bins; bin += 1) {
      let peak = magnitude[bin] > 0

      for (let distance = 1; peak && distance <= 2; distance += 1) {
        if (bin >= distance && magnitude[bin - distance] >= magnitude[bin]) peak = false

        if (bin + distance < bins && magnitude[bin + distance] > magnitude[bin]) peak = false
      }

      if (peak) peaks[this.peakCount++] = bin
    }

    if (this.peakCount === 0) {
      for (let bin = 0; bin < bins; bin += 1) peakOf[bin] = bin

      return
    }

    let bin = 0

    for (let peak = 0; peak < this.peakCount; peak += 1) {
      let boundary = bins - 1

      if (peak + 1 < this.peakCount) {
        boundary = peaks[peak]

        for (let candidate = peaks[peak]; candidate <= peaks[peak + 1]; candidate += 1) {
          if (magnitude[candidate] < magnitude[boundary]) boundary = candidate
        }
      }

      for (; bin <= boundary; bin += 1) peakOf[bin] = peaks[peak]
    }
  }

  polar(bins, re, im) {
    for (let bin = 0; bin < bins; bin += 1) {
      this.magnitude[bin] = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])
      this.phase[bin] = Math.atan2(im[bin], re[bin])
    }
  }

  freeze(state, bins, re, im, controls) {
    const { magnitude, phase } = this

    if (controls.freeze && !state.freezeCaptured) {
      this.polar(bins, re, im)
      this.assignPeaks(bins)

      for (let bin = 0; bin < bins; bin += 1) {
        const peak = this.peakOf[bin]

        state.frozenMagnitude[bin] = magnitude[bin]
        state.frozenPhase[bin] = phase[bin]

        // Without an earlier frame the best estimate of a peak's advance is the advance of its bin centre.
        const advance = state.previousPhaseValid ? phase[peak] - state.previousPhase[peak]
          : 2 * PI * (peak % this.overlap) / this.overlap

        state.frozenAdvance[bin] = wrapPhase(advance)
      }

      state.runningValid = false
      state.freezeCaptured = true
    } else if (!controls.freeze) {
      state.freezeCaptured = false
      state.runningValid = false
    }

    if (!state.freezeCaptured) {
      this.polar(bins, re, im)

      for (let bin = 0; bin < bins; bin += 1) state.previousPhase[bin] = phase[bin]

      state.previousPhaseValid = true

      return
    }

    if (!state.runningValid) {
      for (let bin = 0; bin < bins; bin += 1) state.runningPhase[bin] = state.frozenPhase[bin]

      state.runningValid = true
    } else {
      for (let bin = 0; bin < bins; bin += 1) {
        state.runningPhase[bin] = wrapPhase(state.runningPhase[bin] + state.frozenAdvance[bin])
      }
    }

    for (let bin = 0; bin < bins; bin += 1) {
      re[bin] = state.frozenMagnitude[bin] * Math.cos(state.runningPhase[bin])
      im[bin] = state.frozenMagnitude[bin] * Math.sin(state.runningPhase[bin])
    }
  }

  // A bin is judged on the loudest of itself and its two neighbours (see SpectralKernel::gate).
  gate(state, bins, re, im, controls) {
    const { magnitude } = this
    const hop = this.size / this.overlap
    const threshold = Math.pow(10, controls.gateThresholdDb / 20) / this.normalization
    const attack = Math.exp(-hop / Math.max(1, controls.gateAttackMs * 0.001 * sampleRate))
    const release = Math.exp(-hop / Math.max(1, controls.gateReleaseMs * 0.001 * sampleRate))

    for (let bin = 0; bin < bins; bin += 1) magnitude[bin] = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])

    for (let bin = 0; bin < bins; bin += 1) {
      const loudest = Math.max(magnitude[bin], Math.max(magnitude[bin > 0 ? bin - 1 : bin], magnitude[bin + 1 < bins ? bin + 1 : bin]))
      const target = loudest >= threshold ? 1 : 0
      const gain = state.gateGain[bin]
      const coefficient = target > gain ? attack : release
      const next = flushDouble(target + coefficient * (gain - target))

      state.gateGain[bin] = next
      re[bin] *= next
      im[bin] *= next
    }
  }

  morph(channel, bins, re, im, controls) {
    const sideRe = this.sideRe[channel]
    const sideIm = this.sideIm[channel]

    for (let bin = 0; bin < bins; bin += 1) {
      const phase = Math.atan2(im[bin], re[bin])

      const magnitude = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]) * (1 - controls.morph)
        + Math.sqrt(sideRe[bin] * sideRe[bin] + sideIm[bin] * sideIm[bin]) * controls.morph

      re[bin] = magnitude * Math.cos(phase)
      im[bin] = magnitude * Math.sin(phase)
    }
  }

  shiftBlur(state, bins, re, im, controls) {
    const { magnitude, phase, previous, offset, peaks, peakOf } = this
    this.polar(bins, re, im)
    this.assignPeaks(bins)
    // Each peak's output phase is its own plus an offset that grows by the phase the shift adds per hop; a peak inherits the
    // offset of the nearest peak of the previous frame, so a moving partial keeps its phase.
    const advance = 2 * PI * controls.binShift / this.overlap
    let previousPeak = 0

    for (let peak = 0; peak < this.peakCount; peak += 1) {
      const bin = peaks[peak]

      while (previousPeak + 1 < state.previousPeakCount
        && Math.abs(state.previousPeakBin[previousPeak + 1] - bin) <= Math.abs(state.previousPeakBin[previousPeak] - bin)) previousPeak += 1

      const inherited = state.previousPeakCount > 0
        && Math.abs(state.previousPeakBin[previousPeak] - bin) <= 2

      offset[bin] = inherited ? wrapPhase(state.previousPeakOffset[previousPeak] + advance) : 0
    }

    state.previousPeakCount = this.peakCount

    for (let peak = 0; peak < this.peakCount; peak += 1) {
      state.previousPeakBin[peak] = peaks[peak]
      state.previousPeakOffset[peak] = offset[peaks[peak]]
    }

    for (let bin = 0; bin < bins; bin += 1) previous[bin] = magnitude[bin]

    const radius = Math.min(15, Math.ceil(controls.blur * 15))
    const magnitudeAt = (index) => index >= 0 && index < bins ? previous[index] : 0

    for (let bin = 0; bin < bins; bin += 1) {
      const source = bin - controls.binShift
      const lower = Math.floor(source)
      const fraction = source - lower
      const shifted = magnitudeAt(lower) * (1 - fraction) + magnitudeAt(lower + 1) * fraction
      let sum = 0
      let count = 0

      for (let step = -radius; step <= radius; step += 1) {
        const candidate = lower + step

        if (candidate >= 0 && candidate < bins) {
          sum += previous[candidate]
          count += 1
        }
      }

      const blurred = shifted * (1 - controls.blur) + (count === 0 ? 0 : sum / count) * controls.blur
      const sourceBin = Math.min(Math.max(roundHalfAway(source), 0), bins - 1)
      const outPhase = phase[sourceBin] + offset[peakOf[sourceBin]]

      re[bin] = blurred * Math.cos(outPhase)
      im[bin] = blurred * Math.sin(outPhase)
    }
  }

  hpss(state, bins, re, im, controls) {
    const { current, medianWindow } = this
    const slot = state.hpssIndex
    const filling = state.hpssCount < MEDIAN_FRAMES

    for (let bin = 0; bin < bins; bin += 1) {
      const value = f(Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]))
      const sorted = state.hpssSorted.subarray(bin * MEDIAN_FRAMES, (bin + 1) * MEDIAN_FRAMES)
      const stored = slot * MAX_BINS + bin

      if (filling) sortedInsert(sorted, state.hpssCount, value)
      else sortedReplace(sorted, MEDIAN_FRAMES, state.hpssRing[stored], value)

      state.hpssRing[stored] = value
      current[bin] = value
    }

    if (filling) state.hpssCount += 1

    state.hpssIndex = (slot + 1) % MEDIAN_FRAMES
    const harmonicGain = controls.hpssBalance < 0 ? 1 + controls.hpssBalance : 1
    const percussiveGain = controls.hpssBalance > 0 ? 1 - controls.hpssBalance : 1
    let count = 0

    for (let bin = 0; bin < Math.min(bins, (MEDIAN_BINS >> 1) + 1); bin += 1) sortedInsert(medianWindow, count++, current[bin])

    for (let bin = 0; bin < bins; bin += 1) {
      const harmonic = state.hpssSorted[bin * MEDIAN_FRAMES + (state.hpssCount >> 1)]
      const percussive = medianWindow[count >> 1]
      const harmonicPower = harmonic * harmonic
      const percussivePower = percussive * percussive
      const total = harmonicPower + percussivePower
      const harmonicMask = total > 0 ? harmonicPower / total : 0.5
      const gain = percussiveGain + (harmonicGain - percussiveGain) * harmonicMask

      re[bin] *= gain
      im[bin] *= gain
      const entering = bin + (MEDIAN_BINS >> 1) + 1

      if (entering < bins) sortedInsert(medianWindow, count++, current[entering])

      if (bin >= (MEDIAN_BINS >> 1)) sortedErase(medianWindow, count--, current[bin - (MEDIAN_BINS >> 1)])
    }
  }

  noiseReduce(state, bins, re, im, controls) {
    const DECISION_DIRECTED = 0.98
    const GAIN_RISE = 0.35
    const GAIN_FALL = 0.8
    const TINY_POWER = 1e-30
    const frames = state.noiseFrames

    if (controls.learn) {
      const weight = 1 / (Math.min(frames, 1 << 16) + 1)

      for (let bin = 0; bin < bins; bin += 1) {
        const power = re[bin] * re[bin] + im[bin] * im[bin]
        const mean = state.noiseProfile[bin] * state.noiseProfile[bin]

        state.noiseProfile[bin] = Math.sqrt(mean + (power - mean) * weight)
        state.noisePrior[bin] = 0
        state.noiseGain[bin] = 1
      }

      state.noiseFrames = Math.min(frames + 1, 1 << 16)

      return
    }

    if (frames === 0) return
    const floorGain = Math.pow(10, controls.noiseFloorDb / 20)
    const profileOf = state.noiseProfile

    for (let bin = 0; bin < bins; bin += 1) {
      // A learned line leaks into the bins beside it by at least the window's first-bin response. A profile resampled to another
      // FFT size keeps the line but not that leakage, so each bin is held to that floor from its neighbours.
      const profile = Math.max(profileOf[bin], this.leakage * Math.max(
        profileOf[bin > 0 ? bin - 1 : bin], profileOf[bin + 1 < bins ? bin + 1 : bin]))

      const noisePower = Math.max(profile * profile, TINY_POWER)
      const ratio = (re[bin] * re[bin] + im[bin] * im[bin]) / noisePower
      const prior = DECISION_DIRECTED * state.noisePrior[bin] + (1 - DECISION_DIRECTED) * Math.max(ratio - 1, 0)
      const wiener = Math.max(prior / (1 + prior), floorGain)
      const previous = state.noiseGain[bin]

      state.noisePrior[bin] = wiener * wiener * ratio
      state.noiseGain[bin] = flushDouble(previous + (wiener - previous) * (wiener > previous ? GAIN_RISE : GAIN_FALL))
    }

    for (let bin = 0; bin < bins; bin += 1) {
      const left = state.noiseGain[bin > 0 ? bin - 1 : bin]
      const right = state.noiseGain[bin + 1 < bins ? bin + 1 : bin]
      const smoothed = 0.25 * left + 0.5 * state.noiseGain[bin] + 0.25 * right
      const gain = controls.noiseReduction === 1 ? smoothed : Math.pow(smoothed, controls.noiseReduction)

      re[bin] *= gain
      im[bin] *= gain
    }
  }

  transform(channel, bins, controls) {
    const re = this.binRe[channel]
    const im = this.binIm[channel]
    const state = this.channels[channel]

    switch (this.mode) {
      case FREEZE: this.freeze(state, bins, re, im, controls); break
      case GATE: this.gate(state, bins, re, im, controls); break
      case MORPH: this.morph(channel, bins, re, im, controls); break
      case SHIFT_BLUR: this.shiftBlur(state, bins, re, im, controls); break
      case HPSS: this.hpss(state, bins, re, im, controls); break
      case NOISE_REDUCE: this.noiseReduce(state, bins, re, im, controls); break
    }
  }

  // One analysis frame: reads the last N input samples of both channels and overlap-adds into the double output ring.
  processFrame(parameters, frame) {
    const at = (name) => f(parameters[name][parameters[name].length === 1 ? 0 : frame])

    const controls = {
      freeze: at('spectral.freeze') > 0,
      learn: at('spectral.profileLearn') > 0,
      gateThresholdDb: at('spectral.gateThresholdDb'),
      gateAttackMs: at('spectral.gateAttackMs'),
      gateReleaseMs: at('spectral.gateReleaseMs'),
      morph: at('spectral.morph'),
      binShift: at('spectral.binShift'),
      blur: at('spectral.blur'),
      hpssBalance: at('spectral.harmonicPercussiveBalance'),
      noiseReduction: at('spectral.noiseReduction'),
      noiseFloorDb: at('spectral.noiseFloorDb'),
    }

    const { size, re, im, window } = this
    const bins = size / 2 + 1
    const inputMask = MAX_FFT_SIZE - 1
    const outputMask = MAX_FFT_SIZE * 2 - 1
    const inputStart = (this.writeIndex - size + MAX_FFT_SIZE) & inputMask

    for (let index = 0; index < size; index += 1) {
      const source = (inputStart + index) & inputMask
      re[index] = this.inputRing[0][source] * window[index]
      im[index] = this.inputRing[1][source] * window[index]
    }

    this.fft(false)
    this.split(bins, this.binRe, this.binIm)

    if (this.mode === MORPH) {
      for (let index = 0; index < size; index += 1) {
        const source = (inputStart + index) & inputMask
        re[index] = this.sideRing[0][source] * window[index]
        im[index] = this.sideRing[1][source] * window[index]
      }

      this.fft(false)
      this.split(bins, this.sideRe, this.sideIm)
    }

    for (let channel = 0; channel < 2; channel += 1) {
      this.transform(channel, bins, controls)
      this.binIm[channel][0] = 0
      this.binIm[channel][size / 2] = 0
    }

    for (let bin = 0; bin < bins; bin += 1) {
      re[bin] = this.binRe[0][bin] - this.binIm[1][bin]
      im[bin] = this.binIm[0][bin] + this.binRe[1][bin]
    }

    for (let bin = 1; bin < size / 2; bin += 1) {
      re[size - bin] = this.binRe[0][bin] + this.binIm[1][bin]
      im[size - bin] = this.binRe[1][bin] - this.binIm[0][bin]
    }

    this.fft(true)
    const scale = 2 / this.overlap / size

    for (let index = 0; index < size; index += 1) {
      const target = (this.writeIndex + index) & outputMask
      this.outputRing[0][target] += re[index] * window[index] * scale
      this.outputRing[1][target] += im[index] * window[index] * scale
    }
  }

  process(inputs, outputs, parameters) {
    if (this.released) return false
    const input = inputs[0] ?? []
    const sidechain = inputs[1] ?? []
    const output = outputs[0] ?? []
    const frames = output[0]?.length ?? 0
    const inputMask = MAX_FFT_SIZE - 1
    const outputMask = MAX_FFT_SIZE * 2 - 1
    const step = f(1 / (this.bypassFrames === 0 ? 1 : this.bypassFrames))
    const mixValues = parameters['spectral.mix']

    for (let frame = 0; frame < frames; frame += 1) {
      this.bypass = bypassStep(this.bypass, this.enabled ? 0 : 1, step)
      const mix = f(mixValues[mixValues.length === 1 ? 0 : frame])
      const samples = [0, 0]

      for (let channel = 0; channel < 2; channel += 1) {
        const source = input[channel] ?? input[0]
        const side = sidechain[channel] ?? sidechain[0]
        const sampleValue = source ? source[frame] : 0
        const sample = Number.isFinite(sampleValue) ? f(sampleValue) : 0
        const sideValue = side ? side[frame] : 0
        this.inputRing[channel][this.writeIndex & inputMask] = sample
        this.sideRing[channel][this.writeIndex & inputMask] = Number.isFinite(sideValue) ? sideValue : 0
        this.dryRing[channel][(this.writeIndex + this.size) & outputMask] = sample
        const wet = f(this.outputRing[channel][this.writeIndex])
        const dry = this.dryRing[channel][this.writeIndex]
        this.outputRing[channel][this.writeIndex] = 0
        this.dryRing[channel][this.writeIndex] = 0
        const processed = f(f(dry * f(1 - mix)) + f(wet * mix))
        samples[channel] = f(processed + f(f(dry - processed) * this.bypass))
      }

      this.writeIndex = (this.writeIndex + 1) & outputMask

      if (--this.samplesUntilFrame === 0) {
        this.processFrame(parameters, frame)
        this.samplesUntilFrame = this.hopSize
      }

      if (output[0]) output[0][frame] = samples[0]

      if (output[1]) output[1][frame] = samples[1]
    }

    return true
  }
}

registerProcessor('daw-spectral-processor', DawSpectralProcessor)
