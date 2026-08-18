const names = [
  ['gate.thresholdDb', -40, -80, 0], ['gate.ratio', 4, 1, 20], ['gate.attackMs', 1, 0.1, 100],
  ['gate.holdMs', 20, 0, 500], ['gate.releaseMs', 120, 5, 2000], ['gate.hysteresisDb', 6, 0, 24],
  ['gate.rangeDb', -80, -80, 0], ['gate.lookaheadMs', 0, 0, 2], ['gate.link', 1, 0, 1],
]
const isGateMessage = (message) => message !== null && Object.prototype.toString.call(message) === '[object Object]' && message.version === 1
const isGateConfigureMessage = (message, revision) => isGateMessage(message)
  && message.type === 'configure'
  && Number.isInteger(message.revision)
  && message.revision > revision
  && Object.prototype.toString.call(message.state) === '[object Object]'

class DawGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return names.map(([name, defaultValue, minValue, maxValue]) => ({ name, defaultValue, minValue, maxValue, automationRate: name === 'gate.lookaheadMs' ? 'k-rate' : 'a-rate' })) }
  constructor() {
    super()
    this.revision = -1
    this.state = { enabled: true, mode: 'gate', detector: 'peak', sidechain: { enabled: false, frequencyHz: 80, q: 0.707 } }
    this.delayFrames = Math.ceil(0.002 * sampleRate)
    this.delayL = new Float32Array(this.delayFrames + 1)
    this.delayR = new Float32Array(this.delayFrames + 1)
    this.detectorL = new Float32Array(this.delayFrames + 1)
    this.detectorR = new Float32Array(this.delayFrames + 1)
    this.write = 0
    this.gains = [1, 1]
    this.rms = [0, 0]
    this.hold = [0, 0]
    this.open = [true, true]
    this.detectorStarted = [false, false]
    this.meterFrames = 0
    this.meterMinimumGain = 1
    this.metering = false
    this.faults = 0
    this.hpX1 = [0, 0]; this.hpX2 = [0, 0]
    this.hpY1 = [0, 0]; this.hpY2 = [0, 0]
    this.port.onmessage = (event) => this.onMessage(event.data)
    this.port.postMessage({ type: 'ready', version: 1 })
  }
  onMessage(message) {
    if (!isGateMessage(message)) return this.fault('malformed-message')
    if (message.type === 'dispose') return this.port.close()
    if (message.type === 'metering' && (message.enabled === true || message.enabled === false)) { this.metering = message.enabled; return }
    if (message.type === 'reset') {
      this.delayL.fill(0); this.delayR.fill(0); this.detectorL.fill(0); this.detectorR.fill(0); this.write = 0
      this.gains[0] = this.gains[1] = 1; this.rms[0] = this.rms[1] = 0
      this.hold[0] = this.hold[1] = 0; this.open[0] = this.open[1] = true
      this.detectorStarted[0] = this.detectorStarted[1] = false
      this.meterFrames = 0; this.meterMinimumGain = 1
      this.hpX1[0] = this.hpX1[1] = this.hpX2[0] = this.hpX2[1] = 0
      this.hpY1[0] = this.hpY1[1] = this.hpY2[0] = this.hpY2[1] = 0
      return
    }
    if (!isGateConfigureMessage(message, this.revision)) return this.fault('malformed-or-stale-configure')
    this.revision = message.revision
    this.state = message.state
    this.port.postMessage({ type: 'configured', version: 1, revision: this.revision })
  }
  fault(code) { if (this.faults++ < 4) this.port.postMessage({ type: 'fault', version: 1, code }) }
  highpass(value, channel) {
    const sidechain = this.state.sidechain
    if (!sidechain || !sidechain.enabled) return value
    const frequency = Math.max(20, Math.min(sampleRate * 0.49, sidechain.frequencyHz))
    const q = Math.max(0.1, Math.min(18, sidechain.q))
    const omega = 2 * Math.PI * frequency / sampleRate
    const cosine = Math.cos(omega)
    const alpha = Math.sin(omega) / (2 * q)
    const a0 = 1 + alpha
    const b0 = (1 + cosine) / (2 * a0)
    const b1 = -(1 + cosine) / a0
    const b2 = b0
    const a1 = -2 * cosine / a0
    const a2 = (1 - alpha) / a0
    const output = b0 * value + b1 * this.hpX1[channel] + b2 * this.hpX2[channel]
      - a1 * this.hpY1[channel] - a2 * this.hpY2[channel]
    this.hpX2[channel] = this.hpX1[channel]; this.hpX1[channel] = value
    this.hpY2[channel] = this.hpY1[channel]; this.hpY1[channel] = output
    return output
  }
  process(inputs, outputs, parameters) {
    const audio = inputs[0] || []
    const external = inputs[1] || []
    const output = outputs[0] || []
    const outL = output[0]
    if (!outL) return true
    const outR = output[1]
    const inL = audio[0]
    const inR = audio[1] || inL
    const scL = external[0]
    const scR = external[1] || scL
    let minimumGain = 1
    for (let i = 0; i < outL.length; i++) {
      let l = inL ? inL[i] : 0
      let r = inR ? inR[i] : l
      if (!Number.isFinite(l) || !Number.isFinite(r)) { l = r = 0; this.fault('nonfinite-input') }
      this.delayL[this.write] = l; this.delayR[this.write] = r
      const lookahead = Math.round(parameters['gate.lookaheadMs'][0] * sampleRate / 1000)
      const read = (this.write + this.delayL.length - this.delayFrames) % this.delayL.length
      const delayedL = this.delayL[read], delayedR = this.delayR[read]
      let detectorL = this.state.sidechain && this.state.sidechain.enabled && scL ? scL[i] : l
      let detectorR = this.state.sidechain && this.state.sidechain.enabled && scR ? scR[i] : r
      if (!Number.isFinite(detectorL) || !Number.isFinite(detectorR)) { detectorL = detectorR = 0; this.fault('nonfinite-sidechain') }
      detectorL = this.highpass(detectorL, 0); detectorR = this.highpass(detectorR, 1)
      this.detectorL[this.write] = detectorL; this.detectorR[this.write] = detectorR
      const detectorDelay = this.delayFrames - lookahead
      const detectorRead = (this.write + this.detectorL.length - detectorDelay) % this.detectorL.length
      const detectorSamples = [this.detectorL[detectorRead], this.detectorR[detectorRead]]
      this.write = (this.write + 1) % this.delayL.length
      const independentLevels = [Math.abs(detectorSamples[0]), Math.abs(detectorSamples[1])]
      if (this.state.detector === 'rms') {
        const alpha = Math.exp(-1 / (0.01 * sampleRate))
        for (let channel = 0; channel < 2; channel++) {
          this.rms[channel] = alpha * this.rms[channel] + (1 - alpha) * detectorSamples[channel] * detectorSamples[channel]
          independentLevels[channel] = Math.sqrt(this.rms[channel])
        }
      }
      const linkedLevel = Math.max(independentLevels[0], independentLevels[1])
      const threshold = parameters['gate.thresholdDb'][parameters['gate.thresholdDb'].length === 1 ? 0 : i]
      const hysteresis = parameters['gate.hysteresisDb'][parameters['gate.hysteresisDb'].length === 1 ? 0 : i]
      const range = parameters['gate.rangeDb'][parameters['gate.rangeDb'].length === 1 ? 0 : i]
      const ratio = parameters['gate.ratio'][parameters['gate.ratio'].length === 1 ? 0 : i]
      const link = parameters['gate.link'][parameters['gate.link'].length === 1 ? 0 : i]
      for (let channel = 0; channel < 2; channel++) {
        const level = independentLevels[channel] + (linkedLevel - independentLevels[channel]) * link
        const db = 20 * Math.log10(Math.max(level, 1e-8))
        if (level > 1e-8) this.detectorStarted[channel] = true
        const holdFrames = Math.round(parameters['gate.holdMs'][parameters['gate.holdMs'].length === 1 ? 0 : i] * sampleRate / 1000)
        if (!this.open[channel] && db >= threshold) {
          this.open[channel] = true
          this.hold[channel] = holdFrames
        } else if (this.open[channel] && this.detectorStarted[channel]) {
          if (db >= threshold - hysteresis) this.hold[channel] = holdFrames
          else if (this.hold[channel] > 0) this.hold[channel]--
          else this.open[channel] = false
        }
        const targetDb = this.open[channel] ? 0 : this.state.mode === 'expander' ? Math.max(range, (db - threshold) * (ratio - 1)) : range
        const target = this.state.enabled ? 10 ** (targetDb / 20) : 1
        const ms = target > this.gains[channel] ? parameters['gate.attackMs'][parameters['gate.attackMs'].length === 1 ? 0 : i] : parameters['gate.releaseMs'][parameters['gate.releaseMs'].length === 1 ? 0 : i]
        const coefficient = Math.exp(-1 / (Math.max(0.1, ms) * 0.001 * sampleRate))
        this.gains[channel] = target + coefficient * (this.gains[channel] - target)
        if (!Number.isFinite(this.gains[channel])) { this.gains[channel] = 1; this.fault('nonfinite-state') }
        minimumGain = Math.min(minimumGain, this.gains[channel])
      }
      outL[i] = delayedL * this.gains[0]
      if (outR) outR[i] = delayedR * this.gains[1]
    }
    this.meterFrames += outL.length
    this.meterMinimumGain = Math.min(this.meterMinimumGain, minimumGain)
    if (this.metering && this.meterFrames >= 2048) {
      this.meterFrames %= 2048
      this.port.postMessage({ type: 'meter', version: 1, gainReductionDb: -20 * Math.log10(Math.max(this.meterMinimumGain, 1e-8)) })
      this.meterMinimumGain = 1
    }
    return true
  }
}
registerProcessor('daw-gate-processor', DawGateProcessor)
