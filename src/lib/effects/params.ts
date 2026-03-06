export type EqBandParams = {
  id: string
  frequency: number
  gainDb: number
  q: number
  enabled: boolean
  type: BiquadFilterType
}

export type EqParams = {
  bands: EqBandParams[]
  enabled: boolean
}

export type EqParamsLite = EqParams

const DEFAULT_EQ_FREQUENCIES = [40, 100, 200, 500, 1000, 2500, 6000, 12000]

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function getDefaultEqBandType(index: number): BiquadFilterType {
  if (index === 0) return 'lowshelf'
  if (index === DEFAULT_EQ_FREQUENCIES.length - 1) return 'highshelf'
  return 'peaking'
}

export function createDefaultEqParams(): EqParams {
  const bands: EqBandParams[] = DEFAULT_EQ_FREQUENCIES.map((frequency, index) => ({
    id: `b${index + 1}`,
    frequency,
    gainDb: 0,
    q: 1,
    enabled: true,
    type: getDefaultEqBandType(index),
  }))

  return {
    bands,
    enabled: true,
  }
}

export type ReverbParams = {
  enabled: boolean
  wet: number
  decaySec: number
  preDelayMs: number
}

export type ReverbParamsLite = ReverbParams

export function createDefaultReverbParams(): ReverbParams {
  return {
    enabled: true,
    wet: 0.25,
    decaySec: 2.2,
    preDelayMs: 20,
  }
}

export type SynthWave = 'sine' | 'square' | 'sawtooth' | 'triangle'

export type SynthParams = {
  wave1: SynthWave
  wave2: SynthWave
  gain: number
  attackMs: number
  releaseMs: number
  wave?: SynthWave
}

export type SynthParamsInput = Partial<SynthParams>

export function createDefaultSynthParams(): SynthParams {
  return {
    wave1: 'sawtooth',
    wave2: 'sawtooth',
    gain: 0.8,
    attackMs: 5,
    releaseMs: 30,
    wave: 'sawtooth',
  }
}

export function normalizeSynthParams(input: SynthParamsInput): SynthParams {
  const wave1 = input.wave1 ?? input.wave ?? 'sawtooth'
  const wave2 = input.wave2 ?? wave1

  return {
    wave1,
    wave2,
    gain: typeof input.gain === 'number' ? clamp(input.gain, 0, 1.5) : 0.8,
    attackMs: typeof input.attackMs === 'number' ? clamp(input.attackMs, 0, 200) : 5,
    releaseMs: typeof input.releaseMs === 'number' ? clamp(input.releaseMs, 0, 200) : 30,
    wave: input.wave ?? wave1,
  }
}

export function serializeSynthParams(params: SynthParams): string {
  return JSON.stringify({
    ...params,
    wave: params.wave ?? params.wave1,
  })
}

export type ArpeggiatorPattern = 'up' | 'down' | 'updown' | 'random'
export type ArpeggiatorRate = '1/4' | '1/8' | '1/16' | '1/32'

export type ArpeggiatorParams = {
  enabled: boolean
  pattern: ArpeggiatorPattern
  rate: ArpeggiatorRate
  octaves: number
  gate: number
  hold: boolean
}

export type ArpParams = ArpeggiatorParams

export function createDefaultArpeggiatorParams(): ArpeggiatorParams {
  return {
    enabled: true,
    pattern: 'up',
    rate: '1/16',
    octaves: 1,
    gate: 0.8,
    hold: true,
  }
}

export function supportsGain(type: BiquadFilterType): boolean {
  return type === 'peaking' || type === 'lowshelf' || type === 'highshelf'
}

