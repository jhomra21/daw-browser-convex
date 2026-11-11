import { createEqBandParameterId, normalizeDelayParams, normalizeReverbParams, parseJsonValue, type EqParams } from '@daw-browser/shared'
import { createAudioEffectParameterPayload } from '~/components/timeline/audio-effect-parameter-payload'
import type { EffectTimingInput } from '@daw-browser/audio-engine/effects/timing'
import type { EffectParamsCommitPayload } from '~/lib/undo/types'
import type { LiveProcessorEditIdentity, ProcessorTiming } from '~/lib/live-processor-control'
import {
  encodeAutoFilterProcessorState,
  encodeAutoPanProcessorState,
  encodeChorusProcessorState,
  encodeCompressorProcessorState,
  encodeDelayProcessorState,
  encodeEnsembleProcessorState,
  encodeEqProcessorState,
  encodeFlangerProcessorState,
  encodeGateProcessorState,
  encodeLimiterProcessorState,
  encodeLoFiProcessorState,
  encodePhaserProcessorState,
  encodeReverbProcessorState,
  encodeSaturatorProcessorState,
  encodeSpectralProcessorState,
  encodeTremoloProcessorState,
  encodeUtilityProcessorState,
} from '@daw-browser/audio-core-contract'
import { resolvePortableDelayMs, compilePortableSynthState } from '@daw-browser/audio-engine/mixer/graph-contract'

export type NativeBuiltInParameterValue = {
  parameterId: string
  value: number
}

export type NativeBuiltInParameterCommit = {
  instanceId: string
  values: NativeBuiltInParameterValue[]
  edit?: LiveProcessorEditIdentity
}

// Dispatches can explicitly re-send touched fields even when from/to are equal.
export type NativeBuiltInParameterPayload = EffectParamsCommitPayload & {
  parameterIds?: ReadonlySet<string>
  edit?: LiveProcessorEditIdentity
}

export type NativeBuiltInStateCommit = {
  instanceId: string
  state: Uint8Array
}

const nativeBuiltInTimingInput = (payload: EffectParamsCommitPayload): EffectTimingInput | undefined => {
  const id = payload.instanceId ?? payload.effect
  switch (payload.effect) {
    case 'utility':
    case 'master-utility':
      return { id, kind: 'utility', params: payload.to }
    case 'autofilter':
    case 'master-autofilter':
      return { id, kind: 'autofilter', params: payload.to }
    case 'lofi':
    case 'master-lofi':
      return { id, kind: 'lofi', params: payload.to }
    case 'eq':
    case 'master-eq':
      return { kind: 'eq', params: payload.to }
    case 'gate':
    case 'master-gate':
      return { id, kind: 'gate', params: payload.to }
    case 'compressor':
    case 'master-compressor':
      return { kind: 'compressor', params: payload.to }
    case 'saturator':
    case 'master-saturator':
      return { kind: 'saturator', params: payload.to }
    case 'limiter':
    case 'master-limiter':
      return { id, kind: 'limiter', params: payload.to }
    case 'delay':
    case 'master-delay':
      return { kind: 'delay', params: normalizeDelayParams(payload.to) }
    case 'reverb':
    case 'master-reverb':
      return { kind: 'reverb', params: normalizeReverbParams(payload.to) }
    case 'chorus':
    case 'master-chorus':
      return { id, kind: 'chorus', params: payload.to }
    case 'flanger':
    case 'master-flanger':
      return { id, kind: 'flanger', params: payload.to }
    case 'phaser':
    case 'master-phaser':
      return { id, kind: 'phaser', params: payload.to }
    case 'tremolo':
    case 'master-tremolo':
      return { id, kind: 'tremolo', params: payload.to }
    case 'autopan':
    case 'master-autopan':
      return { id, kind: 'autopan', params: payload.to }
    case 'ensemble':
    case 'master-ensemble':
      return { id, kind: 'ensemble', params: payload.to }
    case 'spectral':
    case 'master-spectral':
      return { id, kind: 'spectral', params: payload.to }
    case 'synth':
    case 'instrument':
    case 'arp':
      return undefined
  }
}

