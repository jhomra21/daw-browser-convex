import type { ResolvedMixerGraph } from './types'

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

const getRoutingSignature = (resolvedTrack: ResolvedMixerGraph['channels'][number]) =>
  [
    resolvedTrack.outputTargetId ?? '',
    ...resolvedTrack.sends.map((send) => send.targetId).sort(),
  ].join('|')

export function applyLiveMixerGraph(options: ApplyLiveMixerGraphOptions) {
  const activeTrackIds = new Set<string>(options.graph.channels.map((entry) => entry.channel.id))

  for (const resolvedTrack of options.graph.channels) {
    const channelId = resolvedTrack.channel.id
    const nodes = options.trackNodes.get(channelId)!

    nodes.gain.gain.value = resolvedTrack.gain
    nodes.output.gain.value = resolvedTrack.outputGain
    const routingSignature = getRoutingSignature(resolvedTrack)
    const shouldReconnect = options.trackRoutingSignatures.get(channelId) !== routingSignature
    const outputTarget = resolvedTrack.outputTargetId
      ? options.trackNodes.get(resolvedTrack.outputTargetId)!.input
      : options.masterInput
    if (shouldReconnect) {
      try { nodes.gain.disconnect() } catch {}
      try { nodes.output.disconnect() } catch {}
      nodes.gain.connect(nodes.output)
      nodes.output.connect(outputTarget)
      options.trackRoutingSignatures.set(channelId, routingSignature)
    }

    let sendMap = options.trackSendGains.get(channelId)

    const activeSends = new Set<string>()
    for (const send of resolvedTrack.sends) {
      const target = options.trackNodes.get(send.targetId)
      if (!target) continue
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
