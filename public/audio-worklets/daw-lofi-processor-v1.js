// Mirrors native/audio-core/src/lofi_kernel.h and processor_lofi.cpp operation for operation (the legacy path must stay within 1e-5
// of the core), so keep the three in step. Math.fround stands where the core rounds to float: every value that crosses the
// processor boundary and every smoother output; the arithmetic in between is double, as in the core.
const f = Math.fround

const CONTROL_FRAMES = 8
const MINIMUM_BITS = 2
const MAXIMUM_BITS = 24
const CUTOFF_OF_RATE = 0.4
const RIPPLE_DB = 0.5
const SECTIONS = 3
const ROUND = 0
const FLOOR = 1
const TRUNCATE = 2
const OFF = 0
const RECTANGULAR = 1
const TRIANGULAR = 2
const QUANTIZATIONS = ['round', 'floor', 'truncate']
const DITHERS = ['off', 'rectangular', 'triangular']
const DENORMAL_FLOOR_DOUBLE = 1e-154

const flushDouble = (value) => Math.abs(value) < DENORMAL_FLOOR_DOUBLE ? 0 : value
const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
const isObject = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]'

const bypassStep = (current, target, step) => {
  if (target > current + step) return f(current + step)

  if (target < current - step) return f(current - step)

  return target
}

// ParameterSmoother: a one-pole in double whose output is rounded to float; Log smooths in the log domain.
class Smoother {
  constructor(log) {
    this.log = log
    this.coefficient = 1
    this.current = 0
    this.target = 0
    this.targetValue = 0
    this.output = 0
    this.settling = false
  }
  prepare(rate, timeMs) {
    this.coefficient = 1 - Math.exp(-1000 / (timeMs * rate))
    this.settling = this.settling && Math.abs(this.target - this.current) > 1e-5

    if (!this.settling) this.current = this.target
  }
  toDomain(value) { return this.log ? Math.log(value) : value }
  reset(value) {
    if (!Number.isFinite(value)) return
    this.targetValue = this.log ? f(Math.max(value, f(1e-12))) : value
    this.target = this.toDomain(this.targetValue)
    this.current = this.target
    this.settling = false
    this.output = this.targetValue
  }
  setTarget(value) {
    if (!Number.isFinite(value)) return
    const next = this.log ? f(Math.max(value, f(1e-12))) : value

    if (next === this.targetValue) return
    this.targetValue = next
    this.target = this.toDomain(next)
    this.settling = Math.abs(this.target - this.current) > 1e-5

    if (!this.settling) {
      this.current = this.target
      this.output = this.targetValue
    }
  }
  next() {
    if (!this.settling) return this.targetValue
    this.current += this.coefficient * (this.target - this.current)

    if (Math.abs(this.target - this.current) <= 1e-5) {
      this.current = this.target
      this.settling = false
      this.output = this.targetValue
    } else {
      this.output = f(this.log ? Math.exp(this.current) : this.current)
    }

    return this.output
  }
}

// Biquad<double>: transposed direct form II; a non-finite output returns the section to rest.
class Biquad {
  constructor() {
    this.s1 = 0
    this.s2 = 0
  }
  reset() {
    this.s1 = 0
    this.s2 = 0
  }
  process(x, c) {
    const y = c.b0 * x + this.s1
    this.s1 = flushDouble(c.b1 * x - c.a1 * y + this.s2)
    this.s2 = flushDouble(c.b2 * x - c.a2 * y)

    if (Number.isFinite(y)) return y
    this.reset()

    return 0
  }
}

// Chebyshev type I, even order, as three biquads by the bilinear transform; the DC gain is brought back to unity.
const designFilter = (cutoffHz, rate) => {
  const epsilon = Math.sqrt(10 ** (RIPPLE_DB / 10) - 1)
  const mu = Math.asinh(1 / epsilon) / (2 * SECTIONS)
  const k = 1 / Math.tan(Math.PI * Math.min(cutoffHz, 0.49 * rate) / rate)
  const sections = []

  for (let i = 0; i < SECTIONS; i += 1) {
    const theta = (2 * i + 1) * Math.PI / (4 * SECTIONS)
    const sigma = Math.sinh(mu) * Math.sin(theta)
    const omega = Math.cosh(mu) * Math.cos(theta)
    const rho = sigma * sigma + omega * omega
    const a0 = k * k + 2 * sigma * k + rho
    const gain = (i === 0 ? 10 ** (RIPPLE_DB / 20) : 1) * rho / a0

    sections.push({ b0: gain, b1: 2 * gain, b2: gain, a1: (2 * rho - 2 * k * k) / a0, a2: (k * k - 2 * sigma * k + rho) / a0 })
  }

  return sections
}

const bitCount = (value) => clamp(Math.floor(value + 0.5), MINIMUM_BITS, MAXIMUM_BITS)

const random = (channel) => {
  let value = channel.randomState

  value ^= value << 13
  value ^= value >>> 17
  value ^= value << 5
  channel.randomState = value >>> 0 || 1

  return channel.randomState / 0x100000000
}

