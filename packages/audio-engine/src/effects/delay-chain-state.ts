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
  let pingPong: boolean | null = null
  let currentBpm = 120
  return {
    chain: () => delay,
    set: (ctx, nextParams, bpm) => {
      const bpmChanged = currentBpm !== bpm
      currentBpm = bpm
      const normalized = normalizeDelayParams(nextParams)
      const nextSignature = serializeDelayParams(normalized)
      if (signature === nextSignature && (!normalized.enabled || normalized.mode !== 'sync' || !bpmChanged)) return { changed: false, requiresRoutingRebuild: false }
      // Disabling only makes the chain's output dry: it stays in the routing and keeps
      // running on its input, so enabling it again brings back the echo of recent audio.
      const topologyChanged = pingPong !== null && pingPong !== normalized.pingPong
      // The signature names what the nodes hold only once every write has landed.
      signature = null
      params = normalized
      if (topologyChanged && delay) {
        disconnectDelayChain(delay)
        delay = null
      }
      const created = !delay
      if (!delay) delay = createDelayNodeChain(ctx, normalized, currentBpm)
      else applyDelayNodeChainParams(delay, normalized, currentBpm)
      signature = nextSignature
      pingPong = normalized.pingPong
      return { changed: true, requiresRoutingRebuild: created }
    },
    setBpm: (bpm) => {
      currentBpm = bpm
      if (!delay || params?.mode !== 'sync') return
      signature = null
      applyDelayNodeChainParams(delay, params, currentBpm)
      signature = serializeDelayParams(params)
    },
    close: () => {
      params = null
      signature = null
      pingPong = null
      if (delay) {
        disconnectDelayChain(delay)
        delay = null
      }
    },
  }
}
