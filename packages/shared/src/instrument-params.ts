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

export type InstrumentKind = 'synth' | 'drum-rack'

export type TrackInstrumentParams =
  | { kind: 'synth'; params: SynthParams }
  | { kind: 'drum-rack'; params: DrumRackParams }

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
} satisfies InstrumentContractByKind

export function isInstrumentKind(value: unknown): value is InstrumentKind {
  return value === 'synth' || value === 'drum-rack'
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
  if (value.kind === 'synth') {
    return { kind: value.kind, params: normalizeSynthParams(readSynthParamsInput(value.params)) }
  }
  return {
    kind: value.kind,
    params: normalizeDrumRackParams(isRecord(value.params) ? value.params : {}),
  }
}
