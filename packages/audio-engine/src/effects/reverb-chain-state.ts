import type { ReverbParamsLite } from '@daw-browser/shared'
import { applyReverbNodeChainParams, createReverbNodeChain, disconnectReverbChain, type CreateReverbImpulseResponse, type ReverbNodeChain } from './chain'
import { getAppliedReverbSignature, getReverbTopologySignature } from './reverb-signature'

export type ReverbChainState = {
  chain: () => ReverbNodeChain | null
  set: (
    ctx: BaseAudioContext,
    params: ReverbParamsLite,
    createImpulseResponse: CreateReverbImpulseResponse,
  ) => {
    changed: boolean
    requiresRoutingRebuild: boolean
  }
  close: () => void
}

export function createReverbChainState(): ReverbChainState {
  let reverb: ReverbNodeChain | null = null
  let signature: string | null = null
  let topologySignature: 'enabled' | 'disabled' | null = null

  return {
    chain: () => reverb,
    set: (ctx, params, createImpulseResponse) => {
      const nextSignature = getAppliedReverbSignature(params)
      const topology = getReverbTopologySignature(params)
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

      if (!reverb) reverb = createReverbNodeChain(ctx, params, createImpulseResponse)
      else applyReverbNodeChainParams(reverb, params, createImpulseResponse)
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