export const enabledValue = (payload: EffectParamsCommitPayload, direction: 'from' | 'to') => {
  if (payload.effect === 'synth' || payload.effect === 'instrument' || payload.effect === 'arp') {
    return undefined
  }
  const value = payload[direction]
  const state = 'state' in value ? value.state : value
  return state.enabled
}

// Captured with an edit: its parameters are only typed where the payload is.
export const nativeBuiltInPatchTiming = (payload: EffectParamsCommitPayload): ProcessorTiming | undefined => {
  const input = nativeBuiltInTimingInput(payload)
  return input && { enabled: enabledValue(payload, 'to'), input }
}

type ChangedValue = number | boolean
type ParameterField = {
  parameterId: string
  from: ChangedValue
  to: ChangedValue
}
type StructuralField = {
  from: ChangedValue | string
  to: ChangedValue | string
}

const same = (from: ChangedValue | string, to: ChangedValue | string) => Object.is(from, to)
const numeric = (value: ChangedValue) => Number(value)

const mapFields = (
  supported: readonly ParameterField[],
  unsupported: readonly StructuralField[],
) => {
  if (unsupported.some((field) => !same(field.from, field.to))) return undefined
  return supported
}

const instanceIdOf = (payload: EffectParamsCommitPayload) =>
  payload.effect === 'instrument' ? payload.to.instanceId
    : payload.instanceId && payload.instanceId.length > 0 ? payload.instanceId : undefined

const mapInstrument = (payload: EffectParamsCommitPayload<'instrument'>) => {
  if (payload.from.kind !== 'synth' || payload.to.kind !== 'synth'
    || payload.from.instanceId !== payload.to.instanceId) return undefined
  if (payload.from.params.retrigger !== payload.to.params.retrigger
    || payload.from.params.polyphony !== payload.to.params.polyphony) return undefined
  // Compilation normalizes every live target to SYNTH_PARAMETER_LIMITS,
  // matching native set_synth_parameter, including cutoff >= 20 and Q > 0.
  const {
    outputGain: fromGain, outputPan: fromPan, filterCutoffHz: fromCutoff, filterResonance: fromResonance,
    ampAttackMs: fromAttack, ampDecayMs: fromDecay, ampSustain: fromSustain, ampReleaseMs: fromRelease,
    ...fromState
  } = compilePortableSynthState(payload.from.params)
  const {
    outputGain: toGain, outputPan: toPan, filterCutoffHz: toCutoff, filterResonance: toResonance,
    ampAttackMs: toAttack, ampDecayMs: toDecay, ampSustain: toSustain, ampReleaseMs: toRelease,
    ...toState
  } = compilePortableSynthState(payload.to.params)
  if (JSON.stringify(fromState) !== JSON.stringify(toState)) return undefined
  return [
    { parameterId: 'synth.outputGain', from: fromGain ?? 1, to: toGain ?? 1 },
    { parameterId: 'synth.outputPan', from: fromPan ?? 0, to: toPan ?? 0 },
    { parameterId: 'synth.filterCutoffHz', from: fromCutoff ?? 20_000, to: toCutoff ?? 20_000 },
    { parameterId: 'synth.filterResonance', from: fromResonance ?? 0.7, to: toResonance ?? 0.7 },
    { parameterId: 'synth.ampAttackMs', from: fromAttack ?? 0, to: toAttack ?? 0 },
    { parameterId: 'synth.ampDecayMs', from: fromDecay ?? 0, to: toDecay ?? 0 },
    { parameterId: 'synth.ampSustain', from: fromSustain ?? 1, to: toSustain ?? 1 },
    { parameterId: 'synth.ampReleaseMs', from: fromRelease ?? 0, to: toRelease ?? 0 },
  ]
}

const mapUtility = (payload: EffectParamsCommitPayload<'utility'> | EffectParamsCommitPayload<'master-utility'>) => {
  const from = payload.from.state
  const to = payload.to.state
  return mapFields(
    [
      { parameterId: 'utility.gainDb', from: from.gainDb, to: to.gainDb },
      { parameterId: 'utility.pan', from: from.pan, to: to.pan },
      { parameterId: 'utility.balance', from: from.balance, to: to.balance },
      { parameterId: 'utility.width', from: from.width, to: to.width },
    ],
    [
      { from: from.enabled, to: to.enabled },
      { from: from.polarity, to: to.polarity },
      { from: from.inputMode, to: to.inputMode },
      { from: from.matrix, to: to.matrix },
      { from: from.swap, to: to.swap },
      { from: from.dcBlock, to: to.dcBlock },
    ],
  )
}

