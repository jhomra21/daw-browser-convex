// Mirrors native/audio-core/src/delay_kernel.h and processor_delay.cpp operation for operation (the legacy path must stay
// within 1e-5 of the core), so keep the three in step. Math.fround stands where the core rounds to float: the lines are
// Float32Arrays and every value that crosses the processor boundary is rounded; the arithmetic in between is double.
//
// What this path cannot do alone: an AudioWorklet knows no project tempo, so a synced time follows the last 'tempo' message
// (and the core's own 120 bpm fallback until one arrives).
const f = Math.fround

const SMOOTHINGS = ['repitch', 'fade', 'jump']
const DIVISIONS = ['1/32', '1/16', '1/8', '1/4', '1/2', '1/1']
const FEELS = ['straight', 'dotted', 'triplet']
const CONTROL_FRAMES = 8
const MINIMUM_DELAY_MS = 1
const MAXIMUM_DELAY_MS = 5000
const DEFAULT_TEMPO_BPM = 120
const DIVISION_BEATS = [0.125, 0.25, 0.5, 1, 2, 4]
const FEEL_SCALE = [1, 1.5, 2 / 3]
const REPITCH_GLIDE_MS = 120
const REPITCH_MAX_SLOPE = 0.5
const FADE_MS = 40
const FADE_THRESHOLD_FRAMES = 0.01
const LIMITER_KNEE = 0.5
const DENORMAL_FLOOR_FLOAT = f(1e-19)
const DENORMAL_FLOOR_DOUBLE = 1e-154

const flushFloat = (value) => Math.abs(value) < DENORMAL_FLOOR_FLOAT ? 0 : value
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

class DelayKernel {
  constructor(rate) {
    this.rate = rate
    let capacity = 8
    const needed = Math.ceil(MAXIMUM_DELAY_MS * 0.001 * rate) + 8

    while (capacity < needed) capacity *= 2
    this.capacity = capacity
    this.mask = capacity - 1
    this.lines = [new Float32Array(capacity), new Float32Array(capacity)]
    this.write = 0
    this.feedback = new Smoother(false)
    this.wet = new Smoother(false)
    this.filterHz = new Smoother(true)
    this.filterWidth = new Smoother(false)
    this.filterAmount = new Smoother(false)
    this.freeze = new Smoother(false)
    this.feedback.prepare(rate, 20)
    this.wet.prepare(rate, 10)
    this.filterHz.prepare(rate, 30)
    this.filterWidth.prepare(rate, 30)
    this.filterAmount.prepare(rate, 20)
    this.freeze.prepare(rate, 30)
    this.glide = 1 - Math.exp(-1000 / (REPITCH_GLIDE_MS * rate))
    this.fadeStep = 1 / (FADE_MS * 0.001 * rate)
    this.heads = [{ target: 0, from: 0, to: 0, t: 1 }, { target: 0, from: 0, to: 0, t: 1 }]
    this.filterState = [{ x1: 0, x2: 0, y1: 0, y2: 0 }, { x1: 0, x2: 0, y1: 0, y2: 0 }]
    this.filterHzValue = 1000
    this.filterWidthValue = 5
    this.designedHz = 0
    this.designedWidth = 0
    this.gain = 0
    this.a1 = 0
    this.a2 = 0
    this.filterActive = false
    this.pingPong = false
    this.smoothing = 0
    this.frame = 0
    this.initialized = false
  }

  reset() {
    this.lines[0].fill(0)
    this.lines[1].fill(0)
    this.write = 0

    for (const state of this.filterState) state.x1 = state.x2 = state.y1 = state.y2 = 0
    this.filterActive = false
    this.frame = 0
    this.initialized = false
  }

  controlDue() { return (this.frame & (CONTROL_FRAMES - 1)) === 0 }

  apply(v, c) {
    this.pingPong = c.pingPong
    this.smoothing = c.smoothing
    const freeze = c.freeze ? 1 : 0
    const filterAmount = c.filter && !c.freeze ? 1 : 0
    const target = [this.delayFrames(v, c, 0), this.delayFrames(v, c, 1)]

    if (!this.initialized) {
      this.feedback.reset(v.feedback)
      this.wet.reset(v.dryWet)
      this.filterHz.reset(v.filterHz)
      this.filterWidth.reset(v.filterWidth)
      this.filterAmount.reset(filterAmount)
      this.freeze.reset(freeze)
      this.filterHzValue = v.filterHz
      this.filterWidthValue = v.filterWidth

      for (let channel = 0; channel < 2; channel += 1) this.heads[channel] = { target: target[channel], from: target[channel], to: target[channel], t: 1 }
      this.initialized = true

      return
    }

    this.feedback.setTarget(v.feedback)
    this.wet.setTarget(v.dryWet)
    this.filterHz.setTarget(v.filterHz)
    this.filterWidth.setTarget(v.filterWidth)
    this.filterAmount.setTarget(filterAmount)
    this.freeze.setTarget(freeze)

    for (let channel = 0; channel < 2; channel += 1) this.heads[channel].target = target[channel]
  }

