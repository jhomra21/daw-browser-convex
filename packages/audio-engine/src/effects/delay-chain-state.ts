import { normalizeDelayParams, serializeDelayParams, type DelayParamsLite } from '@daw-browser/shared'
import { applyDelayNodeChainParams, createDelayNodeChain, disconnectDelayChain, type DelayNodeChain } from './chain'

export type DelayChainState = {
  chain: () => DelayNodeChain | null
  set: (ctx: BaseAudioContext, params: DelayParamsLite, bpm: number) => { changed: boolean; requiresRoutingRebuild: boolean }
  setBpm: (bpm: number) => void
  close: () => void
}

export function createDelayChainState(): DelayChainState {
  let delay: DelayNodeChain | null = null
  let params: DelayParamsLite | null = null
  let signature: string | null = null
  let enabled: boolean | null = null
  let currentBpm = 120
  return {
    chain: () => delay,
    set: (ctx, nextParams, bpm) => {
      currentBpm = bpm
      const normalized = normalizeDelayParams(nextParams)
      const nextSignature = serializeDelayParams(normalized)
      if (signature === nextSignature && params?.mode !== 'sync') return { changed: false, requiresRoutingRebuild: false }
      const requiresRoutingRebuild = enabled !== normalized.enabled && (enabled !== null || normalized.enabled)
      params = normalized
      if (!normalized.enabled) {
        if (delay) {
          disconnectDelayChain(delay)
          delay = null
        }
        signature = nextSignature
        enabled = false
        return { changed: true, requiresRoutingRebuild }
      }
      if (!delay) delay = createDelayNodeChain(ctx, normalized, currentBpm)
      else applyDelayNodeChainParams(delay, normalized, currentBpm)
      signature = nextSignature
      enabled = true
      return { changed: true, requiresRoutingRebuild }
    },
    setBpm: (bpm) => {
      currentBpm = bpm
      if (delay && params?.mode === 'sync') applyDelayNodeChainParams(delay, params, currentBpm)
    },
    close: () => {
      params = null
      signature = null
      enabled = null
      if (delay) {
        disconnectDelayChain(delay)
        delay = null
      }
    },
  }
}
