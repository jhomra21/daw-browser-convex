import {
  normalizeCompressorParamsForUpdate,
  normalizeDelayParamsForUpdate,
  normalizeEqParamsForUpdate,
  normalizeReverbParamsForUpdate,
  normalizeSaturatorParamsForUpdate,
} from './effects-params'
import { isOwnedProcessorKind, mergeOwnedProcessorParams } from './owned-processor-descriptors'

export const normalizeAudioEffectParamsForUpdate = (
  kind: string,
  params: any,
  existing?: any,
) => {
  if (kind === 'eq') return normalizeEqParamsForUpdate(params, existing)
  if (kind === 'compressor') return normalizeCompressorParamsForUpdate(params, existing)
  if (kind === 'saturator') return normalizeSaturatorParamsForUpdate(params, existing)
  if (kind === 'delay') return normalizeDelayParamsForUpdate(params, existing)
  if (kind === 'reverb') return normalizeReverbParamsForUpdate(params, existing)
  if (isOwnedProcessorKind(kind)) return mergeOwnedProcessorParams(kind, params, existing)
  throw new Error(`Unsupported audio effect kind "${kind}".`)
}
