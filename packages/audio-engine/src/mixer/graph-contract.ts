import type { ResolvedMixerGraph } from './types'

type MixerRoutingPlan = {
  channels: readonly {
    channelId: string
    gain: number
    outputGain: number
    outputTargetId?: string
    sends: readonly { targetId: string; amount: number; tap: 'pre-fx' | 'pre-fader' | 'post-fader' }[]
  }[]
  masterVolume: number
}

export const createMixerRoutingPlan = (graph: ResolvedMixerGraph): MixerRoutingPlan => ({
  channels: graph.channels.map((entry) => ({
    channelId: entry.channel.id,
    gain: entry.gain,
    outputGain: entry.outputGain,
    outputTargetId: entry.outputTargetId,
    sends: entry.sends.map((send) => ({
      targetId: send.targetId,
      amount: send.amount,
      tap: send.tap ?? 'post-fader',
    })),
  })),
  masterVolume: graph.master.volume,
})
