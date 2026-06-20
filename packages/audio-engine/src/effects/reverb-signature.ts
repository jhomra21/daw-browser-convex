import { normalizeReverbParams, serializeReverbParams, type ReverbParamsLite } from '@daw-browser/shared'

export function getAppliedReverbSignature(params: ReverbParamsLite): string {
  return serializeReverbParams(params)
}

export function getReverbTopologySignature(params: ReverbParamsLite): string {
  return normalizeReverbParams(params).enabled ? 'enabled' : 'disabled'
}

export function getReverbImpulseSignature(params: ReverbParamsLite): string {
  const normalized = normalizeReverbParams(params)
  return `${normalized.decaySec}|${normalized.size}|${normalized.density}|${normalized.diffusion}|${normalized.highCutHz}`
}
