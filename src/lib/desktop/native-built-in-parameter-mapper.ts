import { createEqBandParameterId, normalizeDelayParams, type EqParams } from '@daw-browser/shared'
import type { EffectParamsCommitPayload } from '~/lib/undo/types'
import { resolvePortableDelayMs } from '@daw-browser/audio-engine/mixer/graph-contract'

export type NativeBuiltInParameterValue = {
  parameterId: string
  value: number
}

export type NativeBuiltInParameterCommit = {
  instanceId: string
  values: NativeBuiltInParameterValue[]
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
      { parameterId: 'lofi.sampleRateRatio', from: from.sampleRateRatio, to: to.sampleRateRatio },
      { parameterId: 'lofi.jitter', from: from.jitter, to: to.jitter },
      { parameterId: 'lofi.noiseDb', from: from.noiseDb, to: to.noiseDb },
      { parameterId: 'lofi.mix', from: from.mix, to: to.mix },
    ],
    [
      { from: from.enabled, to: to.enabled },
      { from: from.bitDepth, to: to.bitDepth },
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
    ],
    [
      { from: from.enabled, to: to.enabled },
      { from: from.decaySec, to: to.decaySec },
      { from: from.reflections, to: to.reflections },
      { from: from.reflectionSpin, to: to.reflectionSpin },
      { from: from.reflectionModAmountMs, to: to.reflectionModAmountMs },
      { from: from.reflectionModRateHz, to: to.reflectionModRateHz },
      { from: from.reflectionShape, to: to.reflectionShape },
      { from: from.diffuse, to: to.diffuse },
      { from: from.size, to: to.size },
      { from: from.diffusion, to: to.diffusion },
      { from: from.density, to: to.density },
      { from: from.diffusionLowCutHz, to: to.diffusionLowCutHz },
      { from: from.diffusionHighCutHz, to: to.diffusionHighCutHz },
    ],
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
    default:
      return undefined
  }
  return values === undefined ? undefined : { instanceId, values }
}
