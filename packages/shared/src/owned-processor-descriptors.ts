import {
  normalizeAutoFilterParamsEnvelope,
  normalizeAutoPanParamsEnvelope,
  normalizeChorusParamsEnvelope,
  normalizeEnsembleParamsEnvelope,
  normalizeFlangerParamsEnvelope,
  normalizeGateParamsEnvelope,
  normalizeLimiterParamsEnvelope,
  normalizeLoFiParamsEnvelope,
  normalizePhaserParamsEnvelope,
  normalizeTremoloParamsEnvelope,
  normalizeUtilityParamsEnvelope,
} from './effects-params'
import { isJsonObject, parseJsonValue, type JsonObject, type JsonValue, type JsonValueInput } from './json-value'
import { normalizeSpectralParamsEnvelope } from './spectral-params'

export const OWNED_PROCESSOR_KINDS = [
  'utility',
  'autofilter',
  'gate',
  'limiter',
  'lofi',
  'chorus',
  'flanger',
  'phaser',
  'tremolo',
  'autopan',
  'ensemble',
  'spectral',
] as const

export type OwnedProcessorKind = typeof OWNED_PROCESSOR_KINDS[number]

export const OWNED_PROCESSOR_PARAMETER_IDS = {
  utility: ['utility.gainDb', 'utility.pan', 'utility.balance', 'utility.width'],
  autofilter: ['autofilter.frequencyHz', 'autofilter.resonance', 'autofilter.driveDb', 'autofilter.mix', 'autofilter.envelope.amountOctaves', 'autofilter.envelope.attackMs', 'autofilter.envelope.releaseMs', 'autofilter.lfo.rateHz', 'autofilter.lfo.depthOctaves', 'autofilter.lfo.phaseOffset', 'autofilter.lfo.stereoPhase'],
  gate: ['gate.thresholdDb', 'gate.ratio', 'gate.attackMs', 'gate.holdMs', 'gate.releaseMs', 'gate.hysteresisDb', 'gate.rangeDb', 'gate.lookaheadMs', 'gate.link'],
  limiter: ['limiter.ceiling', 'limiter.release', 'limiter.lookaheadMs', 'limiter.link', 'limiter.detectorOversampling'],
  lofi: ['lofi.bitDepth', 'lofi.sampleRateRatio', 'lofi.jitter', 'lofi.noiseDb', 'lofi.mix'],
  chorus: ['chorus.delayMs', 'chorus.depthMs', 'chorus.rateHz', 'chorus.feedback', 'chorus.stereoPhase', 'chorus.mix'],
  flanger: ['flanger.delayMs', 'flanger.depthMs', 'flanger.rateHz', 'flanger.feedback', 'flanger.stereoPhase', 'flanger.mix'],
  phaser: ['phaser.centerHz', 'phaser.depthOctaves', 'phaser.rateHz', 'phaser.feedback', 'phaser.stereoPhase', 'phaser.mix'],
  tremolo: ['tremolo.rateHz', 'tremolo.depth', 'tremolo.shape', 'tremolo.phase'],
  autopan: ['autopan.rateHz', 'autopan.depth', 'autopan.shape', 'autopan.phase'],
  ensemble: ['ensemble.delayMs', 'ensemble.depthMs', 'ensemble.rateHz', 'ensemble.spread', 'ensemble.mix'],
  spectral: ['spectral.freeze', 'spectral.gateThresholdDb', 'spectral.gateAttackMs', 'spectral.gateReleaseMs', 'spectral.morph', 'spectral.binShift', 'spectral.blur', 'spectral.harmonicPercussiveBalance', 'spectral.noiseReduction', 'spectral.profileLearn', 'spectral.mix'],
} as const satisfies Record<OwnedProcessorKind, readonly string[]>

const descriptor = (
  normalizeParams: (value: JsonValue) => { version: 1; state: object },
  nestedStateKeys: readonly string[] = [],
) => ({
  normalizeParams,
  nestedStateKeys,
  migratesEnvelope: true,
  persistsState: true,
})

export const OWNED_PROCESSOR_DESCRIPTORS = {
  utility: descriptor(normalizeUtilityParamsEnvelope),
  autofilter: descriptor(normalizeAutoFilterParamsEnvelope, ['envelope', 'lfo']),
  gate: descriptor(normalizeGateParamsEnvelope, ['sidechain']),
  limiter: descriptor(normalizeLimiterParamsEnvelope),
  lofi: descriptor(normalizeLoFiParamsEnvelope),
  chorus: descriptor(normalizeChorusParamsEnvelope),
  flanger: descriptor(normalizeFlangerParamsEnvelope),
  phaser: descriptor(normalizePhaserParamsEnvelope),
  tremolo: descriptor(normalizeTremoloParamsEnvelope),
  autopan: descriptor(normalizeAutoPanParamsEnvelope),
  ensemble: descriptor(normalizeEnsembleParamsEnvelope),
  spectral: descriptor(normalizeSpectralParamsEnvelope),
} satisfies Record<OwnedProcessorKind, ReturnType<typeof descriptor>>

export const isOwnedProcessorKind = (value: JsonValueInput): value is OwnedProcessorKind =>
  OWNED_PROCESSOR_KINDS.some((kind) => value === kind)

export const normalizeOwnedProcessorParams = (kind: OwnedProcessorKind, value: JsonValueInput) =>
  OWNED_PROCESSOR_DESCRIPTORS[kind].normalizeParams(parseJsonValue(value) ?? null)

export const mergeOwnedProcessorParams = (
  kind: OwnedProcessorKind,
  params: JsonValueInput,
  existing?: JsonValueInput,
) => {
  const descriptor = OWNED_PROCESSOR_DESCRIPTORS[kind]
  const currentEnvelope = parseJsonValue(descriptor.normalizeParams(parseJsonValue(existing) ?? null))
  const currentState = isJsonObject(currentEnvelope) && isJsonObject(currentEnvelope.state)
    ? currentEnvelope.state
    : {}
  const parsedParams = parseJsonValue(params)
  const update = isJsonObject(parsedParams) && isJsonObject(parsedParams.state)
    ? parsedParams.state
    : {}
  let state: JsonObject = { ...currentState, ...update }
  for (const key of descriptor.nestedStateKeys) {
    const currentValue = currentState[key]
    const updateValue = update[key]
    if (isJsonObject(currentValue) && isJsonObject(updateValue)) {
      state = { ...state, [key]: { ...currentValue, ...updateValue } }
    }
  }
  return descriptor.normalizeParams({ version: 1, state })
}
