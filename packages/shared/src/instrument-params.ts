import {
  createDefaultSynthParams,
  normalizeSynthParams,
  serializeSynthParams,
  type SynthParams,
  type SynthParamsInput,
  type SynthWave,
} from './effects-params'
import {
  createDefaultDrumRackParams,
  normalizeDrumRackParams,
  serializeDrumRackParams,
  type DrumRackParams,
  type DrumRackParamsInput,
} from './drum-rack-params'
import {
  createDefaultSamplerParams,
  normalizeSamplerParams,
  serializeSamplerParams,
  type SamplerParams,
  type SamplerParamsInput,
} from './sampler-params'
import {
  createDefaultGranularParams,
  normalizeGranularParams,
  serializeGranularParams,
  type GranularParams,
  type GranularParamsInput,
} from './granular-params'
export type InstrumentKind = 'synth' | 'drum-rack' | 'sampler' | 'granular'

export type TrackInstrumentParams =
  | { kind: 'synth'; instanceId: string; params: SynthParams }
  | { kind: 'drum-rack'; instanceId: string; params: DrumRackParams }
  | { kind: 'sampler'; instanceId: string; params: SamplerParams }
  | { kind: 'granular'; instanceId: string; params: GranularParams }

export const createInstrumentInstanceId = () => `instrument:${crypto.randomUUID()}`

export const duplicateTrackInstrumentParams = (
  instrument: TrackInstrumentParams,
): TrackInstrumentParams => ({
  ...instrument,
  instanceId: createInstrumentInstanceId(),
})

const migrationInstanceId = (kind: InstrumentKind, params: unknown) => {
  const serialized = JSON.stringify(params)
  let hash = 2166136261
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `instrument:migration:${kind}:${(hash >>> 0).toString(36)}`
}

type SynthInstrumentContract = {
  kind: 'synth'
  createDefaultParams: () => SynthParams
  normalizeParams: (params: SynthParamsInput) => SynthParams
  serializeParams: (params: SynthParams) => string
}

type DrumRackInstrumentContract = {
  kind: 'drum-rack'
  createDefaultParams: () => DrumRackParams
  normalizeParams: (params: DrumRackParamsInput) => DrumRackParams
  serializeParams: (params: DrumRackParams) => string
}

type InstrumentContractByKind = {
  synth: SynthInstrumentContract
  'drum-rack': DrumRackInstrumentContract
  sampler: {
    kind: 'sampler'
    createDefaultParams: () => SamplerParams
    normalizeParams: (params: SamplerParamsInput) => SamplerParams
    serializeParams: (params: SamplerParams) => string
  }
  granular: {
    kind: 'granular'
    createDefaultParams: () => GranularParams
    normalizeParams: (params: GranularParamsInput) => GranularParams
    serializeParams: (params: GranularParams) => string
  }
}

export type InstrumentContract = InstrumentContractByKind[InstrumentKind]

export const INSTRUMENT_CONTRACTS = {
  synth: {
    kind: 'synth',
    createDefaultParams: createDefaultSynthParams,
    normalizeParams: normalizeSynthParams,
    serializeParams: serializeSynthParams,
  },
  'drum-rack': {
    kind: 'drum-rack',
    createDefaultParams: createDefaultDrumRackParams,
    normalizeParams: normalizeDrumRackParams,
    serializeParams: serializeDrumRackParams,
  },
  sampler: {
    kind: 'sampler',
    createDefaultParams: createDefaultSamplerParams,
    normalizeParams: normalizeSamplerParams,
    serializeParams: serializeSamplerParams,
  },
  granular: {
    kind: 'granular',
    createDefaultParams: createDefaultGranularParams,
    normalizeParams: normalizeGranularParams,
    serializeParams: serializeGranularParams,
  },
} satisfies InstrumentContractByKind

export function isInstrumentKind(value: unknown): value is InstrumentKind {
  return value === 'synth' || value === 'drum-rack' || value === 'sampler' || value === 'granular'
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isSynthWave = (value: unknown): value is SynthWave => (
  value === 'sine' || value === 'square' || value === 'sawtooth' || value === 'triangle'
)

const readOptionalNumber = (value: unknown) => typeof value === 'number' ? value : undefined

const readSynthParamsInput = (value: unknown): SynthParamsInput => {
  if (!isRecord(value)) return {}
  return {
    wave1: isSynthWave(value.wave1) ? value.wave1 : undefined,
    wave2: isSynthWave(value.wave2) ? value.wave2 : undefined,
    gain: readOptionalNumber(value.gain),
    attackMs: readOptionalNumber(value.attackMs),
    releaseMs: readOptionalNumber(value.releaseMs),
  }
}

export function normalizeTrackInstrumentParams(value: unknown): TrackInstrumentParams | undefined {
  if (!isRecord(value) || !isInstrumentKind(value.kind)) return undefined
  const instanceId = typeof value.instanceId === 'string' && value.instanceId
    ? value.instanceId
    : migrationInstanceId(value.kind, value.params)
  if (value.kind === 'synth') {
    return { kind: value.kind, instanceId, params: normalizeSynthParams(readSynthParamsInput(value.params)) }
  }
  if (value.kind === 'sampler') {
    return { kind: value.kind, instanceId, params: normalizeSamplerParams(isRecord(value.params) ? value.params : {}) }
  }
  if (value.kind === 'granular') {
    return { kind: value.kind, instanceId, params: normalizeGranularParams(isRecord(value.params) ? value.params : {}) }
  }
  return {
    kind: value.kind,
    instanceId,
    params: normalizeDrumRackParams(isRecord(value.params) ? value.params : {}),
  }
}
