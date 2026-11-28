import { migrateCompressorParamsV1 } from './compressor-params-migration'
import { migrateDelayParamsV1 } from './delay-params-migration'
import { migrateGateParamsV1 } from './gate-params-migration'
import { migrateLimiterParamsV1 } from './limiter-params-migration'
import { migrateAutoPanParamsV1, migrateChorusParamsV1, migrateEnsembleParamsV1, migrateFlangerParamsV1, migratePhaserParamsV1, migrateTremoloParamsV1 } from './modulation-params-migration'
import { migrateLoFiParamsV1 } from './lofi-params-migration'
import { migrateUtilityParamsV1 } from './utility-params-migration'
import { migrateSaturatorParamsV1 } from './saturator-params-migration'
import { migrateSpectralGateThresholdV1, migrateSpectralParamsV1, storedSpectralFftSize } from './spectral-params-migration'
import { migrateReverbParamsV1, migrateReverbStereoWidthV1 } from './reverb-params-migration'
import { migrateAutoFilterEnvelopeAmountV1, migrateAutoFilterParamsV1, migrateAutoFilterResonanceV1 } from './auto-filter-params-migration'
import { getAutomationParameterDescriptor } from './automation-parameters'
import { isAudioEffectKind, type AudioEffectKind } from './audio-effect-registry'
import { INSTRUMENT_PARAMS_VERSION, INSTRUMENT_PARAMS_VERSIONING } from './instrument-param-versions'
import { isInstrumentKind } from './instrument-params'
import { migrateAutomationValuesStepwise, migrateParamsStepwise, type ParamsVersioning } from './params-versioning'
import { isJsonObject, type JsonValue } from './json-value'

// Storage-only versioning: persisted effect rows carry an optional `paramsVersion` (absent = 1).
// Public contracts and in-memory params always use the current shape; readers migrate before use.
export const AUDIO_EFFECT_PARAMS_VERSION: Readonly<Record<AudioEffectKind, number>> = {
  eq: 2,
  compressor: 2,
  saturator: 2,
  delay: 2,
  reverb: 2,
  autofilter: 2,
  gate: 2,
  limiter: 2,
  lofi: 2,
  chorus: 2,
  flanger: 2,
  phaser: 2,
  tremolo: 2,
  autopan: 2,
  ensemble: 2,
  spectral: 2,
  utility: 2,
  spectrum: 1,
}

export type AudioEffectParamsVersioning = ParamsVersioning<AudioEffectKind>

function migrateEqV1ToV2(params: JsonValue): JsonValue {
  if (!isJsonObject(params)) return params
  const bands = Array.isArray(params.bands) ? params.bands : []
  const curveB = bands.map((band, index) => (isJsonObject(band) ? { ...band, id: `b${index + 9}` } : band))

  return { ...params, bands: [...bands, ...curveB], adaptiveQ: false, scale: 1, outputDb: 0, highQuality: false }
}

export const AUDIO_EFFECT_PARAMS_VERSIONING: AudioEffectParamsVersioning = {
  current: AUDIO_EFFECT_PARAMS_VERSION,
  migrations: {
    autofilter: { 1: migrateAutoFilterParamsV1 },
    // EQ Eight: curve B (a copy of curve A, so L/R and M/S start identical), Scale 100 %, Output 0 dB, Adaptive Q off and
    // Hi-Quality off. Band types, frequencies, gains and Qs and the channel mode (incl. 'mono') carry over unchanged.
    eq: { 1: migrateEqV1ToV2 },
    // Compressor: Auto Makeup off, lookahead snapped to the nearest 0/1/10 ms step.
    compressor: { 1: migrateCompressorParamsV1 },
    // Gate: Flip off, sidechain Gain 0 dB, Dry/Wet 100 %, lookahead snapped to the nearest 0/1/10 ms step.
    gate: { 1: migrateGateParamsV1 },
    // Limiter: Gain 0 dB, Auto off, lookahead snapped to the nearest 1.5/3/6 ms step.
    limiter: { 1: migrateLimiterParamsV1 },
    // Delay: one time per channel (Mode and division carry to both, linked), the filter pair becomes the band-pass whose edges they were,
    // time smoothing Repitch, Freeze and offsets off.
    delay: { 1: migrateDelayParamsV1 },
    // Saturator: Color Amount becomes Amt Hi (x 12 dB), Hi-Quality on, Post Clip off; each old curve's small-signal gain moves into Drive so levels hold (saturator-params-migration.ts).
    saturator: { 1: migrateSaturatorParamsV1 },
    // Lo-Fi: Rate in Hz (old ratio x 48 kHz, ratio 1 the top of the range), the band-limiting filters and the Floor correction off (lofi-params-migration.ts).
    lofi: { 1: migrateLoFiParamsV1 },
    // Utility: Phase L/R from the one polarity switch, Channel Mode from Swap, and the old Pan folded into Balance (utility-params-migration.ts).
    utility: { 1: migrateUtilityParamsV1 },
    // Reverb: Density Sparse (the old 8 lines), the old in-loop cuts as shelves, Width as the Stereo angle, Chorus on, Smooth Fast.
    reverb: { 1: migrateReverbParamsV1 },
    // Chorus, Flanger, Ensemble, Phaser, Tremolo, Auto Pan: each added control starts at the value that keeps the old setting (modulation-params-migration.ts).
    chorus: { 1: migrateChorusParamsV1 },
    flanger: { 1: migrateFlangerParamsV1 },
    phaser: { 1: migratePhaserParamsV1 },
    tremolo: { 1: migrateTremoloParamsV1 },
    autopan: { 1: migrateAutoPanParamsV1 },
    ensemble: { 1: migrateEnsembleParamsV1 },
    // Spectral: Gate threshold in dBFS (exact for the stored FFT size), Learn a toggle, Noise Reduce floor -30 dB (spectral-params-migration.ts).
    spectral: { 1: migrateSpectralParamsV1 },
  },
  parameterValues: {
    reverb: { 1: { 'reverb.stereoWidth': migrateReverbStereoWidthV1 } },
    // A lane moves by the same offset as its effect's own threshold, from the owner's stored FFT size; without the owner it moves as at the default 2048.
    spectral: { 1: { 'spectral.gateThresholdDb': (value, ownerParams) => migrateSpectralGateThresholdV1(value, storedSpectralFftSize(ownerParams)) } },
    autofilter: {
      1: {
        'autofilter.resonance': migrateAutoFilterResonanceV1,
        'autofilter.envelope.amountOctaves': migrateAutoFilterEnvelopeAmountV1,
      },
    },
  },
}