const quantize = (scaled, mode) => {
  if (mode === FLOOR) return Math.floor(scaled)

  if (mode === TRUNCATE) return Math.trunc(scaled)

  return Math.floor(scaled + 0.5)
}

const createChannel = () => ({
  phase: 1,
  interval: 1,
  held: 0,
  randomState: 0,
  pre: [new Biquad(), new Biquad(), new Biquad()],
  post: [new Biquad(), new Biquad(), new Biquad()],
})

class LoFiKernel {
  constructor(rate) {
    this.rate = rate
    this.mix = new Smoother(false)
    this.noise = new Smoother(false)
    this.rateHz = new Smoother(true)
    this.mix.prepare(rate, 10)
    this.noise.prepare(rate, 20)
    this.rateHz.prepare(rate, 20)
    this.initialized = false
    this.config = { quantization: ROUND, dither: OFF, seed: 1, preFilter: false, postFilter: false, dcCorrection: false }
    this.channels = [createChannel(), createChannel()]
    this.sections = [null, null, null]
    this.frame = 0
    this.bits = 12
    this.levels = 2047
    this.jitter = 0
    this.noiseGain = 1
    this.lastNoiseDb = 1000
    this.ratio = 1
    this.lastRateHz = -1
    this.filterStale = true
    this.result = [0, 0]
  }

  controlDue() { return (this.frame & (CONTROL_FRAMES - 1)) === 0 }

  initialize(values, config) {
    this.mix.reset(values.mix)
    this.noise.reset(values.noiseDb)
    this.rateHz.reset(values.sampleRateHz)
    this.config = { ...config }

    for (let c = 0; c < 2; c += 1) {
      const seed = (config.seed ^ (c === 0 ? 0 : 0x9e3779b9)) >>> 0

      this.channels[c].randomState = seed === 0 ? 1 : seed
    }

    this.initialized = true
  }

  apply(values, config) {
    if (config.preFilter !== this.config.preFilter || config.postFilter !== this.config.postFilter) {
      for (const channel of this.channels) {
        for (const section of channel.pre) section.reset()

        for (const section of channel.post) section.reset()
      }

      this.filterStale = true
    }

    this.config = { ...config }
    this.mix.setTarget(values.mix)
    this.noise.setTarget(values.noiseDb)
    this.rateHz.setTarget(values.sampleRateHz)
    this.bits = bitCount(values.bitDepth)
    this.levels = 2 ** (this.bits - 1) - 1
    this.jitter = values.jitter
  }

  renderChannel(channel, dry, mix, reduced, pre, post) {
    let x = dry

    if (pre) {
      for (let i = 0; i < SECTIONS; i += 1) x = channel.pre[i].process(x, this.sections[i])
    }

    channel.phase += this.ratio

    if (channel.phase >= channel.interval) {
      channel.phase -= channel.interval
      channel.interval = 1 + (random(channel) - 0.5) * this.jitter
      let sample = x + (random(channel) * 2 - 1) * this.noiseGain
      const lsb = 1 / this.levels

      if (this.config.dither === RECTANGULAR) {
        sample += (random(channel) - 0.5) * lsb
      } else if (this.config.dither === TRIANGULAR) {
        const first = random(channel)
        const second = random(channel)

        sample += (first - second) * lsb
      }

      // Floor rounds every value down, so its error averages minus half an LSB and silence sits at minus one LSB. The correction shifts
      // the decision point by half an LSB, which centres that error (and makes silence exact).
      const bias = this.config.dcCorrection && this.config.quantization === FLOOR ? 0.5 : 0
      const quantized = quantize(sample * this.levels + bias, this.config.quantization) / this.levels

      channel.held = this.bits < MAXIMUM_BITS || reduced ? clamp(quantized, -1, 1) : quantized
    }

    let wet = channel.held

    if (post) {
      for (let i = 0; i < SECTIONS; i += 1) wet = channel.post[i].process(wet, this.sections[i])
    }

    return dry + (wet - dry) * mix
  }

  process(values, config, inputLeft, inputRight, out) {
    const tick = this.controlDue()

    if (!this.initialized) this.initialize(values, config)

    if (tick) this.apply(values, config)
    const mix = this.mix.next()
    const noiseDb = this.noise.next()

    if (noiseDb !== this.lastNoiseDb) {
      this.noiseGain = 10 ** (noiseDb / 20)
      this.lastNoiseDb = noiseDb
    }

    const rateHz = this.rateHz.next()

    if (rateHz !== this.lastRateHz) {
      this.ratio = Math.min(1, rateHz / this.rate)
      this.lastRateHz = rateHz
      this.filterStale = true
    }

    const reduced = this.ratio < 1
    const pre = this.config.preFilter && reduced
    const post = this.config.postFilter && reduced

    if (tick && this.filterStale && (pre || post)) {
      this.sections = designFilter(CUTOFF_OF_RATE * rateHz, this.rate)
      this.filterStale = false
    }

    out[0] = f(this.renderChannel(this.channels[0], Number.isFinite(inputLeft) ? inputLeft : 0, mix, reduced, pre, post))
    out[1] = f(this.renderChannel(this.channels[1], Number.isFinite(inputRight) ? inputRight : 0, mix, reduced, pre, post))
    this.frame += 1
  }
}

class DawLoFiProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'lofi.bitDepth', defaultValue: 12, minValue: 2, maxValue: 24, automationRate: 'a-rate' },
      { name: 'lofi.sampleRateHz', defaultValue: 96000, minValue: 100, maxValue: 96000, automationRate: 'a-rate' },
      { name: 'lofi.jitter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'lofi.noiseDb', defaultValue: -80, minValue: -120, maxValue: -24, automationRate: 'a-rate' },
      { name: 'lofi.mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
    ]
  }

  constructor(_options) {
    super()
    this.revision = -1
    this.enabled = true
    this.config = { quantization: ROUND, dither: OFF, seed: 1, preFilter: false, postFilter: false, dcCorrection: false }
    this.kernel = new LoFiKernel(sampleRate)
    this.values = { bitDepth: 12, sampleRateHz: 96000, jitter: 0, noiseDb: -80, mix: 1 }
    this.out = new Float64Array(2)
    this.bypassFrames = Math.floor((sampleRate + 50) / 100)
    this.bypass = 0
    this.faults = 0
    this.port.onmessage = (event) => this.onMessage(event.data)
    this.port.postMessage({ type: 'ready', version: 1 })
  }

  onMessage(message) {
    if (!isObject(message) || message.version !== 1) return this.fault('malformed-message')

    if (message.type === 'dispose') return this.port.close()

    if (message.type === 'reset') return this.reset()

    if (message.type !== 'configure' || !Number.isInteger(message.revision) || message.revision <= this.revision || !isObject(message.state)) return this.fault('malformed-or-stale-configure')
    const state = message.state
    const seed = Number.isInteger(state.seed) && state.seed > 0 ? state.seed >>> 0 : 1

    const config = {
      quantization: Math.max(0, QUANTIZATIONS.indexOf(state.quantization)),
      dither: Math.max(0, DITHERS.indexOf(state.dither)),
      seed,
      preFilter: state.preFilter === true,
      postFilter: state.postFilter === true,
      dcCorrection: state.dcCorrection === true,
    }

    const seedChanged = seed !== this.config.seed

    this.revision = message.revision
    this.enabled = state.enabled !== false
    this.config = config

    if (seedChanged) this.reset()
    this.port.postMessage({ type: 'configured', version: 1, revision: this.revision })
  }

  reset() {
    this.kernel = new LoFiKernel(sampleRate)
    this.bypass = this.enabled ? 0 : 1
  }

  fault(code) {
    if (this.faults++ < 4) this.port.postMessage({ type: 'fault', version: 1, code })
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] ?? []
    const output = outputs[0] ?? []
    const outputLeft = output[0]
    const outputRight = output[1] ?? outputLeft

    if (!outputLeft || !outputRight) return true
    const inputLeft = input[0]
    const inputRight = input[1] ?? inputLeft
    const values = this.values
    const step = f(1 / (this.bypassFrames === 0 ? 1 : this.bypassFrames))
    const at = (name, frame) => f(parameters[name][parameters[name].length === 1 ? 0 : frame])

    for (let frame = 0; frame < outputLeft.length; frame += 1) {
      const dryLeft = inputLeft ? inputLeft[frame] : 0
      const dryRight = inputRight ? inputRight[frame] : dryLeft
      const left = Number.isFinite(dryLeft) ? f(dryLeft) : 0
      const right = Number.isFinite(dryRight) ? f(dryRight) : 0

      if (!Number.isFinite(dryLeft) || !Number.isFinite(dryRight)) this.fault('nonfinite-input')

      if (this.kernel.controlDue()) {
        values.bitDepth = at('lofi.bitDepth', frame)
        values.sampleRateHz = at('lofi.sampleRateHz', frame)
        values.jitter = at('lofi.jitter', frame)
        values.noiseDb = at('lofi.noiseDb', frame)
        values.mix = at('lofi.mix', frame)
      }

      this.kernel.process(values, this.config, left, right, this.out)
      this.bypass = bypassStep(this.bypass, this.enabled ? 0 : 1, step)
      outputLeft[frame] = this.blend(this.out[0], left)
      outputRight[frame] = this.blend(this.out[1], right)
    }

    return true
  }

  blend(processed, dry) {
    if (this.bypass <= 0) return Number.isFinite(processed) ? processed : dry

    if (this.bypass >= 1) return dry

    return Number.isFinite(processed) ? f(processed + f(f(dry - processed) * this.bypass)) : dry
  }
}

registerProcessor('daw-lofi-processor', DawLoFiProcessor)
