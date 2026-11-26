// Mirrors native/audio-core/src/{chorus,ensemble,phaser,amplitude_modulation}_kernel.h, dsp/wet_finish.h, dsp/lfo.h and
// processor_modulation.cpp statement for statement (the legacy path must stay within 1e-5 of the core), so keep them in step.
// Math.fround stands where the core rounds to float: the delay rings and per-channel state are Float32Arrays and every
// float operation is rounded; phases, sample rate maths and smoother state are double, as in the core.
//
// What this path cannot do: an AudioWorklet knows neither the song position nor the project tempo, so a synced LFO
// free-runs from the first frame at 120 bpm (the core's own fallback when its transport carries no tempo) instead of
// locking to the bar. Where the shared engine plays the project the core does lock it.
// Continuous controls are AudioParams named kind.key; when a block carries no array for one, the configured state's value is used.
const f = Math.fround

const KINDS = new Set(['chorus', 'flanger', 'phaser', 'tremolo', 'autopan', 'ensemble'])

// key, default, min, max: the contract's portable parameters.
const PARAMS = {
  chorus: [
    ['delayMs', 12, 5, 30], ['depthMs', 4, 0, 10], ['rateHz', 0.8, 0.01, 20], ['feedback', 0, 0, 0.5], ['stereoPhase', 0.25, -0.5, 0.5],
    ['mix', 0.35, 0, 1], ['safeBassHz', 100, 20, 1000], ['width', 1, 0, 2], ['outputDb', 0, -24, 12],
  ],
  flanger: [
    ['delayMs', 1.5, 0.1, 10], ['depthMs', 1, 0, 5], ['rateHz', 0.2, 0.01, 20], ['feedback', 0.35, -0.95, 0.95], ['stereoPhase', 0.5, -0.5, 0.5],
    ['mix', 0.5, 0, 1], ['safeBassHz', 100, 20, 1000], ['width', 1, 0, 2], ['outputDb', 0, -24, 12],
  ],
  phaser: [
    ['centerHz', 1000, 100, 8000], ['depthOctaves', 3, 0, 5], ['rateHz', 0.3, 0.01, 20], ['feedback', 0.3, -0.95, 0.95], ['stereoPhase', 0.5, -0.5, 0.5],
    ['mix', 0.5, 0, 1], ['spreadOctaves', 0, 0, 4], ['blend', 0, 0, 1], ['safeBassHz', 100, 20, 1000], ['outputDb', 0, -24, 12],
  ],
  tremolo: [['rateHz', 4, 0.01, 20], ['depth', 0.5, 0, 1], ['shape', 0.5, 0, 1], ['phase', 0, 0, 1], ['stereoPhase', 0, -0.5, 0.5]],
  autopan: [['rateHz', 1, 0.01, 20], ['depth', 1, 0, 1], ['shape', 0.5, 0, 1], ['phase', 0, 0, 1], ['stereoPhase', 0.5, -0.5, 0.5]],
  ensemble: [
    ['delayMs', 18, 10, 30], ['depthMs', 6, 1, 12], ['rateHz', 0.6, 0.05, 5], ['spread', 1, 0, 1], ['mix', 0.5, 0, 1], ['fastDepthMs', 0, 0, 4],
    ['fastRateHz', 6, 0.5, 12], ['safeBassHz', 100, 20, 1000], ['width', 1, 0, 2], ['outputDb', 0, -24, 12],
  ],
}

const WAVEFORMS = ['sine', 'triangle', 'sawDown', 'sawUp', 'square', 'sampleHold', 'wander']
const DIVISION_COUNT = 16
const DEFAULT_TEMPO_BPM = 120
const BEATS = [8, 4, 3, 2, 1.5, 1, 2 / 3, 0.75, 0.5, 1 / 3, 0.375, 0.25, 1 / 6, 0.1875, 0.125, 1 / 12].map(f)
const DENORMAL_FLOOR = f(1e-19)
const TWO_PI = f(6.2831853071795864769)
const SMOOTH_MS = 12
const CONTROL_FRAMES = 8

const MODE_VIBRATO = 1
const MODE_VINTAGE = 2
const MODE_FLANGER = 3
const MODE_THROUGH_ZERO = 4

const THROUGH_ZERO_DRY_MS = 5
const MAXIMUM_CHORUS_LINE_MS = 40.5
const MINIMUM_LOOP_FRAMES = 2
const BBD_STAGES = 1024
const MAXIMUM_ENSEMBLE_LINE_MS = 46
const VOICE_GAIN = f(0.57735026918962576451)
const LIMITER_KNEE = f(0.25)
const LIMITER_CEILING = f(0.5)
const MAXIMUM_STAGES = 12
const SLEW_MS = 2
const SQUARE = 4
const SAMPLE_AND_HOLD = 5