/** Upgrades stored effect params to the current version; see migrateParamsStepwise. */
export const migrateAudioEffectParams = (
  kind: AudioEffectKind,
  params: JsonValue,
  storedVersion: number | undefined,
  versioning: AudioEffectParamsVersioning = AUDIO_EFFECT_PARAMS_VERSIONING,
): JsonValue => migrateParamsStepwise(versioning, kind, params, storedVersion)

/**
 * Params a client wrote at `writtenVersion`, brought to this build's current shape. Undefined when this build cannot
 * read that version (the client is newer, or the number is malformed), so the write must be refused: stamping it with
 * the current version would pass newer params off as current. Kinds outside the catalog pass through.
 */
export const migrateWrittenAudioEffectParams = (
  kind: string,
  params: JsonValue,
  writtenVersion: number,
  versioning: AudioEffectParamsVersioning = AUDIO_EFFECT_PARAMS_VERSIONING,
): JsonValue | undefined => {
  if (!isAudioEffectKind(kind)) return params

  if (!Number.isInteger(writtenVersion) || writtenVersion < 1 || writtenVersion > versioning.current[kind]) return undefined

  return migrateAudioEffectParams(kind, params, writtenVersion, versioning)
}

/** The storage field to write with every persisted effect; empty for non-catalog rows such as instruments. */
export const audioEffectParamsVersionStamp = (kind: string): { paramsVersion?: number } => (
  isAudioEffectKind(kind) ? { paramsVersion: AUDIO_EFFECT_PARAMS_VERSION[kind] } : {}
)

// Automation envelopes that target a processor parameter carry the same storage field idea: `valuesVersion` (absent = 1) is the
// version of the effect or instrument kind whose parameter units the point values were written in. Mixer lanes have no kind.
const automationParameterOwner = (parameterId: string) => getAutomationParameterDescriptor(parameterId)?.owner ?? null
/** Stored params of each effect instance by id: the owners a lane's migration reads. */
export const effectParamsByInstanceId = (effects: Iterable<{ instanceId?: string; params: JsonValue }>): ReadonlyMap<string, JsonValue> => {
  const owners = new Map<string, JsonValue>()

  for (const { instanceId, params } of effects) if (instanceId !== undefined) owners.set(instanceId, params)

  return owners
}

/**
 * Rescales stored automation point values to the current version of the parameter's owning kind. Newer or unreadable versions pass through.
 * `ownerParams` are the stored params of the effect the lane targets; leave them out only when that effect cannot be found.
 */
export const migrateAutomationPointValues = <Point extends { value: number }>(
  parameterId: string,
  points: Point[],
  storedVersion: number | undefined,
  versioning: AudioEffectParamsVersioning = AUDIO_EFFECT_PARAMS_VERSIONING,
  ownerParams?: JsonValue,
): Point[] => {
  const owner = automationParameterOwner(parameterId)

  if (isAudioEffectKind(owner)) return migrateAutomationValuesStepwise(versioning, owner, parameterId, points, storedVersion, ownerParams)

  if (isInstrumentKind(owner)) return migrateAutomationValuesStepwise(INSTRUMENT_PARAMS_VERSIONING, owner, parameterId, points, storedVersion, ownerParams)

  return points
}

/** The storage field to write with every persisted automation envelope; empty for lanes that do not target a processor parameter. */
export const automationValuesVersionStamp = (parameterId: string): { valuesVersion?: number } => {
  const owner = automationParameterOwner(parameterId)

  if (isAudioEffectKind(owner)) return { valuesVersion: AUDIO_EFFECT_PARAMS_VERSION[owner] }

  return isInstrumentKind(owner) ? { valuesVersion: INSTRUMENT_PARAMS_VERSION[owner] } : {}
}
