import {
  normalizeAudioEffectInstanceOrder,
  type AudioEffectInstance,
  type CompressorParamsLite,
  type DelayParamsLite,
  type EqParamsLite,
  type ReverbParamsLite,
  type SaturatorParamsLite,
} from '@daw-browser/shared'

export type EqAudioEffectRuntimeInstance = AudioEffectInstance & {
  kind: 'eq'
  params: EqParamsLite
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

export type AudioEffectRuntimeInstance =
  | EqAudioEffectRuntimeInstance
  | CompressorAudioEffectRuntimeInstance
  | SaturatorAudioEffectRuntimeInstance
  | DelayAudioEffectRuntimeInstance
  | ReverbAudioEffectRuntimeInstance

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
