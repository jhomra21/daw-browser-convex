import { normalizeSaturatorParams, serializeSaturatorParams, type SaturatorParamsLite } from '@daw-browser/shared'
import { applySaturatorNodeChainParams, createSaturatorNodeChain, disconnectSaturatorChain, type SaturatorNodeChain } from './chain'

export type SaturatorChainState = {
  chain: () => SaturatorNodeChain | null
  set: (ctx: BaseAudioContext, params: SaturatorParamsLite) => { changed: boolean; requiresRoutingRebuild: boolean }
  close: () => void
}

export function createSaturatorChainState(): SaturatorChainState {
  let saturator: SaturatorNodeChain | null = null
  let signature: string | null = null
  let enabled: boolean | null = null
  return {
    chain: () => saturator,
    set: (ctx, params) => {
      const normalized = normalizeSaturatorParams(params)
      const nextSignature = serializeSaturatorParams(normalized)
      if (signature === nextSignature) return { changed: false, requiresRoutingRebuild: false }
      const requiresRoutingRebuild = enabled !== normalized.enabled && (enabled !== null || normalized.enabled)
      if (!normalized.enabled) {
        if (saturator) {
          disconnectSaturatorChain(saturator)
          saturator = null
        }
        signature = nextSignature
        enabled = false
        return { changed: true, requiresRoutingRebuild }
      }
      if (!saturator) saturator = createSaturatorNodeChain(ctx, normalized)
      else applySaturatorNodeChainParams(saturator, normalized)
      signature = nextSignature
      enabled = true
      return { changed: true, requiresRoutingRebuild }
    },
    close: () => {
      signature = null
      enabled = null
      if (saturator) {
        disconnectSaturatorChain(saturator)
        saturator = null
      }
    },
  }
}
