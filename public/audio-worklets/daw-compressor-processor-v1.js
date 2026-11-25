// Mirrors native/audio-core/src/compressor_kernel.h operation for operation (the legacy path must stay within 1e-5 of the
// core), so keep the two in step. Math.fround stands where the core rounds to float.
const f = Math.fround
const CAPACITY = 2048
const MASK = CAPACITY - 1
const RMS_MS = 10
const PEAK_HOLD_MS = 5
const PEAK_RELEASE_MS = 5
const SMOOTH_MS = 8
const AUTO_FAST = 0.25
const AUTO_SLOW = 2
const AUTO_BUILD_MS = 250
const AUTO_DECAY_MS = 1000
const ENGAGED_DB = -0.1
const RECOVERED_DB = -0.5
const FLOOR_DB = -120
const DB_TO_NEPER = 0.11512925464970228
const ENVELOPE_EPSILON_DB = 1e-9
const TWO_PI = Math.fround(2 * Math.PI)
const FLOAT_FLOOR = 1e-19
const DOUBLE_FLOOR = 1e-154
const METER_FRAMES = 2048
const MIN_DB = -120

const gainToDb = (gain) => gain > 0 ? 20 * Math.log10(gain) : MIN_DB
const flushFloat = (value) => Math.abs(value) < FLOAT_FLOOR ? 0 : value
const flushDouble = (value) => Math.abs(value) < DOUBLE_FLOOR ? 0 : value
const clean = (sample) => flushFloat(Number.isFinite(sample) ? sample : 0)
const isObject = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]'

// ParameterSmoother<Linear>: a one-pole in double whose output is rounded to float.
class Smoother {
  constructor(sampleRate) {
    this.coefficient = 1 - Math.exp(-1000 / (SMOOTH_MS * sampleRate))
    this.current = 0
    this.target = 0
    this.targetValue = 0
    this.settling = false
  }
  reset(value) {
    if (!Number.isFinite(value)) return
    this.targetValue = f(value)
    this.target = this.targetValue
    this.current = this.target
    this.settling = false
  }
  setTarget(value) {
    if (!Number.isFinite(value)) return
    const next = f(value)

    if (next === this.targetValue) return
    this.targetValue = next
    this.target = next
    this.settling = Math.abs(this.target - this.current) > 1e-5

    if (!this.settling) this.current = this.target
  }
  next() {
    if (!this.settling) return this.targetValue
    this.current += this.coefficient * (this.target - this.current)

    if (Math.abs(this.target - this.current) <= 1e-5) {
      this.current = this.target
      this.settling = false

      return this.targetValue
    }

    return f(this.current)
  }
}

// RBJ high-pass / low-pass / band-pass as the core's rbj_coefficients designs them: every step is a float operation.
const designSidechain = (filterType, frequencyHz, q, rate) => {
  const frequency = Math.min(frequencyHz, f(rate * 0.49))
  const omega = f(f(TWO_PI * frequency) / rate)
  const cosine = f(Math.cos(omega))
  const alpha = f(f(Math.sin(omega)) / f(2 * q))
  const a0 = f(1 + alpha)
  const a1 = f(-2 * cosine)
  const a2 = f(1 - alpha)
  let b0 = f(f(1 + cosine) * 0.5)
  let b1 = -f(1 + cosine)
  let b2 = b0

  if (filterType === 'lowpass') { b0 = f(f(1 - cosine) * 0.5); b1 = f(1 - cosine); b2 = b0 } else if (filterType === 'bandpass') { b0 = alpha; b1 = 0; b2 = -alpha }

  return { b0: f(b0 / a0), b1: f(b1 / a0), b2: f(b2 / a0), a1: f(a1 / a0), a2: f(a2 / a0) }
}

