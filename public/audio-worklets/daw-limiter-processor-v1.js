const parameters = [
  ['limiter.ceiling', -1, -12, 0, 'a-rate'],
  ['limiter.release', 100, 20, 1000, 'a-rate'],
  ['limiter.lookaheadMs', 5, 1, 5, 'k-rate'],
  ['limiter.link', 1, 0, 1, 'a-rate'],
  ['limiter.detectorOversampling', 4, 4, 4, 'k-rate'],
]
const isLimiterMessage = (message) => message !== null && Object.prototype.toString.call(message) === '[object Object]' && message.version === 1
const isLimiterConfigureMessage = (message, revision) => isLimiterMessage(message)
  && message.type === 'configure'
  && Number.isInteger(message.revision)
  && message.revision > revision
  && Object.prototype.toString.call(message.state) === '[object Object]'

const createFir = () => {
  const taps = 48
  const cutoff = 0.125
  const center = (taps - 1) / 2
  const coefficients = new Float64Array(taps)
  let sum = 0
  for (let index = 0; index < taps; index++) {
    const x = index - center
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
    const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * index / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * index / (taps - 1))
    coefficients[index] = sinc * window
    sum += coefficients[index]
  }
  for (let index = 0; index < taps; index++) coefficients[index] *= 4 / sum
  return coefficients
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
    this.delayFrames = Math.ceil(0.005 * sampleRate)
    this.delayL = new Float32Array(this.delayFrames + 1)
    this.delayR = new Float32Array(this.delayFrames + 1)
    this.detectorDelayL = new Float32Array(this.delayFrames + 1)
    this.detectorDelayR = new Float32Array(this.delayFrames + 1)
    this.historyL = new Float64Array(12)
    this.historyR = new Float64Array(12)
    this.fir = createFir()
    this.write = 0
    this.historyWrite = 0
    this.gainL = 1
    this.gainR = 1
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
      this.delayL.fill(0); this.delayR.fill(0)
      this.detectorDelayL.fill(0); this.detectorDelayR.fill(0)
      this.historyL.fill(0); this.historyR.fill(0)
      this.write = 0; this.historyWrite = 0
      this.gainL = 1; this.gainR = 1
      this.meterFrames = 0; this.minimumGain = 1
      return
    }
    if (!isLimiterConfigureMessage(message, this.revision)) {
      return this.fault('malformed-or-stale-configure')
    }
    this.revision = message.revision
    this.enabled = message.state.enabled !== false
    this.port.postMessage({ type: 'configured', version: 1, revision: this.revision })
  }

  fault(code) {
    if (this.faults++ < 4) this.port.postMessage({ type: 'fault', version: 1, code })
  }

  peak(history) {
    let peak = 0
    for (let phase = 0; phase < 4; phase++) {
      let value = 0
      for (let tap = 0; tap < 12; tap++) {
        const historyIndex = (this.historyWrite + 11 - tap) % 12
        value += history[historyIndex] * this.fir[tap * 4 + phase]
      }
      peak = Math.max(peak, Math.abs(value))
    }
    return peak
  }

  process(inputs, outputs, values) {
    const input = inputs[0] || []
    const output = outputs[0] || []
    const outL = output[0]
    if (!outL) return true
    const outR = output[1]
    const inL = input[0]
    const inR = input[1] || inL
    let blockMinimumGain = 1
    for (let frame = 0; frame < outL.length; frame++) {
      let left = inL ? inL[frame] : 0
      let right = inR ? inR[frame] : left
      if (!Number.isFinite(left) || !Number.isFinite(right)) {
        left = 0; right = 0
        this.fault('nonfinite-input')
      }
      this.delayL[this.write] = left
      this.delayR[this.write] = right
      this.detectorDelayL[this.write] = left
      this.detectorDelayR[this.write] = right
      const delayedRead = (this.write + 1) % this.delayL.length
      const delayedL = this.delayL[delayedRead]
      const delayedR = this.delayR[delayedRead]
      const lookaheadFrames = Math.round(values['limiter.lookaheadMs'][0] * sampleRate / 1000)
      const detectorDelay = this.delayFrames - lookaheadFrames
      const detectorRead = (this.write + this.detectorDelayL.length - detectorDelay) % this.detectorDelayL.length
      this.write = (this.write + 1) % this.delayL.length
      this.historyL[this.historyWrite] = this.detectorDelayL[detectorRead]
      this.historyR[this.historyWrite] = this.detectorDelayR[detectorRead]
      const peakL = this.peak(this.historyL)
      const peakR = this.peak(this.historyR)
      this.historyWrite = (this.historyWrite + 1) % 12
      const parameterIndex = values['limiter.ceiling'].length === 1 ? 0 : frame
      const ceiling = 10 ** (values['limiter.ceiling'][parameterIndex] / 20)
      const targetL = Math.min(1, ceiling / Math.max(peakL, 1e-12))
      const targetR = Math.min(1, ceiling / Math.max(peakR, 1e-12))
      const link = values['limiter.link'][values['limiter.link'].length === 1 ? 0 : frame]
      const linked = Math.min(targetL, targetR)
      const linkedTargetL = targetL + (linked - targetL) * link
      const linkedTargetR = targetR + (linked - targetR) * link
      const releaseMs = values['limiter.release'][values['limiter.release'].length === 1 ? 0 : frame]
      const release = Math.exp(-1 / (releaseMs * 0.001 * sampleRate))
      this.gainL = linkedTargetL < this.gainL ? linkedTargetL : 1 + release * (this.gainL - 1)
      this.gainR = linkedTargetR < this.gainR ? linkedTargetR : 1 + release * (this.gainR - 1)
      if (!Number.isFinite(this.gainL) || !Number.isFinite(this.gainR)) {
        this.gainL = 1; this.gainR = 1
        this.fault('nonfinite-state')
      }
      const gainL = this.enabled ? this.gainL : 1
      const gainR = this.enabled ? this.gainR : 1
      outL[frame] = delayedL * gainL
      if (outR) outR[frame] = delayedR * gainR
      blockMinimumGain = Math.min(blockMinimumGain, gainL, gainR)
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
