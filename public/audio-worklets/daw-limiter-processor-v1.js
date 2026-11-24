const parameters = [
  ['limiter.gainDb', 0, -12, 24, 'a-rate'],
  ['limiter.ceiling', -1, -12, 0, 'a-rate'],
  ['limiter.release', 100, 20, 1000, 'a-rate'],
  ['limiter.link', 1, 0, 1, 'a-rate'],
]

const LOOKAHEAD_STEPS_MS = [1.5, 3, 6]

const isLimiterMessage = (message) => message !== null && Object.prototype.toString.call(message) === '[object Object]' && message.version === 1

const isLimiterConfigureMessage = (message, revision) => isLimiterMessage(message)
  && message.type === 'configure'
  && Number.isInteger(message.revision)
  && message.revision > revision
  && Object.prototype.toString.call(message.state) === '[object Object]'

// Everything below is a port of native/audio-core/src/limiter_kernel.h, kept line for line so the two stay comparable:
// input gain -> true-peak detector -> gain target -> min-hold over the lookahead -> two moving averages -> release stage
// -> gain on the audio delayed by exactly the lookahead -> safety clip at the ceiling.
const OVERSAMPLE = 8
const PAST = 64
const MINIMUM_AHEAD = 12
const MAXIMUM_AHEAD = 64
const MAXIMUM_TAPS = PAST + MAXIMUM_AHEAD
const BOX_FRAMES = 48
const DETECTOR_MARGIN = Math.fround(0.99655)
const CAPACITY = 2048
const MASK = CAPACITY - 1
const MAXIMUM_BOX = 1024
const AUTO_FAST_MS = 25
const AUTO_SLOW_MS = 500
const AUTO_BUILD_MS = 150
const AUTO_SLOW_FROM = 0.15
const AUTO_SLOW_TO = 0.65
const GRID = OVERSAMPLE + 3
const DENORMAL_FLOOR = 1e-19

const flushDenormal = (value) => Math.abs(value) < DENORMAL_FLOOR ? 0 : value

// Sliding minimum of the last window + 1 pushes, in O(1) per push.
class SlidingMinimum {
  constructor() {
    this.value = new Float32Array(CAPACITY)
    this.frame = new Float64Array(CAPACITY)
    this.head = 0
    this.count = 0
    this.now = 0
  }

  push(target, window) {
    while (this.count > 0 && this.value[(this.head + this.count - 1) & MASK] >= target) this.count--

    while (this.count > 0 && this.now - this.frame[this.head] > window) {
      this.head = (this.head + 1) & MASK
      this.count--
    }

    const tail = (this.head + this.count) & MASK
    this.value[tail] = target
    this.frame[tail] = this.now++
    this.count++

    return this.value[this.head]
  }
}

// Moving average of the last `length` pushes, started at unity gain.
class Box {
  constructor() {
    this.ring = new Float32Array(MAXIMUM_BOX)
    this.sum = 0
    this.index = 0
  }

  start(length) {
    this.ring.fill(1)
    this.sum = length
    this.index = 0
  }

  push(value, length) {
    this.sum += value - this.ring[this.index]
    this.ring[this.index] = value
    this.index = this.index + 1 >= length ? 0 : this.index + 1

    return Math.fround(this.sum / length)
  }
}

class Channel {
  constructor() {
    this.dry = new Float32Array(CAPACITY)
    this.gained = new Float32Array(CAPACITY)
    this.minimum = new SlidingMinimum()
    this.first = new Box()
    this.second = new Box()
    this.gain = 1
    this.sustain = 0
  }
}

class LimiterKernel {
  constructor(sampleRate) {
    this.rate = sampleRate
    this.channels = [new Channel(), new Channel()]
    this.point = new Float32Array(GRID * MAXIMUM_TAPS)
    this.window = new Float32Array(MAXIMUM_TAPS)
    this.grid = new Float32Array(GRID)
    this.bound = 1
    this.boxLengths = [1, 1]
    this.delay = 0
    this.ahead = MINIMUM_AHEAD
    this.write = 0
    this.inputGain = 1
    this.ceiling = 0.891
    this.release = 0
    this.autoBuild = 0
    this.autoDecay = 0
    this.safetyClips = 0
    this.smootherCoefficient = 1 - Math.exp(-1000 / (10 * sampleRate))
    this.smootherCurrent = 0
    this.smootherTarget = 0
    this.smootherSettling = false
    this.primed = false
  }

