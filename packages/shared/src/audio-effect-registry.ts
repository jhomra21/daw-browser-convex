// The one place an audio effect kind is named. The tuple order is the persisted and UI device order; every list, union,
// validator and trait check derives from this tuple and the trait table below, which must name the same kinds.
export const AUDIO_EFFECT_KINDS = [
  'utility', 'eq', 'autofilter', 'gate', 'compressor', 'saturator', 'limiter', 'lofi', 'chorus',
  'flanger', 'phaser', 'tremolo', 'autopan', 'ensemble', 'delay', 'reverb', 'spectral', 'spectrum',
] as const

export type AudioEffectKind = typeof AUDIO_EFFECT_KINDS[number]

// operation: which persistence operation carries the params: the kind's own, the shared processor operation or the
//   shared modulation operation (those two carry the kind in the payload).
// runtime: 'worklet' runs in a static AudioWorklet owned by the engine; the Spectrum device only observes and has no
//   processor in any audio graph.
// modulationGroup: shares the modulation worklet and its timing model.
// sidechain: accepts a sidechain input.
// stereoWidening: decorrelates left and right, so a mono input leaves it stereo.
// gainReductionMeter: its worklet posts gain-reduction meter frames to the engine's listeners.
// nonlinear: its output depends on the signal level (dynamics, saturation, quantization, level-dependent bin gains), so
//   the sum of processed stems differs from processing their sum.
const AUDIO_EFFECTS = {
  utility: { operation: 'processor', runtime: 'worklet', modulationGroup: false, sidechain: false, stereoWidening: false, gainReductionMeter: false, nonlinear: false },
  eq: { operation: 'dedicated', runtime: 'nodes', modulationGroup: false, sidechain: false, stereoWidening: false, gainReductionMeter: false, nonlinear: false },
  autofilter: { operation: 'modulation', runtime: 'worklet', modulationGroup: false, sidechain: false, stereoWidening: false, gainReductionMeter: false, nonlinear: false },
  gate: { operation: 'processor', runtime: 'worklet', modulationGroup: false, sidechain: true, stereoWidening: false, gainReductionMeter: true, nonlinear: true },
  compressor: { operation: 'dedicated', runtime: 'nodes', modulationGroup: false, sidechain: true, stereoWidening: false, gainReductionMeter: false, nonlinear: true },
  saturator: { operation: 'dedicated', runtime: 'nodes', modulationGroup: false, sidechain: false, stereoWidening: false, gainReductionMeter: false, nonlinear: true },
  limiter: { operation: 'processor', runtime: 'worklet', modulationGroup: false, sidechain: false, stereoWidening: false, gainReductionMeter: true, nonlinear: true },
  lofi: { operation: 'modulation', runtime: 'worklet', modulationGroup: false, sidechain: false, stereoWidening: false, gainReductionMeter: false, nonlinear: true },
  chorus: { operation: 'modulation', runtime: 'worklet', modulationGroup: true, sidechain: false, stereoWidening: true, gainReductionMeter: false, nonlinear: false },
  flanger: { operation: 'modulation', runtime: 'worklet', modulationGroup: true, sidechain: false, stereoWidening: true, gainReductionMeter: false, nonlinear: false },
  phaser: { operation: 'modulation', runtime: 'worklet', modulationGroup: true, sidechain: false, stereoWidening: true, gainReductionMeter: false, nonlinear: false },
  tremolo: { operation: 'modulation', runtime: 'worklet', modulationGroup: true, sidechain: false, stereoWidening: false, gainReductionMeter: false, nonlinear: false },
  autopan: { operation: 'modulation', runtime: 'worklet', modulationGroup: true, sidechain: false, stereoWidening: true, gainReductionMeter: false, nonlinear: false },
  ensemble: { operation: 'modulation', runtime: 'worklet', modulationGroup: true, sidechain: false, stereoWidening: true, gainReductionMeter: false, nonlinear: false },
  delay: { operation: 'dedicated', runtime: 'nodes', modulationGroup: false, sidechain: false, stereoWidening: false, gainReductionMeter: false, nonlinear: false },
  reverb: { operation: 'dedicated', runtime: 'nodes', modulationGroup: false, sidechain: false, stereoWidening: false, gainReductionMeter: false, nonlinear: false },
  spectral: { operation: 'processor', runtime: 'worklet', modulationGroup: false, sidechain: true, stereoWidening: false, gainReductionMeter: false, nonlinear: true },
  spectrum: { operation: 'modulation', runtime: 'observer', modulationGroup: false, sidechain: false, stereoWidening: false, gainReductionMeter: false, nonlinear: false },
} as const satisfies Record<AudioEffectKind, {
  operation: 'dedicated' | 'processor' | 'modulation'
  runtime: 'nodes' | 'worklet' | 'observer'
  modulationGroup: boolean
  sidechain: boolean
  stereoWidening: boolean
  gainReductionMeter: boolean
  nonlinear: boolean
}>

