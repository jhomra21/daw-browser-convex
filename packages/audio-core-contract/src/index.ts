import { processorRegistry } from './generated/processor-contract-metadata'

export const audioCoreContractVersion = 1

export type UtilityProcessorState = {
  enabled: boolean
  gainDb: number
  polarity: 'normal' | 'invert'
  inputMode: 'stereo' | 'mono-sum'
  pan: number
  balance: number
  width: number
  matrix: 'stereo' | 'mid-side-encode' | 'mid-side-decode'
  swap: boolean
  dcBlock: boolean
}

export type UtilityProcessorContract = {
  version: typeof audioCoreContractVersion
  kind: 'utility'
  state: UtilityProcessorState
}

export type AutoFilterProcessorState = {
  enabled: boolean
  mode: 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peak'
  quality: '2x'
  frequencyHz: number
  resonance: number
  driveDb: number
  mix: number
  envelope: { amountOctaves: number; attackMs: number; releaseMs: number }
  lfo: { waveform: 'sine' | 'triangle'; rateHz: number; depthOctaves: number; phaseOffset: number; stereoPhase: number }
}

export type LoFiProcessorState = {
  enabled: boolean
  bitDepth: number
  sampleRateRatio: number
  jitter: number
  noiseDb: number
  quantization: 'round' | 'floor' | 'truncate'
  dither: 'off' | 'rectangular' | 'triangular'
  mix: number
  seed: number
}

export type SaturatorProcessorState = {
  enabled: boolean
  driveDb: number
  curve: 'soft' | 'medium' | 'hard' | 'clip'
  color: boolean
  colorFrequencyHz: number
  colorAmount: number
  outputDb: number
  dryWet: number
}

export type EqProcessorBandState = {
  enabled: boolean
  type: 'lowpass' | 'highpass' | 'bandpass' | 'lowshelf' | 'highshelf' | 'peaking' | 'notch' | 'allpass'
  frequency: number
  gainDb: number
  q: number
}

/**
 * Portable EQ is a fixed eight-band RBJ cookbook biquad chain. It preserves
 * the legacy band's index, type, enabled state, frequency, gain, and Q, but
 * not browser-specific BiquadFilterNode coefficient or automation behavior.
 */
export type EqProcessorState = {
  enabled: boolean
  channelMode: 'stereo' | 'mono'
  bands: readonly EqProcessorBandState[]
}

export type DelayModulationProcessorState = {
  enabled: boolean
  delayMs: number
  depthMs: number
  rateHz: number
  feedback: number
  stereoPhase: number
  mix: number
}

export type PhaserProcessorState = {
  enabled: boolean
  stages: 4 | 6 | 8 | 12
  centerHz: number
  depthOctaves: number
  rateHz: number
  feedback: number
  stereoPhase: number
  mix: number
}

export type AmplitudeModulationProcessorState = {
  enabled: boolean
  waveform: 'sine' | 'triangle'
  rateHz: number
  depth: number
  shape: number
  phase: number
}

export type EnsembleProcessorState = {
  enabled: boolean
  voices: 3
  delayMs: number
  depthMs: number
  rateHz: number
  spread: number
  mix: number
}

export type GateProcessorState = {
  enabled: boolean
  mode: 'gate' | 'expander'
  thresholdDb: number
  ratio: number
  attackMs: number
  holdMs: number
  releaseMs: number
  hysteresisDb: number
  rangeDb: number
  lookaheadMs: number
  detector: 'peak' | 'rms'
  link: number
  sidechain: { enabled: boolean; frequencyHz: number; q: number }
}

export type CompressorProcessorState = {
  enabled: boolean
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
  autoRelease: boolean
  makeupDb: number
  outputDb: number
  dryWet: number
  kneeDb: number
  lookaheadMs: number
  detectorMode: 'peak' | 'rms'
  dynamicsMode: 'compress' | 'expand'
  envelopeCurve: 'log' | 'linear'
  sidechain: { enabled: boolean; filterType: 'lowpass' | 'highpass' | 'bandpass'; frequencyHz: number; q: number }
}

export type LimiterProcessorState = {
  enabled: boolean
  ceilingDbtp: number
  releaseMs: number
  lookaheadMs: number
  link: number
  detectorOversampling: 4
}

export type DelayProcessorState = {
  enabled: boolean
  delayMs: number
  feedback: number
  dryWet: number
  pingPong: boolean
  filterEnabled: boolean
  lowCutHz: number
  highCutHz: number
}

/**
 * Reverb uses the deterministic bounded feedback-delay profile shared by
 * native, Wasm, and browser AudioWorklet processing.
 */
export type ReverbProcessorState = {
  enabled: boolean
  wet: number
  decaySec: number
  preDelayMs: number
  reflections: number
  reflectionSpin: boolean
  reflectionModAmountMs: number
  reflectionModRateHz: number
  reflectionShape: number
  diffuse: number
  size: number
  diffusion: number
  density: number
  lowCutHz: number
  highCutHz: number
  diffusionLowCutHz: number
  diffusionHighCutHz: number
  stereoWidth: number
}

export type SpectralProcessorState = {
  enabled: boolean
  fftSize: 512 | 1024 | 2048 | 4096
  overlap: 2 | 4
  mode: 'freeze' | 'gate' | 'morph' | 'shift-blur' | 'hpss' | 'noise-reduce'
  freeze: number
  gateThresholdDb: number
  gateAttackMs: number
  gateReleaseMs: number
  morph: number
  binShift: number
  blur: number
  harmonicPercussiveBalance: number
  noiseReduction: number
  profileLearn: number
  mix: number
}

export type AudioCoreGraphNodeDto = {
  version: typeof audioCoreContractVersion
  id: string
  processor: UtilityProcessorContract
}

export type AudioCoreGraphLayout = 'mono' | 'stereo'
export type AudioCoreGraphNodeKind = 'source' | 'instrument' | 'mixer' | 'return' | 'group' | 'master'
export type AudioCoreGraphTap = 'pre-fx' | 'pre-fader' | 'post-fader'

export const audioCoreMaxInstrumentVoices = 32
export const audioCoreMaxInstrumentParameterTargets = 16

/**
 * Stable per-node mixer targets. A parameter event at frame N applies before
 * node N is rendered, so it affects that sample and every following sample in
 * the block. Equal-offset events retain caller order; the last value wins.
 */
export const mixerParameterRegistry = [
  { id: 'mixer.gain', target: 26, minValue: 0, maxValue: 4 },
  { id: 'mixer.pan', target: 27, minValue: -1, maxValue: 1 },
  { id: 'mixer.mute', target: 28, minValue: 0, maxValue: 1 },
  { id: 'mixer.solo', target: 29, minValue: 0, maxValue: 1 },
] as const

export type AudioCoreMixerParameterTarget = typeof mixerParameterRegistry[number]

export type AudioCoreMixerState = {
  instanceId: number
  gain: number
  pan: number
  muted: boolean
  soloed: boolean
  parameterTargets: readonly AudioCoreMixerParameterTarget[]
}