const mapAutoFilter = (payload: EffectParamsCommitPayload<'autofilter'> | EffectParamsCommitPayload<'master-autofilter'>) => {
  const from = payload.from.state
  const to = payload.to.state
  return mapFields(
    [
      { parameterId: 'autofilter.frequencyHz', from: from.frequencyHz, to: to.frequencyHz },
      { parameterId: 'autofilter.resonance', from: from.resonance, to: to.resonance },
      { parameterId: 'autofilter.driveDb', from: from.driveDb, to: to.driveDb },
      { parameterId: 'autofilter.mix', from: from.mix, to: to.mix },
      { parameterId: 'autofilter.envelope.amountOctaves', from: from.envelope.amountOctaves, to: to.envelope.amountOctaves },
      { parameterId: 'autofilter.envelope.attackMs', from: from.envelope.attackMs, to: to.envelope.attackMs },
      { parameterId: 'autofilter.envelope.releaseMs', from: from.envelope.releaseMs, to: to.envelope.releaseMs },
      { parameterId: 'autofilter.lfo.rateHz', from: from.lfo.rateHz, to: to.lfo.rateHz },
      { parameterId: 'autofilter.lfo.depthOctaves', from: from.lfo.depthOctaves, to: to.lfo.depthOctaves },
      { parameterId: 'autofilter.lfo.phaseOffset', from: from.lfo.phaseOffset, to: to.lfo.phaseOffset },
      { parameterId: 'autofilter.lfo.stereoPhase', from: from.lfo.stereoPhase, to: to.lfo.stereoPhase },
    ],
    [
      { from: from.enabled, to: to.enabled },
      { from: from.mode, to: to.mode },
      { from: from.lfo.waveform, to: to.lfo.waveform },
      { from: from.quality, to: to.quality },
    ],
  )
}

const mapLoFi = (payload: EffectParamsCommitPayload<'lofi'> | EffectParamsCommitPayload<'master-lofi'>) => {
  const from = payload.from.state
  const to = payload.to.state
  return mapFields(
    [
      { parameterId: 'lofi.bitDepth', from: from.bitDepth, to: to.bitDepth },
      { parameterId: 'lofi.sampleRateRatio', from: from.sampleRateRatio, to: to.sampleRateRatio },
      { parameterId: 'lofi.jitter', from: from.jitter, to: to.jitter },
      { parameterId: 'lofi.noiseDb', from: from.noiseDb, to: to.noiseDb },
      { parameterId: 'lofi.mix', from: from.mix, to: to.mix },
    ],
    [
      { from: from.enabled, to: to.enabled },
      { from: from.quantization, to: to.quantization },
      { from: from.dither, to: to.dither },
      { from: from.seed, to: to.seed },
    ],
  )
}

const mapDelay = (
  payload: EffectParamsCommitPayload<'delay'> | EffectParamsCommitPayload<'master-delay'>,
  bpm: number,
) => {
  const from = normalizeDelayParams(payload.from)
  const to = normalizeDelayParams(payload.to)
  return mapFields(
    [
      { parameterId: 'delay.timeMs', from: resolvePortableDelayMs(from, bpm), to: resolvePortableDelayMs(to, bpm) },
      { parameterId: 'delay.feedback', from: from.feedback, to: to.feedback },
      { parameterId: 'delay.dryWet', from: from.dryWet, to: to.dryWet },
      { parameterId: 'delay.lowCutHz', from: from.lowCutHz, to: to.lowCutHz },
      { parameterId: 'delay.highCutHz', from: from.highCutHz, to: to.highCutHz },
    ],
    [
      { from: from.enabled, to: to.enabled },
      { from: from.pingPong, to: to.pingPong },
      { from: from.filterEnabled, to: to.filterEnabled },
    ],
  )
}

