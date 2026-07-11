import {
  normalizeAudioEffectInstanceOrder,
  type AudioEffectInstance,
  type AutoFilterParamsEnvelope,
  type AutoPanParamsEnvelope,
  type ChorusParamsEnvelope,
  type CompressorParamsLite,
  type DelayParamsLite,
  type EqParamsLite,
  type EnsembleParamsEnvelope,
  type FlangerParamsEnvelope,
  type GateParamsEnvelope,
  type LimiterParamsEnvelope,
  type LoFiParamsEnvelope,
  type PhaserParamsEnvelope,
  type ReverbParamsLite,
  type SaturatorParamsLite,
  type TremoloParamsEnvelope,
  type UtilityParamsEnvelope,
} from '@daw-browser/shared'

export type EqAudioEffectRuntimeInstance = AudioEffectInstance & {
  kind: 'eq'
  params: EqParamsLite
}

export type UtilityAudioEffectRuntimeInstance = AudioEffectInstance & {
  kind: 'utility'
  params: UtilityParamsEnvelope
}

export type AutoFilterAudioEffectRuntimeInstance = AudioEffectInstance & {
  kind: 'autofilter'
  params: AutoFilterParamsEnvelope
}

export type GateAudioEffectRuntimeInstance = AudioEffectInstance & {
  kind: 'gate'
  params: GateParamsEnvelope
}

export type LimiterAudioEffectRuntimeInstance = AudioEffectInstance & {
  kind: 'limiter'
  params: LimiterParamsEnvelope
}

export type LoFiAudioEffectRuntimeInstance = AudioEffectInstance & {
  kind: 'lofi'
  params: LoFiParamsEnvelope
}

export type CompressorAudioEffectRuntimeInstance = AudioEffectInstance & {
  kind: 'compressor'
  params: CompressorParamsLite
}

export type SaturatorAudioEffectRuntimeInstance = AudioEffectInstance & {
  kind: 'saturator'
  params: SaturatorParamsLite
}

export type DelayAudioEffectRuntimeInstance = AudioEffectInstance & {
  kind: 'delay'
  params: DelayParamsLite
}

export type ReverbAudioEffectRuntimeInstance = AudioEffectInstance & {
  kind: 'reverb'
  params: ReverbParamsLite
}

export type ModulationAudioEffectRuntimeInstance =
  | (AudioEffectInstance & { kind: 'chorus'; params: ChorusParamsEnvelope })
  | (AudioEffectInstance & { kind: 'flanger'; params: FlangerParamsEnvelope })
  | (AudioEffectInstance & { kind: 'phaser'; params: PhaserParamsEnvelope })
  | (AudioEffectInstance & { kind: 'tremolo'; params: TremoloParamsEnvelope })
  | (AudioEffectInstance & { kind: 'autopan'; params: AutoPanParamsEnvelope })
  | (AudioEffectInstance & { kind: 'ensemble'; params: EnsembleParamsEnvelope })

export type AudioEffectRuntimeInstance =
  | UtilityAudioEffectRuntimeInstance
  | AutoFilterAudioEffectRuntimeInstance
  | EqAudioEffectRuntimeInstance
  | GateAudioEffectRuntimeInstance
  | LimiterAudioEffectRuntimeInstance
  | LoFiAudioEffectRuntimeInstance
  | CompressorAudioEffectRuntimeInstance
  | SaturatorAudioEffectRuntimeInstance
  | DelayAudioEffectRuntimeInstance
  | ReverbAudioEffectRuntimeInstance
  | ModulationAudioEffectRuntimeInstance

const runtimeInstanceKey = (instance: AudioEffectInstance) => `${instance.id}\u0000${instance.kind}`

export function normalizeAudioEffectRuntimeInstances(
  instances: readonly AudioEffectRuntimeInstance[],
): AudioEffectRuntimeInstance[] {
  const byKey = new Map(instances.map((instance) => [runtimeInstanceKey(instance), instance]))
  return normalizeAudioEffectInstanceOrder(instances, instances).flatMap((entry) => {
    const instance = byKey.get(runtimeInstanceKey(entry))
    return instance ? [instance] : []
  })
}