export const synthParameterRegistry = [
  { id: 'synth.outputGain', target: 1, minValue: 0, maxValue: 2, tombstone: false },
  { id: 'synth.outputPan', target: 2, minValue: -1, maxValue: 1, tombstone: false },
  { id: 'synth.filterCutoffHz', target: 3, minValue: 20, maxValue: 20_000, tombstone: false },
  { id: 'synth.filterResonance', target: 4, minValue: 0, maxValue: 30, tombstone: false },
  { id: 'synth.ampAttackMs', target: 5, minValue: 0, maxValue: 10_000, tombstone: false },
  { id: 'synth.ampDecayMs', target: 6, minValue: 0, maxValue: 10_000, tombstone: false },
  { id: 'synth.ampSustain', target: 7, minValue: 0, maxValue: 1, tombstone: false },
  { id: 'synth.ampReleaseMs', target: 8, minValue: 0, maxValue: 60_000, tombstone: false },
  { id: 'synth.reserved', target: 9, minValue: 0, maxValue: 0, tombstone: true },
] as const

export type AudioCoreSynthParameterTarget = typeof synthParameterRegistry[number]

export type AudioCoreSynthState = {
  version: typeof audioCoreContractVersion
  kind: 'synth'
  voiceCapacity: number
  outputLayout: 'stereo'
  parameterTargets: readonly AudioCoreProcessorParameterTarget[]
  oscillators?: readonly {
    enabled: boolean
    waveform: 0 | 1 | 2 | 3
    level: number
    octave: number
    semitone: number
    detuneCents: number
  }[]
  noiseEnabled?: boolean
  noiseLevel?: number
  filterEnabled?: boolean
  filterMode?: 0 | 1 | 2 | 3
  filterCutoffHz?: number
  filterResonance?: number
  filterKeyTracking?: number
  filterEnvelopeAmountOctaves?: number
  filterAttackMs?: number
  filterDecayMs?: number
  filterSustain?: number
  filterReleaseMs?: number
  ampAttackMs?: number
  ampDecayMs?: number
  ampSustain?: number
  ampReleaseMs?: number
  lfoEnabled?: boolean
  lfoWaveform?: 0 | 1 | 2 | 3
  lfoRateHz?: number
  lfoPitchCents?: number
  lfoFilterOctaves?: number
  lfoAmplitude?: number
  lfoPan?: number
  outputGain?: number
  outputPan?: number
}

/**
 * Fixed granular ABI state. `assetId` is an immutable decoded-asset identity;
 * native and Wasm allocate their own bounded grain storage from this state.
 */
export type AudioCoreGranularState = {
  version: typeof audioCoreContractVersion
  kind: 'granular'
  voiceCapacity: number
  outputLayout: 'stereo'
  assetId: string
  seed: number
  maxGrains: number
  windowShape: 'hann' | 'tukey' | 'gaussian'
  freeze: boolean
  grainSizeMs: number
  densityHz: number
  position: number
  spray: number
  pitchSemitones: number
  reverseProbability: number
  stereoSpread: number
}

export const audioCoreMaxGranularGrains = 128
export const audioCoreMaxSampleZones = 32

export type AudioCoreSampleZone = {
  assetId: string
  keyLow: number
  keyHigh: number
  velocityLow: number
  velocityHigh: number
  rootNote: number
  tuneCents: number
  gain: number
  pan: number
  roundRobinGroup: number
  roundRobinIndex: number
  playbackMode: 'one-shot' | 'forward-loop' | 'crossfade-loop'
  startFrame: number
  endFrame: number
  loopStartFrame: number
  loopEndFrame: number
  crossfadeFrameCount: number
  chokeGroup: number
}

export type AudioCoreSamplerState = {
  version: typeof audioCoreContractVersion
  kind: 'sampler'
  voiceCapacity: number
  outputLayout: 'stereo'
  ampAttackMs: number
  ampDecayMs: number
  ampSustain: number
  ampReleaseMs: number
  filterEnabled: boolean
  filterMode: 'lowpass' | 'highpass' | 'bandpass' | 'notch'
  filterCutoffHz: number
  filterResonance: number
  filterEnvelopeAmount: number
  filterAttackMs: number
  filterDecayMs: number
  filterSustain: number
  filterReleaseMs: number
  lfoEnabled: boolean
  lfoRateHz: number
  lfoPitchCents: number
  lfoFilterHz: number
  lfoAmplitude: number
  lfoPan: number
  retrigger: boolean
  zones: readonly AudioCoreSampleZone[]
}

export type AudioCoreDrumRackState = Omit<AudioCoreSamplerState, 'kind'> & {
  kind: 'drum-rack'
}

const isBoundedFloat = (value: unknown, minimum: number, maximum: number) =>
  isFiniteNumber(value) && value >= minimum && value <= maximum

const isNonnegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isAudioCoreSampleZone = (value: unknown, drumRack: boolean): value is AudioCoreSampleZone =>
  isRecord(value)
  && hasOnlyKeys(value, ['assetId', 'keyLow', 'keyHigh', 'velocityLow', 'velocityHigh', 'rootNote', 'tuneCents', 'gain', 'pan', 'roundRobinGroup', 'roundRobinIndex', 'playbackMode', 'startFrame', 'endFrame', 'loopStartFrame', 'loopEndFrame', 'crossfadeFrameCount', 'chokeGroup'])
  && typeof value.assetId === 'string' && value.assetId.length > 0
  && isFiniteNumber(value.keyLow) && Number.isInteger(value.keyLow) && value.keyLow >= 0 && value.keyLow <= 127
  && isFiniteNumber(value.keyHigh) && Number.isInteger(value.keyHigh) && value.keyHigh >= value.keyLow && value.keyHigh <= 127
  && isFiniteNumber(value.velocityLow) && Number.isInteger(value.velocityLow) && value.velocityLow >= 1 && value.velocityLow <= 127
  && isFiniteNumber(value.velocityHigh) && Number.isInteger(value.velocityHigh) && value.velocityHigh >= value.velocityLow && value.velocityHigh <= 127
  && isFiniteNumber(value.rootNote) && Number.isInteger(value.rootNote) && value.rootNote >= 0 && value.rootNote <= 127
  && isBoundedFloat(value.tuneCents, -4800, 4800) && isBoundedFloat(value.gain, 0, 4) && isBoundedFloat(value.pan, -1, 1)
  && isNonnegativeSafeInteger(value.roundRobinGroup)
  && isNonnegativeSafeInteger(value.roundRobinIndex)
  && (value.playbackMode === 'one-shot' || value.playbackMode === 'forward-loop' || value.playbackMode === 'crossfade-loop')
  && isNonnegativeSafeInteger(value.startFrame)
  && isNonnegativeSafeInteger(value.endFrame) && value.endFrame > value.startFrame
  && isNonnegativeSafeInteger(value.loopStartFrame) && value.loopStartFrame >= value.startFrame
  && isNonnegativeSafeInteger(value.loopEndFrame) && value.loopEndFrame >= value.loopStartFrame && value.loopEndFrame <= value.endFrame
  && isNonnegativeSafeInteger(value.crossfadeFrameCount)
  && value.crossfadeFrameCount <= Math.floor((value.loopEndFrame - value.loopStartFrame) / 2)
  && isNonnegativeSafeInteger(value.chokeGroup)
  && (!drumRack || (value.keyLow === value.keyHigh && value.roundRobinGroup === 0))