const mapReverb = (payload: EffectParamsCommitPayload<'reverb'> | EffectParamsCommitPayload<'master-reverb'>) => {
  const from = payload.from
  const to = payload.to
  return mapFields(
    [
      { parameterId: 'reverb.wet', from: from.wet, to: to.wet },
      { parameterId: 'reverb.preDelayMs', from: from.preDelayMs, to: to.preDelayMs },
      { parameterId: 'reverb.lowCutHz', from: from.lowCutHz, to: to.lowCutHz },
      { parameterId: 'reverb.highCutHz', from: from.highCutHz, to: to.highCutHz },
      { parameterId: 'reverb.stereoWidth', from: from.stereoWidth, to: to.stereoWidth },
      { parameterId: 'reverb.decaySec', from: from.decaySec, to: to.decaySec },
      { parameterId: 'reverb.reflections', from: from.reflections, to: to.reflections },
      { parameterId: 'reverb.reflectionModAmountMs', from: from.reflectionModAmountMs, to: to.reflectionModAmountMs },
      { parameterId: 'reverb.reflectionModRateHz', from: from.reflectionModRateHz, to: to.reflectionModRateHz },
      { parameterId: 'reverb.reflectionShape', from: from["reflectionShape"], to: to["reflectionShape"] },
      { parameterId: 'reverb.diffuse', from: from.diffuse, to: to.diffuse },
      { parameterId: 'reverb.size', from: from.size, to: to.size },
      { parameterId: 'reverb.diffusion', from: from.diffusion, to: to.diffusion },
      { parameterId: 'reverb.density', from: from.density, to: to.density },
      { parameterId: 'reverb.diffusionLowCutHz', from: from.diffusionLowCutHz, to: to.diffusionLowCutHz },
      { parameterId: 'reverb.diffusionHighCutHz', from: from.diffusionHighCutHz, to: to.diffusionHighCutHz },
    ],
    [
      { from: from.enabled, to: to.enabled },
      { from: from.reflectionSpin, to: to.reflectionSpin },
    ],
  )
}

const mapSaturator = (payload: EffectParamsCommitPayload<'saturator'> | EffectParamsCommitPayload<'master-saturator'>) => {
  const from = payload.from
  const to = payload.to
  return mapFields(
    [
      { parameterId: 'saturator.driveDb', from: from.driveDb, to: to.driveDb },
      { parameterId: 'saturator.colorFrequencyHz', from: from.colorFrequencyHz, to: to.colorFrequencyHz },
      { parameterId: 'saturator.colorAmount', from: from.colorAmount, to: to.colorAmount },
      { parameterId: 'saturator.outputDb', from: from.outputDb, to: to.outputDb },
      { parameterId: 'saturator.dryWet', from: from.dryWet, to: to.dryWet },
    ],
    [
      { from: from.enabled, to: to.enabled },
      { from: from.curve, to: to.curve },
      { from: from.color, to: to.color },
    ],
  )
}

const mapModulation = (
  payload: EffectParamsCommitPayload<'chorus'> | EffectParamsCommitPayload<'master-chorus'>
    | EffectParamsCommitPayload<'flanger'> | EffectParamsCommitPayload<'master-flanger'>,
  prefix: 'chorus' | 'flanger',
) => {
  const from = payload.from.state
  const to = payload.to.state
  return mapFields(
    [
      { parameterId: `${prefix}.delayMs`, from: from.delayMs, to: to.delayMs },
      { parameterId: `${prefix}.depthMs`, from: from.depthMs, to: to.depthMs },
      { parameterId: `${prefix}.rateHz`, from: from.rateHz, to: to.rateHz },
      { parameterId: `${prefix}.feedback`, from: from.feedback, to: to.feedback },
      { parameterId: `${prefix}.stereoPhase`, from: from.stereoPhase, to: to.stereoPhase },
      { parameterId: `${prefix}.mix`, from: from.mix, to: to.mix },
    ],
    [{ from: from.enabled, to: to.enabled }],
  )
}

const mapPhaser = (payload: EffectParamsCommitPayload<'phaser'> | EffectParamsCommitPayload<'master-phaser'>) => {
  const from = payload.from.state
  const to = payload.to.state
  return mapFields(
    [
      { parameterId: 'phaser.centerHz', from: from.centerHz, to: to.centerHz },
      { parameterId: 'phaser.depthOctaves', from: from.depthOctaves, to: to.depthOctaves },
      { parameterId: 'phaser.rateHz', from: from.rateHz, to: to.rateHz },
      { parameterId: 'phaser.feedback', from: from.feedback, to: to.feedback },
      { parameterId: 'phaser.stereoPhase', from: from.stereoPhase, to: to.stereoPhase },
      { parameterId: 'phaser.mix', from: from.mix, to: to.mix },
    ],
    [{ from: from.enabled, to: to.enabled }, { from: from.stages, to: to.stages }],
  )
}

