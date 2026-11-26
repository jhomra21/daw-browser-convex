import {
  createDefaultAutoPanParams,
  createDefaultChorusParams,
  createDefaultEnsembleParams,
  createDefaultFlangerParams,
  createDefaultPhaserParams,
  createDefaultTremoloParams,
} from './effects-params'
import { isJsonObject, type JsonObject, type JsonValue } from './json-value'

// Version 1 -> 2 for Chorus, Flanger, Ensemble, Phaser, Tremolo and Auto Pan. Version 1 had only the knobs of the
// original effects; version 2 adds the controls of the rebuilt ones. Every old knob keeps its meaning and value, and every
// added control starts where it leaves the old setting as it was:
// - Chorus, Flanger and Ensemble: sine LFO, Safe Bass off (100 Hz), Width 1, Output 0 dB; Chorus mode Chorus, Flanger mode
//   Flanger; Ensemble fast modulation (Depth 0 ms, Rate 6 Hz) off;
// - Phaser: sine LFO, Safe Bass off, Spread 0 and Blend 0 (the old all-pass cascade and mix), Output 0 dB;
// - Tremolo and Auto Pan: the old 'sine' or 'triangle' stays, Sync off, Invert off, Stereo Phase 0; Phase stays the offset of
//   both channels' LFOs.
// What does not carry over by design (owner decisions, applies to every project): the delay loop of Chorus and Flanger is now exactly
// the set delay so the comb notches sit where the knob says; Auto Pan is equal-power (-3 dB at centre, 0 dB at the sides, where
// the old one was 0 dB at centre and +3 dB at the sides); Tremolo keeps its average level at any Depth (the old one only ducked).

const withAddedControls = (params: JsonValue, added: JsonObject): JsonValue => {
  if (!isJsonObject(params)) return params
  const wrapped = isJsonObject(params.state)
  const old = wrapped && isJsonObject(params.state) ? params.state : params
  const state: JsonValue = { ...added, ...old }

  return wrapped ? { ...params, state } : state
}

const addedOnly = (defaults: JsonObject, kept: readonly string[]): JsonObject => Object.fromEntries(Object.entries(defaults).filter(([key]) => !kept.includes(key)))

const oldDelayKnobs = ['enabled', 'delayMs', 'depthMs', 'rateHz', 'feedback', 'stereoPhase', 'mix']

export const migrateChorusParamsV1 = (params: JsonValue): JsonValue => withAddedControls(params, addedOnly({ ...createDefaultChorusParams() }, oldDelayKnobs))

export const migrateFlangerParamsV1 = (params: JsonValue): JsonValue => withAddedControls(params, addedOnly({ ...createDefaultFlangerParams() }, oldDelayKnobs))

export const migratePhaserParamsV1 = (params: JsonValue): JsonValue => withAddedControls(params, addedOnly({ ...createDefaultPhaserParams() },
  ['enabled', 'stages', 'centerHz', 'depthOctaves', 'rateHz', 'feedback', 'stereoPhase', 'mix']))

const oldAmplitudeKnobs = ['enabled', 'waveform', 'rateHz', 'depth', 'shape', 'phase']

export const migrateTremoloParamsV1 = (params: JsonValue): JsonValue => withAddedControls(params, addedOnly({ ...createDefaultTremoloParams() }, oldAmplitudeKnobs))

export const migrateAutoPanParamsV1 = (params: JsonValue): JsonValue => withAddedControls(params, addedOnly({ ...createDefaultAutoPanParams() }, oldAmplitudeKnobs))

export const migrateEnsembleParamsV1 = (params: JsonValue): JsonValue => withAddedControls(params, addedOnly({ ...createDefaultEnsembleParams() },
  ['enabled', 'voices', 'delayMs', 'depthMs', 'rateHz', 'spread', 'mix']))
