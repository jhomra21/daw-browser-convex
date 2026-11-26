import { normalizeDelayParams, serializeDelayParams, type DelayParamsLite } from '@daw-browser/shared'
import { applyDelayNodeChainParams, createDelayNodeChain, disconnectDelayChain, setDelayChainTempo, type DelayNodeChain } from './chain'

export type DelayChainState = {
  chain: () => DelayNodeChain | null
  set: (ctx: BaseAudioContext, params: DelayParamsLite, bpm: number) => Promise<{ changed: boolean; requiresRoutingRebuild: boolean }>
  setBpm: (bpm: number) => void
  close: () => void
}

export function createDelayChainState(): DelayChainState {
  let delay: DelayNodeChain | null = null
  let signature: string | null = null
  let generation = 0

  return {
    chain: () => delay,
    set: async (ctx, params, bpm) => {
      // Every request outdates the construction an earlier one still awaits, an equal one that returns early included.
      const current = ++generation
      const normalized = normalizeDelayParams(params)
      const nextSignature = serializeDelayParams(normalized)

      if (delay) {
        setDelayChainTempo(delay, bpm)

        if (signature === nextSignature) return { changed: false, requiresRoutingRebuild: false }
        signature = null
        applyDelayNodeChainParams(delay, normalized)
        signature = nextSignature

        return { changed: true, requiresRoutingRebuild: false }
      }

      const created = await createDelayNodeChain(ctx, normalized, bpm)

      if (current !== generation) {
        disconnectDelayChain(created)

        return { changed: false, requiresRoutingRebuild: false }
      }

      delay = created
      signature = nextSignature

      return { changed: true, requiresRoutingRebuild: true }
    },
    setBpm: (bpm) => {
      if (delay) setDelayChainTempo(delay, bpm)
    },
    close: () => {
      generation++
      signature = null

      if (delay) {
        disconnectDelayChain(delay)
        delay = null
      }
    },
  }
}
