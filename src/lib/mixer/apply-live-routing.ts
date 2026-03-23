import type { ResolvedMixerGraph } from '~/lib/mixer/types'

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
  createGain: () => GainNode
  reconnectTrackMeters: (trackId: string, output: GainNode) => void
  cleanupTrackSendGains?: (trackId: string) => void
}

export function applyLiveMixerGraph(options: ApplyLiveMixerGraphOptions) {
  const activeTrackIds = new Set(options.graph.channels.map((entry) => entry.channel.id))

  for (const resolvedTrack of options.graph.channels) {
    const channelId = resolvedTrack.channel.id
    const nodes = options.trackNodes.get(channelId)
    if (!nodes) continue

    nodes.gain.gain.value = resolvedTrack.gain
    nodes.output.gain.value = resolvedTrack.outputGain
    try { nodes.gain.disconnect() } catch {}
    try { nodes.output.disconnect() } catch {}
    const outputTarget = resolvedTrack.outputTargetId ? options.trackNodes.get(resolvedTrack.outputTargetId)?.input : undefined
    nodes.gain.connect(nodes.output)
    nodes.output.connect(outputTarget ?? options.masterInput)

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
      }
      sendGain.gain.value = send.amount
      try { sendGain.disconnect() } catch {}
      nodes.gain.connect(sendGain)
      sendGain.connect(target.input)
    }

    if (sendMap) {
      for (const [targetId, sendGain] of Array.from(sendMap.entries())) {
        if (activeSends.has(targetId)) continue
        try { sendGain.disconnect() } catch {}
        sendMap.delete(targetId)
      }
      if (sendMap.size === 0) options.trackSendGains.delete(channelId)
    }

    options.reconnectTrackMeters(channelId, nodes.output)
  }

  for (const [trackId, sendMap] of Array.from(options.trackSendGains.entries())) {
    if (activeTrackIds.has(trackId)) continue
    for (const sendGain of sendMap.values()) {
      try { sendGain.disconnect() } catch {}
    }
    options.trackSendGains.delete(trackId)
    options.cleanupTrackSendGains?.(trackId)
  }
}
