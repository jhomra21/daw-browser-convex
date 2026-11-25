// Mirrors native/audio-core/src/autofilter_kernel.h and processor_autofilter.cpp operation for operation (the legacy path
// must stay within 1e-5 of the core), so keep the three in step. Math.fround stands where the core rounds to float;
// everything else is double.
//
// What this path cannot do: an AudioWorklet knows neither the song position nor the project tempo, so a synced LFO
// free-runs from the first frame at 120 bpm (the core's own fallback when its transport carries no tempo) instead of
// locking to the bar. Where the shared engine plays the project the core does lock it.
const f = Math.fround

const PARAMS = [
  ['autofilter.frequencyHz', 1000, 20, 20000],
  ['autofilter.resonance', 0.15, 0, 1],
  ['autofilter.driveDb', 0, 0, 24],
  ['autofilter.mix', 1, 0, 1],
  ['autofilter.outputDb', 0, -24, 24],
  ['autofilter.envelope.amountOctaves', 0, -6, 6],
  ['autofilter.envelope.attackMs', 10, 0.5, 500],
  ['autofilter.envelope.releaseMs', 100, 5, 2000],
  ['autofilter.lfo.rateHz', 1, 0.01, 20],
  ['autofilter.lfo.depthOctaves', 0, 0, 6],
  ['autofilter.lfo.phaseOffset', 0, 0, 1],
  ['autofilter.lfo.stereoPhase', 0, -0.5, 0.5],
]

const MODES = ['lowpass', 'highpass', 'bandpass', 'notch', 'peak']
const WAVEFORMS = ['sine', 'triangle', 'sawDown', 'sawUp', 'square', 'sampleHold']
const DIVISION_COUNT = 16
const DEFAULT_TEMPO_BPM = 120
const MINIMUM_Q = f(0.70710678)
const MAXIMUM_Q = 8
const STATE_GUARD = 1024
const HISTORY_FRAMES = 64
const HALF_LENGTH = 32
const HISTORY = 2 * HALF_LENGTH
const OVERSAMPLER_LATENCY = 2 * HALF_LENGTH - 1
const DENORMAL_FLOOR = f(1e-19)
const LN2 = 0.6931471805599453
const BEATS = [8, 4, 3, 2, 1.5, 1, 2 / 3, 0.75, 0.5, 1 / 3, 0.375, 0.25, 1 / 6, 0.1875, 0.125, 1 / 12].map(f)

const flushDenormal = (value) => Math.abs(value) < DENORMAL_FLOOR ? 0 : value
const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
const isObject = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]'
const isAutoFilterMessage = (message) => isObject(message) && message.version === 1

const isAutoFilterConfigureMessage = (message, revision) => isAutoFilterMessage(message)
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

// Adaa1<TanhShaper>: first-order antiderivative antialiasing, state in double.
const antiderivative = (x) => {
  const a = Math.abs(x)

  return a + Math.log1p(Math.exp(-2 * a)) - LN2
}

class Adaa {
  constructor() { this.reset() }
  reset() {
    this.previousInput = 0
    this.previousAntiderivative = antiderivative(0)
  }
  process(input) {
    if (!Number.isFinite(input)) {
      this.reset()

      return 0
    }

    const x = input
    const integral = antiderivative(x)
    const step = x - this.previousInput
    const y = Math.abs(step) < 1e-6 ? Math.tanh(0.5 * (x + this.previousInput)) : (integral - this.previousAntiderivative) / step
    this.previousInput = x
    this.previousAntiderivative = integral

    return f(y)
  }
}

const besselI0 = (x) => {
  let sum = 1
  let term = 1

  for (let k = 1; k < 60; k++) {
    term *= (x / (2 * k)) * (x / (2 * k))
    sum += term
  }

  return sum
}