const isAudioCoreSamplerState = (value: unknown, kind: 'sampler' | 'drum-rack'): value is AudioCoreSamplerState | AudioCoreDrumRackState =>
  isRecord(value)
  && hasOnlyKeys(value, ['version', 'kind', 'voiceCapacity', 'outputLayout', 'ampAttackMs', 'ampDecayMs', 'ampSustain', 'ampReleaseMs', 'filterEnabled', 'filterMode', 'filterCutoffHz', 'filterResonance', 'filterEnvelopeAmount', 'filterAttackMs', 'filterDecayMs', 'filterSustain', 'filterReleaseMs', 'lfoEnabled', 'lfoRateHz', 'lfoPitchCents', 'lfoFilterHz', 'lfoAmplitude', 'lfoPan', 'retrigger', 'zones'])
  && value.version === audioCoreContractVersion && value.kind === kind
  && isPositiveSafeInteger(value.voiceCapacity) && value.voiceCapacity <= audioCoreMaxInstrumentVoices
  && value.outputLayout === 'stereo'
  && isBoundedFloat(value.ampAttackMs, 0, 10000) && isBoundedFloat(value.ampDecayMs, 0, 10000)
  && isBoundedFloat(value.ampSustain, 0, 1) && isBoundedFloat(value.ampReleaseMs, 0, 10000)
  && typeof value.filterEnabled === 'boolean' && (value.filterMode === 'lowpass' || value.filterMode === 'highpass' || value.filterMode === 'bandpass' || value.filterMode === 'notch')
  && isBoundedFloat(value.filterCutoffHz, 20, 20000) && isBoundedFloat(value.filterResonance, 0.05, 30)
  && isBoundedFloat(value.filterEnvelopeAmount, -1, 1)
  && isBoundedFloat(value.filterAttackMs, 0, 60000)
  && isBoundedFloat(value.filterDecayMs, 0, 60000)
  && isBoundedFloat(value.filterSustain, 0, 1)
  && isBoundedFloat(value.filterReleaseMs, 0, 60000)
  && typeof value.lfoEnabled === 'boolean'
  && isBoundedFloat(value.lfoRateHz, 0.01, 100)
  && isBoundedFloat(value.lfoPitchCents, -2400, 2400)
  && isBoundedFloat(value.lfoFilterHz, -20000, 20000)
  && isBoundedFloat(value.lfoAmplitude, 0, 1)
  && isBoundedFloat(value.lfoPan, 0, 1)
  && typeof value.retrigger === 'boolean' && Array.isArray(value.zones) && value.zones.length > 0
  && value.zones.length <= audioCoreMaxSampleZones && value.zones.every((zone) => isAudioCoreSampleZone(zone, kind === 'drum-rack'))

export const isAudioCoreSamplerInstrumentState = (value: unknown): value is AudioCoreSamplerState =>
  isAudioCoreSamplerState(value, 'sampler')

export const isAudioCoreDrumRackState = (value: unknown): value is AudioCoreDrumRackState =>
  isAudioCoreSamplerState(value, 'drum-rack')

export type AudioCoreInstrumentState =
  | AudioCoreSynthState
  | AudioCoreSamplerState
  | AudioCoreDrumRackState
  | AudioCoreGranularState

export const isAudioCoreInstrumentState = (value: unknown): value is AudioCoreInstrumentState =>
  isAudioCoreSynthState(value)
  || isAudioCoreSamplerInstrumentState(value)
  || isAudioCoreDrumRackState(value)
  || isAudioCoreGranularState(value)

export type AudioCoreInstrumentBinaryState = {
  state: Uint8Array
  zones?: Uint8Array
}

export const encodeAudioCoreInstrumentState = (
  state: AudioCoreInstrumentState,
  resolveAssetHandle: (assetId: string) => bigint,
): AudioCoreInstrumentBinaryState => {
  if (!isAudioCoreInstrumentState(state)) throw new Error('Invalid audio-core instrument state.')
  if (state.kind === 'synth') {
    const oscillators = state.oscillators ?? [
      { enabled: true, waveform: 0, level: 0.5, octave: 0, semitone: 0, detuneCents: 0 },
      { enabled: true, waveform: 0, level: 0.5, octave: 0, semitone: 0, detuneCents: 0 },
    ]
    const output = new Uint8Array(156)
    const view = new DataView(output.buffer)
    view.setUint32(0, state.version, true)
    view.setUint32(4, 0xA341316C, true)
    view.setUint32(8, 1, true)
    view.setUint32(12, 2, true)
    oscillators.slice(0, 2).forEach((oscillator, index) => {
      const offset = 8 + index * 24
      view.setUint32(offset, oscillator.enabled ? 1 : 0, true)
      view.setUint32(offset + 4, oscillator.waveform, true)
      view.setFloat32(offset + 8, oscillator.level, true)
      view.setInt32(offset + 12, oscillator.octave, true)
      view.setInt32(offset + 16, oscillator.semitone, true)
      view.setFloat32(offset + 20, oscillator.detuneCents, true)
    })
    view.setUint32(56, state.noiseEnabled ? 1 : 0, true)
    view.setFloat32(60, state.noiseLevel ?? 0, true)
    view.setUint32(64, state.filterEnabled === false ? 0 : 1, true)
    view.setUint32(68, state.filterMode ?? 0, true)
    view.setFloat32(72, state.filterCutoffHz ?? 20_000, true)
    view.setFloat32(76, state.filterResonance ?? 0.707, true)
    view.setFloat32(80, state.filterKeyTracking ?? 0, true)
    view.setFloat32(84, state.filterEnvelopeAmountOctaves ?? 0, true)
    view.setFloat32(88, state.filterAttackMs ?? 1, true)
    view.setFloat32(92, state.filterDecayMs ?? 1, true)
    view.setFloat32(96, state.filterSustain ?? 1, true)
    view.setFloat32(100, state.filterReleaseMs ?? 10, true)
    view.setFloat32(104, state.ampAttackMs ?? 1, true)
    view.setFloat32(108, state.ampDecayMs ?? 1, true)
    view.setFloat32(112, state.ampSustain ?? 1, true)
    view.setFloat32(116, state.ampReleaseMs ?? 10, true)
    view.setUint32(120, state.lfoEnabled ? 1 : 0, true)
    view.setUint32(124, state.lfoWaveform ?? 0, true)
    view.setFloat32(128, state.lfoRateHz ?? 1, true)
    view.setFloat32(132, state.lfoPitchCents ?? 0, true)
    view.setFloat32(136, state.lfoFilterOctaves ?? 0, true)
    view.setFloat32(140, state.lfoAmplitude ?? 0, true)
    view.setFloat32(144, state.lfoPan ?? 0, true)
    view.setFloat32(148, state.outputGain ?? 1, true)
    view.setFloat32(152, state.outputPan ?? 0, true)
    return { state: output }
  }
  if (state.kind === 'granular') {
    const output = new Uint8Array(60)
    const view = new DataView(output.buffer)
    view.setUint32(0, state.version, true)
    view.setBigUint64(4, resolveAssetHandle(state.assetId), true)
    view.setUint32(12, state.seed, true)
    view.setUint32(16, state.maxGrains, true)
    view.setUint32(20, state.windowShape === 'hann' ? 0 : state.windowShape === 'tukey' ? 1 : 2, true)
    view.setUint32(24, state.freeze ? 1 : 0, true)
    const values = [state.grainSizeMs, state.densityHz, state.position, state.spray, state.pitchSemitones, state.reverseProbability, state.stereoSpread]
    values.forEach((value, index) => view.setFloat32(28 + index * 4, value, true))
    return { state: output }
  }
  const binaryState = new Uint8Array(88)
  const stateView = new DataView(binaryState.buffer)
  stateView.setUint32(0, state.version, true)
  stateView.setUint32(4, state.zones.length, true)
  ;[state.ampAttackMs, state.ampDecayMs, state.ampSustain, state.ampReleaseMs].forEach((value, index) => stateView.setFloat32(8 + index * 4, value, true))
  stateView.setUint32(24, state.filterEnabled ? 1 : 0, true)
  stateView.setUint32(28, state.filterMode === 'lowpass' ? 0 : state.filterMode === 'highpass' ? 1 : state.filterMode === 'bandpass' ? 2 : 3, true)
  stateView.setFloat32(32, state.filterCutoffHz, true)
  stateView.setFloat32(36, state.filterResonance, true)
  stateView.setFloat32(40, state.filterEnvelopeAmount, true)
  stateView.setFloat32(44, state.filterAttackMs, true)
  stateView.setFloat32(48, state.filterDecayMs, true)
  stateView.setFloat32(52, state.filterSustain, true)
  stateView.setFloat32(56, state.filterReleaseMs, true)
  stateView.setUint32(60, state.lfoEnabled ? 1 : 0, true)
  stateView.setFloat32(64, state.lfoRateHz, true)
  stateView.setFloat32(68, state.lfoPitchCents, true)
  stateView.setFloat32(72, state.lfoFilterHz, true)
  stateView.setFloat32(76, state.lfoAmplitude, true)
  stateView.setFloat32(80, state.lfoPan, true)
  stateView.setUint32(84, state.retrigger ? 1 : 0, true)
  const zones = new Uint8Array(state.zones.length * 80)
  const zoneView = new DataView(zones.buffer)
  state.zones.forEach((zone, index) => {
    const offset = index * 80
    zoneView.setBigUint64(offset, resolveAssetHandle(zone.assetId), true)
    const integers = [zone.keyLow, zone.keyHigh, zone.velocityLow, zone.velocityHigh, zone.rootNote]
    integers.forEach((value, integerIndex) => zoneView.setUint32(offset + 8 + integerIndex * 4, value, true))
    zoneView.setFloat32(offset + 28, zone.tuneCents, true)
    zoneView.setFloat32(offset + 32, zone.gain, true)
    zoneView.setFloat32(offset + 36, zone.pan, true)
    const tail = [zone.roundRobinGroup, zone.roundRobinIndex, zone.playbackMode === 'one-shot' ? 0 : zone.playbackMode === 'forward-loop' ? 1 : 2, zone.startFrame, zone.endFrame, zone.loopStartFrame, zone.loopEndFrame, zone.crossfadeFrameCount, zone.chokeGroup]
    tail.forEach((value, integerIndex) => zoneView.setUint32(offset + 40 + integerIndex * 4, value, true))
  })
  return { state: binaryState, zones }
}