const mapAmplitudeModulation = (
  payload: EffectParamsCommitPayload<'tremolo'> | EffectParamsCommitPayload<'master-tremolo'>
    | EffectParamsCommitPayload<'autopan'> | EffectParamsCommitPayload<'master-autopan'>,
  prefix: 'tremolo' | 'autopan',
) => {
  const from = payload.from.state
  const to = payload.to.state
  return mapFields(
    [
      { parameterId: `${prefix}.rateHz`, from: from.rateHz, to: to.rateHz },
      { parameterId: `${prefix}.depth`, from: from.depth, to: to.depth },
      { parameterId: `${prefix}.shape`, from: from["shape"], to: to["shape"] },
      { parameterId: `${prefix}.phase`, from: from.phase, to: to.phase },
    ],
    [{ from: from.enabled, to: to.enabled }, { from: from.waveform, to: to.waveform }],
  )
}

const mapEnsemble = (payload: EffectParamsCommitPayload<'ensemble'> | EffectParamsCommitPayload<'master-ensemble'>) => {
  const from = payload.from.state
  const to = payload.to.state
  return mapFields(
    [
      { parameterId: 'ensemble.delayMs', from: from.delayMs, to: to.delayMs },
      { parameterId: 'ensemble.depthMs', from: from.depthMs, to: to.depthMs },
      { parameterId: 'ensemble.rateHz', from: from.rateHz, to: to.rateHz },
      { parameterId: 'ensemble.spread', from: from.spread, to: to.spread },
      { parameterId: 'ensemble.mix', from: from.mix, to: to.mix },
    ],
    [{ from: from.enabled, to: to.enabled }, { from: from.voices, to: to.voices }],
  )
}

const mapGate = (payload: EffectParamsCommitPayload<'gate'> | EffectParamsCommitPayload<'master-gate'>) => {
  const from = payload.from.state
  const to = payload.to.state
  return mapFields(
    [
      { parameterId: 'gate.thresholdDb', from: from.thresholdDb, to: to.thresholdDb },
      { parameterId: 'gate.ratio', from: from.ratio, to: to.ratio },
      { parameterId: 'gate.attackMs', from: from.attackMs, to: to.attackMs },
      { parameterId: 'gate.holdMs', from: from.holdMs, to: to.holdMs },
      { parameterId: 'gate.releaseMs', from: from.releaseMs, to: to.releaseMs },
      { parameterId: 'gate.hysteresisDb', from: from.hysteresisDb, to: to.hysteresisDb },
      { parameterId: 'gate.rangeDb', from: from.rangeDb, to: to.rangeDb },
      { parameterId: 'gate.lookaheadMs', from: from.lookaheadMs, to: to.lookaheadMs },
      { parameterId: 'gate.link', from: from.link, to: to.link },
      { parameterId: 'gate.sidechain.frequencyHz', from: from.sidechain.frequencyHz, to: to.sidechain.frequencyHz },
      { parameterId: 'gate.sidechain.q', from: from.sidechain.q, to: to.sidechain.q },
    ],
    [
      { from: from.enabled, to: to.enabled },
      { from: from.mode, to: to.mode },
      { from: from.detector, to: to.detector },
      { from: from.sidechain.enabled, to: to.sidechain.enabled },
      { from: from.sidechain.filterType, to: to.sidechain.filterType },
    ],
  )
}

