import { assert } from '@daw-browser/shared'
import type { ResolvedMixerGraph } from './types'
import { createMixerRoutingPlan, type MixerRoutingPlan } from './graph-contract'

type LiveTrackNodes = {
  input: GainNode
  gain: GainNode
  output: GainNode
}

type ApplyLiveMixerGraphOptions = {
  graph: ResolvedMixerGraph
  masterInput: GainNode
  trackNodes: Map<string, LiveTrackNodes>
  trackSendGains: Map<string, Map<string, GainNode>>
  trackRoutingSignatures: Map<string, string>
  createGain: () => GainNode
  reconnectTrackMeters: (trackId: string, output: GainNode) => void
}

const getRoutingSignature = (channel: MixerRoutingPlan['channels'][number]) =>
  [
    channel.outputTargetId ?? '',
    ...channel.sends.map((send) => send.targetId).sort(),
  ].join('|')

export function applyLiveMixerGraph(options: ApplyLiveMixerGraphOptions) {
  const plan = createMixerRoutingPlan(options.graph)
  options.masterInput.gain.value = plan.masterVolume
  const activeTrackIds = new Set<string>(plan.channels.map((channel) => channel.channelId))

  for (const channel of plan.channels) {
    const channelId = channel.channelId
    const nodes = options.trackNodes.get(channelId)
    assert(nodes, `Missing live mixer nodes for track ${channelId}`)

    nodes.gain.gain.value = channel.gain
    nodes.output.gain.value = channel.outputGain
    const routingSignature = getRoutingSignature(channel)
    const shouldReconnect = options.trackRoutingSignatures.get(channelId) !== routingSignature
    const targetNodes = channel.outputTargetId
      ? options.trackNodes.get(channel.outputTargetId)
      : undefined
    if (channel.outputTargetId) {
      assert(targetNodes, `Missing output target nodes for track ${channel.outputTargetId}`)
    }
    const outputTarget = targetNodes?.input ?? options.masterInput
    if (shouldReconnect) {
      try { nodes.gain.disconnect() } catch {}
      try { nodes.output.disconnect() } catch {}
      nodes.gain.connect(nodes.output)
      nodes.output.connect(outputTarget)
      options.trackRoutingSignatures.set(channelId, routingSignature)
    }

    let sendMap = options.trackSendGains.get(channelId)

    const activeSends = new Set<string>()
    for (const send of channel.sends) {
      const target = options.trackNodes.get(send.targetId)
      assert(target, `Missing send target nodes for track ${send.targetId}`)
      activeSends.add(send.targetId)
      if (!sendMap) {
        sendMap = new Map<string, GainNode>()
        options.trackSendGains.set(channelId, sendMap)
      }
      let sendGain = sendMap.get(send.targetId)
      if (!sendGain) {
        sendGain = options.createGain()
        sendMap.set(send.targetId, sendGain)
        nodes.gain.connect(sendGain)
        sendGain.connect(target.input)
      } else if (shouldReconnect) {
        try { sendGain.disconnect() } catch {}
        nodes.gain.connect(sendGain)
        sendGain.connect(target.input)
      }
      sendGain.gain.value = send.amount
    }

    if (sendMap) {
      for (const [targetId, sendGain] of Array.from(sendMap.entries())) {
        if (activeSends.has(targetId)) continue
        try { sendGain.disconnect() } catch {}
        sendMap.delete(targetId)
      }
      if (sendMap.size === 0) options.trackSendGains.delete(channelId)
    }

    if (shouldReconnect) options.reconnectTrackMeters(channelId, nodes.output)
  }

  for (const [trackId, sendMap] of Array.from(options.trackSendGains.entries())) {
    if (activeTrackIds.has(trackId)) continue
    for (const sendGain of sendMap.values()) {
      try { sendGain.disconnect() } catch {}
    }
    options.trackSendGains.delete(trackId)
    options.trackRoutingSignatures.delete(trackId)
  }
}
