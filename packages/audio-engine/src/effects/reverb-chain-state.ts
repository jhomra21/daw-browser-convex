import type { ReverbParamsLite } from '@daw-browser/shared'
import { applyReverbNodeChainParams, createReverbNodeChain, disconnectReverbChain, type ReverbNodeChain } from './chain'
import { serializeReverbParams } from '@daw-browser/shared'

export type ReverbChainState = {
  chain: () => ReverbNodeChain | null
  set: (
    ctx: BaseAudioContext,
    params: ReverbParamsLite,
  ) => Promise<{
    changed: boolean
    requiresRoutingRebuild: boolean
  }>
  close: () => void
}

export function createReverbChainState(): ReverbChainState {
  let reverb: ReverbNodeChain | null = null
  let signature: string | null = null
  let topologySignature: 'enabled' | 'disabled' | null = null

  return {
    chain: () => reverb,
    set: async (ctx, params) => {
      const nextSignature = serializeReverbParams(params)
      const topology = params.enabled ? 'enabled' : 'disabled'
      const previousTopology = topologySignature
      if (signature === nextSignature) {
        return {
          changed: false,
          requiresRoutingRebuild: false,
        }
      }
      const requiresRoutingRebuild = previousTopology !== topology && (previousTopology !== null || topology === 'enabled')

      if (topology === 'disabled') {
        if (reverb) {
          disconnectReverbChain(reverb)
          reverb = null
        }
        signature = nextSignature
        topologySignature = topology
        return {
          changed: true,
          requiresRoutingRebuild,
        }
      }

      if (!reverb) reverb = await createReverbNodeChain(ctx, params)
      else applyReverbNodeChainParams(reverb, params)
      signature = nextSignature
      topologySignature = topology
      return {
        changed: true,
        requiresRoutingRebuild,
      }
    },
    close: () => {
      signature = null
      topologySignature = null
      if (reverb) {
        disconnectReverbChain(reverb)
        reverb = null
      }
    },
  }
}