const mapCompressor = (payload: EffectParamsCommitPayload<'compressor'> | EffectParamsCommitPayload<'master-compressor'>) => {
  const from = payload.from
  const to = payload.to
  return mapFields(
    [
      { parameterId: 'compressor.thresholdDb', from: from.thresholdDb, to: to.thresholdDb },
      { parameterId: 'compressor.ratio', from: from.ratio, to: to.ratio },
      { parameterId: 'compressor.attackMs', from: from.attackMs, to: to.attackMs },
      { parameterId: 'compressor.releaseMs', from: from.releaseMs, to: to.releaseMs },
      { parameterId: 'compressor.makeupDb', from: from.makeupDb, to: to.makeupDb },
      { parameterId: 'compressor.outputDb', from: from.outputDb, to: to.outputDb },
      { parameterId: 'compressor.dryWet', from: from.dryWet, to: to.dryWet },
      { parameterId: 'compressor.kneeDb', from: from.kneeDb, to: to.kneeDb },
      { parameterId: 'compressor.lookaheadMs', from: from.lookaheadMs, to: to.lookaheadMs },
      { parameterId: 'compressor.sidechain.frequencyHz', from: from.sidechain.frequencyHz, to: to.sidechain.frequencyHz },
      { parameterId: 'compressor.sidechain.q', from: from.sidechain.q, to: to.sidechain.q },
    ],
    [
      { from: from.enabled, to: to.enabled },
      { from: from.autoRelease, to: to.autoRelease },
      { from: from.detectorMode, to: to.detectorMode },
      { from: from.dynamicsMode, to: to.dynamicsMode },
      { from: from.envelopeCurve, to: to.envelopeCurve },
      { from: from.sidechain.enabled, to: to.sidechain.enabled },
      { from: from.sidechain.filterType, to: to.sidechain.filterType },
    ],
  )
}

const mapLimiter = (payload: EffectParamsCommitPayload<'limiter'> | EffectParamsCommitPayload<'master-limiter'>) => {
  const from = payload.from.state
  const to = payload.to.state
  return mapFields(
    [
      { parameterId: 'limiter.ceiling', from: from.ceilingDbtp, to: to.ceilingDbtp },
      { parameterId: 'limiter.release', from: from.releaseMs, to: to.releaseMs },
      { parameterId: 'limiter.lookaheadMs', from: from.lookaheadMs, to: to.lookaheadMs },
      { parameterId: 'limiter.link', from: from.link, to: to.link },
    ],
    [{ from: from.enabled, to: to.enabled }, { from: from.detectorOversampling, to: to.detectorOversampling }],
  )
}

const mapEq = (payload: EffectParamsCommitPayload<'eq'> | EffectParamsCommitPayload<'master-eq'>) => {
  const from: EqParams = payload.from
  const to: EqParams = payload.to
  if (from.enabled !== to.enabled || from.channelMode !== to.channelMode || from.bands.length !== to.bands.length) return undefined
  const values: ParameterField[] = []
  for (let index = 0; index < from.bands.length; index += 1) {
    const fromBand = from.bands[index]
    const toBand = to.bands[index]
    if (!fromBand || !toBand || fromBand.id !== toBand.id || fromBand.enabled !== toBand.enabled || fromBand.type !== toBand.type) return undefined
    values.push({
      parameterId: createEqBandParameterId(fromBand.id, 'frequencyHz'),
      from: fromBand.frequency,
      to: toBand.frequency,
    })
    values.push({
      parameterId: createEqBandParameterId(fromBand.id, 'gainDb'),
      from: fromBand.gainDb,
      to: toBand.gainDb,
    })
    values.push({
      parameterId: createEqBandParameterId(fromBand.id, 'q'),
      from: fromBand.q,
      to: toBand.q,
    })
  }
  return values
}

const mapSpectral = (payload: EffectParamsCommitPayload<'spectral'> | EffectParamsCommitPayload<'master-spectral'>) => {
  const from = payload.from.state
  const to = payload.to.state
  return mapFields(
    [
      { parameterId: 'spectral.freeze', from: from.freeze, to: to.freeze },
      { parameterId: 'spectral.gateThresholdDb', from: from.gateThresholdDb, to: to.gateThresholdDb },
      { parameterId: 'spectral.gateAttackMs', from: from.gateAttackMs, to: to.gateAttackMs },
      { parameterId: 'spectral.gateReleaseMs', from: from.gateReleaseMs, to: to.gateReleaseMs },
      { parameterId: 'spectral.morph', from: from.morph, to: to.morph },
      { parameterId: 'spectral.binShift', from: from.binShift, to: to.binShift },
      { parameterId: 'spectral.blur', from: from.blur, to: to.blur },
      { parameterId: 'spectral.harmonicPercussiveBalance', from: from.harmonicPercussiveBalance, to: to.harmonicPercussiveBalance },
      { parameterId: 'spectral.noiseReduction', from: from.noiseReduction, to: to.noiseReduction },
      { parameterId: 'spectral.profileLearn', from: from.profileLearn, to: to.profileLearn },
      { parameterId: 'spectral.mix', from: from.mix, to: to.mix },
    ],
    [
      { from: from.enabled, to: to.enabled },
      { from: from.fftSize, to: to.fftSize },
      { from: from.overlap, to: to.overlap },
      { from: from.mode, to: to.mode },
    ],
  )
}

