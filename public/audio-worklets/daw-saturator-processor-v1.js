// Mirrors native/audio-core/src/saturator_kernel.h and processor_saturator.cpp operation for operation (the legacy path must stay
// within 1e-5 of the core), so keep the three in step. Math.fround stands where the core rounds to float: every value that crosses
// the processor boundary and every smoother output; the arithmetic in between is double, as in the core.
const f = Math.fround

const CURVES = ['soft', 'medium', 'hard', 'clip', 'analog', 'sine', 'bass', 'fold', 'warp']
const POST_CLIPS = ['off', 'soft', 'hard']
const SOFT = 0
const MEDIUM = 1
const HARD = 2
const CLIP = 3
const ANALOG = 4
const SINE = 5
const BASS = 6
const FOLD = 7
const WARP = 8
const CONTROL_FRAMES = 8
const HARD_SLOPE = Math.PI / 2
const MEDIUM_REACH = 1.5
const ANALOG_THRESHOLD = 0.5
const MINIMUM_KNEE = 1e-4
const MINIMUM_STEP = 1e-5
const DENORMAL_FLOOR_DOUBLE = 1e-154
const DROOP = { b0: 1.1184109778187417, b1: -0.3453123670227823, b2: -0.1566534332029562, a1: -0.17724601331356163, a2: -0.2063088090934353 }

const flushDouble = (value) => Math.abs(value) < DENORMAL_FLOOR_DOUBLE ? 0 : value
const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
const copySign = (magnitude, sign) => sign < 0 || Object.is(sign, -0) ? -magnitude : magnitude
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

// PolyphaseIirHalfBand2x: two all-pass branches, six coefficients, computed once from the transition width.
const HALF_BAND_COEFFICIENTS = 6
const HALF_BAND_TRANSITION = 0.05

const accumulateNumerator = (q, order, c) => {
  let sum = 0
  let sign = 1

  for (let i = 0; i < 40; i += 1) {
    sum += q ** (i * (i + 1)) * Math.sin((2 * i + 1) * c * Math.PI / order) * sign
    sign = -sign
  }

  return sum
}

const accumulateDenominator = (q, order, c) => {
  let sum = 0
  let sign = -1

  for (let i = 1; i < 40; i += 1) {
    sum += q ** (i * i) * Math.cos(2 * i * c * Math.PI / order) * sign
    sign = -sign
  }

  return sum
}

const designHalfBand = () => {
  const k = Math.tan((1 - 2 * HALF_BAND_TRANSITION) * Math.PI / 4)
  const root = (1 - k * k) ** 0.25
  const e = 0.5 * (1 - root) / (1 + root)
  const e4 = e * e * e * e
  const q = e * (1 + e4 * (2 + e4 * (15 + 150 * e4)))
  const order = 2 * HALF_BAND_COEFFICIENTS + 1
  const sorted = []

  for (let i = 0; i < HALF_BAND_COEFFICIENTS; i += 1) {
    const c = i + 1
    const w = accumulateNumerator(q, order, c) * q ** 0.25 / (accumulateDenominator(q, order, c) + 0.5)
    const w2 = w * w
    const x = Math.sqrt((1 - w2 * k) * (1 - w2 / k)) / (1 + w2)

    sorted.push((1 - x) / (1 + x))
  }

  sorted.sort((a, b) => a - b)

  return { branch0: sorted.filter((_, i) => i % 2 === 0), branch1: sorted.filter((_, i) => i % 2 === 1) }
}

const HALF_BAND = designHalfBand()

const cascade = (states, coefficients, input) => {
  let x = input

  for (let i = 0; i < coefficients.length; i += 1) {
    const y = coefficients[i] * x + states[i]

    states[i] = flushDouble(x - coefficients[i] * y)
    x = y
  }

  return x
}

