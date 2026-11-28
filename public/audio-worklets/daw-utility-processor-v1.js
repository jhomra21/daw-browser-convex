// Mirrors native/audio-core/src/utility_kernel.h and processor_utility.cpp operation for operation (the legacy path must stay
// within 1e-5 of the core), so keep the three in step. Math.fround stands where the core rounds to float: every value that
// crosses the processor boundary and every smoother output; the arithmetic in between is double, as in the core.
const f = Math.fround

const CONTROL_FRAMES = 8
const GAIN_FLOOR_DB = -70
const DC_CORNER_HZ = 4
const DENORMAL_FLOOR_DOUBLE = 1e-154
const DENORMAL_FLOOR_FLOAT = f(1e-19)
const ROOT_TWO = Math.SQRT2
const MATRICES = ['stereo', 'mid-side-encode', 'mid-side-decode']
const CHANNEL_MODES = ['both', 'left', 'right', 'swap']

const flushDouble = (value) => Math.abs(value) < DENORMAL_FLOOR_DOUBLE ? 0 : value
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

// Butterworth sections for a Linkwitz-Riley split: two identical 2nd-order sections in series, low-pass and high-pass.
const designSections = (cutoffHz, rate) => {
  const k = Math.tan(Math.PI * Math.min(Math.max(cutoffHz, 20), 0.45 * rate) / rate)
  const norm = 1 / (1 + ROOT_TWO * k + k * k)
  const a1 = 2 * (k * k - 1) * norm
  const a2 = (1 - ROOT_TWO * k + k * k) * norm

  return {
    low: { b0: k * k * norm, b1: 2 * k * k * norm, b2: k * k * norm, a1, a2 },
    high: { b0: norm, b1: -2 * norm, b2: norm, a1, a2 },
  }
}

const createChannel = () => ({ x1: 0, y1: 0, low: [new Biquad(), new Biquad()], high: [new Biquad(), new Biquad()] })

const gainTarget = (gainDb) => gainDb <= GAIN_FLOOR_DB ? 0 : f(10 ** (gainDb / 20))

class UtilityKernel {
  constructor(rate) {
    this.rate = rate
    this.gain = new Smoother(false)
    this.audible = new Smoother(false)
    this.balance = new Smoother(false)
    this.width = new Smoother(false)
    this.midSide = new Smoother(false)
    this.bassHz = new Smoother(true)
    this.gain.prepare(rate, 10)
    this.audible.prepare(rate, 10)
    this.balance.prepare(rate, 10)
    this.width.prepare(rate, 10)
    this.midSide.prepare(rate, 10)
    this.bassHz.prepare(rate, 20)
    this.dcCoefficient = Math.exp(-2 * Math.PI * DC_CORNER_HZ / rate)
    this.initialized = false
    this.config = null
    this.channels = [createChannel(), createChannel()]
    this.low = null
    this.high = null
    this.frame = 0
    this.lastGainDb = 0
    this.lastBassHz = -1
    this.filterStale = true
    this.result = [0, 0]
  }

  controlDue() { return (this.frame & (CONTROL_FRAMES - 1)) === 0 }

  resetChannels() { this.channels = [createChannel(), createChannel()] }

  initialize(values, config) {
    this.gain.reset(gainTarget(values.gainDb))
    this.audible.reset(config.mute ? 0 : 1)
    this.balance.reset(values.balance)
    this.width.reset(values.width)
    this.midSide.reset(values.midSide)
    this.bassHz.reset(values.bassMonoHz)
    this.lastGainDb = values.gainDb
    this.config = { ...config }
    this.initialized = true
  }

  apply(values, config) {
    if (config.bassMono !== this.config.bassMono) {
      for (const channel of this.channels) {
        for (const section of channel.low) section.reset()

        for (const section of channel.high) section.reset()
      }

      this.filterStale = true
    }

    this.config = { ...config }

    if (values.gainDb !== this.lastGainDb) {
      this.lastGainDb = values.gainDb
      this.gain.setTarget(gainTarget(values.gainDb))
    }

    this.audible.setTarget(config.mute ? 0 : 1)
    this.balance.setTarget(values.balance)
    this.width.setTarget(values.width)
    this.midSide.setTarget(values.midSide)
    this.bassHz.setTarget(values.bassMonoHz)
  }