const mapParameterFields = (
  payload: NativeBuiltInParameterPayload,
  bpm: number,
): readonly ParameterField[] | undefined => {
  let values: readonly ParameterField[] | undefined
  switch (payload.effect) {
    case 'instrument':
      values = mapInstrument(payload)
      break
    case 'utility':
    case 'master-utility':
      values = mapUtility(payload)
      break
    case 'autofilter':
    case 'master-autofilter':
      values = mapAutoFilter(payload)
      break
    case 'lofi':
    case 'master-lofi':
      values = mapLoFi(payload)
      break
    case 'delay':
    case 'master-delay':
      values = mapDelay(payload, bpm)
      break
    case 'reverb':
    case 'master-reverb':
      values = mapReverb(payload)
      break
    case 'eq':
    case 'master-eq':
      values = mapEq(payload)
      break
    case 'spectral':
    case 'master-spectral':
      values = mapSpectral(payload)
      break
    case 'saturator':
    case 'master-saturator':
      values = mapSaturator(payload)
      break
    case 'chorus':
    case 'master-chorus':
      values = mapModulation(payload, 'chorus')
      break
    case 'flanger':
    case 'master-flanger':
      values = mapModulation(payload, 'flanger')
      break
    case 'phaser':
    case 'master-phaser':
      values = mapPhaser(payload)
      break
    case 'tremolo':
    case 'master-tremolo':
      values = mapAmplitudeModulation(payload, 'tremolo')
      break
    case 'autopan':
    case 'master-autopan':
      values = mapAmplitudeModulation(payload, 'autopan')
      break
    case 'ensemble':
    case 'master-ensemble':
      values = mapEnsemble(payload)
      break
    case 'gate':
    case 'master-gate':
      values = mapGate(payload)
      break
    case 'compressor':
    case 'master-compressor':
      values = mapCompressor(payload)
      break
    case 'limiter':
    case 'master-limiter':
      values = mapLimiter(payload)
      break
    default:
      return undefined
  }
  return values
}

export const isLiveParameterChange = (payload: NativeBuiltInParameterPayload, bpm: number): boolean =>
  mapParameterFields(payload, bpm) !== undefined

const unchanged = <P extends { from: unknown; to: unknown }>(payload: P): P => ({ ...payload, from: payload.to })

// Compare the complete non-live content through the same mapping that defines which fields native can change live.
// The allocator captured absolute values at its tempo; only field membership and structural differences matter here.
export const nativeBuiltInLiveStateFields = (from: ProcessorTiming, to: ProcessorTiming): readonly string[] | undefined => {
  if (from.input.kind !== to.input.kind || from.enabled !== to.enabled) return undefined
  const previous = parseJsonValue(from.input.params)
  const next = parseJsonValue(to.input.params)
  if (previous === undefined || next === undefined) return undefined
  const payload = createAudioEffectParameterPayload({ targetId: "", instanceId: "", kind: to.input.kind }, previous, next)
  return mapParameterFields(payload, 120)?.map(field => field.parameterId)
}

export const nativeBuiltInLiveStateCovered = (
  from: ProcessorTiming,
  to: ProcessorTiming,
  values: Readonly<Record<string, number>>,
): boolean => {
  const fields = nativeBuiltInLiveStateFields(from, to)
  return fields !== undefined && fields.every(id => Object.hasOwn(values, id))
}

// The absolute value of every mappable parameter, taken once when an edit is
// allocated (tempo-synced values resolve at that tempo). The content alone
// decides: a replacement whose structure differs from `from` (a rollback to
// another EQ band layout) is still absolute content, only its commit diff is not
// expressible as parameters.
export const captureNativeBuiltInParameterValues = (
  payload: NativeBuiltInParameterPayload,
  bpm: number,
): Readonly<Record<string, number>> | undefined => {
  const fields = mapParameterFields(unchanged(payload), bpm)
  return fields && Object.fromEntries(fields.map((field) => [field.parameterId, numeric(field.to)]))
}