const flushDenormal = (value) => Math.abs(value) < DENORMAL_FLOOR ? 0 : value
const isObject = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]'
const isModulationMessage = (message) => isObject(message) && message.version === 1

const isModulationConfigureMessage = (message, revision) => isModulationMessage(message)
  && message.type === 'configure'
  && Number.isInteger(message.revision)
  && message.revision > revision
  && isObject(message.state)

const bypassStep = (current, target, step) => {
  if (target > current + step) return f(current + step)

  if (target < current - step) return f(current - step)

  return target
}

// ParameterSmoother: a one-pole in double whose output is rounded to float; Log smooths in the log domain.
class Smoother {
  constructor(log, rate) {
    this.log = log
    this.coefficient = 1 - Math.exp(-1000 / (SMOOTH_MS * rate))
    this.current = 0
    this.target = 0
    this.targetValue = 0
    this.output = 0
    this.settling = false
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

// Twin of dsp/lfo.h: the parabolic sine and the shared LFO shapes, step for step.
const FAST_SINE_CORRECTION = f(0.225)

const fastSineCycles = (phase) => {
  const t = f(phase - Math.floor(f(phase + 0.5)))
  const quadratic = f(f(16 * t) * Math.abs(t))
  const d = f(f(8 * t) - quadratic)
  const correction = f(f(d * Math.abs(d)) - d)

  return f(f(FAST_SINE_CORRECTION * correction) + d)
}

const lfoRandom = (cycle) => {
  let x = Math.imul(cycle, 2654435761) >>> 0
  x = (x ^ (x >>> 16)) >>> 0
  x = Math.imul(x, 0x45D9F3B) >>> 0
  x = (x ^ (x >>> 16)) >>> 0

  return f(f(f(x) * 2 ** -31) - 1)
}

// Bipolar value for one point of a cycle. The cycle number seeds the random shapes so left and right share one sequence.
const lfoShape = (waveform, fraction, cycle) => {
  const phase = f(fraction)

  switch (waveform) {
    case 1: return f(1 - f(4 * Math.abs(f(phase - 0.5))))
    case 2: return f(1 - f(2 * phase))
    case 3: return f(f(2 * phase) - 1)
    case 4: return phase < 0.5 ? 1 : -1
    case 5: return lfoRandom(cycle)
    case 6: {
      const eased = f(f(phase * phase) * f(3 - f(2 * phase)))
      const from = lfoRandom(cycle)

      return f(from + f(f(lfoRandom(cycle + 1) - from) * eased))
    }

    default: return fastSineCycles(phase)
  }
}

const lfoAtPhase = (waveform, phase, cycleBase) => {
  const whole = Math.floor(phase)

  return lfoShape(waveform, phase - whole, (cycleBase + whole) >>> 0)
}

const syncRateHz = (division, tempoBpm) =>
  f((tempoBpm > 0 ? tempoBpm : DEFAULT_TEMPO_BPM) / 60 / BEATS[Math.min(division, DIVISION_COUNT - 1)])

// LfoClock: a free-running LFO position, the phase in cycles and how many cycles it has completed.
class LfoClock {
  constructor() {
    this.phase = 0
    this.cycle = 0
  }
  shape(waveform, offset) { return lfoAtPhase(waveform, this.phase + offset, this.cycle) }
  advance(cycles) {
    this.phase += cycles

    if (this.phase >= 1) {
      const wraps = Math.floor(this.phase)
      this.phase -= wraps
      this.cycle = (this.cycle + wraps) >>> 0
    }
  }
}

// DelayRing<float>: power-of-two ring, delays are ages (read(0) is the newest sample).
class DelayRing {
  constructor(minimumFrames) {
    let capacity = 8

    while (capacity < minimumFrames) capacity *= 2
    this.buffer = new Float32Array(capacity)
    this.mask = capacity - 1
    this.write = 0
  }
  reset() {
    this.buffer.fill(0)
    this.write = 0
  }
  get capacity() { return this.mask + 1 }
  push(value) {
    this.buffer[this.write & this.mask] = value
    this.write = (this.write + 1) >>> 0
  }
  read(age) { return this.buffer[(this.write - 1 - Math.min(age, this.mask)) & this.mask] }
  // 4-point, 3rd-order Hermite (Catmull-Rom).
  readHermite(delay) {
    const bounded = Number.isNaN(delay) ? 1 : Math.min(Math.max(delay, 1), this.mask - 2)
    const whole = Math.floor(bounded)
    const t = f(1 - f(bounded - whole))
    const p0 = this.read(whole + 2), p1 = this.read(whole + 1), p2 = this.read(whole), p3 = this.read(whole - 1)
    const c1 = f(0.5 * f(p2 - p0))
    const c2 = f(f(f(p0 - f(2.5 * p1)) + f(2 * p2)) - f(0.5 * p3))
    const c3 = f(f(0.5 * f(p3 - p0)) + f(1.5 * f(p1 - p2)))

    return f(f(f(f(f(c3 * t) + c2) * t) + c1) * t + p1)
  }
  // Hermite from one frame behind the newest sample and up, linear between the newest sample and the one before it.
  readHermiteOrLinear(delay) {
    if (!(delay < 1)) return this.readHermite(delay)
    const fraction = Math.max(delay, 0)

    return f(this.read(0) + f(f(this.read(1) - this.read(0)) * fraction))
  }
}

// WetFinish: Safe Bass one-pole high-pass, Width on the wet mid/side balance, Output gain.
class WetFinish {
  constructor(rate) {
    this.rate = f(rate)
    this.bass = new Smoother(true, rate)
    this.width = new Smoother(false, rate)
    this.output = new Smoother(false, rate)
    this.initialized = false
    this.low = new Float32Array(2)
    this.coefficient = 0
    this.lastBassHz = -1
    this.widthValue = 1
    this.gain = 1
    this.lastOutputDb = -1000
  }
  reset() { this.low.fill(0) }
  next(bassHz, width, outputDb) {
    if (!this.initialized) {
      this.bass.reset(bassHz)
      this.width.reset(width)
      this.output.reset(outputDb)
      this.initialized = true
    }

    this.bass.setTarget(bassHz)
    this.width.setTarget(width)
    this.output.setTarget(outputDb)
    const hz = this.bass.next()

    if (hz !== this.lastBassHz) {
      this.coefficient = f(1 - f(Math.exp(f(f(-TWO_PI * hz) / this.rate))))
      this.lastBassHz = hz
    }

    this.widthValue = this.width.next()
    const db = this.output.next()

    if (db !== this.lastOutputDb) {
      this.gain = f(Math.pow(10, f(db / 20)))
      this.lastOutputDb = db
    }
  }
  apply(safeBass, wet) {
    let left = wet[0]
    let right = wet[1]

    if (safeBass) {
      this.low[0] = flushDenormal(f(this.low[0] + f(this.coefficient * f(left - this.low[0]))))
      this.low[1] = flushDenormal(f(this.low[1] + f(this.coefficient * f(right - this.low[1]))))
      left = f(left - this.low[0])
      right = f(right - this.low[1])
    }

    const mid = f(0.5 * f(left + right))
    const side = f(f(0.5 * f(left - right)) * this.widthValue)
    wet[0] = f(mid + side)
    wet[1] = f(mid - side)
  }
}

// What every kernel does with its mixed result: a bypass ramp towards the dry input, and a reset on a non-finite value.
const finishFrame = (kernel, mixed, dry, bypass, out) => {
  for (let c = 0; c < 2; c++) out[c] = f(mixed[c] + f(f(dry[c] - mixed[c]) * bypass))

  if (!Number.isFinite(out[0]) || !Number.isFinite(out[1])) {
    kernel.reset()
    out[0] = out[1] = 0
  }
}

const sanitized = (value) => Number.isFinite(value) ? value : 0

class ChorusKernel {
  constructor(rate) {
    this.rate = rate
    this.lines = [new DelayRing(Math.ceil(MAXIMUM_CHORUS_LINE_MS * 0.001 * rate) + 8), new DelayRing(Math.ceil(MAXIMUM_CHORUS_LINE_MS * 0.001 * rate) + 8)]
    this.dryLines = [new DelayRing(Math.ceil(THROUGH_ZERO_DRY_MS * 0.001 * rate) + 8), new DelayRing(Math.ceil(THROUGH_ZERO_DRY_MS * 0.001 * rate) + 8)]
    this.pre = [new Float32Array(2), new Float32Array(2)]
    this.post = [new Float32Array(2), new Float32Array(2)]
    this.delay = new Smoother(false, rate)
    this.depth = new Smoother(false, rate)
    this.feedback = new Smoother(false, rate)
    this.stereo = new Smoother(false, rate)
    this.mix = new Smoother(false, rate)
    this.finish = new WetFinish(rate)
    this.initialized = false
    this.clock = new LfoClock()
    this.bbdCoefficient = 1
    this.frame = 0
    this.wet = [0, 0]
    this.dry = [0, 0]
    this.mixed = [0, 0]
  }
  get phase() { return this.clock.phase }
  // The dry path of Through-zero is delayed by this many frames: the effect's declared latency.
  latencyFrames(mode) { return mode === MODE_THROUGH_ZERO ? Math.ceil(THROUGH_ZERO_DRY_MS * this.rate / 1000) : 0 }
  reset() {
    for (let c = 0; c < 2; c++) {
      this.lines[c].reset()
      this.dryLines[c].reset()
      this.pre[c].fill(0)
      this.post[c].fill(0)
    }

    this.finish.reset()
    this.clock = new LfoClock()
    this.frame = 0
  }
  // A bucket-brigade line with BBD_STAGES stages is clocked at stages / (2 delay): its Nyquist sets the filters.
  bbd(delayMs) {
    const rate = f(this.rate)
    const clock = f(BBD_STAGES / f(f(2 * Math.max(delayMs, f(0.05))) * f(0.001)))
    const cutoff = Math.min(f(f(0.4) * clock), f(f(0.45) * rate))

    return f(1 - f(Math.exp(f(f(-TWO_PI * cutoff) / rate))))
  }
  lowpass(state, x) {
    state[0] = flushDenormal(f(state[0] + f(this.bbdCoefficient * f(x - state[0]))))
    state[1] = flushDenormal(f(state[1] + f(this.bbdCoefficient * f(state[0] - state[1]))))

    return state[1]
  }
  process(values, config, bypass, inLeft, inRight, out) {
    if (!this.initialized) {
      this.delay.reset(values.delayMs)
      this.depth.reset(values.depthMs)
      this.feedback.reset(values.feedback)
      this.stereo.reset(values.stereoPhase)
      this.mix.reset(values.mix)
      this.initialized = true
    }

    this.delay.setTarget(values.delayMs)
    this.depth.setTarget(values.depthMs)
    this.feedback.setTarget(values.feedback)
    this.stereo.setTarget(values.stereoPhase)
    this.mix.setTarget(values.mix)
    const delayMs = this.delay.next()
    const depthMs = this.depth.next()
    const stereo = this.stereo.next()
    const vibrato = config.mode === MODE_VIBRATO
    const vintage = config.mode === MODE_VINTAGE
    const throughZero = config.mode === MODE_THROUGH_ZERO
    const smoothedFeedback = this.feedback.next()
    const smoothedMix = this.mix.next()
    const feedback = vibrato ? 0 : smoothedFeedback
    const mix = vibrato ? 1 : smoothedMix
    this.finish.next(values.safeBassHz, values.width, values.outputDb)

    if ((this.frame++ & (CONTROL_FRAMES - 1)) === 0) this.bbdCoefficient = this.bbd(delayMs)

    const framesPerMs = f(this.rate * 0.001)
    const tapMs = f(delayMs + (throughZero ? THROUGH_ZERO_DRY_MS : 0))
    const dryFrames = this.latencyFrames(MODE_THROUGH_ZERO)
    const input = [sanitized(inLeft), sanitized(inRight)]
    const wet = this.wet
    const dry = this.dry

    for (let c = 0; c < 2; c++) {
      const line = this.lines[c]
      const lfo = this.clock.shape(config.waveform, c === 1 ? stereo : 0)
      const limit = f(line.capacity - 4)
      const frames = Math.min(Math.max(f(f(tapMs + f(depthMs * lfo)) * framesPerMs), 0), limit)
      const loop = Math.max(frames, MINIMUM_LOOP_FRAMES)
      const fed = line.readHermite(f(loop - 1))
      let written = f(input[c] + f(feedback * fed))

      if (vintage) written = f(Math.tanh(f(f(1.2) * this.lowpass(this.pre[c], written))) / f(1.2))
      line.push(flushDenormal(written))
      let tap = frames >= MINIMUM_LOOP_FRAMES ? fed : line.readHermiteOrLinear(frames)

      if (vintage) tap = this.lowpass(this.post[c], tap)
      wet[c] = tap
      this.dryLines[c].push(input[c])
      dry[c] = throughZero ? this.dryLines[c].read(dryFrames) : input[c]
    }

    this.clock.advance(values.rateHz / this.rate)
    this.finish.apply(config.safeBass, wet)
    const gain = this.finish.gain

    for (let c = 0; c < 2; c++) this.mixed[c] = f(f(f(dry[c] * f(1 - mix)) + f(wet[c] * mix)) * gain)
    finishFrame(this, this.mixed, dry, bypass, out)
  }
}

class EnsembleKernel {
  constructor(rate) {
    this.rate = rate
    this.lines = [new DelayRing(Math.ceil(MAXIMUM_ENSEMBLE_LINE_MS * 0.001 * rate) + 8), new DelayRing(Math.ceil(MAXIMUM_ENSEMBLE_LINE_MS * 0.001 * rate) + 8)]
    this.delay = new Smoother(false, rate)
    this.depth = new Smoother(false, rate)
    this.spread = new Smoother(false, rate)
    this.mix = new Smoother(false, rate)
    this.fastDepth = new Smoother(false, rate)
    this.finish = new WetFinish(rate)
    this.initialized = false
    this.slow = new LfoClock()
    this.fast = new LfoClock()
    this.wet = [0, 0]
    this.dry = [0, 0]
    this.mixed = [0, 0]
  }
  get phase() { return this.slow.phase }
  reset() {
    for (const line of this.lines) line.reset()
    this.finish.reset()
    this.slow = new LfoClock()
    this.fast = new LfoClock()
  }
  process(values, config, bypass, inLeft, inRight, out) {
    if (!this.initialized) {
      this.delay.reset(values.delayMs)
      this.depth.reset(values.depthMs)
      this.spread.reset(values.spread)
      this.mix.reset(values.mix)
      this.fastDepth.reset(values.fastDepthMs)
      this.initialized = true
    }

    this.delay.setTarget(values.delayMs)
    this.depth.setTarget(values.depthMs)
    this.spread.setTarget(values.spread)
    this.mix.setTarget(values.mix)
    this.fastDepth.setTarget(values.fastDepthMs)
    const delayMs = this.delay.next()
    const depthMs = this.depth.next()
    const spread = this.spread.next()
    const mix = this.mix.next()
    const fastDepthMs = this.fastDepth.next()
    this.finish.next(values.safeBassHz, values.width, values.outputDb)

    const framesPerMs = f(this.rate * 0.001)
    const input = this.dry
    input[0] = sanitized(inLeft)
    input[1] = sanitized(inRight)
    const wet = this.wet
    wet[0] = wet[1] = 0

    for (let c = 0; c < 2; c++) this.lines[c].push(input[c])

    for (let voice = 0; voice < 3; voice++) {
      const third = voice / 3
      const offset = f(f(spread * f(voice - 1)) * 0.25)

      for (let c = 0; c < 2; c++) {
        const shifted = third + (c === 0 ? -offset : offset)
        const lfo = f(f(depthMs * this.slow.shape(config.waveform, shifted)) + f(fastDepthMs * this.fast.shape(config.waveform, shifted)))
        const limit = f(this.lines[c].capacity - 4)
        wet[c] = f(wet[c] + this.lines[c].readHermiteOrLinear(Math.min(Math.max(f(f(delayMs + lfo) * framesPerMs), 0), limit)))
      }
    }

    this.slow.advance(values.rateHz / this.rate)
    this.fast.advance(values.fastRateHz / this.rate)

    for (let c = 0; c < 2; c++) wet[c] = f(wet[c] * VOICE_GAIN)
    this.finish.apply(config.safeBass, wet)
    const gain = this.finish.gain

    for (let c = 0; c < 2; c++) this.mixed[c] = f(f(f(input[c] * f(1 - mix)) + f(wet[c] * mix)) * gain)
    finishFrame(this, this.mixed, input, bypass, out)
  }
}

const softLimit = (x) => {
  const magnitude = Math.abs(x)

  if (magnitude <= LIMITER_KNEE) return x
  const room = f(LIMITER_CEILING - LIMITER_KNEE)
  const limited = f(LIMITER_KNEE + f(room * f(Math.tanh(f(f(magnitude - LIMITER_KNEE) / room)))))

  return x < 0 ? -limited : limited
}

const createPhaserChannel = () => ({
  coefficient: new Float32Array(MAXIMUM_STAGES),
  target: new Float32Array(MAXIMUM_STAGES),
  step: new Float32Array(MAXIMUM_STAGES),
  x1: new Float32Array(MAXIMUM_STAGES),
  y1: new Float32Array(MAXIMUM_STAGES),
})

class PhaserKernel {
  constructor(rate) {
    this.rate = rate
    this.center = new Smoother(true, rate)
    this.depth = new Smoother(false, rate)
    this.feedback = new Smoother(false, rate)
    this.stereo = new Smoother(false, rate)
    this.mix = new Smoother(false, rate)
    this.spread = new Smoother(false, rate)
    this.blend = new Smoother(false, rate)
    this.finish = new WetFinish(rate)
    this.initialized = false
    this.channels = [createPhaserChannel(), createPhaserChannel()]
    this.clock = new LfoClock()
    this.centerValue = 1000
    this.depthValue = 0
    this.stereoValue = 0
    this.spreadValue = 0
    this.blendValue = 0
    this.frame = 0
    this.appliedStages = 0
    this.memory = new Float32Array(MAXIMUM_STAGES)
    this.wet = [0, 0]
    this.mixed = [0, 0]
    this.input = [0, 0]
  }
  get phase() { return this.clock.phase }
  reset() {
    this.channels = [createPhaserChannel(), createPhaserChannel()]
    this.finish.reset()
    this.clock = new LfoClock()
    this.frame = 0
    this.appliedStages = 0
  }
  stageCoefficient(octaves) {
    const rate = f(this.rate)
    const frequency = Math.min(Math.max(f(this.centerValue * f(Math.pow(2, octaves))), 20), f(f(0.49) * rate))
    const tangent = f(Math.tan(f(f(f(Math.PI) * frequency) / rate)))

    return f(f(tangent - 1) / f(tangent + 1))
  }
  retarget(config) {
    const snap = this.appliedStages !== config.stages
    const uniform = this.spreadValue === 0 && this.blendValue === 0

    for (let c = 0; c < 2; c++) {
      const channel = this.channels[c]
      const lfo = this.clock.shape(config.waveform, c === 1 ? this.stereoValue : 0)
      const sweep = f(this.depthValue * lfo)
      let shared = 0

      if (uniform) shared = this.stageCoefficient(sweep)

      for (let k = 0; k < config.stages; k++) {
        let next = shared

        if (!uniform) {
          const position = config.stages > 1 ? f(f(k / (config.stages - 1)) - 0.5) : 0
          const reach = f(f(sweep * f(1 - this.blendValue)) + f(f(this.spreadValue + f(this.blendValue * sweep)) * position))
          next = this.stageCoefficient(reach)
        }

        if (snap) channel.coefficient[k] = next
        channel.target[k] = next
        channel.step[k] = f(f(next - channel.coefficient[k]) / CONTROL_FRAMES)
      }
    }

    this.appliedStages = config.stages
  }
  // The feedback loop has no delay in it: the chain is linear in its input, y = G u + P, so u = x + fb y solves in closed form.
  runChain(channel, stages, feedback, x) {
    const memory = this.memory
    let gain = 1
    let past = 0

    for (let k = 0; k < stages; k++) {
      channel.coefficient[k] = f(channel.coefficient[k] + channel.step[k])
      const c = channel.coefficient[k]
      memory[k] = f(channel.x1[k] - f(c * channel.y1[k]))
      gain = f(gain * c)
      past = f(f(c * past) + memory[k])
    }

    let u = f(f(x + f(feedback * past)) / f(1 - f(feedback * gain)))
    const fed = f(feedback * f(f(gain * u) + past))

    if (Math.abs(fed) > LIMITER_KNEE) u = f(x + softLimit(fed))
    let value = u

    for (let k = 0; k < stages; k++) {
      const out = f(f(channel.coefficient[k] * value) + memory[k])
      channel.x1[k] = flushDenormal(value)
      channel.y1[k] = flushDenormal(out)
      value = out
    }

    return value
  }
  process(values, config, bypass, inLeft, inRight, out) {
    if (!this.initialized) {
      this.center.reset(values.centerHz)
      this.depth.reset(values.depthOctaves)
      this.feedback.reset(values.feedback)
      this.stereo.reset(values.stereoPhase)
      this.mix.reset(values.mix)
      this.spread.reset(values.spreadOctaves)
      this.blend.reset(values.blend)
      this.initialized = true
    }

    this.center.setTarget(values.centerHz)
    this.depth.setTarget(values.depthOctaves)
    this.feedback.setTarget(values.feedback)
    this.stereo.setTarget(values.stereoPhase)
    this.mix.setTarget(values.mix)
    this.spread.setTarget(values.spreadOctaves)
    this.blend.setTarget(values.blend)
    this.centerValue = this.center.next()
    this.depthValue = this.depth.next()
    const feedback = this.feedback.next()
    this.stereoValue = this.stereo.next()
    const mix = this.mix.next()
    this.spreadValue = this.spread.next()
    this.blendValue = this.blend.next()
    this.finish.next(values.safeBassHz, 1, values.outputDb)

    if ((this.frame++ & (CONTROL_FRAMES - 1)) === 0) this.retarget(config)

    const input = this.input
    input[0] = sanitized(inLeft)
    input[1] = sanitized(inRight)
    const wet = this.wet

    for (let c = 0; c < 2; c++) wet[c] = this.runChain(this.channels[c], config.stages, feedback, input[c])
    this.clock.advance(values.rateHz / this.rate)
    this.finish.apply(config.safeBass, wet)
    const gain = this.finish.gain

    for (let c = 0; c < 2; c++) this.mixed[c] = f(f(f(input[c] * f(1 - mix)) + f(wet[c] * mix)) * gain)
    finishFrame(this, this.mixed, input, bypass, out)
  }
}

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
]

// ln Gamma(x) for x >= 0.5 (Lanczos, g = 7), standing for lgamma where the core has it.
const logGamma = (x) => {
  const z = x - 1
  let sum = LANCZOS[0]

  for (let i = 1; i < LANCZOS.length; i++) sum += LANCZOS[i] / (z + i)
  const t = z + 7.5

  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum)
}