export const isAudioCoreGranularState = (value: unknown): value is AudioCoreGranularState =>
  isRecord(value)
  && hasOnlyKeys(value, ['version', 'kind', 'voiceCapacity', 'outputLayout', 'assetId', 'seed', 'maxGrains', 'windowShape', 'freeze', 'grainSizeMs', 'densityHz', 'position', 'spray', 'pitchSemitones', 'reverseProbability', 'stereoSpread'])
  && value.version === audioCoreContractVersion
  && value.kind === 'granular'
  && typeof value.voiceCapacity === 'number' && Number.isSafeInteger(value.voiceCapacity) && value.voiceCapacity >= 1 && value.voiceCapacity <= audioCoreMaxInstrumentVoices
  && value.outputLayout === 'stereo'
  && typeof value.assetId === 'string' && value.assetId.length > 0
  && typeof value.seed === 'number' && Number.isSafeInteger(value.seed) && value.seed > 0 && value.seed <= 0xffffffff
  && typeof value.maxGrains === 'number' && Number.isSafeInteger(value.maxGrains) && value.maxGrains >= 1 && value.maxGrains <= audioCoreMaxGranularGrains
  && (value.windowShape === 'hann' || value.windowShape === 'tukey' || value.windowShape === 'gaussian')
  && typeof value.freeze === 'boolean'
  && isFiniteNumber(value.grainSizeMs) && value.grainSizeMs >= 5 && value.grainSizeMs <= 1000
  && isFiniteNumber(value.densityHz) && value.densityHz >= 0.25 && value.densityHz <= 200
  && isFiniteNumber(value.position) && value.position >= 0 && value.position <= 1
  && isFiniteNumber(value.spray) && value.spray >= 0 && value.spray <= 1
  && isFiniteNumber(value.pitchSemitones) && value.pitchSemitones >= -48 && value.pitchSemitones <= 48
  && isFiniteNumber(value.reverseProbability) && value.reverseProbability >= 0 && value.reverseProbability <= 1
  && isFiniteNumber(value.stereoSpread) && value.stereoSpread >= 0 && value.stereoSpread <= 1

const isAudioCoreSynthOscillator = (
  value: unknown,
): value is NonNullable<AudioCoreSynthState['oscillators']>[number] => (
  isRecord(value)
  && hasOnlyKeys(value, ['enabled', 'waveform', 'level', 'octave', 'semitone', 'detuneCents'])
  && typeof value.enabled === 'boolean'
  && typeof value.waveform === 'number' && [0, 1, 2, 3].includes(value.waveform)
  && isBoundedFloat(value.level, 0, 1)
  && typeof value.octave === 'number' && Number.isInteger(value.octave) && value.octave >= -8 && value.octave <= 8
  && typeof value.semitone === 'number' && Number.isInteger(value.semitone) && value.semitone >= -12 && value.semitone <= 12
  && isBoundedFloat(value.detuneCents, -100, 100)
)

export const isAudioCoreSynthState = (value: unknown): value is AudioCoreSynthState => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'version', 'kind', 'voiceCapacity', 'outputLayout', 'parameterTargets', 'oscillators',
    'noiseEnabled', 'noiseLevel', 'filterEnabled', 'filterMode', 'filterCutoffHz',
    'filterResonance', 'filterKeyTracking', 'filterEnvelopeAmountOctaves', 'filterAttackMs',
    'filterDecayMs', 'filterSustain', 'filterReleaseMs', 'ampAttackMs', 'ampDecayMs',
    'ampSustain', 'ampReleaseMs', 'lfoEnabled', 'lfoWaveform', 'lfoRateHz', 'lfoPitchCents',
    'lfoFilterOctaves', 'lfoAmplitude', 'lfoPan', 'outputGain', 'outputPan',
  ])) return false
  const complete = value.oscillators !== undefined
  const oscillators = value.oscillators
  if (value.version !== audioCoreContractVersion || value.kind !== 'synth'
    || typeof value.voiceCapacity !== 'number' || !Number.isSafeInteger(value.voiceCapacity)
    || value.voiceCapacity < 1 || value.voiceCapacity > audioCoreMaxInstrumentVoices
    || value.outputLayout !== 'stereo' || !Array.isArray(value.parameterTargets)
    || value.parameterTargets.length > audioCoreMaxInstrumentParameterTargets) return false
  if (complete && (
    !Array.isArray(value.oscillators) || value.oscillators.length !== 2
    || typeof value.noiseEnabled !== 'boolean' || !isFiniteNumber(value.noiseLevel)
    || typeof value.filterEnabled !== 'boolean' || typeof value.filterMode !== 'number' || ![0, 1, 2, 3].includes(value.filterMode)
    || !isBoundedFloat(value.filterCutoffHz, 20, 20_000)
    || !isBoundedFloat(value.filterResonance, 0.05, 30)
    || !isBoundedFloat(value.filterKeyTracking, -1, 1)
    || !isBoundedFloat(value.filterEnvelopeAmountOctaves, -8, 8)
    || !isBoundedFloat(value.filterAttackMs, 0, 10_000)
    || !isBoundedFloat(value.filterDecayMs, 0, 10_000)
    || !isBoundedFloat(value.filterSustain, 0, 1)
    || !isBoundedFloat(value.filterReleaseMs, 0, 10_000)
    || !isBoundedFloat(value.ampAttackMs, 0, 10_000)
    || !isBoundedFloat(value.ampDecayMs, 0, 10_000)
    || !isBoundedFloat(value.ampSustain, 0, 1)
    || !isBoundedFloat(value.ampReleaseMs, 0, 60_000)
    || typeof value.lfoEnabled !== 'boolean'
    || typeof value.lfoWaveform !== 'number' || ![0, 1, 2, 3].includes(value.lfoWaveform)
    || !isBoundedFloat(value.lfoRateHz, 0, 1_000)
    || !isBoundedFloat(value.lfoPitchCents, -4_800, 4_800)
    || !isBoundedFloat(value.lfoFilterOctaves, -8, 8)
    || !isBoundedFloat(value.lfoAmplitude, -1, 1)
    || !isBoundedFloat(value.lfoPan, -1, 1)
    || !isBoundedFloat(value.outputGain, 0, 2)
    || !isBoundedFloat(value.outputPan, -1, 1))) return false
  if (complete && Array.isArray(oscillators) && !oscillators.every((oscillator) => (
    isAudioCoreSynthOscillator(oscillator)
  ))) return false
  const ids = new Set<string>()
  const targets = new Set<number>()
  return value.parameterTargets.every((parameter) => {
    if (!isRecord(parameter) || typeof parameter.id !== 'string' || !isPositiveSafeInteger(parameter.target)
      || ids.has(parameter.id) || targets.has(parameter.target)) return false
    const entry = synthParameterRegistry.find((candidate) => candidate.id === parameter.id && candidate.target === parameter.target)
    if (entry === undefined || entry.tombstone) return false
    ids.add(parameter.id)
    targets.add(parameter.target)
    return true
  })
}