export const mapNativeBuiltInParameterCommit = (
  payload: NativeBuiltInParameterPayload,
  bpm: number,
): NativeBuiltInParameterCommit | undefined => {
  const instanceId = instanceIdOf(payload)
  const fields = instanceId ? mapParameterFields(payload, bpm) : undefined
  if (!instanceId || !fields) return undefined
  const captured = payload.edit?.content.values
  return {
    instanceId,
    edit: payload.edit,
    values: fields
      .filter((field) => payload.parameterIds
        ? payload.parameterIds.has(field.parameterId)
        : !same(field.from, field.to))
      .map((field) => ({ parameterId: field.parameterId, value: captured?.[field.parameterId] ?? numeric(field.to) })),
  }
}

// An edit's bytes are encoded once, when it is allocated. Execution and byte
// comparisons read those bytes; only payloads without an edit encode here.
export const captureNativeBuiltInStateCommit = (
  payload: EffectParamsCommitPayload,
  bpm: number,
): NativeBuiltInStateCommit | undefined => {
  const edit = payload.edit
  return edit?.content.state
    ? { instanceId: edit.target.instanceId, state: edit.content.state }
    : encodeNativeBuiltInStateCommit(payload, bpm)
}

export const encodeNativeBuiltInStateCommit = (
  payload: EffectParamsCommitPayload,
  bpm: number,
): NativeBuiltInStateCommit | undefined => {
  const instanceId = instanceIdOf(payload)
  if (!instanceId) return undefined
  let state: Uint8Array
  switch (payload.effect) {
    case 'utility':
    case 'master-utility':
      state = encodeUtilityProcessorState(payload.to.state)
      break
    case 'autofilter':
    case 'master-autofilter':
      state = encodeAutoFilterProcessorState(payload.to.state)
      break
    case 'lofi':
    case 'master-lofi':
      state = encodeLoFiProcessorState(payload.to.state)
      break
    case 'saturator':
    case 'master-saturator':
      state = encodeSaturatorProcessorState(payload.to)
      break
    case 'eq':
    case 'master-eq':
      state = encodeEqProcessorState(payload.to)
      break
    case 'gate':
    case 'master-gate':
      state = encodeGateProcessorState(payload.to.state)
      break
    case 'compressor':
    case 'master-compressor':
      state = encodeCompressorProcessorState(payload.to)
      break
    case 'limiter':
    case 'master-limiter':
      state = encodeLimiterProcessorState(payload.to.state)
      break
    case 'delay':
    case 'master-delay':
      {
        const normalized = normalizeDelayParams(payload.to)
        state = encodeDelayProcessorState({
          enabled: normalized.enabled,
          delayMs: resolvePortableDelayMs(normalized, bpm),
          feedback: normalized.feedback,
          dryWet: normalized.dryWet,
          pingPong: normalized.pingPong,
          filterEnabled: normalized.filterEnabled,
          lowCutHz: normalized.lowCutHz,
          highCutHz: normalized.highCutHz,
        })
      }
      break
    case 'reverb':
    case 'master-reverb':
      state = encodeReverbProcessorState(normalizeReverbParams(payload.to))
      break
    case 'chorus':
    case 'master-chorus':
      state = encodeChorusProcessorState(payload.to.state)
      break
    case 'flanger':
    case 'master-flanger':
      state = encodeFlangerProcessorState(payload.to.state)
      break
    case 'phaser':
    case 'master-phaser':
      state = encodePhaserProcessorState(payload.to.state)
      break
    case 'tremolo':
    case 'master-tremolo':
      state = encodeTremoloProcessorState(payload.to.state)
      break
    case 'autopan':
    case 'master-autopan':
      state = encodeAutoPanProcessorState(payload.to.state)
      break
    case 'ensemble':
    case 'master-ensemble':
      state = encodeEnsembleProcessorState(payload.to.state)
      break
    case 'spectral':
    case 'master-spectral':
      state = encodeSpectralProcessorState(payload.to.state)
      break
    default:
      return undefined
  }
  return { instanceId, state }
}
