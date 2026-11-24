// Effect specs for the harness: typed contract state per processor kind, its wire encoding, and the
// parameter target ids (native/audio-core/include/daw/audio_core.h, DAW_AUDIO_PROCESSOR_PARAMETER_*).
import {
  encodeAutoFilterProcessorState, encodeAutoPanProcessorState, encodeChorusProcessorState, encodeCompressorProcessorState,
  encodeDelayProcessorState, encodeEnsembleProcessorState, encodeEqProcessorState, encodeFlangerProcessorState,
  encodeGateProcessorState, encodeLimiterProcessorState, encodeLoFiProcessorState, encodePhaserProcessorState,
  encodeReverbProcessorState, encodeSaturatorProcessorState, encodeSpectralProcessorState, encodeTremoloProcessorState,
  encodeUtilityProcessorState,
} from '../../packages/audio-core-contract/src'
import type {
  AmplitudeModulationProcessorState, AutoFilterProcessorState, CompressorProcessorState, DelayModulationProcessorState,
  DelayProcessorState, EnsembleProcessorState, EqProcessorBandState, EqProcessorState, GateProcessorState,
  LimiterProcessorState, LoFiProcessorState, PhaserProcessorState, ReverbProcessorState, SaturatorProcessorState,
  SpectralProcessorState, UtilityProcessorState,
} from '../../packages/audio-core-contract/src'

export type EffectSpec =
  | { kind: 'utility'; state: UtilityProcessorState }
  | { kind: 'saturator'; state: SaturatorProcessorState }
  | { kind: 'eq'; state: EqProcessorState }
  | { kind: 'chorus'; state: DelayModulationProcessorState }
  | { kind: 'flanger'; state: DelayModulationProcessorState }
  | { kind: 'phaser'; state: PhaserProcessorState }
  | { kind: 'tremolo'; state: AmplitudeModulationProcessorState }
  | { kind: 'autopan'; state: AmplitudeModulationProcessorState }
  | { kind: 'ensemble'; state: EnsembleProcessorState }
  | { kind: 'gate'; state: GateProcessorState }
  | { kind: 'compressor'; state: CompressorProcessorState }
  | { kind: 'limiter'; state: LimiterProcessorState }
  | { kind: 'delay'; state: DelayProcessorState }
  | { kind: 'reverb'; state: ReverbProcessorState }
  | { kind: 'spectral'; state: SpectralProcessorState }
  | { kind: 'autofilter'; state: AutoFilterProcessorState }
  | { kind: 'lofi'; state: LoFiProcessorState }

export type EffectKind = EffectSpec['kind']

export const kindIds: Record<EffectKind, number> = {
  utility: 1, saturator: 2, eq: 3, chorus: 4, flanger: 5, phaser: 6, tremolo: 7, autopan: 8, ensemble: 9,
  gate: 10, compressor: 11, limiter: 12, delay: 13, reverb: 14, spectral: 15, autofilter: 16, lofi: 17,
}

export const encodeSpec = (spec: EffectSpec): Uint8Array => {
  switch (spec.kind) {
    case 'utility': return encodeUtilityProcessorState(spec.state)
    case 'saturator': return encodeSaturatorProcessorState(spec.state)
    case 'eq': return encodeEqProcessorState(spec.state)
    case 'chorus': return encodeChorusProcessorState(spec.state)
    case 'flanger': return encodeFlangerProcessorState(spec.state)
    case 'phaser': return encodePhaserProcessorState(spec.state)
    case 'tremolo': return encodeTremoloProcessorState(spec.state)
    case 'autopan': return encodeAutoPanProcessorState(spec.state)
    case 'ensemble': return encodeEnsembleProcessorState(spec.state)
    case 'gate': return encodeGateProcessorState(spec.state)
    case 'compressor': return encodeCompressorProcessorState(spec.state)
    case 'limiter': return encodeLimiterProcessorState(spec.state)
    case 'delay': return encodeDelayProcessorState(spec.state)
    case 'reverb': return encodeReverbProcessorState(spec.state)
    case 'spectral': return encodeSpectralProcessorState(spec.state)
    case 'autofilter': return encodeAutoFilterProcessorState(spec.state)
    case 'lofi': return encodeLoFiProcessorState(spec.state)
  }
}

/** Latency the graph validator requires a descriptor to declare (audio_core_validation.cpp); zero for everything else. */
export const declaredLatencyFrames = (spec: EffectSpec): number =>
  spec.kind === 'autofilter' ? 6 : spec.kind === 'spectral' ? spec.state.fftSize : 0

const range = (first: number, keys: readonly string[]): Record<string, number> =>
  Object.fromEntries(keys.map((key, index) => [key, first + index]))

const eqTargets = Object.fromEntries(Array.from({ length: 8 }, (_, band) => [
  [`bands.${band}.frequency`, 45 + band * 3], [`bands.${band}.gainDb`, 46 + band * 3], [`bands.${band}.q`, 47 + band * 3],
]).flat())