// Average of the shaped unipolar LFO over a cycle: the sine's is the Beta-function integral, the stepped square only
// visits 0 and 1, the other shapes are uniform on [0, 1].
const meanShaped = (waveform, exponent) => {
  if (waveform === 0) return f(f(Math.exp(f(f(logGamma(f(exponent + 0.5))) - f(logGamma(f(exponent + 1)))))) * f(0.56418958354775628695))

  if (waveform === SQUARE) return 0.5

  return f(1 / f(exponent + 1))
}

class AmplitudeKernel {
  constructor(rate) {
    this.rate = rate
    this.depth = new Smoother(false, rate)
    this.shape = new Smoother(false, rate)
    this.phaseOffset = new Smoother(false, rate)
    this.stereo = new Smoother(false, rate)
    this.initialized = false
    this.clock = new LfoClock()
    this.slew = new Float32Array(2)
    this.slewCoefficient = f(1 - Math.exp(-1000 / (SLEW_MS * rate)))
    this.exponent = 1
    this.mean = 0.5
    this.frame = 0
    this.shaped = [0, 0]
    this.gain = [0, 0]
    this.input = [0, 0]
    this.mixed = [0, 0]
  }
  get phase() { return this.clock.phase }
  reset() {
    this.clock = new LfoClock()
    this.slew.fill(0)
    this.frame = 0
  }
  process(values, config, bypass, inLeft, inRight, out) {
    if (!this.initialized) {
      this.depth.reset(values.depth)
      this.shape.reset(values.shape)
      this.phaseOffset.reset(values.phase)
      this.stereo.reset(values.stereoPhase)
      this.initialized = true
    }

    this.depth.setTarget(values.depth)
    this.shape.setTarget(values.shape)
    this.phaseOffset.setTarget(values.phase)
    this.stereo.setTarget(values.stereoPhase)
    const depth = this.depth.next()
    const shape = this.shape.next()
    const phase = this.phaseOffset.next()
    const stereo = this.stereo.next()

    if ((this.frame++ & (CONTROL_FRAMES - 1)) === 0) {
      this.exponent = f(Math.pow(2, f(4 * f(shape - 0.5))))
      this.mean = meanShaped(config.waveform, this.exponent)
    }

    const base = config.sync ? syncRateHz(config.division, 0) : values.rateHz
    const stepped = config.waveform === SQUARE || config.waveform === SAMPLE_AND_HOLD
    const input = this.input
    input[0] = sanitized(inLeft)
    input[1] = sanitized(inRight)
    const shaped = this.shaped

    for (let c = 0; c < 2; c++) {
      let lfo = this.clock.shape(config.waveform, phase + (c === 1 ? stereo : 0))

      if (config.invert) lfo = -lfo
      const unipolar = Math.min(Math.max(f(0.5 + f(0.5 * lfo)), 0), 1)
      const bent = this.exponent === 1 ? unipolar : f(Math.pow(unipolar, this.exponent))
      this.slew[c] = stepped ? f(this.slew[c] + f(this.slewCoefficient * f(bent - this.slew[c]))) : bent
      shaped[c] = this.slew[c]
    }

    this.clock.advance(base / this.rate)
    const gain = this.gain

    if (!config.autoPan) {
      const average = f(f(1 - depth) + f(depth * this.mean))

      for (let c = 0; c < 2; c++) gain[c] = f(f(f(1 - depth) + f(depth * shaped[c])) / average)
    } else {
      // Each channel's angle runs 0 (silent) to 0.25 (full) in cycles; opposite LFOs make the two angles sum to 0.25.
      for (let c = 0; c < 2; c++) gain[c] = fastSineCycles(f(f(f(depth * f(f(2 * shaped[c]) - 1)) + 1) * 0.125))
    }

    for (let c = 0; c < 2; c++) this.mixed[c] = f(input[c] * gain[c])
    finishFrame(this, this.mixed, input, bypass, out)
  }
}