class HalfBand {
  constructor() {
    this.up0 = new Float64Array(HALF_BAND.branch0.length)
    this.up1 = new Float64Array(HALF_BAND.branch1.length)
    this.down0 = new Float64Array(HALF_BAND.branch0.length)
    this.down1 = new Float64Array(HALF_BAND.branch1.length)
    this.downDelay = 0
    this.pair = [0, 0]
  }
  reset() {
    this.up0.fill(0)
    this.up1.fill(0)
    this.down0.fill(0)
    this.down1.fill(0)
    this.downDelay = 0
  }
  up(x) {
    if (!Number.isFinite(x)) {
      this.reset()
      this.pair[0] = 0
      this.pair[1] = 0

      return this.pair
    }

    this.pair[0] = cascade(this.up0, HALF_BAND.branch0, x)
    this.pair[1] = cascade(this.up1, HALF_BAND.branch1, x)

    return this.pair
  }
  down(first, second) {
    if (!Number.isFinite(first) || !Number.isFinite(second)) {
      this.reset()

      return 0
    }

    const y = 0.5 * (cascade(this.down0, HALF_BAND.branch0, first) + this.downDelay)

    this.downDelay = cascade(this.down1, HALF_BAND.branch1, second)

    return y
  }
}

const logcosh = (x) => {
  const a = Math.abs(x)

  return a + Math.log1p(Math.exp(-2 * a)) - Math.LN2
}

// Linear up to t, then t + h tanh((x - t) / h), h = 1 - t: slope one, asymptote one, no corner.
const knee = (a, t) => {
  if (a <= t) return a
  const h = Math.max(1 - t, MINIMUM_KNEE)

  return t + h * Math.tanh((a - t) / h)
}

const kneeIntegral = (a, t) => {
  if (a <= t) return 0.5 * a * a
  const h = Math.max(1 - t, MINIMUM_KNEE)

  return 0.5 * t * t + t * (a - t) + h * h * logcosh((a - t) / h)
}

const curveKnobs = { threshold: 0.25, depth: 0.5, period: 0.5 }

const curveValue = (curve, u) => {
  switch (curve) {
    case MEDIUM: {
      const c = clamp(u, -MEDIUM_REACH, MEDIUM_REACH)

      return c - c * c * c / 6.75
    }

    case HARD: return Math.atan(HARD_SLOPE * u) / HARD_SLOPE
    case CLIP: return clamp(u, -1, 1)
    case ANALOG: return copySign(knee(Math.abs(u), ANALOG_THRESHOLD), u)
    case SINE: return Math.sin(clamp(u, -0.5 * Math.PI, 0.5 * Math.PI))
    case BASS: return copySign(knee(Math.abs(u), curveKnobs.threshold), u)
    case FOLD: return Math.sin(u)
    case WARP: return (1 - curveKnobs.depth) * Math.tanh(u) + curveKnobs.depth * curveKnobs.period * Math.sin(u / curveKnobs.period)
    default: return Math.tanh(u)
  }
}

const curveIntegral = (curve, u) => {
  const a = Math.abs(u)

  switch (curve) {
    case MEDIUM: return a <= MEDIUM_REACH ? 0.5 * u * u - u * u * u * u / 27 : a - 0.5625
    case HARD: return (u * Math.atan(HARD_SLOPE * u) - Math.log1p(HARD_SLOPE * HARD_SLOPE * u * u) / (2 * HARD_SLOPE)) / HARD_SLOPE
    case CLIP: return a <= 1 ? 0.5 * u * u : a - 0.5
    case ANALOG: return kneeIntegral(a, ANALOG_THRESHOLD)
    case SINE: return a <= 0.5 * Math.PI ? 1 - Math.cos(u) : a - 0.5 * Math.PI + 1
    case BASS: return kneeIntegral(a, curveKnobs.threshold)
    case FOLD: return 1 - Math.cos(u)
    case WARP: return (1 - curveKnobs.depth) * logcosh(u) + curveKnobs.depth * curveKnobs.period * curveKnobs.period * (1 - Math.cos(u / curveKnobs.period))
    default: return logcosh(u)
  }
}

// First-order ADAA: the curve's average over the step; the curve at the midpoint when the inputs are closer than MINIMUM_STEP.
class Adaa {
  constructor() {
    this.previous = 0
    this.previousIntegral = 0
  }
  reset() {
    this.previous = 0
    this.previousIntegral = 0
  }
  process(curve, x, knobsMoved) {
    const integral = curveIntegral(curve, x)

    if (knobsMoved) this.previousIntegral = curveIntegral(curve, this.previous)
    const step = x - this.previous
    const y = Math.abs(step) < MINIMUM_STEP ? curveValue(curve, 0.5 * (x + this.previous)) : (integral - this.previousIntegral) / step

    this.previous = x
    this.previousIntegral = integral

    return y
  }
}

