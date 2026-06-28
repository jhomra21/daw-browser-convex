import { normalizeCompressorParams, serializeCompressorParams, type CompressorParamsLite } from '@daw-browser/shared'

export type CompressorMeterFrame = {
  inputDb: number
  outputDb: number
  gainReductionDb: number
  thresholdDb: number
}

export type CompressorMeterListener = (frame: CompressorMeterFrame) => void

const registeredContexts = new WeakSet<BaseAudioContext>()
const registeringContexts = new WeakMap<BaseAudioContext, Promise<void>>()

const WORKLET_SOURCE = `
const MIN_DB = -120
const dbToGain = (db) => Math.pow(10, db / 20)
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
    const lower = threshold - knee / 2
    const blend = clamp((threshold + knee / 2 - inputDb) / Math.max(0.0001, knee), 0, 1)
    return inputDb + (expanded - inputDb) * blend * blend
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
    this.lookaheadFrames = Math.ceil(sampleRate * 0.01) + 128
    this.writeIndex = 0
    this.delayL = new Float32Array(this.lookaheadFrames)
    this.delayR = new Float32Array(this.lookaheadFrames)
    this.rms = 0
    this.scLow = 0
    this.scBand = 0
    this.meterFrames = 0
    this.meterInSum = 0
    this.meterOutSum = 0
    this.meterGainReductionDb = 0
    this.meterReportEveryFrames = 2048
    this.meterMessage = { type: 'meter', inputDb: MIN_DB, outputDb: MIN_DB, gainReductionDb: 0, thresholdDb: this.params.thresholdDb }
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'params') this.params = event.data.params
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    const left = input[0]
    if (!left) return true
    const right = input[1] || left
    const outL = output[0]
    const outR = output[1] || outL
    const p = this.params
    const lookahead = clamp(Math.round(sampleRate * p.lookaheadMs / 1000), 0, this.lookaheadFrames - 1)
    const readOffset = this.lookaheadFrames - lookahead
    const attack = Math.exp(-1 / Math.max(1, sampleRate * p.attackMs / 1000))
    const releaseMs = p.autoRelease ? Math.max(p.releaseMs, p.releaseMs * (1 + Math.min(1, -this.envelopeDb / 24))) : p.releaseMs
    const release = Math.exp(-1 / Math.max(1, sampleRate * releaseMs / 1000))
    const makeup = dbToGain(p.makeupDb + p.outputDb)
    const wet = p.dryWet
    const dry = 1 - wet
    const cutoff = clamp(p.sidechain.frequencyHz / sampleRate, 0.00001, 0.45)
    const filterCoeff = 1 - Math.exp(-2 * Math.PI * cutoff)
    for (let i = 0; i < left.length; i++) {
      const inL = left[i]
      const inR = right[i]
      const mono = (inL + inR) * 0.5
      let detector = mono
      if (p.sidechain.enabled) {
        this.scLow += filterCoeff * (mono - this.scLow)
        const sidechainQ = clamp(p.sidechain.q, 0.1, 18)
        this.scBand += filterCoeff * (mono - this.scLow - this.scBand / sidechainQ)
        if (p.sidechain.filterType === 'lowpass') detector = this.scLow
        else if (p.sidechain.filterType === 'bandpass') detector = this.scBand
        else detector = mono - this.scLow
      }
      const abs = Math.abs(detector)
      this.rms = this.rms * 0.99 + detector * detector * 0.01
      const level = p.detectorMode === 'rms' ? Math.sqrt(this.rms) : abs
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
      let delayedL = inL
      let delayedR = inR
      if (lookahead > 0) {
        const readIndex = (this.writeIndex + readOffset) % this.lookaheadFrames
        delayedL = this.delayL[readIndex]
        delayedR = this.delayR[readIndex]
        this.delayL[this.writeIndex] = inL
        this.delayR[this.writeIndex] = inR
        this.writeIndex = (this.writeIndex + 1) % this.lookaheadFrames
      }
      const processedL = delayedL * gain
      const processedR = delayedR * gain
      outL[i] = delayedL * dry + processedL * wet
      outR[i] = delayedR * dry + processedR * wet
      this.meterInSum += (inL * inL + inR * inR) * 0.5
      this.meterOutSum += (outL[i] * outL[i] + outR[i] * outR[i]) * 0.5
      this.meterGainReductionDb = Math.min(this.meterGainReductionDb, this.envelopeDb)
    }
    this.meterFrames += left.length
    if (this.meterFrames >= this.meterReportEveryFrames) {
      this.meterMessage.inputDb = gainToDb(Math.sqrt(this.meterInSum / this.meterFrames))
      this.meterMessage.outputDb = gainToDb(Math.sqrt(this.meterOutSum / this.meterFrames))
      this.meterMessage.gainReductionDb = this.meterGainReductionDb
      this.meterMessage.thresholdDb = p.thresholdDb
      this.port.postMessage(this.meterMessage)
      this.meterFrames = 0
      this.meterInSum = 0
      this.meterOutSum = 0
      this.meterGainReductionDb = 0
    }
    return true
  }
}
registerProcessor('daw-compressor-processor', CompressorProcessor)
`

export async function ensureCompressorWorklet(ctx: BaseAudioContext): Promise<void> {
  if (registeredContexts.has(ctx)) return
  const registration = registeringContexts.get(ctx)
  if (registration) return registration
  const blob = new Blob([WORKLET_SOURCE], { type: 'text/javascript' })
  const url = URL.createObjectURL(blob)
  const nextRegistration = (async () => {
    await ctx.audioWorklet.addModule(url)
    registeredContexts.add(ctx)
  })()
  registeringContexts.set(ctx, nextRegistration)
  try {
    await nextRegistration
  } catch (error) {
    registeringContexts.delete(ctx)
    throw error
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function postCompressorParams(node: AudioWorkletNode, params: CompressorParamsLite) {
  node.port.postMessage({ type: 'params', params: normalizeCompressorParams(params) })
}

export function readCompressorMeterFrame(data: unknown): CompressorMeterFrame | null {
  if (!data || typeof data !== 'object') return null
  if (!('type' in data) || data.type !== 'meter') return null
  if (!('inputDb' in data) || typeof data.inputDb !== 'number') return null
  if (!('outputDb' in data) || typeof data.outputDb !== 'number') return null
  if (!('gainReductionDb' in data) || typeof data.gainReductionDb !== 'number') return null
  if (!('thresholdDb' in data) || typeof data.thresholdDb !== 'number') return null
  return {
    inputDb: data.inputDb,
    outputDb: data.outputDb,
    gainReductionDb: data.gainReductionDb,
    thresholdDb: data.thresholdDb,
  }
}

export function getCompressorParamsSignature(params: CompressorParamsLite): string {
  return serializeCompressorParams(normalizeCompressorParams(params))
}
