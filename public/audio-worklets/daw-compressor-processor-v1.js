const MIN_DB = -120
const dbToGain = (db) => 10 ** (db / 20)
const gainToDb = (gain) => gain > 0 ? 20 * Math.log10(gain) : MIN_DB
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const curveDb = (inputDb, p) => {
  const threshold = p.thresholdDb
  const ratio = p.ratio
  const knee = p.kneeDb
  if (p.dynamicsMode === 'expand') {
    if (inputDb >= threshold) return inputDb
    const expanded = threshold + (inputDb - threshold) * ratio
    if (knee <= 0 || inputDb <= threshold - knee / 2) return expanded
    const distance = threshold - inputDb
    return inputDb - (2 * (ratio - 1) * distance * distance) / knee
  }
  const compressed = threshold + (inputDb - threshold) / ratio
  if (knee <= 0) return inputDb <= threshold ? inputDb : compressed
  const lower = threshold - knee / 2
  const upper = threshold + knee / 2
  if (inputDb <= lower) return inputDb
  if (inputDb >= upper) return compressed
  const x = inputDb - lower
  return inputDb + ((1 / ratio - 1) * x * x) / (2 * knee)
}

class CompressorProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.params = {
      enabled: true, thresholdDb: -24, ratio: 4, attackMs: 10, releaseMs: 120, autoRelease: true,
      makeupDb: 0, outputDb: 0, dryWet: 1, kneeDb: 6, lookaheadMs: 0, detectorMode: 'rms',
      dynamicsMode: 'compress', envelopeCurve: 'log',
      sidechain: { enabled: false, filterType: 'highpass', frequencyHz: 120, q: 0.707 },
    }
    this.envelopeDb = 0
    this.lookaheadFrames = Math.ceil(sampleRate * 0.01) + 1
    this.writeIndex = 0
    this.delayL = new Float32Array(this.lookaheadFrames)
    this.delayR = new Float32Array(this.lookaheadFrames)
    this.detectorDelay = new Float32Array(this.lookaheadFrames)
    this.rms = 0
    this.scLow = 0
    this.scBand = 0
    this.meterFrames = 0
    this.meterInSum = 0
    this.meterOutSum = 0
    this.meterGainReductionDb = 0
    this.meteringEnabled = false
    this.port.onmessage = (event) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'params' && data.params && typeof data.params === 'object') this.params = data.params
      if (data.type === 'metering' && typeof data.enabled === 'boolean') {
        this.meteringEnabled = data.enabled
        if (!data.enabled) this.resetMeter()
      }
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
    const detectorInput = inputs[1] || input
    const output = outputs[0]
    const left = input[0]
    if (!left) return true
    const right = input[1] || left
    const detectorLeft = detectorInput[0] || left
    const detectorRight = detectorInput[1] || detectorLeft
    const outL = output[0]
    const outR = output[1] || outL
    const p = this.params
    const lookahead = clamp(Math.round(sampleRate * p.lookaheadMs / 1000), 0, this.lookaheadFrames - 1)
    const programReadOffset = 1
    const detectorReadOffset = lookahead + 1
    const attack = Math.exp(-1 / Math.max(1, sampleRate * p.attackMs / 1000))
    const releaseMs = p.autoRelease ? Math.max(p.releaseMs, p.releaseMs * (1 + Math.min(1, -this.envelopeDb / 24))) : p.releaseMs
    const release = Math.exp(-1 / Math.max(1, sampleRate * releaseMs / 1000))
    const makeup = dbToGain(p.makeupDb + p.outputDb)
    const wet = p.dryWet
    const dry = 1 - wet
    const cutoff = clamp(p.sidechain.frequencyHz / sampleRate, 0.00001, 0.45)
    const filterCoeff = 1 - Math.exp(-2 * Math.PI * cutoff)
    const sidechainQ = clamp(p.sidechain.q, 0.1, 18)
    for (let i = 0; i < left.length; i++) {
      const inL = left[i]
      const inR = right[i]
      const mono = (detectorLeft[i] + detectorRight[i]) * 0.5
      const detectorReadIndex = (this.writeIndex + detectorReadOffset) % this.lookaheadFrames
      let detector = this.detectorDelay[detectorReadIndex]
      this.detectorDelay[this.writeIndex] = mono
      if (p.sidechain.enabled) {
        this.scLow += filterCoeff * (detector - this.scLow)
        this.scBand += filterCoeff * (detector - this.scLow - this.scBand / sidechainQ)
        detector = p.sidechain.filterType === 'lowpass' ? this.scLow : p.sidechain.filterType === 'bandpass' ? this.scBand : detector - this.scLow
      }
      const level = p.detectorMode === 'rms'
        ? Math.sqrt(this.rms = this.rms * 0.99 + detector * detector * 0.01)
        : Math.abs(detector)
      const levelDb = gainToDb(level)
      const targetDb = p.enabled ? curveDb(levelDb, p) - levelDb : 0
      if (p.envelopeCurve === 'linear') {
        const timeMs = targetDb < this.envelopeDb ? p.attackMs : releaseMs
        const stepDb = 60 / Math.max(1, sampleRate * timeMs / 1000)
        this.envelopeDb += clamp(targetDb - this.envelopeDb, -stepDb, stepDb)
      } else {
        const coeff = targetDb < this.envelopeDb ? attack : release
        this.envelopeDb = targetDb + coeff * (this.envelopeDb - targetDb)
      }
      const gain = dbToGain(this.envelopeDb) * makeup
      const readIndex = (this.writeIndex + programReadOffset) % this.lookaheadFrames
      const delayedL = this.delayL[readIndex]
      const delayedR = this.delayR[readIndex]
      this.delayL[this.writeIndex] = inL
      this.delayR[this.writeIndex] = inR
      this.writeIndex = (this.writeIndex + 1) % this.lookaheadFrames
      outL[i] = delayedL * dry + delayedL * gain * wet
      outR[i] = delayedR * dry + delayedR * gain * wet
      if (this.meteringEnabled) {
        this.meterInSum += (inL * inL + inR * inR) * 0.5
        this.meterOutSum += (outL[i] * outL[i] + outR[i] * outR[i]) * 0.5
        this.meterGainReductionDb = Math.min(this.meterGainReductionDb, this.envelopeDb)
      }
    }
    if (this.meteringEnabled) this.meterFrames += left.length
    if (this.meteringEnabled && this.meterFrames >= 2048) {
      this.port.postMessage({
        type: 'meter',
        inputDb: gainToDb(Math.sqrt(this.meterInSum / this.meterFrames)),
        outputDb: gainToDb(Math.sqrt(this.meterOutSum / this.meterFrames)),
        gainReductionDb: this.meterGainReductionDb,
        thresholdDb: p.thresholdDb,
      })
      this.resetMeter()
    }
    return true
  }
}
registerProcessor('daw-compressor-processor', CompressorProcessor)
