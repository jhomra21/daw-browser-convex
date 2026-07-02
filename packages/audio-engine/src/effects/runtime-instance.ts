import type {
  AudioEffectInstance,
  CompressorParamsLite,
  DelayParamsLite,
  EqParamsLite,
  ReverbParamsLite,
  SaturatorParamsLite,
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
