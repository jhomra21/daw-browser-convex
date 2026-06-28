import { normalizeCompressorParams, serializeCompressorParams, type CompressorParamsLite } from '@daw-browser/shared'
import { applyCompressorNodeChainParams, createCompressorNodeChain, disconnectCompressorChain, type CompressorNodeChain } from './chain'
import { readCompressorMeterFrame, setCompressorMeteringEnabled, type CompressorMeterFrame, type CompressorMeterListener } from './compressor-worklet'

export type CompressorChainState = {
  chain: () => CompressorNodeChain | null
  set: (ctx: BaseAudioContext, params: CompressorParamsLite) => Promise<{ changed: boolean; requiresRoutingRebuild: boolean }>
  subscribeMeter: (listener: CompressorMeterListener) => () => void
  isIdle: () => boolean
  close: () => void
}

export function createCompressorChainState(): CompressorChainState {
  let compressor: CompressorNodeChain | null = null
  let signature: string | null = null
  let enabled: boolean | null = null
  let token = 0
  let pendingSets = 0
  let lastFrame: CompressorMeterFrame | null = null
  const meterListeners = new Set<CompressorMeterListener>()

  const bindMeterPort = (chain: CompressorNodeChain) => {
    chain.workletNode.port.onmessage = (event) => {
      const frame = readCompressorMeterFrame(event.data)
      if (!frame) return
      lastFrame = frame
      for (const listener of meterListeners) listener(frame)
    }
    setCompressorMeteringEnabled(chain.workletNode, meterListeners.size > 0)
  }

  return {
    chain: () => compressor,
    set: async (ctx, params) => {
      pendingSets++
      try {
        const normalized = normalizeCompressorParams(params)
        const nextSignature = serializeCompressorParams(normalized)
        if (signature === nextSignature) return { changed: false, requiresRoutingRebuild: false }
        const requiresRoutingRebuild = enabled !== normalized.enabled && (enabled !== null || normalized.enabled)
        const currentToken = ++token
        if (!normalized.enabled) {
          if (compressor) {
            disconnectCompressorChain(compressor)
            compressor = null
          }
          lastFrame = null
          signature = nextSignature
          enabled = false
          return { changed: true, requiresRoutingRebuild }
        }
        if (!compressor) {
          const next = await createCompressorNodeChain(ctx, normalized).catch(() => null)
          if (!next) {
            if (currentToken === token) {
              if (compressor) {
                disconnectCompressorChain(compressor)
                compressor = null
              }
              enabled = false
            }
            return { changed: false, requiresRoutingRebuild: false }
          }
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
      } finally {
        pendingSets--
      }
    },
    subscribeMeter: (listener) => {
      const hadListeners = meterListeners.size > 0
      meterListeners.add(listener)
      if (lastFrame) listener(lastFrame)
      if (!hadListeners && compressor) setCompressorMeteringEnabled(compressor.workletNode, true)
      return () => {
        meterListeners.delete(listener)
        if (meterListeners.size === 0 && compressor) setCompressorMeteringEnabled(compressor.workletNode, false)
      }
    },
    isIdle: () => pendingSets === 0 && !compressor && meterListeners.size === 0,
    close: () => {
      token++
      signature = null
      enabled = null
      lastFrame = null
      if (compressor) {
        disconnectCompressorChain(compressor)
        compressor = null
      }
    },
  }
}
