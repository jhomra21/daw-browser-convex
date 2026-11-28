// Mirrors native/audio-core/src/gate_kernel.h and processor_gate.cpp operation for operation (the legacy path must stay within
// 1e-5 of the core), so keep the three in step. Math.fround stands where the core rounds to float; everything else is double.
const f = Math.fround
const CAPACITY = 2048
const MASK = CAPACITY - 1
const WINDOW_CAPACITY = 1024
const WINDOW_MASK = WINDOW_CAPACITY - 1
const RMS_MS = 10
const PEAK_WINDOW_MS = 4
const SILENCE = 1e-8
const DB_TO_NEPER = 0.11512925464970228
const NEPER_TO_DB = 8.685889638065037
const UNSET = f(1e30)
const TWO_PI = f(2 * Math.PI)
const FLOAT_FLOOR = 1e-19
const DOUBLE_FLOOR = 1e-154
const METER_FRAMES = 2048

const names = [
  ['gate.thresholdDb', -40, -80, 0], ['gate.ratio', 4, 1, 20], ['gate.attackMs', 1, 0.1, 100],
  ['gate.holdMs', 20, 0, 500], ['gate.releaseMs', 120, 5, 2000], ['gate.hysteresisDb', 6, 0, 24],
  ['gate.rangeDb', -80, -80, 0], ['gate.link', 1, 0, 1], ['gate.sidechain.frequencyHz', 80, 20, 20000],
  ['gate.sidechain.q', 0.707, 0.1, 18], ['gate.sidechain.gainDb', 0, -70, 24], ['gate.sidechain.mix', 1, 0, 1],
]

const flushFloat = (value) => Math.abs(value) < FLOAT_FLOOR ? 0 : value
const flushDouble = (value) => Math.abs(value) < DOUBLE_FLOOR ? 0 : value
const clean = (sample) => flushFloat(Number.isFinite(sample) ? sample : 0)
const isObject = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]'
const isGateMessage = (message) => isObject(message) && message.version === 1

const isGateConfigureMessage = (message, revision) => isGateMessage(message)
  && message.type === 'configure'
  && Number.isInteger(message.revision)
  && message.revision > revision
  && isObject(message.state)

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

const bypassStep = (current, target, step) => {
  if (target > current + step) return f(current + step)

  if (target < current - step) return f(current - step)

  return target
}

