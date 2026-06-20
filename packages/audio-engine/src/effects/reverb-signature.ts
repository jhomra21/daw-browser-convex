import type { ReverbParamsLite } from '@daw-browser/shared'

export function getAppliedReverbSignature(params: ReverbParamsLite): string {
  return `${params.enabled ? 1 : 0}|${params.wet}|${params.decaySec}|${params.preDelayMs}`
}
