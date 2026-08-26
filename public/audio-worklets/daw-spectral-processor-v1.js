const MAX_FFT_SIZE = 4096
const MAX_BINS = MAX_FFT_SIZE / 2 + 1
const HPSS_FRAMES = 31

const parameter = (name, minValue, maxValue, defaultValue) => ({
  name, minValue, maxValue, defaultValue, automationRate: 'a-rate',
})

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
      parameter('spectral.profileLearn', 0, 1, 0),
      parameter('spectral.mix', 0, 1, 1),
    ]
  }

  constructor(options) {
    super()
    this.released = false
    this.enabled = true
    this.bypass = 0
    this.mode = 'freeze'
    this.fftSize = 2048
    this.overlap = 4
    this.hopSize = 512
    this.latency = this.fftSize
    this.writeIndex = 0
    this.samplesUntilFrame = this.fftSize
    this.window = new Float64Array(MAX_FFT_SIZE)
    this.inputRing = [new Float64Array(MAX_FFT_SIZE), new Float64Array(MAX_FFT_SIZE)]
    this.sideRing = [new Float64Array(MAX_FFT_SIZE), new Float64Array(MAX_FFT_SIZE)]
    this.outputRing = [new Float64Array(MAX_FFT_SIZE * 2), new Float64Array(MAX_FFT_SIZE * 2)]
    this.dryRing = [new Float64Array(MAX_FFT_SIZE * 2), new Float64Array(MAX_FFT_SIZE * 2)]
    this.real = [new Float64Array(MAX_FFT_SIZE), new Float64Array(MAX_FFT_SIZE)]
    this.imaginary = [new Float64Array(MAX_FFT_SIZE), new Float64Array(MAX_FFT_SIZE)]
    this.sideReal = [new Float64Array(MAX_FFT_SIZE), new Float64Array(MAX_FFT_SIZE)]
    this.sideImaginary = [new Float64Array(MAX_FFT_SIZE), new Float64Array(MAX_FFT_SIZE)]
    this.frozenMagnitude = [new Float64Array(MAX_BINS), new Float64Array(MAX_BINS)]
    this.frozenPhase = [new Float64Array(MAX_BINS), new Float64Array(MAX_BINS)]
    this.gateGain = [new Float64Array(MAX_BINS), new Float64Array(MAX_BINS)]
    this.noiseProfile = [new Float64Array(MAX_BINS), new Float64Array(MAX_BINS)]
    this.scratch = [new Float64Array(MAX_BINS), new Float64Array(MAX_BINS)]
    this.hpssMedian = [new Float64Array(MAX_BINS), new Float64Array(MAX_BINS)]
    this.hpssHistory = [new Float64Array(MAX_BINS * HPSS_FRAMES), new Float64Array(MAX_BINS * HPSS_FRAMES)]
    this.hpssIndex = [0, 0]
    this.freezeCaptured = [false, false]
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
      const enabled = message.state.enabled !== false
      const enabledChanged = enabled !== this.enabled
      this.enabled = enabled
      this.mode = message.state.mode
      if (enabledChanged) this.reset()
    }
  }

  reset() {
    this.writeIndex = 0
    this.samplesUntilFrame = this.fftSize
    this.bypass = this.enabled ? 0 : 1
    for (let channel = 0; channel < 2; channel += 1) {
      this.inputRing[channel].fill(0)
      this.sideRing[channel].fill(0)
      this.outputRing[channel].fill(0)
      this.dryRing[channel].fill(0)
      this.gateGain[channel].fill(1)
      this.noiseProfile[channel].fill(0)
      this.hpssHistory[channel].fill(0)
      this.freezeCaptured[channel] = false
      this.hpssIndex[channel] = 0
    }
  }

  reconfigure(fftSize, overlap) {
    if (fftSize !== 512 && fftSize !== 1024 && fftSize !== 2048 && fftSize !== 4096) fftSize = 2048
    if (overlap !== 2 && overlap !== 4) overlap = 4
    if (this.fftSize === fftSize && this.overlap === overlap && this.window[1] !== 0) return
    this.fftSize = fftSize
    this.overlap = overlap
    this.hopSize = fftSize / overlap
    this.latency = fftSize
    for (let index = 0; index < fftSize; index += 1) {
      this.window[index] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * index / fftSize))
    }
    this.reset()
  }

  fft(real, imaginary, inverse) {
    const size = this.fftSize
    for (let index = 1, reversed = 0; index < size; index += 1) {
      let bit = size >> 1
      while (reversed & bit) { reversed ^= bit; bit >>= 1 }
      reversed ^= bit
      if (index < reversed) {
        let value = real[index]; real[index] = real[reversed]; real[reversed] = value
        value = imaginary[index]; imaginary[index] = imaginary[reversed]; imaginary[reversed] = value
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
    if (inverse) for (let index = 0; index < size; index += 1) { real[index] /= size; imaginary[index] /= size }
  }

  median(values, count) {
    const target = count >> 1
    let left = 0
    let right = count - 1
    while (left < right) {
      const pivot = values[(left + right) >> 1]
      let low = left
      let high = right
      while (low <= high) {
        while (values[low] < pivot) low += 1
        while (values[high] > pivot) high -= 1
        if (low <= high) {
          const value = values[low]
          values[low] = values[high]
          values[high] = value
          low += 1
          high -= 1
        }
      }
      if (target <= high) right = high
      else if (target >= low) left = low
      else return values[target]
    }
    return values[target]
  }

  transform(channel, parameters) {
    const real = this.real[channel]
    const imaginary = this.imaginary[channel]
    const sideReal = this.sideReal[channel]
    const sideImaginary = this.sideImaginary[channel]
    const bins = this.fftSize / 2 + 1
    const value = (name) => parameters[name][parameters[name].length - 1]
    if (this.mode === 'freeze') {
      const freeze = value('spectral.freeze')
      if (freeze > 0 && !this.freezeCaptured[channel]) {
        for (let bin = 0; bin < bins; bin += 1) {
          this.frozenMagnitude[channel][bin] = Math.hypot(real[bin], imaginary[bin])
          this.frozenPhase[channel][bin] = Math.atan2(imaginary[bin], real[bin])
        }
        this.freezeCaptured[channel] = true
      } else if (freeze === 0) this.freezeCaptured[channel] = false
      if (this.freezeCaptured[channel]) for (let bin = 0; bin < bins; bin += 1) {
        const magnitude = this.frozenMagnitude[channel][bin]
        const phase = this.frozenPhase[channel][bin]
        real[bin] = magnitude * Math.cos(phase); imaginary[bin] = magnitude * Math.sin(phase)
      }
    } else if (this.mode === 'gate') {
      const threshold = 10 ** (value('spectral.gateThresholdDb') / 20)
      const attack = Math.exp(-this.hopSize / Math.max(1, value('spectral.gateAttackMs') * sampleRate / 1000))
      const release = Math.exp(-this.hopSize / Math.max(1, value('spectral.gateReleaseMs') * sampleRate / 1000))
      for (let bin = 0; bin < bins; bin += 1) {
        const target = Math.hypot(real[bin], imaginary[bin]) >= threshold ? 1 : 0
        const coefficient = target > this.gateGain[channel][bin] ? attack : release
        this.gateGain[channel][bin] = target + coefficient * (this.gateGain[channel][bin] - target)
        real[bin] *= this.gateGain[channel][bin]; imaginary[bin] *= this.gateGain[channel][bin]
      }
    } else if (this.mode === 'morph') {
      const morph = value('spectral.morph')
      for (let bin = 0; bin < bins; bin += 1) {
        const phase = Math.atan2(imaginary[bin], real[bin])
        const magnitude = Math.hypot(real[bin], imaginary[bin]) * (1 - morph) + Math.hypot(sideReal[bin], sideImaginary[bin]) * morph
        real[bin] = magnitude * Math.cos(phase); imaginary[bin] = magnitude * Math.sin(phase)
      }
    } else if (this.mode === 'shift-blur') {
      const shift = value('spectral.binShift')
      const blur = value('spectral.blur')
      const scratch = this.scratch[channel]
      for (let bin = 0; bin < bins; bin += 1) scratch[bin] = Math.hypot(real[bin], imaginary[bin])
      const radius = Math.min(15, Math.ceil(blur * 15))
      for (let bin = 0; bin < bins; bin += 1) {
        const source = bin - shift
        const lower = Math.floor(source)
        const fraction = source - lower
        const shifted = lower >= 0 && lower + 1 < bins ? scratch[lower] * (1 - fraction) + scratch[lower + 1] * fraction : 0
        let sum = 0; let count = 0
        for (let offset = -radius; offset <= radius; offset += 1) { const at = lower + offset; if (at >= 0 && at < bins) { sum += scratch[at]; count += 1 } }
        const magnitude = shifted * (1 - blur) + (count ? sum / count : 0) * blur
        const phase = Math.atan2(imaginary[bin], real[bin])
        real[bin] = magnitude * Math.cos(phase); imaginary[bin] = magnitude * Math.sin(phase)
      }
    } else if (this.mode === 'hpss') {
      const history = this.hpssHistory[channel]
      const historyOffset = this.hpssIndex[channel] * MAX_BINS
      for (let bin = 0; bin < bins; bin += 1) history[historyOffset + bin] = Math.hypot(real[bin], imaginary[bin])
      this.hpssIndex[channel] = (this.hpssIndex[channel] + 1) % HPSS_FRAMES
      const percussive = this.hpssMedian[channel]
      for (let bin = 0; bin < bins; bin += 1) {
        let count = 0
        for (let offset = -15; offset <= 15; offset += 1) {
          const candidate = bin + offset
          if (candidate >= 0 && candidate < bins) this.scratch[channel][count++] = history[historyOffset + candidate]
        }
        percussive[bin] = this.median(this.scratch[channel], count)
      }
      for (let bin = 0; bin < bins; bin += 1) {
        for (let frame = 0; frame < HPSS_FRAMES; frame += 1) this.scratch[channel][frame] = history[frame * MAX_BINS + bin]
        const harmonic = this.median(this.scratch[channel], HPSS_FRAMES)
        const balance = (value('spectral.harmonicPercussiveBalance') + 1) / 2
        const mask = (harmonic * balance + percussive[bin] * (1 - balance)) / Math.max(1e-12, harmonic + percussive[bin])
        real[bin] *= mask
        imaginary[bin] *= mask
      }
    } else if (this.mode === 'noise-reduce') {
      const reduction = value('spectral.noiseReduction')
      const learn = value('spectral.profileLearn')
      for (let bin = 0; bin < bins; bin += 1) {
        const magnitude = Math.hypot(real[bin], imaginary[bin])
        const detector = Math.hypot(sideReal[bin], sideImaginary[bin]) || magnitude
        this.noiseProfile[channel][bin] += (detector - this.noiseProfile[channel][bin]) * learn
        const gain = magnitude > 0 ? Math.max(0, 1 - reduction * this.noiseProfile[channel][bin] / magnitude) : 0
        real[bin] *= gain; imaginary[bin] *= gain
      }
    }
    for (let bin = 1; bin < this.fftSize / 2; bin += 1) {
      real[this.fftSize - bin] = real[bin]
      imaginary[this.fftSize - bin] = -imaginary[bin]
    }
  }

  processFrame(parameters) {
    const inputMask = MAX_FFT_SIZE - 1
    const outputMask = this.outputRing[0].length - 1
    const frameStart = (this.writeIndex - this.fftSize + MAX_FFT_SIZE) & inputMask
    for (let channel = 0; channel < 2; channel += 1) {
      const real = this.real[channel]; const imaginary = this.imaginary[channel]
      const sideReal = this.sideReal[channel]; const sideImaginary = this.sideImaginary[channel]
      for (let index = 0; index < this.fftSize; index += 1) {
        const source = (frameStart + index) & (MAX_FFT_SIZE - 1)
        real[index] = this.inputRing[channel][source] * this.window[index]; imaginary[index] = 0
        sideReal[index] = this.sideRing[channel][source] * this.window[index]; sideImaginary[index] = 0
      }
      this.fft(real, imaginary, false)
      if (this.mode === 'morph' || this.mode === 'noise-reduce') this.fft(sideReal, sideImaginary, false)
      this.transform(channel, parameters)
      this.fft(real, imaginary, true)
      for (let index = 0; index < this.fftSize; index += 1) {
        const target = (this.writeIndex + index) & outputMask
        this.outputRing[channel][target] += real[index] * this.window[index] * (2 / this.overlap)
      }
    }
  }

  process(inputs, outputs, parameters) {
    if (this.released) return false
    const input = inputs[0]
    const sidechain = inputs[1] || []
    const output = outputs[0]
    const frames = output[0]?.length || 0
    const inputMask = MAX_FFT_SIZE - 1
    const outputMask = this.outputRing[0].length - 1
    const bypassStep = 1 / Math.max(1, Math.round(0.01 * sampleRate))
    const targetBypass = this.enabled ? 0 : 1
    for (let frame = 0; frame < frames; frame += 1) {
      this.bypass += Math.max(-bypassStep, Math.min(bypassStep, targetBypass - this.bypass))
      for (let channel = 0; channel < 2; channel += 1) {
        const sourceChannel = input[channel] || input[0]
        const sideChannel = sidechain[channel] || sidechain[0]
        const sampleValue = sourceChannel ? sourceChannel[frame] : 0
        const sample = Number.isFinite(sampleValue) ? sampleValue : 0
        const inputIndex = this.writeIndex & inputMask
        this.inputRing[channel][inputIndex] = sample
        const sideValue = sideChannel ? sideChannel[frame] : 0
        this.sideRing[channel][inputIndex] = Number.isFinite(sideValue) ? sideValue : 0
        const dryTarget = (this.writeIndex + this.latency) & outputMask
        this.dryRing[channel][dryTarget] = sample
        const wet = this.outputRing[channel][this.writeIndex]
        const dry = this.dryRing[channel][this.writeIndex]
        this.outputRing[channel][this.writeIndex] = 0
        this.dryRing[channel][this.writeIndex] = 0
        const mixValues = parameters['spectral.mix']
        const mix = mixValues.length === 1 ? mixValues[0] : mixValues[frame]
        const processed = dry * (1 - mix) + wet * mix
        if (output[channel]) output[channel][frame] = processed + (dry - processed) * this.bypass
      }
      this.writeIndex = (this.writeIndex + 1) & outputMask
      this.samplesUntilFrame -= 1
      if (this.samplesUntilFrame === 0) { this.processFrame(parameters); this.samplesUntilFrame = this.hopSize }
    }
    return true
  }
}

registerProcessor('daw-spectral-processor', DawSpectralProcessor)