const indexOfWaveform = (waveform) => Math.max(0, WAVEFORMS.indexOf(waveform))

// The core reads the state's discrete choices into a config like this one; stages outside 4, 6, 8 and 12 never reach it.
const configFor = (kind, state) => {
  const waveform = indexOfWaveform(state.waveform)

  switch (kind) {
    case 'chorus': return { mode: state.mode === 'vibrato' ? MODE_VIBRATO : state.mode === 'vintage' ? MODE_VINTAGE : 0, waveform, safeBass: state.safeBass === true }
    case 'flanger': return { mode: state.mode === 'throughZero' ? MODE_THROUGH_ZERO : MODE_FLANGER, waveform, safeBass: state.safeBass === true }
    case 'phaser': return { stages: [4, 6, 8, 12].includes(state.stages) ? state.stages : 6, waveform, safeBass: state.safeBass === true }
    case 'ensemble': return { waveform, safeBass: state.safeBass === true }
    default: {
      const division = Number.isInteger(state.division) ? state.division : 5

      return { autoPan: kind === 'autopan', waveform, division: Math.min(Math.max(division, 0), DIVISION_COUNT - 1), sync: state.sync === true, invert: state.invert === true }
    }
  }
}

const KERNELS = { chorus: ChorusKernel, flanger: ChorusKernel, phaser: PhaserKernel, tremolo: AmplitudeKernel, autopan: AmplitudeKernel, ensemble: EnsembleKernel }

class DawModulationProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return Object.entries(PARAMS).flatMap(([kind, params]) => params.map(([key, defaultValue, minValue, maxValue]) =>
      ({ name: kind + '.' + key, defaultValue, minValue, maxValue, automationRate: 'a-rate' })))
  }

  constructor(options) {
    super()
    const requestedKind = options && options.processorOptions && options.processorOptions.processorKind
    this.processorKind = KINDS.has(requestedKind) ? requestedKind : null
    this.params = this.processorKind ? PARAMS[this.processorKind] : []
    this.names = this.params.map(([key]) => this.processorKind + '.' + key)
    this.sources = new Array(this.params.length)
    this.fallbacks = this.params.map(([, defaultValue]) => defaultValue)
    this.values = Object.fromEntries(this.params.map(([key, defaultValue]) => [key, f(defaultValue)]))
    this.revision = -1
    this.enabled = true
    this.config = this.processorKind ? configFor(this.processorKind, {}) : null
    this.kernel = this.processorKind ? new KERNELS[this.processorKind](sampleRate) : null
    this.out = [0, 0]
    this.bypassFrames = Math.floor((sampleRate + 50) / 100)
    this.bypass = 0
    this.faults = 0
    this.port.onmessage = (event) => this.onMessage(event.data)

    if (!this.processorKind) this.fault('invalid-processor-kind')
    this.port.postMessage({ type: 'ready', version: 1, processorKind: this.processorKind })
  }

  get phase() { return this.kernel ? this.kernel.phase : 0 }

  onMessage(message) {
    if (!isModulationMessage(message)) return this.fault('malformed-message')

    if (message.type === 'dispose') return this.port.close()

    if (message.type === 'reset') {
      if (this.processorKind) this.kernel = new KERNELS[this.processorKind](sampleRate)
      this.bypass = this.enabled ? 0 : 1

      return
    }

    if (!isModulationConfigureMessage(message, this.revision)) return this.fault('malformed-or-stale-configure')

    if (message.processorKind !== undefined && message.processorKind !== this.processorKind) return this.fault('immutable-processor-kind')
    this.revision = message.revision
    const state = message.state
    this.enabled = state.enabled !== false

    if (this.processorKind) {
      this.config = configFor(this.processorKind, state)
      this.fallbacks = this.params.map(([key, defaultValue]) => Number.isFinite(state[key]) ? state[key] : defaultValue)
    }

    this.port.postMessage({ type: 'configured', version: 1, revision: this.revision })
  }

  fault(code) {
    if (this.faults++ < 4) this.port.postMessage({ type: 'fault', version: 1, code })
  }

  process(inputs, outputs, parameters = {}) {
    const input = inputs[0] || []
    const output = outputs[0] || []
    const outL = output[0]

    if (!outL) return true
    const outR = output[1]
    const inL = input[0]
    const inR = input[1] || inL
    const kernel = this.kernel
    const values = this.values
    const step = f(1 / (this.bypassFrames === 0 ? 1 : this.bypassFrames))

    for (let k = 0; k < this.names.length; k++) this.sources[k] = parameters[this.names[k]]

    for (let frame = 0; frame < outL.length; frame++) {
      const left = inL ? inL[frame] : 0
      const right = inR ? inR[frame] : left

      if (!Number.isFinite(left) || !Number.isFinite(right)) this.fault('nonfinite-input')
      this.bypass = bypassStep(this.bypass, this.enabled ? 0 : 1, step)

      if (kernel) {
        for (let k = 0; k < this.params.length; k++) {
          const source = this.sources[k]
          values[this.params[k][0]] = f(source && source.length > 0 ? source[source.length === 1 ? 0 : frame] : this.fallbacks[k])
        }

        kernel.process(values, this.config, this.bypass, f(left), f(right), this.out)
      } else {
        this.out[0] = sanitized(left)
        this.out[1] = sanitized(right)
      }

      outL[frame] = this.out[0]

      if (outR) outR[frame] = this.out[1]
    }

    return true
  }
}

registerProcessor('daw-modulation-processor', DawModulationProcessor)