// Kaiser-windowed half-band: every second tap is zero, the centre tap is 0.5, and the stored taps sum to exactly 0.5.
const HALF_BAND_TAPS = (() => {
  const centre = 2 * HALF_LENGTH - 1
  const raw = new Float64Array(HISTORY)
  let side = 0

  for (let j = 0; j < HISTORY; j++) {
    const offset = 2 * j - centre
    const ratio = offset / centre
    const window = besselI0(10 * Math.sqrt(1 - ratio * ratio)) / besselI0(10)
    raw[j] = Math.sin(Math.PI * offset / 2) / (Math.PI * offset) * window
    side += raw[j]
  }

  return Float32Array.from({ length: HALF_LENGTH }, (_, j) => raw[j] * 0.5 / side)
})()

// HalfBandOversampler2x: up then down delays the signal by OVERSAMPLER_LATENCY (63) base-rate frames.
class Oversampler {
  constructor() {
    this.input = new Float32Array(HISTORY)
    this.even = new Float32Array(HISTORY)
    this.odd = new Float32Array(HISTORY)
    this.pair = [0, 0]
    this.reset()
  }
  reset() {
    this.input.fill(0)
    this.even.fill(0)
    this.odd.fill(0)
    this.inputWrite = 0
    this.evenWrite = 0
    this.oddWrite = 0
  }
  at(history, write, age) { return history[(write - 1 - age) & (HISTORY - 1)] }
  fold(history, write) {
    let sum = 0

    for (let j = 0; j < HALF_LENGTH; j++) sum = f(sum + f(HALF_BAND_TAPS[j] * f(this.at(history, write, j) + this.at(history, write, HISTORY - 1 - j))))

    return sum
  }
  up(x) {
    this.input[this.inputWrite++ & (HISTORY - 1)] = x
    this.pair[0] = f(2 * this.fold(this.input, this.inputWrite))
    this.pair[1] = this.at(this.input, this.inputWrite, HALF_LENGTH - 1)

    return this.pair
  }
  down(first, second) {
    this.even[this.evenWrite++ & (HISTORY - 1)] = first
    const y = f(this.fold(this.even, this.evenWrite) + f(0.5 * this.at(this.odd, this.oddWrite, HALF_LENGTH - 1)))
    this.odd[this.oddWrite++ & (HISTORY - 1)] = second

    return y
  }
}

const createPath = (mode, slope) => ({ stages: [{ ic1: 0, ic2: 0 }, { ic1: 0, ic2: 0 }], mode, slope })

const createChannel = (mode, slope) => ({
  paths: [createPath(mode, slope), createPath(0, 0)],
  coefficients: [null, null],
  valid: [false, false],
  oversampler: new Oversampler(),
  driveAdaa: new Adaa(),
  clipAdaa: new Adaa(),
  dry: new Float32Array(HISTORY_FRAMES),
  write: 0,
  phase: 0,
  cycle: 0,
  cutoff: 1000,
  lastCutoff: -1,
  lastQ: -1,
})

const qFromResonance = (resonance) => f(MINIMUM_Q * f(Math.pow(f(MAXIMUM_Q / MINIMUM_Q), clamp(resonance, 0, 1))))

const syncRateHz = (division, tempoBpm) =>
  f((tempoBpm > 0 ? tempoBpm : DEFAULT_TEMPO_BPM) / 60 / BEATS[Math.min(division, DIVISION_COUNT - 1)])

// Bipolar value for one point of a cycle. `cycle` seeds sample and hold so left and right share one sequence.
const lfoValue = (waveform, fraction, cycle) => {
  const phase = f(fraction)

  switch (waveform) {
    case 1: return f(1 - f(4 * Math.abs(f(phase - 0.5))))
    case 2: return f(1 - f(2 * phase))
    case 3: return f(f(2 * phase) - 1)
    case 4: return phase < 0.5 ? 1 : -1
    case 5: {
      let x = Math.imul(cycle, 2654435761) >>> 0
      x = (x ^ (x >>> 16)) >>> 0
      x = Math.imul(x, 0x45D9F3B) >>> 0
      x = (x ^ (x >>> 16)) >>> 0

      return f(f(f(x) * 2 ** -31) - 1)
    }

    default: return f(Math.sin(f(f(2 * Math.PI) * phase)))
  }
}

