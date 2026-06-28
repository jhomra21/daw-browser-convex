import { normalizeCompressorParams, type CompressorParamsLite } from '@daw-browser/shared'
import { applyCompressorNodeChainParams, createCompressorNodeChain, disconnectCompressorChain, type CompressorNodeChain } from './chain'
import { getCompressorParamsSignature, readCompressorMeterFrame, type CompressorMeterListener } from './compressor-worklet'

export type CompressorChainState = {
  chain: () => CompressorNodeChain | null
  set: (ctx: BaseAudioContext, params: CompressorParamsLite) => Promise<{ changed: boolean; requiresRoutingRebuild: boolean }>
  subscribeMeter: (listener: CompressorMeterListener) => () => void
  close: () => void
}

export function createCompressorChainState(): CompressorChainState {
  let compressor: CompressorNodeChain | null = null
  let signature: string | null = null
  let enabled: boolean | null = null
  let token = 0
  const meterListeners = new Set<CompressorMeterListener>()

  const bindMeterPort = (chain: CompressorNodeChain) => {
    chain.workletNode.port.onmessage = (event) => {
      const frame = readCompressorMeterFrame(event.data)
      if (!frame) return
      for (const listener of meterListeners) listener(frame)
    }
  }

  return {
    chain: () => compressor,
    set: async (ctx, params) => {
      const normalized = normalizeCompressorParams(params)
      const nextSignature = getCompressorParamsSignature(normalized)
      if (signature === nextSignature) return { changed: false, requiresRoutingRebuild: false }
      const requiresRoutingRebuild = enabled !== normalized.enabled && (enabled !== null || normalized.enabled)
      const currentToken = ++token
      if (!normalized.enabled) {
        if (compressor) {
          disconnectCompressorChain(compressor)
          compressor = null
        }
        signature = nextSignature
        enabled = false
        return { changed: true, requiresRoutingRebuild }
      }
      if (!compressor) {
        const next = await createCompressorNodeChain(ctx, normalized)
        if (currentToken !== token) {
          disconnectCompressorChain(next)
          return { changed: false, requiresRoutingRebuild: false }
        }
        compressor = next
        bindMeterPort(compressor)
      } else {
        applyCompressorNodeChainParams(compressor, normalized)
      }
      signature = nextSignature
      enabled = true
      return { changed: true, requiresRoutingRebuild }
    },
    subscribeMeter: (listener) => {
      meterListeners.add(listener)
      return () => {
        meterListeners.delete(listener)
      }
    },
    close: () => {
      token++
      signature = null
      enabled = null
      if (compressor) {
        disconnectCompressorChain(compressor)
        compressor = null
      }
    },
  }
}
