import { normalizeReverbParams, REVERB_DECAY_SEC_MAX, REVERB_DECAY_SEC_MIN, serializeReverbParams, type ReverbParamsLite } from '@daw-browser/shared'

export type ReverbImpulseBucket = {
  bucketIndex: number
  bucketSec: number
}

export type ReverbImpulseSignatureParts = ReverbImpulseBucket & {
  sizeBucket: number
  densityBucket: number
  diffusionBucket: number
  diffusionLowCutBucket: number
  diffusionHighCutBucket: number
  reflectionsBucket: number
  reflectionSpinBucket: number
  reflectionModAmountBucket: number
  reflectionModRateBucket: number
  reflectionShapeBucket: number
  diffuseBucket: number
}

export function getAppliedReverbSignature(params: ReverbParamsLite): string {
  return serializeReverbParams(normalizeReverbParams(params))
}

export function getReverbTopologySignature(params: ReverbParamsLite): string {
  return normalizeReverbParams(params).enabled ? 'enabled' : 'disabled'
}

export function getReverbImpulseBucket(decaySec: number, bucketSize = 0.1): ReverbImpulseBucket {
  const clampedDecay = Math.min(REVERB_DECAY_SEC_MAX, Math.max(REVERB_DECAY_SEC_MIN, decaySec))
  const bucketIndex = Math.max(1, Math.round(clampedDecay / bucketSize))
  return {
    bucketIndex,
    bucketSec: Math.min(REVERB_DECAY_SEC_MAX, Math.max(bucketSize, bucketIndex * bucketSize)),
  }
}

export function getReverbImpulseSignatureParts(
  params: ReverbParamsLite,
  options?: { bucketSize?: number },
): ReverbImpulseSignatureParts {
  const normalized = normalizeReverbParams(params)
  const sizeScale = 0.5 + normalized.size * 0.75
  const bucket = getReverbImpulseBucket(normalized.decaySec * sizeScale, options?.bucketSize)
  return {
    bucketIndex: bucket.bucketIndex,
    bucketSec: bucket.bucketSec,
    sizeBucket: Math.round(normalized.size * 100),
    densityBucket: Math.round(normalized.density * 100),
    diffusionBucket: Math.round(normalized.diffusion * 100),
    diffusionLowCutBucket: Math.round(normalized.diffusionLowCutHz / 10),
    diffusionHighCutBucket: Math.round(normalized.diffusionHighCutHz / 100),
    reflectionsBucket: Math.round(normalized.reflections * 100),
    reflectionSpinBucket: normalized.reflectionSpin ? 1 : 0,
    reflectionModAmountBucket: Math.round(normalized.reflectionModAmountMs * 10),
    reflectionModRateBucket: Math.round(normalized.reflectionModRateHz * 100),
    reflectionShapeBucket: Math.round(normalized.reflectionShape * 100),
    diffuseBucket: Math.round(normalized.diffuse * 100),
  }
}

export function formatReverbImpulseSignature(parts: ReverbImpulseSignatureParts, length?: number): string {
  const signature = `${parts.bucketIndex}:${parts.sizeBucket}:${parts.densityBucket}:${parts.diffusionBucket}:${parts.diffusionLowCutBucket}:${parts.diffusionHighCutBucket}:${parts.reflectionsBucket}:${parts.reflectionSpinBucket}:${parts.reflectionModAmountBucket}:${parts.reflectionModRateBucket}:${parts.reflectionShapeBucket}:${parts.diffuseBucket}`
  return length === undefined ? signature : `${signature}:${length}`
}

export function getReverbImpulseSignature(params: ReverbParamsLite): string {
  return formatReverbImpulseSignature(getReverbImpulseSignatureParts(params))
}