class CompressorKernel {
  constructor(rate) {
    this.rate = rate
    this.threshold = new Smoother(rate)
    this.ratio = new Smoother(rate)
    this.knee = new Smoother(rate)
    this.makeup = new Smoother(rate)
    this.output = new Smoother(rate)
    this.wet = new Smoother(rate)
    this.rmsDecay = Math.exp(-1 / (RMS_MS * 0.001 * rate))
    this.rmsGain = 1 - this.rmsDecay
    this.peakHoldFrames = Math.round(PEAK_HOLD_MS * 0.001 * rate)
    this.peakRelease = Math.exp(-1 / (PEAK_RELEASE_MS * 0.001 * rate))
    this.autoBuild = 1 - Math.exp(-1 / (AUTO_BUILD_MS * 0.001 * rate))
    this.autoDecay = Math.exp(-1 / (AUTO_DECAY_MS * 0.001 * rate))
    this.bypassFrames = Math.floor((rate + 50) / 100)
    this.bypass = 0
    this.primed = false
    this.makeupPrimed = false
    this.cachedAttackMs = -1
    this.cachedReleaseMs = -1
    this.attack = 0
    this.attackStep = 0
    this.release = [0, 0, 0]
    this.releaseStep = [0, 0, 0]
    this.curve = { threshold: 1e9, ratio: 0, knee: -1, expand: false, rms: false, slope: 0, lower: 0, upper: 0, edgeLevel: 0, floorLevel: 0, dbScale: 0, autoMakeupDb: 0 }
    this.dryL = new Float32Array(CAPACITY)
    this.dryR = new Float32Array(CAPACITY)
    this.filter = null
    this.filterKey = ''
    this.reset()
  }
  reset() {
    this.dryL.fill(0)
    this.dryR.fill(0)
    this.write = 0
    this.s1 = 0
    this.s2 = 0
    this.meanSquare = 0
    this.peak = 0
    this.peakHold = 0
    this.envelopeDb = 0
    this.sustain = 0
    this.gainDb = 0
    this.gain = 1
  }
  onePole(milliseconds) { return Math.exp(-1 / Math.max(1, this.rate * milliseconds / 1000)) }
  slew(milliseconds) { return 60 / Math.max(1, this.rate * milliseconds / 1000) }
  targetDb(db) {
    const c = this.curve
    const threshold = c.threshold

    if (c.expand) {
      if (db >= threshold) return 0

      if (c.knee <= 0 || db <= c.lower) return (db - threshold) * c.slope
      const distance = threshold - db

      return -2 * c.slope * distance * distance / c.knee
    }

    if (c.knee <= 0) return db <= threshold ? 0 : (db - threshold) * c.slope

    if (db <= c.lower) return 0

    if (db >= c.upper) return (db - threshold) * c.slope
    const x = db - c.lower

    return c.slope * x * x / (2 * c.knee)
  }
  designCurve(threshold, ratio, knee, expand, rms) {
    const c = this.curve

    c.threshold = threshold
    c.ratio = ratio
    c.knee = knee
    c.expand = expand
    c.rms = rms
    c.slope = expand ? ratio - 1 : 1 / ratio - 1
    c.lower = threshold - 0.5 * knee
    c.upper = threshold + 0.5 * knee
    const perDb = rms ? 2 * DB_TO_NEPER : DB_TO_NEPER

    c.dbScale = 1 / perDb
    c.edgeLevel = Math.exp((expand ? threshold : c.lower) * perDb)
    c.floorLevel = Math.exp(FLOOR_DB * perDb)
    c.autoMakeupDb = 0

    if (!expand) c.autoMakeupDb = -this.targetDb(0)
  }
  releaseCoefficient(automatic) {
    return automatic ? this.release[1] + (this.release[2] - this.release[1]) * this.sustain : this.release[0]
  }
  releaseStepDb(automatic) {
    return automatic ? this.releaseStep[1] + (this.releaseStep[2] - this.releaseStep[1]) * this.sustain : this.releaseStep[0]
  }
  // Returns the dry-delayed, gain-applied pair through out[0], out[1].
  process(v, c, bypassed, inL, inR, scL, scR, out) {
    const delay = Math.min(Math.ceil(c.lookaheadMs * this.rate / 1000), CAPACITY - 1)

    if (!this.primed) {
      this.threshold.reset(v.thresholdDb)
      this.ratio.reset(v.ratio)
      this.knee.reset(v.kneeDb)
      this.output.reset(v.outputDb)
      this.wet.reset(v.dryWet)
      this.primed = true
    }

    this.threshold.setTarget(v.thresholdDb)
    this.ratio.setTarget(v.ratio)
    this.knee.setTarget(v.kneeDb)
    this.output.setTarget(v.outputDb)
    this.wet.setTarget(v.dryWet)
    const threshold = this.threshold.next()
    const ratio = Math.max(this.ratio.next(), 1)
    const knee = Math.max(this.knee.next(), 0)
    const outputDb = this.output.next()
    const wet = this.wet.next()
    const curve = this.curve

    if (threshold !== curve.threshold || ratio !== curve.ratio || knee !== curve.knee || c.expand !== curve.expand || c.rms !== curve.rms) {
      this.designCurve(threshold, ratio, knee, c.expand, c.rms)
    }

    const makeupTarget = c.autoMakeup ? f(curve.autoMakeupDb) : v.makeupDb

    if (!this.makeupPrimed) {
      this.makeup.reset(makeupTarget)
      this.makeupPrimed = true
    }

    this.makeup.setTarget(makeupTarget)
    const makeup = this.makeup.next()

    if (v.attackMs !== this.cachedAttackMs) {
      this.cachedAttackMs = v.attackMs
      this.attack = this.onePole(v.attackMs)
      this.attackStep = this.slew(v.attackMs)
    }

    if (v.releaseMs !== this.cachedReleaseMs) {
      this.cachedReleaseMs = v.releaseMs
      const ms = v.releaseMs

      this.release = [this.onePole(ms), this.onePole(ms * AUTO_FAST), this.onePole(ms * AUTO_SLOW)]
      this.releaseStep = [this.slew(ms), this.slew(ms * AUTO_FAST), this.slew(ms * AUTO_SLOW)]
    }

    this.bypass = bypassStep(this.bypass, bypassed ? 1 : 0, f(1 / (this.bypassFrames === 0 ? 1 : this.bypassFrames)))
    const dryLeft = clean(inL)
    const dryRight = clean(inR)
    let key = 0.5 * (clean(scL) + clean(scR))

    if (this.filter) {
      const k = this.filter
      const y = k.b0 * key + this.s1

      this.s1 = flushDouble(k.b1 * key - k.a1 * y + this.s2)
      this.s2 = flushDouble(k.b2 * key - k.a2 * y)

      if (Number.isFinite(y)) key = y
      else { this.s1 = 0; this.s2 = 0; key = 0 }
    }

    const slot = this.write & MASK

    this.dryL[slot] = dryLeft
    this.dryR[slot] = dryRight
    const read = (this.write - delay) & MASK

    this.write++
    this.meanSquare = flushDouble(this.rmsDecay * this.meanSquare + this.rmsGain * key * key)
    const magnitude = Math.abs(key)

    if (magnitude >= this.peak) {
      this.peak = magnitude
      this.peakHold = this.peakHoldFrames
    } else if (this.peakHold > 0) this.peakHold--
    else this.peak = flushDouble(magnitude + (this.peak - magnitude) * this.peakRelease)

    const level = c.rms ? this.meanSquare : this.peak
    let target = 0

    if (c.expand ? level < curve.edgeLevel : level > curve.edgeLevel) {
      target = Math.max(this.targetDb(curve.dbScale * Math.log(Math.max(level, curve.floorLevel))), FLOOR_DB)
    }

    if (c.linear) {
      const step = target < this.envelopeDb ? this.attackStep : this.releaseStepDb(c.autoRelease)

      this.envelopeDb += Math.max(-step, Math.min(step, target - this.envelopeDb))
    } else {
      const coefficient = target < this.envelopeDb ? this.attack : this.releaseCoefficient(c.autoRelease)

      this.envelopeDb = target + coefficient * (this.envelopeDb - target)
    }

    if (Math.abs(this.envelopeDb) < ENVELOPE_EPSILON_DB) this.envelopeDb = 0

    if (c.autoRelease) {
      if (target < ENGAGED_DB) this.sustain += (1 - this.sustain) * this.autoBuild
      else if (this.envelopeDb > RECOVERED_DB) this.sustain = flushDouble(this.sustain * this.autoDecay)
    }

    const gainDb = this.envelopeDb + makeup + outputDb

    if (gainDb !== this.gainDb) {
      this.gainDb = gainDb
      this.gain = Math.exp(gainDb * DB_TO_NEPER)
    }

    const mix = 1 + wet * (this.gain - 1)
    const dl = this.dryL[read]
    const dr = this.dryR[read]
    const wl = f(dl * mix)
    const wr = f(dr * mix)
    const left = f(wl + f(f(dl - wl) * this.bypass))
    const right = f(wr + f(f(dr - wr) * this.bypass))

    if (!Number.isFinite(this.envelopeDb) || !Number.isFinite(this.meanSquare) || !Number.isFinite(this.peak) || !Number.isFinite(this.gain)) this.reset()

    if (Number.isFinite(left) && Number.isFinite(right)) {
      out[0] = left
      out[1] = right
    } else {
      this.reset()
      out[0] = 0
      out[1] = 0
    }
  }
}