/**
 * Versioned, portable graph metadata. Processor latency is declared by the
 * TypeScript routing authority during projection; backends consume this value
 * and never infer project effect timing themselves.
 */
export type AudioCoreGraphProcessorDto = {
  /** Stable control-plane identity; the audio ABI only consumes its mapping. */
  id: string
  /** Generated processor kind, never a user-facing display name. */
  kind: string
  /** Stable generated numeric kind id consumed by native and Wasm ABIs. */
  kindId: number
  instanceId: number
  stateVersion: typeof audioCoreContractVersion
  /** Bounded canonical state payload; no JSON is decoded on the render path. */
  state: Uint8Array
  parameterTargets: readonly AudioCoreProcessorParameterTarget[]
  latencyFrames: number
  tailFrames: number
  /** Explicit continuation semantics; omitted means the legacy finite form. */
  tailKind?: 'finite' | 'unbounded'
  bypassed: boolean
}

export type AudioCoreProcessorParameterTarget = {
  id: string
  target: number
}

export const audioCoreMaxProcessorsPerNode = 8
export const audioCoreMaxProcessorStateBytes = 256
export const audioCoreMaxProcessorParameterTargets = 24
export const audioCoreProcessorStateEnvelopeBytes = 40

export type AudioCoreProcessorStateEnvelope = {
  kindId: number
  schemaVersion: number
  state: Uint8Array
  instanceId: number
  bypassed: boolean
  inputLayout: AudioCoreGraphLayout
  outputLayout: AudioCoreGraphLayout
  latencyFrames: number
  tailFrames: number
  parameterTargets: readonly AudioCoreProcessorParameterTarget[]
}

export const encodeAudioCoreProcessorStateEnvelope = (envelope: AudioCoreProcessorStateEnvelope): Uint8Array => {
  if (!isAudioCoreProcessorStateEnvelope(envelope)) throw new Error('Invalid audio-core processor state envelope.')
  const output = new Uint8Array(audioCoreProcessorStateEnvelopeBytes + envelope.state.byteLength + envelope.parameterTargets.length * 4)
  const view = new DataView(output.buffer)
  view.setUint32(0, envelope.kindId, true)
  view.setUint32(4, envelope.schemaVersion, true)
  view.setUint32(8, envelope.state.byteLength, true)
  view.setUint32(12, envelope.instanceId, true)
  view.setUint32(16, envelope.bypassed ? 1 : 0, true)
  view.setUint32(20, envelope.inputLayout === 'mono' ? 1 : 2, true)
  view.setUint32(24, envelope.outputLayout === 'mono' ? 1 : 2, true)
  view.setUint32(28, envelope.parameterTargets.length, true)
  view.setUint32(32, envelope.latencyFrames, true)
  view.setUint32(36, envelope.tailFrames, true)
  output.set(envelope.state, audioCoreProcessorStateEnvelopeBytes)
  envelope.parameterTargets.forEach((target, index) => view.setUint32(audioCoreProcessorStateEnvelopeBytes + envelope.state.byteLength + index * 4, target.target, true))
  return output
}

export const decodeAudioCoreProcessorStateEnvelope = (input: Uint8Array): AudioCoreProcessorStateEnvelope => {
  if (input.byteLength < audioCoreProcessorStateEnvelopeBytes) throw new Error('Audio-core processor state envelope is truncated.')
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const stateBytes = view.getUint32(8, true)
  const parameterCount = view.getUint32(28, true)
  if (stateBytes > audioCoreMaxProcessorStateBytes || parameterCount > audioCoreMaxProcessorParameterTargets
    || input.byteLength !== audioCoreProcessorStateEnvelopeBytes + stateBytes + parameterCount * 4) throw new Error('Audio-core processor state envelope has invalid bounds.')
  const envelope: AudioCoreProcessorStateEnvelope = {
    kindId: view.getUint32(0, true),
    schemaVersion: view.getUint32(4, true),
    state: input.slice(audioCoreProcessorStateEnvelopeBytes, audioCoreProcessorStateEnvelopeBytes + stateBytes),
    instanceId: view.getUint32(12, true),
    bypassed: view.getUint32(16, true) === 1,
    inputLayout: view.getUint32(20, true) === 1 ? 'mono' : 'stereo',
    outputLayout: view.getUint32(24, true) === 1 ? 'mono' : 'stereo',
    latencyFrames: view.getUint32(32, true),
    tailFrames: view.getUint32(36, true),
    parameterTargets: Array.from({ length: parameterCount }, (_, index) => ({
      id: '',
      target: view.getUint32(audioCoreProcessorStateEnvelopeBytes + stateBytes + index * 4, true),
    })),
  }
  if (!isAudioCoreProcessorStateEnvelope(envelope)) throw new Error('Audio-core processor state envelope is invalid.')
  return envelope
}

export const encodeUtilityProcessorState = (state: UtilityProcessorState): Uint8Array => {
  const output = new Uint8Array(40)
  const view = new DataView(output.buffer)
  view.setUint32(0, state.enabled ? 1 : 0, true)
  view.setFloat32(4, state.gainDb, true)
  view.setUint32(8, state.polarity === 'invert' ? 1 : 0, true)
  view.setUint32(12, state.inputMode === 'mono-sum' ? 1 : 0, true)
  view.setFloat32(16, state.pan, true)
  view.setFloat32(20, state.balance, true)
  view.setFloat32(24, state.width, true)
  view.setUint32(28, state.matrix === 'mid-side-encode' ? 1 : state.matrix === 'mid-side-decode' ? 2 : 0, true)
  view.setUint32(32, state.swap ? 1 : 0, true)
  view.setUint32(36, state.dcBlock ? 1 : 0, true)
  return output
}

