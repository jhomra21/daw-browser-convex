import { normalizeSaturatorParams, serializeSaturatorParams, type SaturatorParamsLite } from '@daw-browser/shared'
import { applySaturatorNodeChainParams, createSaturatorNodeChain, disconnectSaturatorChain, type SaturatorNodeChain } from './chain'

export type SaturatorChainState = {
  chain: () => SaturatorNodeChain | null
  set: (ctx: BaseAudioContext, params: SaturatorParamsLite) => Promise<{ changed: boolean; requiresRoutingRebuild: boolean }>
  close: () => void
}

export function createSaturatorChainState(): SaturatorChainState {
  let saturator: SaturatorNodeChain | null = null
  let signature: string | null = null
  let generation = 0

  return {
    chain: () => saturator,
    set: async (ctx, params) => {
      // Every request outdates the construction an earlier one still awaits, an equal one that returns early included.
      const current = ++generation
      const normalized = normalizeSaturatorParams(params)
      const nextSignature = serializeSaturatorParams(normalized)

      if (saturator) {
        if (signature === nextSignature) return { changed: false, requiresRoutingRebuild: false }
        signature = null
        applySaturatorNodeChainParams(saturator, normalized)
        signature = nextSignature

        return { changed: true, requiresRoutingRebuild: false }
      }

      const created = await createSaturatorNodeChain(ctx, normalized)

      if (current !== generation) {
        disconnectSaturatorChain(created)

        return { changed: false, requiresRoutingRebuild: false }
      }

      saturator = created
      signature = nextSignature

      return { changed: true, requiresRoutingRebuild: true }
    },
    close: () => {
      generation++
      signature = null

      if (saturator) {
        disconnectSaturatorChain(saturator)
        saturator = null
      }
    },
  }
}
