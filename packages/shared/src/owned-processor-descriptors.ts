import { AUDIO_EFFECT_KINDS, isOwnedProcessorKind, type OwnedProcessorKind } from './audio-effect-registry'
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

export const OWNED_PROCESSOR_KINDS = AUDIO_EFFECT_KINDS.filter(isOwnedProcessorKind)

export const OWNED_PROCESSOR_PARAMETER_IDS = {
  utility: ['utility.gainDb', 'utility.balance', 'utility.width', 'utility.midSide', 'utility.bassMonoHz'],
  autofilter: ['autofilter.frequencyHz', 'autofilter.resonance', 'autofilter.driveDb', 'autofilter.mix', 'autofilter.envelope.amountOctaves', 'autofilter.envelope.attackMs', 'autofilter.envelope.releaseMs', 'autofilter.lfo.rateHz', 'autofilter.lfo.depthOctaves', 'autofilter.lfo.phaseOffset', 'autofilter.lfo.stereoPhase', 'autofilter.outputDb'],
  gate: ['gate.thresholdDb', 'gate.ratio', 'gate.attackMs', 'gate.holdMs', 'gate.releaseMs', 'gate.hysteresisDb', 'gate.rangeDb', 'gate.link', 'gate.sidechain.frequencyHz', 'gate.sidechain.q', 'gate.sidechain.gainDb', 'gate.sidechain.mix'],
  limiter: ['limiter.gainDb', 'limiter.ceiling', 'limiter.release', 'limiter.link'],
  lofi: ['lofi.bitDepth', 'lofi.sampleRateHz', 'lofi.jitter', 'lofi.noiseDb', 'lofi.mix'],
  chorus: ['chorus.delayMs', 'chorus.depthMs', 'chorus.rateHz', 'chorus.feedback', 'chorus.stereoPhase', 'chorus.mix', 'chorus.safeBassHz', 'chorus.width', 'chorus.outputDb'],
  flanger: ['flanger.delayMs', 'flanger.depthMs', 'flanger.rateHz', 'flanger.feedback', 'flanger.stereoPhase', 'flanger.mix', 'flanger.safeBassHz', 'flanger.width', 'flanger.outputDb'],
  phaser: ['phaser.centerHz', 'phaser.depthOctaves', 'phaser.rateHz', 'phaser.feedback', 'phaser.stereoPhase', 'phaser.mix', 'phaser.spreadOctaves', 'phaser.blend', 'phaser.safeBassHz', 'phaser.outputDb'],
  tremolo: ['tremolo.rateHz', 'tremolo.depth', 'tremolo.shape', 'tremolo.phase', 'tremolo.stereoPhase'],
  autopan: ['autopan.rateHz', 'autopan.depth', 'autopan.shape', 'autopan.phase', 'autopan.stereoPhase'],
  ensemble: ['ensemble.delayMs', 'ensemble.depthMs', 'ensemble.rateHz', 'ensemble.spread', 'ensemble.mix', 'ensemble.fastDepthMs', 'ensemble.fastRateHz', 'ensemble.safeBassHz', 'ensemble.width', 'ensemble.outputDb'],
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

  const mergedNested = descriptor.nestedStateKeys.flatMap((key): [string, JsonObject][] => {
    const currentValue = currentState[key]
    const updateValue = update[key]

    return isJsonObject(currentValue) && isJsonObject(updateValue) ? [[key, { ...currentValue, ...updateValue }]] : []
  })

  const state: JsonObject = { ...currentState, ...update, ...Object.fromEntries(mergedNested) }

  return descriptor.normalizeParams({ version: 1, state })
}