type KindsWhere<Match> = { [Kind in AudioEffectKind]: typeof AUDIO_EFFECTS[Kind] extends Match ? Kind : never }[AudioEffectKind]

export type DspAudioEffectKind = Exclude<AudioEffectKind, KindsWhere<{ runtime: 'observer' }>>

export type OwnedProcessorKind = KindsWhere<{ runtime: 'worklet' }>

export type ModulationGroupKind = KindsWhere<{ modulationGroup: true }>

export type SidechainCapableKind = KindsWhere<{ sidechain: true }>

export type StereoWideningKind = KindsWhere<{ stereoWidening: true }>

export type GainReductionMeterKind = KindsWhere<{ gainReductionMeter: true }>

export type ModulationOperationKind = KindsWhere<{ operation: 'modulation' }>

export type ProcessorOperationKind = KindsWhere<{ operation: 'processor' }>

export const isAudioEffectKind = (value: unknown): value is AudioEffectKind =>
  typeof value === 'string' && Object.hasOwn(AUDIO_EFFECTS, value)

export const isDspAudioEffectKind = (value: unknown): value is DspAudioEffectKind =>
  isAudioEffectKind(value) && AUDIO_EFFECTS[value].runtime !== 'observer'

export const isOwnedProcessorKind = (value: unknown): value is OwnedProcessorKind =>
  isAudioEffectKind(value) && AUDIO_EFFECTS[value].runtime === 'worklet'

export const isModulationGroupKind = (value: unknown): value is ModulationGroupKind =>
  isAudioEffectKind(value) && AUDIO_EFFECTS[value].modulationGroup

export const isSidechainCapableKind = (value: unknown): value is SidechainCapableKind =>
  isAudioEffectKind(value) && AUDIO_EFFECTS[value].sidechain

export const isStereoWideningKind = (value: unknown): value is StereoWideningKind =>
  isAudioEffectKind(value) && AUDIO_EFFECTS[value].stereoWidening

export const isNonlinearKind = (value: unknown): value is KindsWhere<{ nonlinear: true }> =>
  isAudioEffectKind(value) && AUDIO_EFFECTS[value].nonlinear

export const isGainReductionMeterKind = (value: unknown): value is GainReductionMeterKind =>
  isAudioEffectKind(value) && AUDIO_EFFECTS[value].gainReductionMeter

type AudioEffectOperation = typeof AUDIO_EFFECTS[AudioEffectKind]['operation']

export const isModulationOperationKind = (kind: AudioEffectKind): kind is ModulationOperationKind =>
  AUDIO_EFFECTS[kind].operation === 'modulation'

export const audioEffectKindsWithOperation = <Operation extends AudioEffectOperation>(
  operation: Operation,
): KindsWhere<{ operation: Operation }>[] =>
  AUDIO_EFFECT_KINDS.filter((kind): kind is KindsWhere<{ operation: Operation }> => AUDIO_EFFECTS[kind].operation === operation)