export const encodeAutoFilterProcessorState = (state: AutoFilterProcessorState): Uint8Array => {
  const output = new Uint8Array(60)
  const view = new DataView(output.buffer)
  view.setUint32(0, state.enabled ? 1 : 0, true)
  view.setUint32(4, state.mode === 'highpass' ? 1 : state.mode === 'bandpass' ? 2 : state.mode === 'notch' ? 3 : state.mode === 'peak' ? 4 : 0, true)
  view.setUint32(8, 0, true)
  view.setFloat32(12, state.frequencyHz, true)
  view.setFloat32(16, state.resonance, true)
  view.setFloat32(20, state.driveDb, true)
  view.setFloat32(24, state.mix, true)
  view.setFloat32(28, state.envelope.amountOctaves, true)
  view.setFloat32(32, state.envelope.attackMs, true)
  view.setFloat32(36, state.envelope.releaseMs, true)
  view.setUint32(40, state.lfo.waveform === 'triangle' ? 1 : 0, true)
  view.setFloat32(44, state.lfo.rateHz, true)
  view.setFloat32(48, state.lfo.depthOctaves, true)
  view.setFloat32(52, state.lfo.phaseOffset, true)
  view.setFloat32(56, state.lfo.stereoPhase, true)
  return output
}

export const encodeLoFiProcessorState = (state: LoFiProcessorState): Uint8Array => {
  const output = new Uint8Array(36)
  const view = new DataView(output.buffer)
  view.setUint32(0, state.enabled ? 1 : 0, true)
  view.setUint32(4, Math.round(state.bitDepth), true)
  view.setFloat32(8, state.sampleRateRatio, true)
  view.setFloat32(12, state.jitter, true)
  view.setFloat32(16, state.noiseDb, true)
  view.setUint32(20, state.quantization === 'floor' ? 1 : state.quantization === 'truncate' ? 2 : 0, true)
  view.setUint32(24, state.dither === 'rectangular' ? 1 : state.dither === 'triangular' ? 2 : 0, true)
  view.setFloat32(28, state.mix, true)
  view.setUint32(32, Math.max(1, Math.round(state.seed)) >>> 0, true)
  return output
}

export const encodeSaturatorProcessorState = (state: SaturatorProcessorState): Uint8Array => {
  const output = new Uint8Array(32)
  const view = new DataView(output.buffer)
  view.setUint32(0, state.enabled ? 1 : 0, true)
  view.setFloat32(4, state.driveDb, true)
  view.setUint32(8, state.curve === 'medium' ? 1 : state.curve === 'hard' ? 2 : state.curve === 'clip' ? 3 : 0, true)
  view.setUint32(12, state.color ? 1 : 0, true)
  view.setFloat32(16, state.colorFrequencyHz, true)
  view.setFloat32(20, state.colorAmount, true)
  view.setFloat32(24, state.outputDb, true)
  view.setFloat32(28, state.dryWet, true)
  return output
}

export const encodeEqProcessorState = (state: EqProcessorState): Uint8Array => {
  if (state.bands.length !== 8) throw new Error('Portable EQ requires exactly eight bands.')
  const output = new Uint8Array(200)
  const view = new DataView(output.buffer)
  view.setUint32(0, state.enabled ? 1 : 0, true)
  view.setUint32(4, state.channelMode === 'mono' ? 1 : 0, true)
  state.bands.forEach((band, index) => {
    const offset = 8 + index * 24
    view.setUint32(offset, band.enabled ? 1 : 0, true)
    view.setUint32(offset + 4, eqBandTypeId(band.type), true)
    view.setFloat32(offset + 8, band.frequency, true)
    view.setFloat32(offset + 12, band.gainDb, true)
    view.setFloat32(offset + 16, band.q, true)
  })
  return output
}

const encodeDelayModulationProcessorState = (state: DelayModulationProcessorState): Uint8Array => {
  const output = new Uint8Array(28)
  const view = new DataView(output.buffer)
  view.setUint32(0, state.enabled ? 1 : 0, true)
  view.setFloat32(4, state.delayMs, true)
  view.setFloat32(8, state.depthMs, true)
  view.setFloat32(12, state.rateHz, true)
  view.setFloat32(16, state.feedback, true)
  view.setFloat32(20, state.stereoPhase, true)
  view.setFloat32(24, state.mix, true)
  return output
}

export const encodeChorusProcessorState = encodeDelayModulationProcessorState
export const encodeFlangerProcessorState = encodeDelayModulationProcessorState

export const encodePhaserProcessorState = (state: PhaserProcessorState): Uint8Array => {
  const output = new Uint8Array(32)
  const view = new DataView(output.buffer)
  view.setUint32(0, state.enabled ? 1 : 0, true)
  view.setUint32(4, state.stages, true)
  view.setFloat32(8, state.centerHz, true)
  view.setFloat32(12, state.depthOctaves, true)
  view.setFloat32(16, state.rateHz, true)
  view.setFloat32(20, state.feedback, true)
  view.setFloat32(24, state.stereoPhase, true)
  view.setFloat32(28, state.mix, true)
  return output
}

const encodeAmplitudeModulationProcessorState = (state: AmplitudeModulationProcessorState): Uint8Array => {
  const output = new Uint8Array(24)
  const view = new DataView(output.buffer)
  view.setUint32(0, state.enabled ? 1 : 0, true)
  view.setUint32(4, state.waveform === 'triangle' ? 1 : 0, true)
  view.setFloat32(8, state.rateHz, true)
  view.setFloat32(12, state.depth, true)
  view.setFloat32(16, state.shape, true)
  view.setFloat32(20, state.phase, true)
  return output
}

export const encodeTremoloProcessorState = encodeAmplitudeModulationProcessorState
export const encodeAutoPanProcessorState = encodeAmplitudeModulationProcessorState

export const encodeEnsembleProcessorState = (state: EnsembleProcessorState): Uint8Array => {
  const output = new Uint8Array(28)
  const view = new DataView(output.buffer)
  view.setUint32(0, state.enabled ? 1 : 0, true)
  view.setUint32(4, state.voices, true)
  view.setFloat32(8, state.delayMs, true)
  view.setFloat32(12, state.depthMs, true)
  view.setFloat32(16, state.rateHz, true)
  view.setFloat32(20, state.spread, true)
  view.setFloat32(24, state.mix, true)
  return output
}

export const encodeGateProcessorState = (state: GateProcessorState): Uint8Array => {
  const output = new Uint8Array(60)
  const view = new DataView(output.buffer)
  view.setUint32(0, state.enabled ? 1 : 0, true)
  view.setUint32(4, state.mode === 'expander' ? 1 : 0, true)
  view.setFloat32(8, state.thresholdDb, true)
  view.setFloat32(12, state.ratio, true)
  view.setFloat32(16, state.attackMs, true)
  view.setFloat32(20, state.holdMs, true)
  view.setFloat32(24, state.releaseMs, true)
  view.setFloat32(28, state.hysteresisDb, true)
  view.setFloat32(32, state.rangeDb, true)
  view.setFloat32(36, state.lookaheadMs, true)
  view.setUint32(40, state.detector === 'rms' ? 1 : 0, true)
  view.setFloat32(44, state.link, true)
  view.setUint32(48, state.sidechain.enabled ? 1 : 0, true)
  view.setFloat32(52, state.sidechain.frequencyHz, true)
  view.setFloat32(56, state.sidechain.q, true)
  return output
}