  delayFrames(v, c, channel) {
    const source = c.link ? 0 : channel
    let ms = v.timeMs[source]

    if (c.sync[source]) {
      const bpm = v.tempoBpm > 0 ? v.tempoBpm : DEFAULT_TEMPO_BPM
      const beats = DIVISION_BEATS[Math.min(c.division[source], DIVISION_BEATS.length - 1)] * FEEL_SCALE[Math.min(c.feel[source], FEEL_SCALE.length - 1)]

      ms = beats * 60000 / bpm * (1 + v.offsetPercent[source] / 100)
    }

    return clamp(ms, MINIMUM_DELAY_MS, MAXIMUM_DELAY_MS) * 0.001 * this.rate
  }

  sample(channel, age) {
    return this.lines[channel][(this.write - 1 - age) & this.mask]
  }

  hermite(channel, delay) {
    const age = delay - 1
    const whole = Math.floor(age)
    const t = age - whole
    const p0 = this.sample(channel, whole - 1)
    const p1 = this.sample(channel, whole)
    const p2 = this.sample(channel, whole + 1)
    const p3 = this.sample(channel, whole + 2)
    const c1 = 0.5 * (p2 - p0)
    const c2 = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3
    const c3 = 0.5 * (p3 - p0) + 1.5 * (p1 - p2)

    return ((c3 * t + c2) * t + c1) * t + p1
  }

  settled(frames, freeze) { return frames + freeze * (Math.round(frames) - frames) }

  readTap(channel, freeze) {
    const head = this.heads[channel]

    if (this.smoothing === 2) {
      head.to = head.target
      head.t = 1
    } else if (this.smoothing === 0) {
      const step = clamp((head.target - head.to) * this.glide, -REPITCH_MAX_SLOPE, REPITCH_MAX_SLOPE)

      head.to = Math.abs(head.target - head.to) < FADE_THRESHOLD_FRAMES ? head.target : head.to + step
      head.t = 1
    } else if (head.t >= 1) {
      if (Math.abs(head.target - head.to) > FADE_THRESHOLD_FRAMES) {
        head.from = head.to
        head.to = head.target
        head.t = 0
      }
    } else {
      head.t = Math.min(1, head.t + this.fadeStep)
    }

    const incoming = this.hermite(channel, this.settled(head.to, freeze))

    if (head.t >= 1) return incoming
    const outgoing = this.hermite(channel, this.settled(head.from, freeze))

    return Math.sqrt(head.t) * incoming + Math.sqrt(1 - head.t) * outgoing
  }

  softLimit(x) {
    const magnitude = Math.abs(x)

    if (magnitude <= LIMITER_KNEE) return x
    const limited = LIMITER_KNEE + (1 - LIMITER_KNEE) * Math.tanh((magnitude - LIMITER_KNEE) / (1 - LIMITER_KNEE))

    return x < 0 ? -limited : limited
  }

  designFilter() {
    if (this.filterHzValue === this.designedHz && this.filterWidthValue === this.designedWidth) return
    this.designedHz = this.filterHzValue
    this.designedWidth = this.filterWidthValue
    const omega = 2 * Math.PI * clamp(this.filterHzValue, 20, this.rate * 0.49) / this.rate
    const sine = Math.sin(omega)
    const alpha = sine * Math.sinh(0.5 * Math.log(2) * this.filterWidthValue * omega / sine)
    const a0 = 1 + alpha

    this.gain = alpha / a0
    this.a1 = -2 * Math.cos(omega) / a0
    this.a2 = (1 - alpha) / a0
  }

  bandPass(channel, input) {
    const state = this.filterState[channel]
    const output = this.gain * (input - state.x2) - this.a1 * state.y1 - this.a2 * state.y2

    state.x2 = state.x1
    state.x1 = input
    state.y2 = flushDouble(state.y1)
    state.y1 = flushDouble(output)

    return output
  }