const modulationKeys = ['delayMs', 'depthMs', 'rateHz', 'feedback', 'stereoPhase', 'mix']
const amplitudeKeys = ['rateHz', 'depth', 'shape', 'phase']

/* oxlint-disable anti-slop/no-shape-in-symbol-names -- reflectionShape and shape are contract field names */

/** Parameter targets by state path; the same path patches the legacy worklet's state. */
export const parameterTargets: Record<EffectKind, Record<string, number>> = {
  utility: range(1, ['gainDb', 'pan', 'balance', 'width']),
  saturator: range(69, ['driveDb', 'colorFrequencyHz', 'colorAmount', 'outputDb', 'dryWet']),
  eq: eqTargets,
  chorus: range(74, modulationKeys),
  flanger: range(80, modulationKeys),
  phaser: range(86, ['centerHz', 'depthOctaves', 'rateHz', 'feedback', 'stereoPhase', 'mix']),
  tremolo: range(92, amplitudeKeys),
  autopan: range(96, amplitudeKeys),
  ensemble: range(100, ['delayMs', 'depthMs', 'rateHz', 'spread', 'mix']),
  gate: range(105, ['thresholdDb', 'ratio', 'attackMs', 'holdMs', 'releaseMs', 'hysteresisDb', 'rangeDb', 'lookaheadMs', 'link', 'sidechain.frequencyHz', 'sidechain.q']),
  compressor: range(116, ['thresholdDb', 'ratio', 'attackMs', 'releaseMs', 'makeupDb', 'outputDb', 'dryWet', 'kneeDb', 'lookaheadMs', 'sidechain.frequencyHz', 'sidechain.q']),
  limiter: range(127, ['ceilingDbtp', 'releaseMs', 'lookaheadMs', 'link']),
  delay: range(5, ['delayMs', 'feedback', 'dryWet', 'lowCutHz', 'highCutHz']),
  reverb: {
    wet: 10, preDelayMs: 11, lowCutHz: 12, highCutHz: 13, stereoWidth: 14, decaySec: 132, reflections: 133,
    reflectionModAmountMs: 134, reflectionModRateHz: 135, reflectionShape: 136, diffuse: 137, size: 138, diffusion: 139,
    density: 140, diffusionLowCutHz: 141, diffusionHighCutHz: 142,
  },
  spectral: range(15, ['freeze', 'gateThresholdDb', 'gateAttackMs', 'gateReleaseMs', 'morph', 'binShift', 'blur', 'harmonicPercussiveBalance', 'noiseReduction', 'profileLearn', 'mix']),
  autofilter: range(30, ['frequencyHz', 'resonance', 'driveDb', 'mix', 'envelope.amountOctaves', 'envelope.attackMs', 'envelope.releaseMs', 'lfo.rateHz', 'lfo.depthOctaves', 'lfo.phaseOffset', 'lfo.stereoPhase']),
  lofi: { sampleRateRatio: 41, jitter: 42, noiseDb: 43, mix: 44, bitDepth: 131 },
}

const idleBand: EqProcessorBandState = { enabled: false, type: 'peaking', frequency: 1000, gainDb: 0, q: 1 }

/** One enabled band on an otherwise idle EQ. */
export const eqWith = (band: Partial<EqProcessorBandState>, extra: Partial<EqProcessorState> = {}): EffectSpec => ({
  kind: 'eq',
  state: { enabled: true, channelMode: 'stereo', bands: [{ ...idleBand, enabled: true, ...band }, ...Array.from({ length: 7 }, () => idleBand)], ...extra },
})

const modulation = (state: Partial<DelayModulationProcessorState>): DelayModulationProcessorState => ({
  enabled: true, delayMs: 12, depthMs: 4, rateHz: 0.8, feedback: 0, stereoPhase: 0.25, mix: 0.35, ...state,
})

const amplitude = (state: Partial<AmplitudeModulationProcessorState>): AmplitudeModulationProcessorState => ({
  enabled: true, waveform: 'sine', rateHz: 4, depth: 0.5, shape: 0.5, phase: 0, ...state,
})