  reset() {
    this.channels = [new Channel(), new Channel()]
    this.write = 0
    this.boxLengths = [1, 1]
    this.delay = 0
  }

  latencyFrames(lookaheadMs) {
    const wanted = Math.ceil(lookaheadMs * this.rate / 1000)

    return Math.min(Math.max(wanted, MINIMUM_AHEAD + 2), CAPACITY - 48)
  }

  onePole(milliseconds) {
    return Math.exp(-1 / (Math.max(milliseconds, 0.01) * 0.001 * this.rate))
  }

  nextInputGainDb(target) {
    const value = Math.fround(target)

    if (!this.primed) {
      this.smootherCurrent = value
      this.smootherTarget = value
      this.smootherSettling = false
      this.primed = true
    }

    if (value !== this.smootherTarget) {
      this.smootherTarget = value
      this.smootherSettling = Math.abs(value - this.smootherCurrent) > 1e-5

      if (!this.smootherSettling) this.smootherCurrent = value
    }

    if (!this.smootherSettling) return this.smootherTarget
    this.smootherCurrent += this.smootherCoefficient * (this.smootherTarget - this.smootherCurrent)

    if (Math.abs(this.smootherTarget - this.smootherCurrent) <= 1e-5) {
      this.smootherCurrent = this.smootherTarget
      this.smootherSettling = false

      return this.smootherTarget
    }

    return Math.fround(this.smootherCurrent)
  }

  design(ahead) {
    this.bound = 1

    for (let i = 0; i < GRID; i++) {
      if (i === 1 || i === OVERSAMPLE + 1) continue
      const weights = new Float64Array(MAXIMUM_TAPS)
      let sum = 0

      for (let j = 0; j < PAST + ahead; j++) {
        // Sample j sits at offset j - (PAST - 1) from the sample the detector judges.
        const distance = (i - 1) / OVERSAMPLE - (j - (PAST - 1))
        const ratio = distance > 0 ? distance / PAST : distance / ahead
        const window = Math.abs(ratio) >= 1 ? 0 : Math.cos(0.5 * Math.PI * ratio) ** 0.75
        weights[j] = (distance === 0 ? 1 : Math.sin(Math.PI * distance) / (Math.PI * distance)) * window
        sum += weights[j]
      }

      let absolute = 0

      for (let j = 0; j < PAST + ahead; j++) {
        this.point[i * MAXIMUM_TAPS + j] = weights[j] / sum
        absolute += Math.abs(weights[j] / sum)
      }

      this.bound = Math.max(this.bound, Math.fround(absolute))
    }
  }

  configure(lookaheadMs) {
    const delay = this.latencyFrames(lookaheadMs)

    if (delay === this.delay) return
    this.reset()
    this.delay = delay
    this.ahead = Math.min(Math.max(delay - BOX_FRAMES, MINIMUM_AHEAD), MAXIMUM_AHEAD) & ~1
    this.design(this.ahead)
    const span = delay - this.ahead + 1
    this.boxLengths = [Math.min(Math.floor((span + 1) / 2), MAXIMUM_BOX), Math.min(Math.floor(span / 2), MAXIMUM_BOX)]

    for (const channel of this.channels) {
      channel.first.start(this.boxLengths[0])
      channel.second.start(this.boxLengths[1])
    }

    this.autoBuild = this.onePole(AUTO_BUILD_MS)
    this.autoDecay = this.onePole(AUTO_SLOW_MS)
  }