  process(v, c, inputLeft, inputRight, out) {
    const dry = [Number.isFinite(inputLeft) ? inputLeft : 0, Number.isFinite(inputRight) ? inputRight : 0]
    const tick = this.controlDue()

    if (tick) this.apply(v, c)
    const feedback = this.feedback.next()
    const wet = this.wet.next()
    const freeze = this.freeze.next()
    const filterAmount = this.filterAmount.next()

    this.filterHzValue = this.filterHz.next()
    this.filterWidthValue = this.filterWidth.next()

    if (tick) this.designFilter()

    if (filterAmount <= 0 && this.filterActive) {
      for (const state of this.filterState) state.x1 = state.x2 = state.y1 = state.y2 = 0
      this.filterActive = false
    }

    if (filterAmount > 0) this.filterActive = true
    const loopGain = feedback + (1 - feedback) * freeze
    const inputGain = 1 - freeze
    const tap = [this.readTap(0, freeze), this.readTap(1, freeze)]
    const mixed = [0, 0]

    for (let channel = 0; channel < 2; channel += 1) {
      const source = this.pingPong ? tap[1 - channel] : tap[channel]
      const limited = this.softLimit(source)
      const lineIn = dry[channel] * inputGain + loopGain * (limited + freeze * (source - limited))
      const filtered = this.filterActive ? lineIn + filterAmount * (this.bandPass(channel, lineIn) - lineIn) : lineIn

      this.lines[channel][this.write & this.mask] = flushFloat(f(filtered))
      mixed[channel] = dry[channel] * (1 - wet) + tap[channel] * wet
    }

    this.write = (this.write + 1) >>> 0
    this.frame = (this.frame + 1) >>> 0
    out[0] = this.finiteOrReset(mixed[0])
    out[1] = this.finiteOrReset(mixed[1])
  }

  finiteOrReset(output) {
    if (Number.isFinite(output)) return f(output)
    this.reset()

    return 0
  }
}

class DawDelayProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'delay.timeMs', defaultValue: 250, minValue: 1, maxValue: 5000, automationRate: 'a-rate' },
      { name: 'delay.timeRightMs', defaultValue: 250, minValue: 1, maxValue: 5000, automationRate: 'a-rate' },
      { name: 'delay.offsetLeftPercent', defaultValue: 0, minValue: -33, maxValue: 33, automationRate: 'a-rate' },
      { name: 'delay.offsetRightPercent', defaultValue: 0, minValue: -33, maxValue: 33, automationRate: 'a-rate' },
      { name: 'delay.feedback', defaultValue: 0.25, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'delay.dryWet', defaultValue: 0.2, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'delay.filterHz', defaultValue: 1000, minValue: 20, maxValue: 20000, automationRate: 'a-rate' },
      { name: 'delay.filterWidth', defaultValue: 5, minValue: 0.5, maxValue: 9, automationRate: 'a-rate' },
    ]
  }

  constructor() {
    super()
    this.kernel = new DelayKernel(sampleRate)
    this.enabled = true
    this.values = { timeMs: [250, 250], offsetPercent: [0, 0], feedback: 0.25, dryWet: 0.2, filterHz: 1000, filterWidth: 5, tempoBpm: 0 }
    this.config = { link: true, pingPong: false, freeze: false, filter: false, smoothing: 0, sync: [true, true], division: [2, 2], feel: [0, 0] }
    this.out = new Float64Array(2)
    this.bypassFrames = Math.floor((sampleRate + 50) / 100)
    this.bypass = 0
    this.tempoBpm = 0
    this.port.onmessage = (event) => {
      const message = event.data

      if (!isObject(message) || message.version !== 1) return

      if (message.type === 'configure' && isObject(message.state)) {
        this.configure(message.state)

        return
      }

      if (message.type === 'tempo' && Number.isFinite(message.bpm) && message.bpm > 0) {
        this.tempoBpm = message.bpm

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
    const index = (list, value) => Math.max(0, list.indexOf(value))

    this.enabled = state.enabled !== false
    this.config = {
      link: state.link !== false,
      pingPong: state.pingPong === true,
      freeze: state.freeze === true,
      filter: state.filterEnabled === true,
      smoothing: index(SMOOTHINGS, state.smoothing),
      sync: [state.syncLeft !== false, state.syncRight !== false],
      division: [index(DIVISIONS, state.divisionLeft), index(DIVISIONS, state.divisionRight)],
      feel: [index(FEELS, state.feelLeft), index(FEELS, state.feelRight)],
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
        values.timeMs[0] = at('delay.timeMs', frame)
        values.timeMs[1] = at('delay.timeRightMs', frame)
        values.offsetPercent[0] = at('delay.offsetLeftPercent', frame)
        values.offsetPercent[1] = at('delay.offsetRightPercent', frame)
        values.feedback = at('delay.feedback', frame)
        values.dryWet = at('delay.dryWet', frame)
        values.filterHz = at('delay.filterHz', frame)
        values.filterWidth = at('delay.filterWidth', frame)
        values.tempoBpm = this.tempoBpm
      }

      kernel.process(values, this.config, left, right, this.out)
      this.bypass = bypassStep(this.bypass, this.enabled ? 0 : 1, step)
      outputLeft[frame] = f(this.out[0] + f(f(left - this.out[0]) * this.bypass))
      outputRight[frame] = f(this.out[1] + f(f(right - this.out[1]) * this.bypass))
    }

    return true
  }
}

registerProcessor('daw-delay-processor', DawDelayProcessor)