/** Product-default states with per-scenario overrides; nested groups are replaced whole. */
export const fx = {
  utility: (state: Partial<UtilityProcessorState> = {}): EffectSpec => ({
    kind: 'utility',
    state: { enabled: true, gainDb: 0, polarity: 'normal', inputMode: 'stereo', pan: 0, balance: 0, width: 1, matrix: 'stereo', swap: false, dcBlock: true, ...state },
  }),
  saturator: (state: Partial<SaturatorProcessorState> = {}): EffectSpec => ({
    kind: 'saturator',
    state: { enabled: true, driveDb: 6, curve: 'soft', color: false, colorFrequencyHz: 1200, colorAmount: 0, outputDb: 0, dryWet: 1, ...state },
  }),
  chorus: (state: Partial<DelayModulationProcessorState> = {}): EffectSpec => ({ kind: 'chorus', state: modulation(state) }),
  flanger: (state: Partial<DelayModulationProcessorState> = {}): EffectSpec => ({
    kind: 'flanger', state: modulation({ delayMs: 1.5, depthMs: 1, rateHz: 0.2, feedback: 0.35, stereoPhase: 0.5, mix: 0.5, ...state }),
  }),
  phaser: (state: Partial<PhaserProcessorState> = {}): EffectSpec => ({
    kind: 'phaser',
    state: { enabled: true, stages: 6, centerHz: 1000, depthOctaves: 3, rateHz: 0.3, feedback: 0.3, stereoPhase: 0.5, mix: 0.5, ...state },
  }),
  tremolo: (state: Partial<AmplitudeModulationProcessorState> = {}): EffectSpec => ({ kind: 'tremolo', state: amplitude(state) }),
  autopan: (state: Partial<AmplitudeModulationProcessorState> = {}): EffectSpec => ({ kind: 'autopan', state: amplitude({ rateHz: 1, depth: 1, ...state }) }),
  ensemble: (state: Partial<EnsembleProcessorState> = {}): EffectSpec => ({
    kind: 'ensemble', state: { enabled: true, voices: 3, delayMs: 18, depthMs: 6, rateHz: 0.6, spread: 1, mix: 0.5, ...state },
  }),
  gate: (state: Partial<GateProcessorState> = {}): EffectSpec => ({
    kind: 'gate',
    state: {
      enabled: true, mode: 'gate', thresholdDb: -40, ratio: 4, attackMs: 1, holdMs: 20, releaseMs: 120, hysteresisDb: 6, rangeDb: -80,
      lookaheadMs: 0, detector: 'peak', link: 1, sidechain: { enabled: false, frequencyHz: 80, q: 0.707 }, ...state,
    },
  }),
  compressor: (state: Partial<CompressorProcessorState> = {}): EffectSpec => ({
    kind: 'compressor',
    state: {
      enabled: true, thresholdDb: -24, ratio: 4, attackMs: 10, releaseMs: 120, autoRelease: true, makeupDb: 0, outputDb: 0, dryWet: 1,
      kneeDb: 6, lookaheadMs: 0, detectorMode: 'rms', dynamicsMode: 'compress', envelopeCurve: 'log',
      sidechain: { enabled: false, filterType: 'highpass', frequencyHz: 120, q: 0.707 }, ...state,
    },
  }),
  limiter: (state: Partial<LimiterProcessorState> = {}): EffectSpec => ({
    kind: 'limiter', state: { enabled: true, ceilingDbtp: -1, releaseMs: 100, lookaheadMs: 5, link: 1, detectorOversampling: 4, ...state },
  }),
  delay: (state: Partial<DelayProcessorState> = {}): EffectSpec => ({
    kind: 'delay',
    state: { enabled: true, delayMs: 250, feedback: 0.25, dryWet: 0.2, pingPong: false, filterEnabled: false, lowCutHz: 120, highCutHz: 8000, ...state },
  }),
  reverb: (state: Partial<ReverbProcessorState> = {}): EffectSpec => ({
    kind: 'reverb',
    state: {
      enabled: true, wet: 0.25, decaySec: 2.2, preDelayMs: 20, reflections: 0, reflectionSpin: true, reflectionModAmountMs: 17.5,
      reflectionModRateHz: 0.3, reflectionShape: 0.5, diffuse: 1, size: 0.65, diffusion: 0.75, density: 0.8, lowCutHz: 20,
      highCutHz: 20000, diffusionLowCutHz: 20, diffusionHighCutHz: 20000, stereoWidth: 1, ...state,
    },
  }),
  spectral: (state: Partial<SpectralProcessorState> = {}): EffectSpec => ({
    kind: 'spectral',
    state: {
      enabled: true, fftSize: 2048, overlap: 4, mode: 'gate', freeze: 0, gateThresholdDb: -60, gateAttackMs: 10, gateReleaseMs: 100,
      morph: 0, binShift: 0, blur: 0, harmonicPercussiveBalance: 0, noiseReduction: 0, profileLearn: 0, mix: 1, ...state,
    },
  }),
  autofilter: (state: Partial<AutoFilterProcessorState> = {}): EffectSpec => ({
    kind: 'autofilter',
    state: {
      enabled: true, mode: 'lowpass', quality: '2x', frequencyHz: 1000, resonance: 0.25, driveDb: 0, mix: 1,
      envelope: { amountOctaves: 0, attackMs: 10, releaseMs: 100 },
      lfo: { waveform: 'sine', rateHz: 1, depthOctaves: 0, phaseOffset: 0, stereoPhase: 0 }, ...state,
    },
  }),
  lofi: (state: Partial<LoFiProcessorState> = {}): EffectSpec => ({
    kind: 'lofi',
    state: { enabled: true, bitDepth: 12, sampleRateRatio: 1, jitter: 0, noiseDb: -80, quantization: 'round', dither: 'off', mix: 1, seed: 1, ...state },
  }),
}