  // Largest magnitude of the waveform between the sample the detector judges and the next one.
  truePeak(channel) {
    const taps = PAST + this.ahead
    const window = this.window
    let largest = 0

    for (let j = 0; j < taps; j++) {
      window[j] = channel.gained[(this.write - (taps - 1) + j) & MASK]
      largest = Math.max(largest, Math.abs(window[j]))
    }

    const margin = this.ceiling * DETECTOR_MARGIN

    if (largest * this.bound <= margin) return largest * this.bound
    const grid = this.grid
    grid[1] = Math.abs(window[PAST - 1])
    grid[OVERSAMPLE + 1] = Math.abs(window[PAST])

    for (let i = 0; i < GRID; i++) {
      if (i === 1 || i === OVERSAMPLE + 1) continue
      const offset = i * MAXIMUM_TAPS
      let sum = 0

      for (let j = 0; j < taps; j++) sum += window[j] * this.point[offset + j]
      grid[i] = Math.abs(sum)
    }

    let at = 1

    for (let i = 2; i <= OVERSAMPLE + 1; i++) if (grid[i] > grid[at]) at = i

    // A largest point that is not a local maximum means the peak lies in a neighbouring interval, whose own pass reads it.
    if (grid[at - 1] > grid[at] || grid[at + 1] > grid[at]) return grid[at]
    const curvature = 2 * grid[at] - grid[at - 1] - grid[at + 1]

    return curvature > 0 ? grid[at] + (grid[at + 1] - grid[at - 1]) * (grid[at + 1] - grid[at - 1]) / (8 * curvature) : grid[at]
  }

  releaseCoefficient(channel, autoRelease, releaseCoefficient) {
    if (!autoRelease) return releaseCoefficient
    const slow = Math.min(Math.max((channel.sustain - AUTO_SLOW_FROM) / (AUTO_SLOW_TO - AUTO_SLOW_FROM), 0), 1)

    return this.onePole(AUTO_FAST_MS + (AUTO_SLOW_MS - AUTO_FAST_MS) * slow)
  }

  // The sustain only rises while the smoothed gain is what sets the output; it falls at the slow stage's pace after.
  trackSustain(channel, smooth) {
    const working = smooth < 1 && channel.gain === smooth

    channel.sustain = flushDenormal(working ? channel.sustain + (1 - channel.sustain) * (1 - this.autoBuild) : channel.sustain * this.autoDecay)
  }

  // Writes the delayed, limited pair into out[0..1]; `enabled` false passes the delayed dry signal.
  process(values, lookaheadMs, autoRelease, enabled, inputLeft, inputRight, out) {
    this.configure(lookaheadMs)
    const gainDb = this.nextInputGainDb(values.gainDb)
    this.inputGain = 10 ** (gainDb / 20)
    this.ceiling = 10 ** (values.ceilingDbtp / 20)
    const releaseCoefficient = this.onePole(values.releaseMs)
    const input = [flushDenormal(inputLeft), flushDenormal(inputRight)]
    const slot = this.write & MASK
    const target = [0, 0]

    for (let c = 0; c < 2; c++) {
      this.channels[c].dry[slot] = input[c]
      this.channels[c].gained[slot] = input[c] * this.inputGain
    }

    for (let c = 0; c < 2; c++) target[c] = Math.min(1, this.ceiling * DETECTOR_MARGIN / Math.max(this.truePeak(this.channels[c]), 1e-12))
    const linked = Math.min(target[0], target[1])
    const read = (this.write - this.delay) & MASK
    const wet = [0, 0]

    for (let c = 0; c < 2; c++) {
      const channel = this.channels[c]
      const held = channel.minimum.push(target[c] + (linked - target[c]) * values.link, this.delay - this.ahead + 1)
      const smooth = channel.second.push(channel.first.push(held, this.boxLengths[0]), this.boxLengths[1])
      channel.gain = Math.min(smooth, 1 + this.releaseCoefficient(channel, autoRelease, releaseCoefficient) * (channel.gain - 1))

      if (autoRelease) this.trackSustain(channel, smooth)
      let value = channel.gained[read] * channel.gain

      if (Math.abs(value) > this.ceiling) {
        if (Math.abs(value) > this.ceiling * 1.00001) this.safetyClips++
        value = Math.sign(value) * this.ceiling
      }

      wet[c] = value
    }

    this.write++
    const gainFault = !Number.isFinite(this.channels[0].gain) || !Number.isFinite(this.channels[1].gain)
    const left = enabled ? wet[0] : this.channels[0].dry[read]
    const right = enabled ? wet[1] : this.channels[1].dry[read]
    const finite = !gainFault && Number.isFinite(left) && Number.isFinite(right)

    if (!finite) this.reset()
    out[0] = finite ? left : 0
    out[1] = finite ? right : 0

    return finite
  }

