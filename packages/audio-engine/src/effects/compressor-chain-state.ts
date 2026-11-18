import { normalizeCompressorParams, serializeCompressorParams, type CompressorParamsLite } from '@daw-browser/shared'
import { applyCompressorNodeChainParams, createCompressorNodeChain, disconnectCompressorChain, type CompressorNodeChain } from './chain'
import { readCompressorMeterFrame, setCompressorMeteringEnabled, type CompressorMeterFrame, type CompressorMeterListener } from './compressor-worklet'

export type CompressorChainState = {
  chain: () => CompressorNodeChain | null
  // `unavailable` is present only when the params ask for a compressor and none is running: no chain could be built
  // ('absent'), or the chain that ran failed and its replacement could not be built ('faulted').
  set: (ctx: BaseAudioContext, params: CompressorParamsLite) => Promise<{ changed: boolean; requiresRoutingRebuild: boolean; unavailable?: 'absent' | 'faulted' }>
  subscribeMeter: (listener: CompressorMeterListener) => () => void
  isIdle: () => boolean
  close: () => void
}

export function createCompressorChainState(
  createChain: (ctx: BaseAudioContext, params: CompressorParamsLite) => Promise<CompressorNodeChain> = createCompressorNodeChain,
): CompressorChainState {
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

  const apply = async (ctx: BaseAudioContext, params: CompressorParamsLite) => {
    pendingSets++
    try {
      const normalized = normalizeCompressorParams(params)
      const nextSignature = serializeCompressorParams(normalized)
      // Every request outdates the construction an earlier one still awaits, an equal one that returns early included.
      const currentToken = ++token
      const wasFaulted = compressor?.state === 'faulted'
      if (!wasFaulted && signature === nextSignature) return { changed: false, requiresRoutingRebuild: false }
      if (wasFaulted) signature = null
      const requiresRoutingRebuild = wasFaulted || (enabled !== normalized.enabled && (enabled !== null || normalized.enabled))
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
      if (!compressor || wasFaulted) {
        const previous = compressor
        const next = await createChain(ctx, normalized).catch(() => null)
        if (!next) {
          return { changed: false, requiresRoutingRebuild: false }
        }
        if (currentToken !== token) {
          disconnectCompressorChain(next)
          return { changed: false, requiresRoutingRebuild: false }
        }
        compressor = next
        bindMeterPort(compressor)
        lastFrame = null
        if (previous) disconnectCompressorChain(previous)
      } else {
        applyCompressorNodeChainParams(compressor, normalized)
      }
      signature = nextSignature
      enabled = true
      return { changed: true, requiresRoutingRebuild }
    } finally {
      pendingSets--
    }
  }

  return {
    chain: () => compressor,
    set: async (ctx, params) => {
      const result = await apply(ctx, params)
      if (!normalizeCompressorParams(params).enabled || compressor?.state === 'active') return result
      return { ...result, unavailable: compressor ? 'faulted' : 'absent' }
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
