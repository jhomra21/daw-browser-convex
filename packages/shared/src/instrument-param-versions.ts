import type { InstrumentKind } from './instrument-params'
import type { JsonValue } from './json-value'
import { migrateParamsStepwise, type ParamsVersioning } from './params-versioning'
import { migrateSynthParamsV1 } from './synth-params'

// Storage-only versioning, the instrument counterpart of audio-effect-param-versions.ts: the persisted effect row of an
// instrument, a legacy synth or an arpeggiator carries the same optional `paramsVersion` (absent = 1). Public contracts and
// in-memory params always use the current shape; readers migrate before use.
export type VersionedInstrumentKind = InstrumentKind | 'arpeggiator'

export const INSTRUMENT_PARAMS_VERSION: Readonly<Record<VersionedInstrumentKind, number>> = {
  synth: 2,
  sampler: 1,
  'drum-rack': 1,
  granular: 1,
  arpeggiator: 1,
}

export type InstrumentParamsVersioning = ParamsVersioning<VersionedInstrumentKind>

export const INSTRUMENT_PARAMS_VERSIONING: InstrumentParamsVersioning = {
  current: INSTRUMENT_PARAMS_VERSION,
  migrations: {
    // Synth v1 is the wave1/wave2/attackMs/releaseMs shape; rows written before versions existed hold either shape, so the step tells them apart.
    synth: { 1: migrateSynthParamsV1 },
  },
  parameterValues: {},
}

/** Upgrades stored instrument or arpeggiator params to the current version; see migrateParamsStepwise. */
export const migrateInstrumentParams = (
  kind: VersionedInstrumentKind,
  params: JsonValue,
  storedVersion: number | undefined,
  versioning: InstrumentParamsVersioning = INSTRUMENT_PARAMS_VERSIONING,
): JsonValue => migrateParamsStepwise(versioning, kind, params, storedVersion)