  gainReduction() {
    return Math.min(this.channels[0].gain, this.channels[1].gain)
  }
}

class DawLimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return parameters.map(([name, defaultValue, minValue, maxValue, automationRate]) => ({
      name, defaultValue, minValue, maxValue, automationRate,
    }))
  }

  constructor() {
    super()
    this.revision = -1
    this.enabled = true
    this.autoRelease = false
    this.lookaheadMs = 3
    this.kernel = new LimiterKernel(sampleRate)
    this.out = new Float64Array(2)
    this.values = { gainDb: 0, ceilingDbtp: -1, releaseMs: 100, link: 1 }
    this.meterFrames = 0
    this.minimumGain = 1
    this.metering = false
    this.faults = 0
    this.port.onmessage = (event) => this.onMessage(event.data)
    this.port.postMessage({ type: 'ready', version: 1 })
  }

  onMessage(message) {
    if (!isLimiterMessage(message)) return this.fault('malformed-message')

    if (message.type === 'dispose') return this.port.close()

    if (message.type === 'metering' && (message.enabled === true || message.enabled === false)) {
      this.metering = message.enabled

      return
    }

    if (message.type === 'reset') {
      this.kernel.reset()
      this.meterFrames = 0; this.minimumGain = 1

      return
    }

    if (!isLimiterConfigureMessage(message, this.revision)) {
      return this.fault('malformed-or-stale-configure')
    }

    this.revision = message.revision
    this.enabled = message.state.enabled !== false
    this.autoRelease = message.state.autoRelease === true
    this.lookaheadMs = LOOKAHEAD_STEPS_MS.includes(message.state.lookaheadMs) ? message.state.lookaheadMs : 3
    this.port.postMessage({ type: 'configured', version: 1, revision: this.revision })
  }

  fault(code) {
    if (this.faults++ < 4) this.port.postMessage({ type: 'fault', version: 1, code })
  }

  process(inputs, outputs, parameterValues) {
    const input = inputs[0] || []
    const output = outputs[0] || []
    const outL = output[0]

    if (!outL) return true
    const outR = output[1]
    const inL = input[0]
    const inR = input[1] || inL
    const at = (name, frame) => parameterValues[name][parameterValues[name].length === 1 ? 0 : frame]
    const values = this.values
    let blockMinimumGain = 1

    for (let frame = 0; frame < outL.length; frame++) {
      let left = inL ? inL[frame] : 0
      let right = inR ? inR[frame] : left

      if (!Number.isFinite(left) || !Number.isFinite(right)) {
        left = 0; right = 0
        this.fault('nonfinite-input')
      }

      values.gainDb = at('limiter.gainDb', frame)
      values.ceilingDbtp = at('limiter.ceiling', frame)
      values.releaseMs = at('limiter.release', frame)
      values.link = at('limiter.link', frame)

      if (!this.kernel.process(values, this.lookaheadMs, this.autoRelease, this.enabled, left, right, this.out)) this.fault('nonfinite-state')
      outL[frame] = this.out[0]

      if (outR) outR[frame] = this.out[1]
      blockMinimumGain = Math.min(blockMinimumGain, this.enabled ? this.kernel.gainReduction() : 1)
    }

    this.meterFrames += outL.length
    this.minimumGain = Math.min(this.minimumGain, blockMinimumGain)

    if (this.metering && this.meterFrames >= 2048) {
      this.meterFrames %= 2048
      this.port.postMessage({ type: 'meter', version: 1, gainReductionDb: -20 * Math.log10(Math.max(this.minimumGain, 1e-12)) })
      this.minimumGain = 1
    }

    return true
  }
}

registerProcessor('daw-limiter-processor', DawLimiterProcessor)