  // The lows of both channels are summed to one signal; the highs stay per channel.
  splitBass(left, right) {
    const band = (channel, x) => [
      channel.low[1].process(channel.low[0].process(x, this.low), this.low),
      channel.high[1].process(channel.high[0].process(x, this.high), this.high),
    ]

    const [lowLeft, highLeft] = band(this.channels[0], left)
    const [lowRight, highRight] = band(this.channels[1], right)
    const low = 0.5 * (lowLeft + lowRight)

    this.result[0] = this.config.bassMonoAudition ? low : low + highLeft
    this.result[1] = this.config.bassMonoAudition ? low : low + highRight
  }

  // y[n] = x[n] - x[n-1] + R y[n-1]. The state is flushed at the float floor so silence settles to exact zeros.
  blockDc(channel, x) {
    const y = x - channel.x1 + this.dcCoefficient * channel.y1

    channel.x1 = x
    channel.y1 = Math.abs(y) < DENORMAL_FLOOR_FLOAT ? 0 : y

    return channel.y1
  }

  process(values, config, inputLeft, inputRight, out) {
    const tick = this.controlDue()

    if (!this.initialized) this.initialize(values, config)

    if (tick) this.apply(values, config)
    const gain = this.gain.next() * this.audible.next()
    const balance = this.balance.next()
    const width = this.width.next()
    const midSide = this.midSide.next()
    const bassHz = this.bassHz.next()

    if (bassHz !== this.lastBassHz) {
      this.lastBassHz = bassHz
      this.filterStale = true
    }

    if (tick && this.filterStale && this.config.bassMono) {
      const { low, high } = designSections(bassHz, this.rate)

      this.low = low
      this.high = high
      this.filterStale = false
    }

    const cfg = this.config
    let left = Number.isFinite(inputLeft) ? inputLeft : 0
    let right = Number.isFinite(inputRight) ? inputRight : 0

    if (cfg.mono) left = right = 0.5 * left + 0.5 * right

    if (cfg.phaseLeft) left = -left

    if (cfg.phaseRight) right = -right

    if (cfg.matrix === 1) {
      const mid = (left + right) * Math.SQRT1_2

      right = (left - right) * Math.SQRT1_2
      left = mid
    } else if (cfg.matrix === 2) {
      const mid = left

      left = (mid + right) * Math.SQRT1_2
      right = (mid - right) * Math.SQRT1_2
    }

    if (cfg.channelMode === 1) {
      right = left
    } else if (cfg.channelMode === 2) {
      left = right
    } else {
      if (cfg.channelMode === 3) { const swap = left; left = right; right = swap }

      const bySide = cfg.widthMode === 1
      const midGain = bySide && midSide > 0 ? 1 - midSide : 1
      const sideGain = bySide ? (midSide < 0 ? 1 + midSide : 1) : width
      const mid = (left + right) * Math.SQRT1_2 * midGain
      const side = (left - right) * Math.SQRT1_2 * sideGain

      left = (mid + side) * Math.SQRT1_2
      right = (mid - side) * Math.SQRT1_2
    }

    if (balance > 0) left *= 1 - balance

    if (balance < 0) right *= 1 + balance
    left *= gain
    right *= gain

    if (cfg.bassMono) {
      this.splitBass(left, right)
      left = this.result[0]
      right = this.result[1]
    }

    if (cfg.dcBlock) {
      left = this.blockDc(this.channels[0], left)
      right = this.blockDc(this.channels[1], right)
    }

    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      left = right = 0
      this.resetChannels()
    }

    this.frame += 1
    out[0] = f(left)
    out[1] = f(right)
  }
}

const isUtilityMessage = (message) => isObject(message) && message.version === 1

const isUtilityConfigureMessage = (message, revision) => isUtilityMessage(message)
  && message.type === 'configure'
  && Number.isInteger(message.revision)
  && message.revision > revision
  && isObject(message.state)

const DEFAULT_CONFIG = { phaseLeft: false, phaseRight: false, mono: false, matrix: 0, channelMode: 0, widthMode: 0, mute: false, bassMono: false, bassMonoAudition: false, dcBlock: false }

class DawUtilityProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      ['utility.gainDb', 0, GAIN_FLOOR_DB, 35],
      ['utility.balance', 0, -1, 1],
      ['utility.width', 1, 0, 2],
      ['utility.midSide', 0, -1, 1],
      ['utility.bassMonoHz', 120, 50, 500],
    ].map(([name, defaultValue, minValue, maxValue]) => ({ name, defaultValue, minValue, maxValue, automationRate: 'a-rate' }))
  }

  constructor() {
    super()
    this.revision = -1
    this.enabled = true
    this.config = DEFAULT_CONFIG
    this.kernel = new UtilityKernel(sampleRate)
    this.values = { gainDb: 0, balance: 0, width: 1, midSide: 0, bassMonoHz: 120 }
    this.out = new Float64Array(2)
    this.bypassFrames = Math.floor((sampleRate + 50) / 100)
    this.bypass = 0
    this.faults = 0
    this.port.onmessage = (event) => this.onMessage(event.data)
    this.port.postMessage({ type: 'ready', version: 1 })
  }

  onMessage(message) {
    if (!isUtilityMessage(message)) return this.fault('malformed-message')

    if (message.type === 'dispose') return this.port.close()

    if (message.type === 'reset') return this.reset()

    if (!isUtilityConfigureMessage(message, this.revision)) return this.fault('malformed-or-stale-configure')
    const state = message.state

    this.revision = message.revision
    this.enabled = state.enabled !== false

    this.config = {
      phaseLeft: state.phaseLeft === true,
      phaseRight: state.phaseRight === true,
      mono: state.inputMode === 'mono-sum',
      matrix: Math.max(0, MATRICES.indexOf(state.matrix)),
      channelMode: Math.max(0, CHANNEL_MODES.indexOf(state.channelMode)),
      widthMode: state.widthMode === 'mid-side' ? 1 : 0,
      mute: state.mute === true,
      bassMono: state.bassMono === true,
      bassMonoAudition: state.bassMonoAudition === true,
      dcBlock: state.dcBlock === true,
    }

    this.port.postMessage({ type: 'configured', version: 1, revision: this.revision })
  }

  reset() {
    this.kernel = new UtilityKernel(sampleRate)
    this.bypass = this.enabled ? 0 : 1
  }

  fault(code) {
    if (this.faults++ < 4) this.port.postMessage({ type: 'fault', version: 1, code })
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]
    const output = outputs[0]

    if (!output || output.length === 0) return true
    const leftIn = input && input[0]
    const rightIn = input && (input[1] || input[0])
    const leftOut = output[0]
    const rightOut = output[1]
    const values = this.values
    const step = f(1 / (this.bypassFrames === 0 ? 1 : this.bypassFrames))
    const at = (name, frame) => f(parameters[name][parameters[name].length === 1 ? 0 : frame])

    for (let i = 0; i < leftOut.length; i++) {
      const dryL = leftIn ? leftIn[i] : 0
      const dryR = rightIn ? rightIn[i] : dryL
      const left = Number.isFinite(dryL) ? f(dryL) : 0
      const right = Number.isFinite(dryR) ? f(dryR) : 0

      if (!Number.isFinite(dryL) || !Number.isFinite(dryR)) this.fault('nonfinite-input')

      if (this.kernel.controlDue()) {
        values.gainDb = at('utility.gainDb', i)
        values.balance = at('utility.balance', i)
        values.width = at('utility.width', i)
        values.midSide = at('utility.midSide', i)
        values.bassMonoHz = at('utility.bassMonoHz', i)
      }

      this.kernel.process(values, this.config, left, right, this.out)
      this.bypass = bypassStep(this.bypass, this.enabled ? 0 : 1, step)
      leftOut[i] = this.blend(this.out[0], left)

      if (rightOut) rightOut[i] = this.blend(this.out[1], right)
    }

    return true
  }

  blend(processed, dry) {
    if (this.bypass <= 0) return processed

    if (this.bypass >= 1) return dry

    return f(processed + f(f(dry - processed) * this.bypass))
  }
}

registerProcessor('daw-utility-processor', DawUtilityProcessor)