// RBJ shelf; the post-EQ is the same design at the negated gain, which inverts the pre-EQ exactly.
const shelf = (low, hz, q, gainDb, rate) => {
  const a = 10 ** (gainDb / 40)
  const w = 2 * Math.PI * Math.min(hz, 0.49 * rate) / rate
  const c = Math.cos(w)
  const beta = 2 * Math.sqrt(a) * (Math.sin(w) / (2 * q))
  const sign = low ? 1 : -1
  const a0 = (a + 1) + sign * (a - 1) * c + beta

  return {
    b0: a * ((a + 1) - sign * (a - 1) * c + beta) / a0,
    b1: sign * 2 * a * ((a - 1) - sign * (a + 1) * c) / a0,
    b2: a * ((a + 1) - sign * (a - 1) * c - beta) / a0,
    a1: -sign * 2 * ((a - 1) + sign * (a + 1) * c) / a0,
    a2: ((a + 1) + sign * (a - 1) * c - beta) / a0,
  }
}

const colorQ = (width) => 2 * 0.2 ** clamp(width, 0, 1)

const createChannel = () => ({
  pre: [new Biquad(), new Biquad()],
  post: [new Biquad(), new Biquad()],
  oversampler: new HalfBand(),
  clipOversampler: new HalfBand(),
  droop: new Biquad(),
  clipDroop: new Biquad(),
  curveStage: new Adaa(),
  clip: new Adaa(),
})

class SaturatorKernel {
  constructor(rate) {
    this.rate = rate
    this.drive = new Smoother(false)
    this.output = new Smoother(false)
    this.wet = new Smoother(false)
    this.frequency = new Smoother(true)
    this.width = new Smoother(false)
    this.low = new Smoother(false)
    this.high = new Smoother(false)
    this.threshold = new Smoother(false)
    this.depth = new Smoother(false)
    this.period = new Smoother(false)
    this.drive.prepare(rate, 10)
    this.output.prepare(rate, 10)
    this.wet.prepare(rate, 10)
    this.frequency.prepare(rate, 20)

    for (const smoother of [this.width, this.low, this.high, this.threshold, this.depth, this.period]) smoother.prepare(rate, 20)
    this.initialized = false
    this.applied = { curve: 0, postClip: 0, hiQuality: true, color: false }
    this.channels = [createChannel(), createChannel()]
    this.frame = 0
    this.designed = [0, 0, 0, 0]
    this.shelvesActive = false
    this.shelves = null
    this.driveGain = 1
    this.outputGain = 1
    this.lastDriveDb = -1000
    this.lastOutputDb = -1000
    this.lastThresholdDb = 1000
    this.lastDepth = -1
    this.lastPeriod = -1
    this.result = [0, 0]
  }

  reset() {
    this.channels = [createChannel(), createChannel()]
    this.frame = 0
    this.designed = [0, 0, 0, 0]
    this.shelvesActive = false
  }

  controlDue() { return (this.frame & (CONTROL_FRAMES - 1)) === 0 }

  initialize(values, config) {
    this.drive.reset(values.driveDb)
    this.output.reset(values.outputDb)
    this.wet.reset(values.dryWet)
    this.frequency.reset(values.colorFrequencyHz)
    this.width.reset(values.colorWidth)
    this.low.reset(config.color ? values.colorLowDb : 0)
    this.high.reset(config.color ? values.colorHighDb : 0)
    this.threshold.reset(values.bassThresholdDb)
    this.depth.reset(values.warpDepth)
    this.period.reset(values.warpPeriod)
    this.applied = { ...config }
    this.initialized = true
  }

  apply(values, config) {
    if (config.hiQuality !== this.applied.hiQuality || config.curve !== this.applied.curve || config.postClip !== this.applied.postClip) {
      for (const channel of this.channels) {
        channel.oversampler.reset()
        channel.clipOversampler.reset()
        channel.curveStage.reset()
        channel.clip.reset()
      }
    }

    this.applied = { ...config }
    this.drive.setTarget(values.driveDb)
    this.output.setTarget(values.outputDb)
    this.wet.setTarget(values.dryWet)
    this.frequency.setTarget(values.colorFrequencyHz)
    this.width.setTarget(values.colorWidth)
    this.low.setTarget(config.color ? values.colorLowDb : 0)
    this.high.setTarget(config.color ? values.colorHighDb : 0)
    this.threshold.setTarget(values.bassThresholdDb)
    this.depth.setTarget(values.warpDepth)
    this.period.setTarget(values.warpPeriod)
  }

