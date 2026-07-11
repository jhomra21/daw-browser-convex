import type { ResolvedMixerGraph } from './types'

export type MixerRoutingPlan = {
  channels: readonly {
    channelId: string
    gain: number
    outputGain: number
    outputTargetId?: string
    sends: readonly { targetId: string; amount: number }[]
  }[]
  masterVolume: number
}

export const createMixerRoutingPlan = (graph: ResolvedMixerGraph): MixerRoutingPlan => ({
  channels: graph.channels.map((entry) => ({
    channelId: entry.channel.id,
    gain: entry.gain,
    outputGain: entry.outputGain,
    outputTargetId: entry.outputTargetId,
    sends: entry.sends.map((send) => ({ targetId: send.targetId, amount: send.amount })),
  })),
  masterVolume: graph.master.volume,
})