const bypassStep = (current, target, step) => {
  if (target > current + step) return f(current + step)

  if (target < current - step) return f(current - step)

  return target
}

class CompressorProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.params = null
    this.values = null
    this.config = null
    this.kernel = new CompressorKernel(sampleRate)
    this.frame = [0, 0]
    this.meterFrames = 0
    this.meterInSum = 0
    this.meterOutSum = 0
    this.meterGainReductionDb = 0
    this.meteringEnabled = false
    this.port.onmessage = (event) => {
      const data = event.data

      if (!isObject(data)) return

      if (data.type === 'params' && isObject(data.params)) this.configure(data.params)

      if (data.type === 'metering' && (data.enabled === true || data.enabled === false)) {
        this.meteringEnabled = data.enabled

        if (!data.enabled) this.resetMeter()
      }
    }

    this.configure({})
  }
  configure(p) {
    const number = (value, fallback) => f(Number.isFinite(value) ? value : fallback)
    const sidechain = isObject(p.sidechain) ? p.sidechain : {}

    this.params = p
    this.enabled = p.enabled !== false
    this.values = {
      thresholdDb: number(p.thresholdDb, -24), ratio: number(p.ratio, 4), attackMs: number(p.attackMs, 10), releaseMs: number(p.releaseMs, 120),
      makeupDb: number(p.makeupDb, 0), outputDb: number(p.outputDb, 0), dryWet: number(p.dryWet, 1), kneeDb: number(p.kneeDb, 6),
    }
    this.config = {
      lookaheadMs: number(p.lookaheadMs, 0), autoRelease: p.autoRelease === true, autoMakeup: p.autoMakeup === true,
      rms: p.detectorMode !== 'peak', expand: p.dynamicsMode === 'expand', linear: p.envelopeCurve === 'linear',
    }
    this.sidechain = {
      enabled: sidechain.enabled === true, filterType: sidechain.filterType === 'lowpass' || sidechain.filterType === 'bandpass' ? sidechain.filterType : 'highpass',
      frequencyHz: number(sidechain.frequencyHz, 120), q: number(sidechain.q, 0.707),
    }
    const { enabled, filterType, frequencyHz, q } = this.sidechain
    const key = enabled ? filterType + ':' + frequencyHz + ':' + q : ''

    if (key !== this.kernel.filterKey) {
      this.kernel.filterKey = key
      this.kernel.filter = enabled ? designSidechain(filterType, frequencyHz, q, sampleRate) : null
    }
  }
  resetMeter() {
    this.meterFrames = 0
    this.meterInSum = 0
    this.meterOutSum = 0
    this.meterGainReductionDb = 0
  }
  process(inputs, outputs) {
    const input = inputs[0]
    const external = inputs[1] || []
    const output = outputs[0]
    const left = input[0]

    if (!left) return true
    const right = input[1] || left
    const keyLeft = external[0] || left
    const keyRight = external[0] ? external[1] || keyLeft : right
    const outL = output[0]
    const outR = output[1] || outL
    const config = external[0] ? { ...this.config, autoMakeup: false } : this.config
    const bypassed = !this.enabled
    const frame = this.frame

    for (let i = 0; i < left.length; i++) {
      this.kernel.process(this.values, config, bypassed, left[i], right[i], keyLeft[i], keyRight[i], frame)
      outL[i] = frame[0]
      outR[i] = frame[1]

      if (this.meteringEnabled) {
        this.meterInSum += (left[i] * left[i] + right[i] * right[i]) * 0.5
        this.meterOutSum += (frame[0] * frame[0] + frame[1] * frame[1]) * 0.5
        this.meterGainReductionDb = Math.min(this.meterGainReductionDb, this.kernel.envelopeDb)
      }
    }

    if (this.meteringEnabled) this.meterFrames += left.length

    if (this.meteringEnabled && this.meterFrames >= METER_FRAMES) {
      this.port.postMessage({
        type: 'meter',
        inputDb: gainToDb(Math.sqrt(this.meterInSum / this.meterFrames)),
        outputDb: gainToDb(Math.sqrt(this.meterOutSum / this.meterFrames)),
        gainReductionDb: this.meterGainReductionDb,
        thresholdDb: this.values.thresholdDb,
      })
      this.resetMeter()
    }

    return true
  }
}

registerProcessor('daw-compressor-processor', CompressorProcessor)