// The integrator states only need a guard against a runaway: 60 dB above full scale, far over any state a +6 dBFS input reaches at Q 8.
const limitState = (s) => {
  const a = Math.abs(s)

  if (a <= STATE_GUARD) return s

  return Math.sign(s) * f(STATE_GUARD * f(1 + f(2 * f(Math.tanh(f(f(f(a / STATE_GUARD) - 1) * 0.5))))))
}

const stageOutput = (stage, c, mode, x) => {
  const v3 = f(x - stage.ic2)
  const v1 = f(f(c.a1 * stage.ic1) + f(c.a2 * v3))
  const v2 = f(f(stage.ic2 + f(c.a2 * stage.ic1)) + f(c.a3 * v3))
  stage.ic1 = flushDenormal(limitState(f(f(2 * v1) - stage.ic1)))
  stage.ic2 = flushDenormal(limitState(f(f(2 * v2) - stage.ic2)))
  const band = f(c.k * v1)

  switch (mode) {
    case 1: return f(f(x - band) - v2)
    case 2: return band
    case 3: return f(x - band)
    case 4: return f(f(f(2 * v2) + band) - x)
    default: return v2
  }
}

class AutoFilterKernel {
  constructor(rate) {
    this.rate = rate
    this.frequency = new Smoother(true)
    this.resonance = new Smoother(false)
    this.drive = new Smoother(false)
    this.mix = new Smoother(false)
    this.output = new Smoother(false)

    for (const smoother of [this.frequency, this.resonance, this.drive, this.mix, this.output]) smoother.prepare(rate, 8)
    this.initialized = false
    this.channels = [createChannel(0, 0), createChannel(0, 0)]
    this.fading = false
    this.envelope = [0, 0]
    this.attacking = [false, false]
    this.heldPeak = [0, 0]
    this.baseFrequency = 1000
    this.q = MINIMUM_Q
    this.lastResonance = -1
    this.driveGain = 1
    this.driveBlend = 0
    this.lastDrive = -1
    this.mixValue = 1
    this.outputGain = 1
    this.lastOutput = -1000
    this.active = 0
    this.fadePosition = 0
    this.fadeFrames = 480
    this.applied = null
    this.input = [0, 0]
    this.result = [0, 0]
  }
  latencyFrames(hiQuality) { return hiQuality ? OVERSAMPLER_LATENCY : 0 }
  initialize(values, config) {
    this.frequency.reset(values.frequencyHz)
    this.resonance.reset(values.resonance)
    this.drive.reset(values.driveDb)
    this.mix.reset(values.mix)
    this.output.reset(values.outputDb)

    for (const channel of this.channels) {
      channel.paths[0].mode = config.mode
      channel.paths[0].slope = config.slope
    }

    this.applied = { ...config }
    this.initialized = true
  }
  applyConfig(config) {
    if (config.hiQuality !== this.applied.hiQuality) {
      for (const channel of this.channels) {
        channel.oversampler.reset()
        channel.driveAdaa.reset()
        channel.clipAdaa.reset()
        channel.dry.fill(0)
        channel.valid.fill(false)
      }
    }

    if (config.mode !== this.applied.mode || config.slope !== this.applied.slope) {
      // The new type starts from silent state and fades in over 10 ms while the old one fades out.
      const incoming = 1 - this.active

      for (const channel of this.channels) {
        channel.paths[incoming] = createPath(config.mode, config.slope)
        channel.valid.fill(false)
      }

      this.active = incoming
      this.fading = true
      this.fadePosition = 0
      this.fadeFrames = Math.max(1, Math.floor(0.010 * this.rate) >>> 0)
    }

    this.applied = { ...config }
  }
  smooth(values) {
    this.frequency.setTarget(values.frequencyHz)
    this.resonance.setTarget(values.resonance)
    this.drive.setTarget(values.driveDb)
    this.mix.setTarget(values.mix)
    this.output.setTarget(values.outputDb)
    this.baseFrequency = this.frequency.next()
    const resonance = this.resonance.next()

    if (resonance !== this.lastResonance) {
      this.q = qFromResonance(resonance)
      this.lastResonance = resonance
    }

    const drive = this.drive.next()

    if (drive !== this.lastDrive) {
      this.driveGain = f(Math.pow(10, f(drive / 20)))
      this.driveBlend = Math.min(1, f(drive / 6))
      this.lastDrive = drive
    }

    this.mixValue = this.mix.next()
    const output = this.output.next()

    if (output !== this.lastOutput) {
      this.outputGain = f(Math.pow(10, f(output / 20)))
      this.lastOutput = output
    }
  }
  // The follower runs on the linear peak; its level maps to the modulation through dB so the amount means the same
  // octaves at any input level: -60 dBFS gives none, 0 dBFS gives the full amount.
  updateEnvelope(values, config, input) {
    const rate = f(this.rate)
    const attack = f(Math.exp(f(-1 / f(f(f(Math.max(0.5, values.envAttackMs) * f(0.001)) * rate)))))
    const release = f(Math.exp(f(-1 / f(f(f(Math.max(5, values.envReleaseMs) * f(0.001)) * rate)))))
    const linked = Math.max(Math.abs(input[0]), Math.abs(input[1]))

    for (let c = 0; c < (config.envLink ? 1 : 2); c++) {
      const level = config.envLink ? linked : Math.abs(input[c])
      let env = this.envelope[c]

      if (config.envHold) {
        if (!this.attacking[c] && level > env) {
          this.attacking[c] = true
          this.heldPeak[c] = level
        }

        if (this.attacking[c]) {
          this.heldPeak[c] = Math.max(this.heldPeak[c], level)
          env = f(f(attack * env) + f(f(1 - attack) * this.heldPeak[c]))

          if (env >= f(0.95 * this.heldPeak[c])) this.attacking[c] = false
        } else {
          env = f(f(release * env) + f(f(1 - release) * level))
        }
      } else {
        this.attacking[c] = false
        env = level > env ? f(f(attack * env) + f(f(1 - attack) * level)) : f(f(release * env) + f(f(1 - release) * level))
      }

      this.envelope[c] = flushDenormal(env)
    }

    if (config.envLink) this.envelope[1] = this.envelope[0]
  }
  coefficients(channel, slope, cutoff, rate) {
    if (cutoff !== channel.lastCutoff || this.q !== channel.lastQ) {
      channel.valid.fill(false)
      channel.lastCutoff = cutoff
      channel.lastQ = this.q
    }

    if (!channel.valid[slope]) {
      const stageQ = slope === 0 ? this.q : f(Math.sqrt(this.q))
      const g = f(Math.tan(f(f(f(Math.PI) * cutoff) / rate)))
      const k = f(1 / stageQ)
      const a1 = f(1 / f(1 + f(g * f(g + k))))
      channel.coefficients[slope] = { a1, a2: f(g * a1), a3: f(f(g * g) * a1), k }
      channel.valid[slope] = true
    }

    return channel.coefficients[slope]
  }
  runPath(channel, index, cutoff, rate, x) {
    const path = channel.paths[index]
    const c = this.coefficients(channel, path.slope, cutoff, rate)
    let y = stageOutput(path.stages[0], c, path.mode, x)

    if (path.slope === 1) y = stageOutput(path.stages[1], c, path.mode, y)

    return y
  }
  filterSample(channel, cutoff, rate, x) {
    if (!this.fading) return this.runPath(channel, this.active, cutoff, rate, x)
    const weight = f(f(this.fadePosition) / f(this.fadeFrames))
    const outgoing = this.runPath(channel, 1 - this.active, cutoff, rate, x)
    const incoming = this.runPath(channel, this.active, cutoff, rate, x)

    return f(outgoing + f(f(incoming - outgoing) * weight))
  }
  driveSample(channel, hiQuality, x) {
    if (this.driveBlend <= 0) {
      channel.driveAdaa.reset()

      return x
    }

    const u = f(this.driveGain * x)
    const driven = f(f(hiQuality ? channel.driveAdaa.process(u) : f(Math.tanh(u))) / this.driveGain)

    return f(x + f(this.driveBlend * f(driven - x)))
  }
  clipSample(channel, hiQuality, clip, x) {
    if (!clip) return x

    return hiQuality ? channel.clipAdaa.process(x) : f(Math.tanh(x))
  }
  renderChannel(index, values, config, rate, input, bypass) {
    const channel = this.channels[index]
    let phase = channel.phase + values.lfoPhaseOffset

    if (index === 1 && config.stereoMode === 0) phase += values.lfoStereoPhase
    const whole = Math.floor(phase)
    const lfo = lfoValue(config.waveform, phase - whole, (channel.cycle + whole) >>> 0)
    channel.phase += rate / this.rate

    if (channel.phase >= 1) {
      const wraps = Math.floor(channel.phase)
      channel.phase -= wraps
      channel.cycle = (channel.cycle + wraps) >>> 0
    }

    const envUnit = clamp(f(f(f(20 * f(Math.log10(Math.max(this.envelope[index], f(1e-6))))) + 60) / 60), 0, 1)
    const octaves = f(f(values.envAmountOctaves * envUnit) + f(values.lfoDepthOctaves * lfo))
    const cutoff = clamp(f(this.baseFrequency * f(Math.pow(2, octaves))), 20, f(f(0.45) * f(this.rate)))
    channel.cutoff = cutoff
    channel.dry[channel.write & (HISTORY_FRAMES - 1)] = input
    const dry = channel.dry[(channel.write - this.latencyFrames(config.hiQuality)) & (HISTORY_FRAMES - 1)]
    channel.write = (channel.write + 1) >>> 0
    let wet = 0

    if (config.hiQuality) {
      const pair = channel.oversampler.up(input)
      const rate2 = f(2 * this.rate)
      const doubled = [pair[0], pair[1]]

      for (let n = 0; n < 2; n++) {
        const filtered = this.filterSample(channel, cutoff, rate2, this.driveSample(channel, true, doubled[n]))
        doubled[n] = this.clipSample(channel, true, config.clip, f(filtered * this.outputGain))
      }

      wet = channel.oversampler.down(doubled[0], doubled[1])
    } else {
      const filtered = this.filterSample(channel, cutoff, f(this.rate), this.driveSample(channel, false, input))
      wet = this.clipSample(channel, false, config.clip, f(filtered * this.outputGain))
    }

    if (!Number.isFinite(wet)) {
      channel.paths[0].stages = [{ ic1: 0, ic2: 0 }, { ic1: 0, ic2: 0 }]
      channel.paths[1].stages = [{ ic1: 0, ic2: 0 }, { ic1: 0, ic2: 0 }]
      channel.oversampler.reset()
      channel.driveAdaa.reset()
      channel.clipAdaa.reset()
      wet = 0
    }

    const mixed = f(dry + f(f(wet - dry) * this.mixValue))

    return flushDenormal(f(mixed + f(f(dry - mixed) * bypass)))
  }
  // Discrete settings may change at any frame; filter type and slope crossfade, quality resets the oversampler.
  process(values, config, bypass, inLeft, inRight, out) {
    if (!this.initialized) this.initialize(values, config)
    this.applyConfig(config)
    this.smooth(values)
    this.input[0] = Number.isFinite(inLeft) ? inLeft : 0
    this.input[1] = Number.isFinite(inRight) ? inRight : 0
    this.updateEnvelope(values, config, this.input)
    const base = config.sync ? syncRateHz(config.division, 0) : values.lfoRateHz

    for (let c = 0; c < 2; c++) {
      const rate = c === 1 && config.stereoMode === 1 ? base * (1 + values.lfoStereoPhase) : base
      this.result[c] = this.renderChannel(c, values, config, rate, this.input[c], bypass)
    }

    if (this.fading && ++this.fadePosition >= this.fadeFrames) this.fading = false
    out[0] = this.result[0]
    out[1] = this.result[1]
  }
}

class DawAutoFilterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return PARAMS.map(([name, defaultValue, minValue, maxValue]) => ({ name, defaultValue, minValue, maxValue, automationRate: 'a-rate' }))
  }

  constructor() {
    super()
    this.revision = -1
    this.enabled = true
    this.config = { mode: 0, slope: 0, waveform: 0, stereoMode: 0, division: 5, hiQuality: false, clip: false, envHold: false, envLink: false, sync: false }
    this.kernel = new AutoFilterKernel(sampleRate)
    this.values = {
      frequencyHz: 1000, resonance: 0.15, driveDb: 0, mix: 1, outputDb: 0, envAmountOctaves: 0, envAttackMs: 10, envReleaseMs: 100,
      lfoRateHz: 1, lfoDepthOctaves: 0, lfoPhaseOffset: 0, lfoStereoPhase: 0,
    }
    this.out = new Float64Array(2)
    this.bypassFrames = Math.floor((sampleRate + 50) / 100)
    this.bypass = 0
    this.faults = 0
    this.port.onmessage = (event) => this.onMessage(event.data)
    this.port.postMessage({ type: 'ready', version: 1 })
  }

  reset() {
    this.kernel = new AutoFilterKernel(sampleRate)
    this.bypass = this.enabled ? 0 : 1
  }

  onMessage(message) {
    if (!isAutoFilterMessage(message)) return this.fault('malformed-message')

    if (message.type === 'dispose') return this.port.close()

    if (message.type === 'reset') return this.reset()

    if (!isAutoFilterConfigureMessage(message, this.revision)) return this.fault('malformed-or-stale-configure')
    this.revision = message.revision
    const state = message.state
    const envelope = isObject(state.envelope) ? state.envelope : {}
    const lfo = isObject(state.lfo) ? state.lfo : {}
    const division = Number.isInteger(lfo.division) ? lfo.division : 5
    this.enabled = state.enabled !== false

    this.config = {
      mode: Math.max(0, MODES.indexOf(state.mode)),
      slope: state.slope === 24 ? 1 : 0,
      waveform: Math.max(0, WAVEFORMS.indexOf(lfo.waveform)),
      stereoMode: lfo.stereoMode === 'spin' ? 1 : 0,
      division: clamp(division, 0, DIVISION_COUNT - 1),
      hiQuality: state.hiQuality === true,
      clip: state.clip === true,
      envHold: envelope.hold === true,
      envLink: envelope.link === true,
      sync: lfo.sync === true,
    }
    this.port.postMessage({ type: 'configured', version: 1, revision: this.revision })
  }

  fault(code) {
    if (this.faults++ < 4) this.port.postMessage({ type: 'fault', version: 1, code })
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] || []
    const output = outputs[0] || []
    const outL = output[0]

    if (!outL) return true
    const outR = output[1]
    const inL = input[0]
    const inR = input[1] || inL
    const at = (name, frame) => f(parameters[name][parameters[name].length === 1 ? 0 : frame])
    const values = this.values
    const step = f(1 / (this.bypassFrames === 0 ? 1 : this.bypassFrames))

    for (let frame = 0; frame < outL.length; frame++) {
      const left = inL ? inL[frame] : 0
      const right = inR ? inR[frame] : left

      if (!Number.isFinite(left) || !Number.isFinite(right)) this.fault('nonfinite-input')
      values.frequencyHz = at('autofilter.frequencyHz', frame)
      values.resonance = at('autofilter.resonance', frame)
      values.driveDb = at('autofilter.driveDb', frame)
      values.mix = at('autofilter.mix', frame)
      values.outputDb = at('autofilter.outputDb', frame)
      values.envAmountOctaves = at('autofilter.envelope.amountOctaves', frame)
      values.envAttackMs = at('autofilter.envelope.attackMs', frame)
      values.envReleaseMs = at('autofilter.envelope.releaseMs', frame)
      values.lfoRateHz = at('autofilter.lfo.rateHz', frame)
      values.lfoDepthOctaves = at('autofilter.lfo.depthOctaves', frame)
      values.lfoPhaseOffset = at('autofilter.lfo.phaseOffset', frame)
      values.lfoStereoPhase = at('autofilter.lfo.stereoPhase', frame)
      this.bypass = bypassStep(this.bypass, this.enabled ? 0 : 1, step)
      this.kernel.process(values, this.config, this.bypass, f(left), f(right), this.out)
      outL[frame] = this.out[0]

      if (outR) outR[frame] = this.out[1]
    }

    return true
  }
}

registerProcessor('daw-autofilter-processor', DawAutoFilterProcessor)
