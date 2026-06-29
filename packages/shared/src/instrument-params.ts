import {
  createDefaultSynthParams,
  normalizeSynthParams,
  serializeSynthParams,
  type SynthParams,
  type SynthParamsInput,
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
