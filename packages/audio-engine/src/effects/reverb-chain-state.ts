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
  let generation = 0

  return {
    chain: () => reverb,
    set: async (ctx, params) => {
      // Every request outdates the construction an earlier one still awaits, an equal one that returns early included.
      const current = ++generation
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

      // The signature names what the node holds only once every write has landed.
      signature = null
      if (!reverb) {
        const created = await createReverbNodeChain(ctx, params)
        if (current !== generation) {
          disconnectReverbChain(created)
          return { changed: false, requiresRoutingRebuild: false }
        }
        reverb = created
      } else applyReverbNodeChainParams(reverb, params)
      signature = nextSignature
      topologySignature = topology
      return {
        changed: true,
        requiresRoutingRebuild,
      }
    },
    close: () => {
      generation++
      signature = null
      topologySignature = null
      if (reverb) {
        disconnectReverbChain(reverb)
        reverb = null
      }
    },
  }
}