class GateKernel {
  constructor(rate) {
    this.rate = rate
    this.rmsDecay = Math.exp(-1 / (RMS_MS * 0.001 * rate))
    this.rmsGain = 1 - this.rmsDecay
    this.windowFrames = Math.min(Math.max(Math.round(PEAK_WINDOW_MS * 0.001 * rate), 1), WINDOW_CAPACITY - 1)
    this.bypassFrames = Math.floor((rate + 50) / 100)
    this.bypass = 0
    this.cachedThresholdDb = UNSET
    this.cachedHysteresisDb = UNSET
    this.cachedHoldMs = UNSET
    this.cachedAttackMs = UNSET
    this.cachedReleaseMs = UNSET
    this.cachedSidechainGainDb = UNSET
    this.openLevel = 0
    this.closeLevel = 0
    this.holdFrames = 0
    this.attackPerFrame = 0
    this.releasePerFrame = 0
    this.sidechainGain = 1
    this.mix = 1
    this.filterEnabled = false
    this.filterCoefficients = null
    this.filterFrequency = 0
    this.filterQ = 0
    this.filterType = ''
    this.dry = [new Float32Array(CAPACITY), new Float32Array(CAPACITY)]
    this.windowValue = [new Float64Array(WINDOW_CAPACITY), new Float64Array(WINDOW_CAPACITY)]
    this.windowPosition = [new Uint32Array(WINDOW_CAPACITY), new Uint32Array(WINDOW_CAPACITY)]
    this.windowHead = [0, 0]
    this.windowTail = [0, 0]
    this.filterS1 = [0, 0]
    this.filterS2 = [0, 0]
    this.meanSquare = [0, 0]
    this.open = [true, true]
    this.started = [false, false]
    this.hold = [0, 0]
    this.gainDb = [0, 0]
    this.gainAppliedDb = [0, 0]
    this.gain = [1, 1]
    this.level = [0, 0]
    this.reset()
  }
  reset() {
    this.dry[0].fill(0)
    this.dry[1].fill(0)
    this.write = 0
    this.tick = 0

    for (let channel = 0; channel < 2; channel++) {
      this.filterS1[channel] = 0
      this.filterS2[channel] = 0
      this.windowHead[channel] = 0
      this.windowTail[channel] = 0
      this.meanSquare[channel] = 0
      this.open[channel] = true
      this.started[channel] = false
      this.hold[channel] = 0
      this.gainDb[channel] = 0
      this.gainAppliedDb[channel] = 0
      this.gain[channel] = 1
    }
  }
  // Designs the detector filter when what it is made from changes; the state it runs on carries over.
  setSidechain(enabled, filterType, frequencyHz, q) {
    if (!enabled) {
      this.filterEnabled = false
      this.filterFrequency = 0

      return
    }

    if (frequencyHz !== this.filterFrequency || q !== this.filterQ || filterType !== this.filterType) {
      this.filterFrequency = frequencyHz
      this.filterQ = q
      this.filterType = filterType
      this.filterCoefficients = designSidechain(filterType, frequencyHz, q, this.rate)
    }

    this.filterEnabled = true
  }
  gainReductionDb() { return Math.min(this.gainDb[0], this.gainDb[1]) }
  filter(channel, input) {
    const c = this.filterCoefficients
    const y = c.b0 * input + this.filterS1[channel]

    this.filterS1[channel] = flushDouble(c.b1 * input - c.a1 * y + this.filterS2[channel])
    this.filterS2[channel] = flushDouble(c.b2 * input - c.a2 * y)

    if (Number.isFinite(y)) return y
    this.filterS1[channel] = 0
    this.filterS2[channel] = 0

    return 0
  }
  peakLevel(channel, key) {
    const value = this.windowValue[channel]
    const position = this.windowPosition[channel]
    const magnitude = Math.abs(key)
    let head = this.windowHead[channel]
    let tail = this.windowTail[channel]

    while (tail !== head && value[(tail - 1) & WINDOW_MASK] <= magnitude) tail--
    value[tail & WINDOW_MASK] = magnitude
    position[tail & WINDOW_MASK] = this.tick
    tail++

    while (((this.tick - position[head & WINDOW_MASK]) >>> 0) >= this.windowFrames) head++
    this.windowHead[channel] = head
    this.windowTail[channel] = tail

    return value[head & WINDOW_MASK]
  }
  rmsLevel(channel, key) {
    this.meanSquare[channel] = flushDouble(this.rmsDecay * this.meanSquare[channel] + this.rmsGain * key * key)

    return Math.sqrt(this.meanSquare[channel])
  }
  refresh(v) {
    if (v.thresholdDb !== this.cachedThresholdDb || v.hysteresisDb !== this.cachedHysteresisDb) {
      this.cachedThresholdDb = v.thresholdDb
      this.cachedHysteresisDb = v.hysteresisDb
      this.openLevel = Math.exp(v.thresholdDb * DB_TO_NEPER)
      this.closeLevel = Math.exp((v.thresholdDb - v.hysteresisDb) * DB_TO_NEPER)
    }

    if (v.holdMs !== this.cachedHoldMs) {
      this.cachedHoldMs = v.holdMs
      this.holdFrames = Math.round(v.holdMs * 0.001 * this.rate)
    }

    if (v.attackMs !== this.cachedAttackMs) {
      this.cachedAttackMs = v.attackMs
      this.attackPerFrame = 1 / Math.max(1, this.rate * v.attackMs / 1000)
    }

    if (v.releaseMs !== this.cachedReleaseMs) {
      this.cachedReleaseMs = v.releaseMs
      this.releasePerFrame = 1 / Math.max(1, this.rate * v.releaseMs / 1000)
    }

    if (v.sidechainGainDb !== this.cachedSidechainGainDb) {
      this.cachedSidechainGainDb = v.sidechainGainDb
      this.sidechainGain = Math.exp(v.sidechainGainDb * DB_TO_NEPER)
    }

    this.mix = Math.min(Math.max(v.sidechainMix, 0), 1)
  }
  // Returns the delayed, gain-applied pair through out[0], out[1].
  process(v, c, bypassed, inL, inR, scL, scR, out) {
    const delay = Math.min(Math.ceil(c.lookaheadMs * this.rate / 1000), CAPACITY - 1)

    this.refresh(v)
    this.bypass = bypassStep(this.bypass, bypassed ? 1 : 0, f(1 / (this.bypassFrames === 0 ? 1 : this.bypassFrames)))
    const input = [clean(inL), clean(inR)]
    const external = [clean(scL), clean(scR)]
    const slot = this.write & MASK
    const read = (this.write - delay) & MASK

    this.write++

    for (let channel = 0; channel < 2; channel++) {
      this.dry[channel][slot] = input[channel]
      let key = input[channel]

      if (c.externalKey) key += this.mix * (this.sidechainGain * external[channel] - key)

      if (this.filterEnabled) key = this.filter(channel, key)
      this.level[channel] = c.rms ? this.rmsLevel(channel, key) : this.peakLevel(channel, key)
    }

    this.tick = (this.tick + 1) >>> 0
    const linked = Math.max(this.level[0], this.level[1])
    const link = Math.min(Math.max(v.link, 0), 1)
    const floorDb = Math.min(v.rangeDb, 0)
    const scale = Math.max(-floorDb, 1)
    const attackStep = scale * this.attackPerFrame
    const releaseStep = scale * this.releasePerFrame
    const slope = v.ratio - 1
    const result = [0, 0]

    for (let channel = 0; channel < 2; channel++) {
      const keyLevel = this.level[channel] + (linked - this.level[channel]) * link

      if (keyLevel > SILENCE) this.started[channel] = true

      if (!this.open[channel] && keyLevel >= this.openLevel) {
        this.open[channel] = true
        this.hold[channel] = this.holdFrames
      } else if (this.open[channel] && this.started[channel]) {
        if (keyLevel >= this.closeLevel) this.hold[channel] = this.holdFrames
        else if (this.hold[channel] > 0) this.hold[channel]--
        else this.open[channel] = false
      }

      let target = 0

      if (this.open[channel] === c.flip) {
        target = floorDb

        if (c.expander && !c.flip) {
          const db = NEPER_TO_DB * Math.log(Math.max(keyLevel, SILENCE))

          target = Math.min(Math.max((db - v.thresholdDb) * slope, floorDb), 0)
        }
      }

      let gainDb = this.gainDb[channel]

      if (target > gainDb) gainDb = Math.min(target, gainDb + attackStep)
      else if (target < gainDb) gainDb = Math.max(target, gainDb - releaseStep)
      this.gainDb[channel] = gainDb

      if (gainDb !== this.gainAppliedDb[channel]) {
        this.gainAppliedDb[channel] = gainDb
        this.gain[channel] = Math.exp(gainDb * DB_TO_NEPER)
      }

      const dry = this.dry[channel][read]
      const wet = f(dry * this.gain[channel])

      result[channel] = f(wet + f(f(dry - wet) * this.bypass))
    }

    if (!Number.isFinite(this.gain[0]) || !Number.isFinite(this.gain[1]) || !Number.isFinite(this.meanSquare[0]) || !Number.isFinite(this.meanSquare[1])) this.reset()

    for (let channel = 0; channel < 2; channel++) {
      if (Number.isFinite(result[channel])) out[channel] = result[channel]
      else {
        this.reset()
        out[channel] = 0
      }
    }
  }
}

class DawGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return names.map(([name, defaultValue, minValue, maxValue]) => ({ name, defaultValue, minValue, maxValue, automationRate: 'a-rate' })) }
  constructor() {
    super()
    this.revision = -1
    this.state = { enabled: true, mode: 'gate', detector: 'peak', lookaheadMs: 0, flip: false, sidechain: { enabled: false, filterType: 'highpass' } }
    this.kernel = new GateKernel(sampleRate)
    this.values = {}
    this.config = { lookaheadMs: 0, expander: false, rms: false, flip: false, externalKey: false }
    this.frame = [0, 0]
    this.meterFrames = 0
    this.meterGainReductionDb = 0
    this.metering = false
    this.faults = 0
    this.port.onmessage = (event) => this.onMessage(event.data)
    this.port.postMessage({ type: 'ready', version: 1 })
  }
  onMessage(message) {
    if (!isGateMessage(message)) return this.fault('malformed-message')

    if (message.type === 'dispose') return this.port.close()

    if (message.type === 'metering' && (message.enabled === true || message.enabled === false)) { this.metering = message.enabled

      return }

    if (message.type === 'reset') {
      this.kernel.reset()
      this.meterFrames = 0
      this.meterGainReductionDb = 0

      return
    }

    if (!isGateConfigureMessage(message, this.revision)) return this.fault('malformed-or-stale-configure')
    this.revision = message.revision
    this.state = message.state
    const state = message.state
    const lookaheadMs = state.lookaheadMs

    this.config.lookaheadMs = Number.isFinite(lookaheadMs) ? f(lookaheadMs) : 0
    this.config.expander = state.mode === 'expander'
    this.config.rms = state.detector === 'rms'
    this.config.flip = state.flip === true
    this.port.postMessage({ type: 'configured', version: 1, revision: this.revision })
  }
  fault(code) { if (this.faults++ < 4) this.port.postMessage({ type: 'fault', version: 1, code }) }
  process(inputs, outputs, parameters) {
    const audio = inputs[0] || []
    const external = inputs[1] || []
    const output = outputs[0] || []
    const outL = output[0]

    if (!outL) return true
    const outR = output[1]
    const inL = audio[0]
    const inR = audio[1] || inL
    const keyL = external[0]
    const keyR = external[1] || keyL
    const kernel = this.kernel
    const values = this.values
    const config = this.config
    const sidechain = isObject(this.state.sidechain) ? this.state.sidechain : {}
    const filterType = sidechain.filterType === 'lowpass' || sidechain.filterType === 'bandpass' ? sidechain.filterType : 'highpass'
    const bypassed = this.state.enabled === false
    const at = (name, i) => parameters[name][parameters[name].length === 1 ? 0 : i]
    const frame = this.frame

    config.externalKey = keyL !== undefined

    for (let i = 0; i < outL.length; i++) {
      const l = inL ? inL[i] : 0
      const r = inR ? inR[i] : l
      const keyLeft = keyL ? keyL[i] : 0
      const keyRight = keyR ? keyR[i] : 0

      if (!Number.isFinite(l) || !Number.isFinite(r)) this.fault('nonfinite-input')

      if (keyL && (!Number.isFinite(keyLeft) || !Number.isFinite(keyRight))) this.fault('nonfinite-sidechain')
      values.thresholdDb = at('gate.thresholdDb', i)
      values.ratio = at('gate.ratio', i)
      values.attackMs = at('gate.attackMs', i)
      values.holdMs = at('gate.holdMs', i)
      values.releaseMs = at('gate.releaseMs', i)
      values.hysteresisDb = at('gate.hysteresisDb', i)
      values.rangeDb = at('gate.rangeDb', i)
      values.link = at('gate.link', i)
      values.sidechainGainDb = at('gate.sidechain.gainDb', i)
      values.sidechainMix = at('gate.sidechain.mix', i)
      kernel.setSidechain(sidechain.enabled === true, filterType, at('gate.sidechain.frequencyHz', i), at('gate.sidechain.q', i))
      kernel.process(values, config, bypassed, l, r, keyLeft, keyRight, frame)
      outL[i] = frame[0]

      if (outR) outR[i] = frame[1]

      if (this.metering) this.meterGainReductionDb = Math.max(this.meterGainReductionDb, -kernel.gainReductionDb())
    }

    if (this.metering) this.meterFrames += outL.length

    if (this.metering && this.meterFrames >= METER_FRAMES) {
      this.meterFrames %= METER_FRAMES
      this.port.postMessage({ type: 'meter', version: 1, gainReductionDb: this.meterGainReductionDb })
      this.meterGainReductionDb = 0
    }

    return true
  }
}

registerProcessor('daw-gate-processor', DawGateProcessor)