export const encodeCompressorProcessorState = (state: CompressorProcessorState): Uint8Array => {
  const output = new Uint8Array(72)
  const view = new DataView(output.buffer)
  view.setUint32(0, state.enabled ? 1 : 0, true)
  view.setFloat32(4, state.thresholdDb, true)
  view.setFloat32(8, state.ratio, true)
  view.setFloat32(12, state.attackMs, true)
  view.setFloat32(16, state.releaseMs, true)
  view.setUint32(20, state.autoRelease ? 1 : 0, true)
  view.setFloat32(24, state.makeupDb, true)
  view.setFloat32(28, state.outputDb, true)
  view.setFloat32(32, state.dryWet, true)
  view.setFloat32(36, state.kneeDb, true)
  view.setFloat32(40, state.lookaheadMs, true)
  view.setUint32(44, state.detectorMode === 'rms' ? 1 : 0, true)
  view.setUint32(48, state.dynamicsMode === 'expand' ? 1 : 0, true)
  view.setUint32(52, state.envelopeCurve === 'linear' ? 1 : 0, true)
  view.setUint32(56, state.sidechain.enabled ? 1 : 0, true)
  view.setUint32(60, state.sidechain.filterType === 'lowpass' ? 1 : state.sidechain.filterType === 'bandpass' ? 2 : 0, true)
  view.setFloat32(64, state.sidechain.frequencyHz, true)
  view.setFloat32(68, state.sidechain.q, true)
  return output
}

export const encodeLimiterProcessorState = (state: LimiterProcessorState): Uint8Array => {
  const output = new Uint8Array(24)
  const view = new DataView(output.buffer)
  view.setUint32(0, state.enabled ? 1 : 0, true)
  view.setFloat32(4, state.ceilingDbtp, true)
  view.setFloat32(8, state.releaseMs, true)
  view.setFloat32(12, state.lookaheadMs, true)
  view.setFloat32(16, state.link, true)
  view.setUint32(20, state.detectorOversampling, true)
  return output
}

export const encodeDelayProcessorState = (state: DelayProcessorState): Uint8Array => {
  const output = new Uint8Array(32)
  const view = new DataView(output.buffer)
  view.setUint32(0, state.enabled ? 1 : 0, true)
  view.setFloat32(4, state.delayMs, true)
  view.setFloat32(8, state.feedback, true)
  view.setFloat32(12, state.dryWet, true)
  view.setUint32(16, state.pingPong ? 1 : 0, true)
  view.setUint32(20, state.filterEnabled ? 1 : 0, true)
  view.setFloat32(24, state.lowCutHz, true)
  view.setFloat32(28, state.highCutHz, true)
  return output
}

export const encodeReverbProcessorState = (state: ReverbProcessorState): Uint8Array => {
  const output = new Uint8Array(72)
  const view = new DataView(output.buffer)
  view.setUint32(0, state.enabled ? 1 : 0, true)
  view.setFloat32(4, state.wet, true)
  view.setFloat32(8, state.decaySec, true)
  view.setFloat32(12, state.preDelayMs, true)
  view.setFloat32(16, state.reflections, true)
  view.setUint32(20, state.reflectionSpin ? 1 : 0, true)
  view.setFloat32(24, state.reflectionModAmountMs, true)
  view.setFloat32(28, state.reflectionModRateHz, true)
  view.setFloat32(32, state.reflectionShape, true)
  view.setFloat32(36, state.diffuse, true)
  view.setFloat32(40, state.size, true)
  view.setFloat32(44, state.diffusion, true)
  view.setFloat32(48, state.density, true)
  view.setFloat32(52, state.lowCutHz, true)
  view.setFloat32(56, state.highCutHz, true)
  view.setFloat32(60, state.diffusionLowCutHz, true)
  view.setFloat32(64, state.diffusionHighCutHz, true)
  view.setFloat32(68, state.stereoWidth, true)
  return output
}

export const encodeSpectralProcessorState = (state: SpectralProcessorState): Uint8Array => {
  const output = new Uint8Array(60)
  const view = new DataView(output.buffer)
  view.setUint32(0, state.enabled ? 1 : 0, true)
  view.setUint32(4, state.fftSize, true)
  view.setUint32(8, state.overlap, true)
  view.setUint32(12, state.mode === 'gate' ? 1 : state.mode === 'morph' ? 2 : state.mode === 'shift-blur' ? 3 : state.mode === 'hpss' ? 4 : state.mode === 'noise-reduce' ? 5 : 0, true)
  view.setFloat32(16, state.freeze, true)
  view.setFloat32(20, state.gateThresholdDb, true)
  view.setFloat32(24, state.gateAttackMs, true)
  view.setFloat32(28, state.gateReleaseMs, true)
  view.setFloat32(32, state.morph, true)
  view.setFloat32(36, state.binShift, true)
  view.setFloat32(40, state.blur, true)
  view.setFloat32(44, state.harmonicPercussiveBalance, true)
  view.setFloat32(48, state.noiseReduction, true)
  view.setFloat32(52, state.profileLearn, true)
  view.setFloat32(56, state.mix, true)
  return output
}

export type AudioCoreGraphTopologyNodeDto = {
  id: string
  kind: AudioCoreGraphNodeKind
  inputLayout: AudioCoreGraphLayout
  outputLayout: AudioCoreGraphLayout
  processorOrder: readonly AudioCoreGraphProcessorDto[]
  /** Native-only external hook latency; built-in processor latency stays separate. */
  externalLatencyFrames?: number
  latencyFrames: number
  assetId?: string
  instrument?: AudioCoreInstrumentState
  mixer?: AudioCoreMixerState
}

export type AudioCoreGraphEdgeDto = {
  version: typeof audioCoreContractVersion
  id: string
  fromNodeId: string
  toNodeId: string
  gain: number
  kind: 'output' | 'send'
  tap: AudioCoreGraphTap
  sidechain: boolean
  targetProcessorId?: string
  pdcDelayFrames: number
}

export type AudioCoreGraphSnapshot = {
  version: typeof audioCoreContractVersion
  revision: number
  contractHash: string
  nodes: readonly AudioCoreGraphTopologyNodeDto[]
  edges: readonly AudioCoreGraphEdgeDto[]
  masterNodeId: string
  assets: readonly AudioAssetRef[]
}

/** @deprecated Use AudioCoreGraphSnapshot for routable portable graphs. */
export type AudioCoreGraphDto = AudioCoreGraphSnapshot

export type AudioCoreEventDto = {
  version: typeof audioCoreContractVersion
  frameOffset: number
  type: 'note-on' | 'note-off' | 'parameter'
  targetNodeId: string
  data: readonly number[]
}

export type AudioCoreSampleSourceEventDto = {
  version: typeof audioCoreContractVersion
  epoch: number
  sequence: number
  sourceNodeId: string
  assetId: string
  startFrame: number
  stopFrame: number
  sourceOffsetFrame: number
  sourceOffsetFraction?: number
  sourceFrameCount: number
  gain: number
  fadeInStartFrame: number
  fadeInEndFrame: number
  fadeOutStartFrame: number
  fadeOutEndFrame: number
  fadeInCurve?: number
  fadeInCurvePosition?: number
  fadeOutCurve?: number
  fadeOutCurvePosition?: number
}

