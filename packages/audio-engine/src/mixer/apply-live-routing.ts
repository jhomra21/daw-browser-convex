import { assertDefined } from '@daw-browser/shared'
import type { ResolvedMixerGraph } from './types'
import { createMixerRoutingPlan } from './graph-contract'
import { MASTER_ROUTE_TARGET, mixerRouteKey, resolveMixerTiming } from './resolve-timing'

type LiveTrackNodes = {
  input: GainNode
  postFx: GainNode
  gain: GainNode
  output: GainNode
}

export type LiveMixerEdgeRuntime = {
  source: AudioNode
  target: AudioNode
  delay: DelayNode
  gain?: GainNode
}

type ApplyLiveMixerGraphOptions = {
  graph: ResolvedMixerGraph
  masterInput: GainNode
  trackNodes: Map<string, LiveTrackNodes>
  edgeRuntimes: Map<string, LiveMixerEdgeRuntime>
  staticGainSync?: ReadonlyMap<string, { gain: boolean; outputGain: boolean }>
  createGain: () => GainNode
  createDelay: () => DelayNode
  currentTime: number
  sampleRate: number
  bpm?: number
  reconnectTrackMeters: (trackId: string, output: GainNode) => void
}

const disconnectEdge = (edge: LiveMixerEdgeRuntime) => {
  try { edge.source.disconnect(edge.gain ?? edge.delay) } catch {}
  try { edge.gain?.disconnect(edge.delay) } catch {}
  try { edge.delay.disconnect(edge.target) } catch {}
  try { edge.gain?.disconnect() } catch {}
  try { edge.delay.disconnect() } catch {}
}

const updateDelay = (delay: DelayNode, seconds: number, currentTime: number) => {
  delay.delayTime.cancelScheduledValues(currentTime)
  delay.delayTime.setValueAtTime(delay.delayTime.value, currentTime)
  delay.delayTime.linearRampToValueAtTime(seconds, currentTime + 0.01)
}

export function applyLiveMixerGraph(options: ApplyLiveMixerGraphOptions) {
  const plan = createMixerRoutingPlan(options.graph)
  const timing = resolveMixerTiming(options.graph, options.sampleRate, options.bpm)
  options.masterInput.gain.value = plan.masterVolume
  const activeEdgeIds = new Set<string>()

  for (const channel of plan.channels) {
    const channelId = channel.channelId
    const nodes = assertDefined(
      options.trackNodes.get(channelId),
      `Missing live mixer nodes for track ${channelId}`,
    )

    const staticGainSync = options.staticGainSync?.get(channelId)
    if (!options.staticGainSync || staticGainSync?.gain) nodes.gain.gain.value = channel.gain
    if (!options.staticGainSync || staticGainSync?.outputGain) nodes.output.gain.value = channel.outputGain
    nodes.postFx.connect(nodes.gain)
    nodes.gain.connect(nodes.output)
    const targetNodes = channel.outputTargetId
      ? assertDefined(
        options.trackNodes.get(channel.outputTargetId),
        `Missing output target nodes for track ${channel.outputTargetId}`,
      )
      : undefined
    const outputTarget = targetNodes?.input ?? options.masterInput
    const outputTargetId = channel.outputTargetId ?? MASTER_ROUTE_TARGET
    const outputEdgeId = mixerRouteKey(channelId, outputTargetId, 'output')
    activeEdgeIds.add(outputEdgeId)
    const outputDelaySeconds = (timing.routeDelayFrames.get(outputEdgeId) ?? 0) / options.sampleRate
    const existingOutputEdge = options.edgeRuntimes.get(outputEdgeId)
    if (existingOutputEdge) {
      updateDelay(existingOutputEdge.delay, outputDelaySeconds, options.currentTime)
    } else {
      const delay = options.createDelay()
      delay.delayTime.value = outputDelaySeconds
      nodes.output.connect(delay)
      delay.connect(outputTarget)
      options.edgeRuntimes.set(outputEdgeId, { source: nodes.output, target: outputTarget, delay })
    }

    for (const send of channel.sends) {
      const target = assertDefined(
        options.trackNodes.get(send.targetId),
        `Missing send target nodes for track ${send.targetId}`,
      )
      const sendSource = send.tap === 'pre-fx'
        ? nodes.input
        : send.tap === 'pre-fader'
          ? nodes.postFx
          : nodes.output
      const edgeId = mixerRouteKey(channelId, send.targetId, 'send', send.tap)
      activeEdgeIds.add(edgeId)
      const delaySeconds = (timing.routeDelayFrames.get(edgeId) ?? 0) / options.sampleRate
      const existing = options.edgeRuntimes.get(edgeId)
      if (existing) {
        const gain = assertDefined(existing.gain, `Missing live mixer send gain for edge ${edgeId}`)
        gain.gain.value = send.amount
        updateDelay(existing.delay, delaySeconds, options.currentTime)
      } else {
        const sendGain = options.createGain()
        const delay = options.createDelay()
        sendGain.gain.value = send.amount
        delay.delayTime.value = delaySeconds
        sendSource.connect(sendGain)
        sendGain.connect(delay)
        delay.connect(target.input)
        options.edgeRuntimes.set(edgeId, { source: sendSource, target: target.input, gain: sendGain, delay })
      }
    }

    options.reconnectTrackMeters(channelId, nodes.output)
  }

  for (const [edgeId, edge] of Array.from(options.edgeRuntimes.entries())) {
    if (activeEdgeIds.has(edgeId)) continue
    disconnectEdge(edge)
    options.edgeRuntimes.delete(edgeId)
  }
}

export const clearLiveMixerEdges = (edges: Map<string, LiveMixerEdgeRuntime>) => {
  for (const edge of edges.values()) disconnectEdge(edge)
  edges.clear()
}

export const removeLiveMixerEdgesForNodes = (
  edges: Map<string, LiveMixerEdgeRuntime>,
  nodes: ReadonlySet<AudioNode>,
) => {
  for (const [edgeId, edge] of Array.from(edges.entries())) {
    if (!nodes.has(edge.source) && !nodes.has(edge.target)) continue
    disconnectEdge(edge)
    edges.delete(edgeId)
  }
}