  designShelves(frequency, width, low, high) {
    const now = [frequency, width, low, high]

    this.shelvesActive = low !== 0 || high !== 0 || this.low.settling || this.high.settling

    if (!this.shelvesActive) {
      for (const channel of this.channels) {
        for (const section of channel.pre) section.reset()

        for (const section of channel.post) section.reset()
      }

      this.designed = [0, 0, 0, 0]

      return
    }

    if (now.every((value, index) => value === this.designed[index])) return
    this.designed = now
    const q = colorQ(width)

    this.shelves = {
      pre: [shelf(true, frequency, q, low, this.rate), shelf(false, frequency, q, high, this.rate)],
      post: [shelf(true, frequency, q, -low, this.rate), shelf(false, frequency, q, -high, this.rate)],
    }
  }

  clipSample(channel, config, x) {
    const curve = config.postClip === 1 ? ANALOG : CLIP

    if (!config.hiQuality) return curveValue(curve, x)
    const pair = channel.clipOversampler.up(x)
    const first = channel.clip.process(curve, pair[0], false)
    const second = channel.clip.process(curve, pair[1], false)

    return clamp(channel.clipDroop.process(channel.clipOversampler.down(first, second), DROOP), -1, 1)
  }

  renderChannel(index, config, dry, wetMix, knobsMoved) {
    const channel = this.channels[index]
    let x = dry

    if (this.shelvesActive) {
      x = channel.pre[0].process(x, this.shelves.pre[0])
      x = channel.pre[1].process(x, this.shelves.pre[1])
    }

    const u = x * this.driveGain
    let wet = 0

    if (config.hiQuality) {
      const pair = channel.oversampler.up(u)
      const first = channel.curveStage.process(config.curve, pair[0], knobsMoved)
      const second = channel.curveStage.process(config.curve, pair[1], false)

      wet = channel.droop.process(channel.oversampler.down(first, second), DROOP)
    } else {
      wet = curveValue(config.curve, u)
    }

    if (this.shelvesActive) {
      wet = channel.post[1].process(wet, this.shelves.post[1])
      wet = channel.post[0].process(wet, this.shelves.post[0])
    }

    if (config.postClip !== 0) wet = this.clipSample(channel, config, wet)
    wet *= this.outputGain

    if (!Number.isFinite(wet)) {
      this.channels[index] = createChannel()
      wet = 0
    }

    return flushDouble(dry + (wet - dry) * wetMix)
  }

  process(values, config, inputLeft, inputRight, out) {
    const tick = this.controlDue()

    if (!this.initialized) this.initialize(values, config)

    if (tick) this.apply(values, config)
    const driveDb = this.drive.next()

    if (driveDb !== this.lastDriveDb) {
      this.driveGain = 10 ** (driveDb / 20)
      this.lastDriveDb = driveDb
    }

    const outputDb = this.output.next()

    if (outputDb !== this.lastOutputDb) {
      this.outputGain = 10 ** (outputDb / 20)
      this.lastOutputDb = outputDb
    }

    const wetMix = this.wet.next()
    const thresholdDb = this.threshold.next()
    const depth = this.depth.next()
    const period = this.period.next()
    const knobsMoved = thresholdDb !== this.lastThresholdDb || depth !== this.lastDepth || period !== this.lastPeriod

    if (knobsMoved) {
      curveKnobs.threshold = 10 ** (thresholdDb / 20)
      curveKnobs.depth = depth
      curveKnobs.period = period
      this.lastThresholdDb = thresholdDb
      this.lastDepth = depth
      this.lastPeriod = period
    }

    const frequency = this.frequency.next()
    const width = this.width.next()
    const low = this.low.next()
    const high = this.high.next()

    if (tick) this.designShelves(frequency, width, low, high)
    const left = this.renderChannel(0, config, Number.isFinite(inputLeft) ? inputLeft : 0, wetMix, knobsMoved)
    const right = this.renderChannel(1, config, Number.isFinite(inputRight) ? inputRight : 0, wetMix, knobsMoved)

    this.frame = (this.frame + 1) >>> 0
    out[0] = f(left)
    out[1] = f(right)
  }
}

class DawSaturatorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'saturator.driveDb', defaultValue: 6, minValue: 0, maxValue: 36, automationRate: 'a-rate' },
      { name: 'saturator.outputDb', defaultValue: 0, minValue: -24, maxValue: 12, automationRate: 'a-rate' },
      { name: 'saturator.dryWet', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'saturator.colorFrequencyHz', defaultValue: 1200, minValue: 100, maxValue: 10000, automationRate: 'a-rate' },
      { name: 'saturator.colorWidth', defaultValue: 0.57, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'saturator.colorLowDb', defaultValue: 0, minValue: -12, maxValue: 12, automationRate: 'a-rate' },
      { name: 'saturator.colorHighDb', defaultValue: 0, minValue: -12, maxValue: 12, automationRate: 'a-rate' },
      { name: 'saturator.bassThresholdDb', defaultValue: -12, minValue: -50, maxValue: 0, automationRate: 'a-rate' },
      { name: 'saturator.warpDepth', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'saturator.warpPeriod', defaultValue: 0.5, minValue: 0.1, maxValue: 1, automationRate: 'a-rate' },
    ]
  }

  constructor() {
    super()
    this.kernel = new SaturatorKernel(sampleRate)
    this.enabled = true
    this.values = {
      driveDb: 6, outputDb: 0, dryWet: 1, colorFrequencyHz: 1200, colorWidth: 0.57, colorLowDb: 0, colorHighDb: 0,
      bassThresholdDb: -12, warpDepth: 0.5, warpPeriod: 0.5,
    }
    this.config = { curve: SOFT, postClip: 0, hiQuality: true, color: false }
    this.out = new Float64Array(2)
    this.bypassFrames = Math.floor((sampleRate + 50) / 100)
    this.bypass = 0
    this.port.onmessage = (event) => {
      const message = event.data

      if (!isObject(message) || message.version !== 1) return

      if (message.type === 'configure' && isObject(message.state)) {
        this.configure(message.state)

        return
      }

      if (message.type === 'reset') {
        this.kernel.reset()

        return
      }

      if (message.type === 'release') this.port.close()
    }
  }

  configure(state) {
    this.enabled = state.enabled !== false
    this.config = {
      curve: Math.max(0, CURVES.indexOf(state.curve)),
      postClip: Math.max(0, POST_CLIPS.indexOf(state.postClip)),
      hiQuality: state.hiQuality !== false,
      color: state.color === true,
    }
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
    const kernel = this.kernel
    const step = f(1 / (this.bypassFrames === 0 ? 1 : this.bypassFrames))
    const at = (name, frame) => f(parameters[name][parameters[name].length === 1 ? 0 : frame])

    for (let frame = 0; frame < outputLeft.length; frame += 1) {
      const dryLeft = inputLeft ? inputLeft[frame] : 0
      const dryRight = inputRight ? inputRight[frame] : dryLeft
      const left = Number.isFinite(dryLeft) ? f(dryLeft) : 0
      const right = Number.isFinite(dryRight) ? f(dryRight) : 0

      if (kernel.controlDue()) {
        values.driveDb = at('saturator.driveDb', frame)
        values.outputDb = at('saturator.outputDb', frame)
        values.dryWet = at('saturator.dryWet', frame)
        values.colorFrequencyHz = at('saturator.colorFrequencyHz', frame)
        values.colorWidth = at('saturator.colorWidth', frame)
        values.colorLowDb = at('saturator.colorLowDb', frame)
        values.colorHighDb = at('saturator.colorHighDb', frame)
        values.bassThresholdDb = at('saturator.bassThresholdDb', frame)
        values.warpDepth = at('saturator.warpDepth', frame)
        values.warpPeriod = at('saturator.warpPeriod', frame)
      }

      kernel.process(values, this.config, left, right, this.out)
      this.bypass = bypassStep(this.bypass, this.enabled ? 0 : 1, step)
      outputLeft[frame] = this.mix(this.out[0], left)
      outputRight[frame] = this.mix(this.out[1], right)
    }

    return true
  }

  mix(processed, dry) {
    if (this.bypass <= 0) return processed

    if (this.bypass >= 1) return dry

    return f(processed + f(f(dry - processed) * this.bypass))
  }
}

registerProcessor('daw-saturator-processor', DawSaturatorProcessor)