export type AudioCoreAssetDto = {
  version: typeof audioCoreContractVersion
  id: string
  revision: number
  contentHash: string
  byteLength: number
  format: 'pcm-f32-planar' | 'opaque'
}

/**
 * A portable identity for decoded audio. It intentionally excludes every
 * runtime-specific representation (URLs, paths, browser buffers, Wasm
 * pointers, and native handles).
 */
export type AudioAssetRef = {
  version: typeof audioCoreContractVersion
  assetId: string
  frameCount: number
  sampleRateHz: number
  channelCount: number
}

export type PlanarPcm = {
  frameCount: number
  planes: readonly Float32Array[]
}

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export const isAudioAssetRef = (value: unknown): value is AudioAssetRef =>
  isRecord(value)
  && hasOnlyKeys(value, ['version', 'assetId', 'frameCount', 'sampleRateHz', 'channelCount'])
  && value.version === audioCoreContractVersion
  && typeof value.assetId === 'string'
  && value.assetId.length > 0
  && isPositiveSafeInteger(value.frameCount)
  && isPositiveSafeInteger(value.sampleRateHz)
  && isPositiveSafeInteger(value.channelCount)

export const isPlanarPcmForAsset = (
  asset: AudioAssetRef,
  pcm: PlanarPcm,
): boolean => (
  pcm.frameCount === asset.frameCount
  && pcm.planes.length === asset.channelCount
  && pcm.planes.every((plane) => plane instanceof Float32Array && plane.length === asset.frameCount)
)

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnlyKeys = (value: JsonRecord, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key))

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const eqBandTypeId = (type: EqProcessorBandState['type']) =>
  type === 'highpass' ? 1
    : type === 'bandpass' ? 2
      : type === 'lowshelf' ? 3
        : type === 'highshelf' ? 4
          : type === 'peaking' ? 5
            : type === 'notch' ? 6
              : type === 'allpass' ? 7
                : 0

const isUtilityState = (value: unknown): value is UtilityProcessorState => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['enabled', 'gainDb', 'polarity', 'inputMode', 'pan', 'balance', 'width', 'matrix', 'swap', 'dcBlock'])) return false
  return typeof value.enabled === 'boolean'
    && isFiniteNumber(value.gainDb)
    && (value.polarity === 'normal' || value.polarity === 'invert')
    && (value.inputMode === 'stereo' || value.inputMode === 'mono-sum')
    && isFiniteNumber(value.pan)
    && isFiniteNumber(value.balance)
    && isFiniteNumber(value.width)
    && (value.matrix === 'stereo' || value.matrix === 'mid-side-encode' || value.matrix === 'mid-side-decode')
    && typeof value.swap === 'boolean'
    && typeof value.dcBlock === 'boolean'
}

export const isUtilityProcessorContract = (value: unknown): value is UtilityProcessorContract =>
  isRecord(value)
  && hasOnlyKeys(value, ['version', 'kind', 'state'])
  && value.version === audioCoreContractVersion
  && value.kind === 'utility'
  && isUtilityState(value.state)

export const parseUtilityProcessorContract = (value: unknown): UtilityProcessorContract => {
  if (!isUtilityProcessorContract(value)) throw new Error('Invalid audio-core utility processor contract.')
  return value
}

export const isAudioCoreGraphProcessor = (value: unknown): value is AudioCoreGraphProcessorDto => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'kind', 'kindId', 'instanceId', 'stateVersion', 'state', 'parameterTargets', 'latencyFrames', 'tailFrames', 'tailKind', 'bypassed'])) return false
  const registryEntry = processorRegistry.find((entry) => entry.name === value.kind && entry.id === value.kindId)
  return typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.kind === 'string'
    && registryEntry !== undefined
    && !registryEntry.tombstone
    && Number.isSafeInteger(value.kindId)
    && isPositiveSafeInteger(value.instanceId)
    && value.stateVersion === audioCoreContractVersion
    && value.state instanceof Uint8Array
    && value.state.byteLength === registryEntry.stateBytes
    && value.stateVersion === registryEntry.schemaVersion
    && value.state.byteLength <= audioCoreMaxProcessorStateBytes
    && Array.isArray(value.parameterTargets)
    && value.parameterTargets.length <= audioCoreMaxProcessorParameterTargets
    && value.parameterTargets.every((target) => isRecord(target)
      && typeof target.id === 'string'
      && (registryEntry.parameters.length === 0
        ? target.id.startsWith(`${registryEntry.name}.`)
        : registryEntry.parameters.some((parameter) => `${registryEntry.name}.${parameter.id}` === target.id))
      && isPositiveSafeInteger(target.target))
    && typeof value.latencyFrames === 'number'
    && Number.isSafeInteger(value.latencyFrames)
    && value.latencyFrames >= 0
    && typeof value.tailFrames === 'number'
    && Number.isSafeInteger(value.tailFrames)
    && value.tailFrames >= 0
    && (value.tailKind === undefined || value.tailKind === 'finite' || value.tailKind === 'unbounded')
    && typeof value.bypassed === 'boolean'
}

export const isAudioCoreProcessorStateEnvelope = (value: unknown): value is AudioCoreProcessorStateEnvelope =>
  isRecord(value)
  && typeof value.kindId === 'number'
  && Number.isSafeInteger(value.kindId)
  && value.kindId > 0
  && typeof value.schemaVersion === 'number'
  && Number.isSafeInteger(value.schemaVersion)
  && value.schemaVersion > 0
  && value.state instanceof Uint8Array
  && value.state.byteLength <= audioCoreMaxProcessorStateBytes
  && isPositiveSafeInteger(value.instanceId)
  && typeof value.bypassed === 'boolean'
  && (value.inputLayout === 'mono' || value.inputLayout === 'stereo')
  && (value.outputLayout === 'mono' || value.outputLayout === 'stereo')
  && typeof value.latencyFrames === 'number'
  && Number.isSafeInteger(value.latencyFrames)
  && value.latencyFrames >= 0
  && typeof value.tailFrames === 'number'
  && Number.isSafeInteger(value.tailFrames)
  && value.tailFrames >= 0
  && Array.isArray(value.parameterTargets)
  && value.parameterTargets.length <= audioCoreMaxProcessorParameterTargets
  && value.parameterTargets.every((target) => typeof target.id === 'string' && isPositiveSafeInteger(target.target))

export type AudioCoreWireEnvelope = {
  version: typeof audioCoreContractVersion
  payload: string
}

const wireHeaderBytes = 5

export const encodeAudioCoreWireEnvelope = (payload: string): Uint8Array => {
  const payloadBytes = new TextEncoder().encode(payload)
  const output = new Uint8Array(wireHeaderBytes + payloadBytes.byteLength)
  output[0] = audioCoreContractVersion
  new DataView(output.buffer).setUint32(1, payloadBytes.byteLength, true)
  output.set(payloadBytes, wireHeaderBytes)
  return output
}

export const decodeAudioCoreWireEnvelope = (input: Uint8Array): AudioCoreWireEnvelope => {
  if (input.byteLength < wireHeaderBytes) throw new Error('Audio-core wire envelope is truncated.')
  if (input[0] !== audioCoreContractVersion) throw new Error('Audio-core wire envelope has an unsupported version.')
  const payloadBytes = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(1, true)
  if (payloadBytes !== input.byteLength - wireHeaderBytes) throw new Error('Audio-core wire envelope has an invalid payload length.')
  return { version: audioCoreContractVersion, payload: new TextDecoder().decode(input.subarray(wireHeaderBytes)) }
}
