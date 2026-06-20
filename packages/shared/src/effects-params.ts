export type EqBandType = 'lowpass' | 'highpass' | 'bandpass' | 'lowshelf' | 'highshelf' | 'peaking' | 'notch' | 'allpass'

export type EqBandParams = {
  id: string
  frequency: number
  gainDb: number
  q: number
  enabled: boolean
  type: EqBandType
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

function readFiniteNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getDefaultEqBandType(index: number): EqBandType {
  if (index === 0) return 'lowshelf'
  if (index === DEFAULT_EQ_FREQUENCIES.length - 1) return 'highshelf'
  return 'peaking'
}

export function createDefaultEqParams(): EqParams {
  return {
    bands: DEFAULT_EQ_FREQUENCIES.map((frequency, index) => ({
      id: `b${index + 1}`,
      frequency,
      gainDb: 0,
      q: 1,
      enabled: true,
      type: getDefaultEqBandType(index),
    })),
    enabled: true,
  }
}

export function serializeEqParams(params: EqParams): string {
  let signature = params.enabled ? '1' : '0'
  for (const band of params.bands) {
    signature += `|${band.id}:${band.enabled ? 1 : 0}:${band.type}:${band.frequency}:${band.gainDb}:${band.q}`
  }
  return signature
}

export type ReverbParams = {
  enabled: boolean
  wet: number
  decaySec: number
  preDelayMs: number
  size: number
  diffusion: number
  density: number
  lowCutHz: number
  highCutHz: number
  stereoWidth: number
}

export type ReverbParamsLite = ReverbParams
export type ReverbParamsInput = Partial<ReverbParams>

export function createDefaultReverbParams(): ReverbParams {
  return {
    enabled: true,
    wet: 0.25,
    decaySec: 2.2,
    preDelayMs: 20,
    size: 0.65,
    diffusion: 0.75,
    density: 0.8,
    lowCutHz: 20,
    highCutHz: 20000,
    stereoWidth: 1,
  }
}

export function normalizeReverbParams(input: ReverbParamsInput): ReverbParams {
  const defaults = createDefaultReverbParams()
  const wet = readFiniteNumber(input.wet)
  const decaySec = readFiniteNumber(input.decaySec)
  const preDelayMs = readFiniteNumber(input.preDelayMs)
  const size = readFiniteNumber(input.size)
  const diffusion = readFiniteNumber(input.diffusion)
  const density = readFiniteNumber(input.density)
  const lowCutInput = readFiniteNumber(input.lowCutHz)
  const highCutInput = readFiniteNumber(input.highCutHz)
  const stereoWidth = readFiniteNumber(input.stereoWidth)
  const lowCutHz = lowCutInput === undefined ? defaults.lowCutHz : clamp(lowCutInput, 20, 1200)
  const highCutHz = highCutInput === undefined ? defaults.highCutHz : clamp(highCutInput, 1200, 20000)
  return {
    enabled: input.enabled ?? defaults.enabled,
    wet: wet === undefined ? defaults.wet : clamp(wet, 0, 1),
    decaySec: decaySec === undefined ? defaults.decaySec : clamp(decaySec, 0.05, 12),
    preDelayMs: preDelayMs === undefined ? defaults.preDelayMs : clamp(preDelayMs, 0, 250),
    size: size === undefined ? defaults.size : clamp(size, 0, 1),
    diffusion: diffusion === undefined ? defaults.diffusion : clamp(diffusion, 0, 1),
    density: density === undefined ? defaults.density : clamp(density, 0, 1),
    lowCutHz: Math.min(lowCutHz, highCutHz),
    highCutHz: Math.max(highCutHz, lowCutHz),
    stereoWidth: stereoWidth === undefined ? defaults.stereoWidth : clamp(stereoWidth, 0, 2),
  }
}

export function serializeReverbParams(params: ReverbParams): string {
  return `${params.enabled ? 1 : 0}|${params.wet}|${params.decaySec}|${params.preDelayMs}|${params.size}|${params.diffusion}|${params.density}|${params.lowCutHz}|${params.highCutHz}|${params.stereoWidth}`
}

export type SynthWave = 'sine' | 'square' | 'sawtooth' | 'triangle'

export type SynthParams = {
  wave1: SynthWave
  wave2: SynthWave
  gain: number
  attackMs: number
  releaseMs: number
}

export type SynthParamsInput = Partial<SynthParams>

export function createDefaultSynthParams(): SynthParams {
  return {
    wave1: 'sawtooth',
    wave2: 'sawtooth',
    gain: 0.8,
    attackMs: 5,
    releaseMs: 30,
  }
}

export function normalizeSynthParams(input: SynthParamsInput): SynthParams {
  const wave1 = input.wave1 ?? 'sawtooth'
  const wave2 = input.wave2 ?? wave1

  return {
    wave1,
    wave2,
    gain: typeof input.gain === 'number' ? clamp(input.gain, 0, 1.5) : 0.8,
    attackMs: typeof input.attackMs === 'number' ? clamp(input.attackMs, 0, 200) : 5,
    releaseMs: typeof input.releaseMs === 'number' ? clamp(input.releaseMs, 0, 200) : 30,
  }
}

export function serializeSynthParams(params: SynthParams): string {
  return JSON.stringify(params)
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

export function supportsGain(type: EqBandType): boolean {
  return type === 'peaking' || type === 'lowshelf' || type === 'highshelf'
}

