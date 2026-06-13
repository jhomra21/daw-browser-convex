export type BpmDetectionAlternative = {
  bpm: number
  confidence: number
}

export type BpmDetectionResult = {
  bpm: number
  confidence: number
  alternatives: BpmDetectionAlternative[]
}

export type BpmDetectionInput = {
  channels: Float32Array[]
  sampleRate: number
}

const MIN_BPM = 60
const MAX_BPM = 200
const ANALYSIS_SAMPLE_RATE = 200
const MIN_DURATION_SEC = 1
const MAX_ANALYSIS_SEC = 24

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const roundBpm = (value: number) => Math.round(value * 100) / 100

const normalizeBpm = (bpm: number) => {
  let normalized = bpm
  while (normalized < MIN_BPM) normalized *= 2
  while (normalized > MAX_BPM) normalized /= 2
  return normalized
}

const createEnergyEnvelope = (input: BpmDetectionInput) => {
  const sourceLength = input.channels[0]?.length ?? 0
  const frameSize = Math.max(1, Math.floor(input.sampleRate / ANALYSIS_SAMPLE_RATE))
  const maxFrames = Math.min(Math.floor(sourceLength / frameSize), Math.floor(MAX_ANALYSIS_SEC * ANALYSIS_SAMPLE_RATE))
  const envelope = new Float32Array(maxFrames)
  for (let frameIndex = 0; frameIndex < maxFrames; frameIndex++) {
    const start = frameIndex * frameSize
    let total = 0
    for (const channel of input.channels) {
      let channelTotal = 0
      for (let offset = 0; offset < frameSize; offset++) {
        const sample = channel[start + offset] ?? 0
        channelTotal += sample * sample
      }
      total += Math.sqrt(channelTotal / frameSize)
    }
    envelope[frameIndex] = total / Math.max(1, input.channels.length)
  }
  return envelope
}

const emphasizeOnsets = (envelope: Float32Array) => {
  const onsets = new Float32Array(envelope.length)
  let previous = envelope[0] ?? 0
  let mean = 0
  for (let index = 1; index < envelope.length; index++) {
    const value = Math.max(0, envelope[index] - previous)
    onsets[index] = value
    mean += value
    previous = envelope[index]
  }
  mean /= Math.max(1, envelope.length - 1)
  let variance = 0
  for (let index = 0; index < onsets.length; index++) {
    const centered = onsets[index] - mean
    variance += centered * centered
  }
  const deviation = Math.sqrt(variance / Math.max(1, onsets.length))
  if (deviation <= 0) return null
  for (let index = 0; index < onsets.length; index++) onsets[index] = Math.max(0, (onsets[index] - mean) / deviation)
  return onsets
}

const scoreLag = (onsets: Float32Array, lag: number) => {
  let score = 0
  let total = 0
  for (let index = lag; index < onsets.length; index++) {
    score += onsets[index] * onsets[index - lag]
    total += onsets[index] * onsets[index] + onsets[index - lag] * onsets[index - lag]
  }
  return total > 0 ? (2 * score) / total : 0
}

const dedupeAlternatives = (candidates: BpmDetectionAlternative[]) => {
  const alternatives: BpmDetectionAlternative[] = []
  for (const candidate of candidates) {
    if (alternatives.some((entry) => Math.abs(entry.bpm - candidate.bpm) < 1)) continue
    alternatives.push(candidate)
  }
  return alternatives.slice(0, 4)
}

export function detectLoopBpm(input: BpmDetectionInput): BpmDetectionResult | null {
  if (input.sampleRate <= 0 || input.channels.length === 0) return null
  const sourceLength = input.channels[0]?.length ?? 0
  if (sourceLength / input.sampleRate < MIN_DURATION_SEC) return null
  const envelope = createEnergyEnvelope(input)
  const onsets = emphasizeOnsets(envelope)
  if (!onsets) return null

  const minLag = Math.max(1, Math.floor((60 / MAX_BPM) * ANALYSIS_SAMPLE_RATE))
  const maxLag = Math.min(onsets.length - 1, Math.ceil((60 / MIN_BPM) * ANALYSIS_SAMPLE_RATE))
  const candidates: BpmDetectionAlternative[] = []
  for (let lag = minLag; lag <= maxLag; lag++) {
    const score = scoreLag(onsets, lag)
    const bpm = normalizeBpm((60 * ANALYSIS_SAMPLE_RATE) / lag)
    candidates.push({ bpm: roundBpm(bpm), confidence: clamp(score, 0, 1) })
  }

  candidates.sort((a, b) => b.confidence - a.confidence)
  const alternatives = dedupeAlternatives(candidates)
  const best = alternatives[0]
  if (!best || best.confidence < 0.12) return null
  return {
    bpm: best.bpm,
    confidence: best.confidence,
    alternatives,
  }
}
