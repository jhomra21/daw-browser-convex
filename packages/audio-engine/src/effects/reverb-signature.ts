import { serializeReverbParams, type ReverbParamsLite } from '@daw-browser/shared'

export function getAppliedReverbSignature(params: ReverbParamsLite): string {
  return serializeReverbParams(params)
}
