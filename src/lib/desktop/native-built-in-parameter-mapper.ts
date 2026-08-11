import { createEqBandParameterId, normalizeDelayParams, normalizeReverbParams, type EqParams } from '@daw-browser/shared'
import { getEffectTiming } from '@daw-browser/audio-engine/effects/timing'
import type { EffectParamsCommitPayload } from '~/lib/undo/types'
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
import { resolvePortableDelayMs } from '@daw-browser/audio-engine/mixer/graph-contract'

export type NativeBuiltInParameterValue = {
  parameterId: string
  value: number
}

export type NativeBuiltInParameterCommit = {
  instanceId: string
  values: NativeBuiltInParameterValue[]
}

export type NativeBuiltInStateCommit = {
  instanceId: string
  state: Uint8Array
}

export const nativeBuiltInTimingForCommit = (
  payload: EffectParamsCommitPayload,
  sampleRateHz: number,
  bpm: number,
) => {
  const id = payload.instanceId ?? payload.effect
  switch (payload.effect) {
    case 'utility':
    case 'master-utility':
      return getEffectTiming({ id, kind: 'utility', params: payload.to }, sampleRateHz, bpm)
    case 'autofilter':
    case 'master-autofilter':
      return getEffectTiming({ id, kind: 'autofilter', params: payload.to }, sampleRateHz, bpm)
    case 'lofi':
    case 'master-lofi':
      return getEffectTiming({ id, kind: 'lofi', params: payload.to }, sampleRateHz, bpm)
    case 'eq':
    case 'master-eq':
      return getEffectTiming({ kind: 'eq', params: payload.to }, sampleRateHz, bpm)
    case 'gate':
    case 'master-gate':
      return getEffectTiming({ id, kind: 'gate', params: payload.to }, sampleRateHz, bpm)
    case 'compressor':
    case 'master-compressor':
      return getEffectTiming({ kind: 'compressor', params: payload.to }, sampleRateHz, bpm)
    case 'saturator':
    case 'master-saturator':
      return getEffectTiming({ kind: 'saturator', params: payload.to }, sampleRateHz, bpm)
    case 'limiter':
    case 'master-limiter':
      return getEffectTiming({ id, kind: 'limiter', params: payload.to }, sampleRateHz, bpm)
    case 'delay':
    case 'master-delay':
      return getEffectTiming({ kind: 'delay', params: normalizeDelayParams(payload.to) }, sampleRateHz, bpm)
    case 'reverb':
    case 'master-reverb':
      return getEffectTiming({ kind: 'reverb', params: normalizeReverbParams(payload.to) }, sampleRateHz, bpm)
    case 'chorus':
    case 'master-chorus':
      return getEffectTiming({ id, kind: 'chorus', params: payload.to }, sampleRateHz, bpm)
    case 'flanger':
    case 'master-flanger':
      return getEffectTiming({ id, kind: 'flanger', params: payload.to }, sampleRateHz, bpm)
    case 'phaser':
    case 'master-phaser':
      return getEffectTiming({ id, kind: 'phaser', params: payload.to }, sampleRateHz, bpm)
    case 'tremolo':
    case 'master-tremolo':
      return getEffectTiming({ id, kind: 'tremolo', params: payload.to }, sampleRateHz, bpm)
    case 'autopan':
    case 'master-autopan':
      return getEffectTiming({ id, kind: 'autopan', params: payload.to }, sampleRateHz, bpm)
    case 'ensemble':
    case 'master-ensemble':
      return getEffectTiming({ id, kind: 'ensemble', params: payload.to }, sampleRateHz, bpm)
    case 'spectral':
    case 'master-spectral':
      return getEffectTiming({ id, kind: 'spectral', params: payload.to }, sampleRateHz, bpm)
    case 'synth':
    case 'instrument':
    case 'arp':
      return undefined
  }
}

type ChangedValue = number | boolean
type Field = {
  parameterId?: string
  from: ChangedValue | string
  to: ChangedValue | string
}

const same = (from: unknown, to: unknown) => (
  Object.is(from, to)
  || (
    typeof from === 'object'
    && from !== null
    && typeof to === 'object'
    && to !== null
    && JSON.stringify(from) === JSON.stringify(to)
  )
)

const numeric = (value: ChangedValue | string) =>
  typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'number' ? value : undefined

const mapFields = (
  supported: readonly Field[],
  unsupported: readonly Field[],
) => {
  if (unsupported.some((field) => !same(field.from, field.to))) return undefined
  return supported
    .filter((field) => field.parameterId !== undefined && !same(field.from, field.to))
    .flatMap((field) => {
      const value = numeric(field.to)
      return field.parameterId !== undefined && value !== undefined
        ? [{ parameterId: field.parameterId, value }]
        : []
    })
}

const instanceIdOf = (payload: EffectParamsCommitPayload) =>
  typeof payload.instanceId === 'string' && payload.instanceId.length > 0 ? payload.instanceId : undefined

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
      { parameterId: 'reverb.reflectionShape', from: from.reflectionShape, to: to.reflectionShape },
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
      { parameterId: `${prefix}.shape`, from: from.shape, to: to.shape },
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
  const values: NativeBuiltInParameterValue[] = []
  for (let index = 0; index < from.bands.length; index += 1) {
    const fromBand = from.bands[index]
    const toBand = to.bands[index]
    if (!fromBand || !toBand || fromBand.id !== toBand.id || fromBand.enabled !== toBand.enabled || fromBand.type !== toBand.type) return undefined
    if (!same(fromBand.frequency, toBand.frequency)) values.push({
      parameterId: createEqBandParameterId(fromBand.id, 'frequencyHz'),
      value: toBand.frequency,
    })
    if (!same(fromBand.gainDb, toBand.gainDb)) values.push({
      parameterId: createEqBandParameterId(fromBand.id, 'gainDb'),
      value: toBand.gainDb,
    })
    if (!same(fromBand.q, toBand.q)) values.push({
      parameterId: createEqBandParameterId(fromBand.id, 'q'),
      value: toBand.q,
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

export const mapNativeBuiltInParameterCommit = (
  payload: EffectParamsCommitPayload,
  bpm: number,
): NativeBuiltInParameterCommit | undefined => {
  const instanceId = instanceIdOf(payload)
  if (!instanceId) return undefined
  let values: NativeBuiltInParameterValue[] | undefined
  switch (payload.effect) {
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
  return values === undefined ? undefined : { instanceId, values }
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
