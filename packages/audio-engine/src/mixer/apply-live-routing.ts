import { assertDefined } from '@daw-browser/shared'
import type { ResolvedMixerGraph } from './types'
import { createMixerRoutingPlan } from './graph-contract'
import { MASTER_ROUTE_TARGET, mixerRouteKey, resolveMixerTiming } from './resolve-timing'
import { LIVE_GAIN_RAMP_SEC, rampAudioParam, setAudioParamValue } from '../audio-param-ramp'

type LiveTrackNodes = {
  input: GainNode
  postFx: GainNode
  mute?: GainNode
  gain: GainNode
  output: GainNode
}

export type LiveMixerEdgeRuntime = {
  source: AudioNode
  target: AudioNode
  delay: DelayNode
  gain?: GainNode
  fadeEndTime?: number
  releaseResources?: Array<() => void>
}

type ApplyLiveMixerGraphOptions = {
  graph: ResolvedMixerGraph
  masterInput: GainNode
  trackNodes: Map<string, LiveTrackNodes>
  edgeRuntimes: Map<string, LiveMixerEdgeRuntime>
  staticGainSync?: ReadonlyMap<string, { gain: boolean; outputGain: boolean; muteGain: boolean; created?: boolean }>
  automatedVolumeTargets?: ReadonlySet<string>
  createGain: () => GainNode
  createDelay: () => DelayNode
  observeEdgeResource?: (node: AudioNode) => () => void
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
  for (const release of edge.releaseResources ?? []) release()
  edge.releaseResources = []
}

const initializedMasterInputs = new WeakSet<GainNode>()

const sendEdgeId = (sourceId: string, targetId: string, tap?: 'pre-fx' | 'pre-fader' | 'post-fader') =>
  mixerRouteKey(sourceId, targetId, 'send', tap ?? 'post-fader')

const updateDelay = (delay: DelayNode, seconds: number, currentTime: number) => {
  delay.delayTime.cancelScheduledValues(currentTime)
  delay.delayTime.setValueAtTime(delay.delayTime.value, currentTime)
  delay.delayTime.linearRampToValueAtTime(seconds, currentTime + 0.01)
}

export function applyLiveMixerGraph(options: ApplyLiveMixerGraphOptions) {
  const plan = createMixerRoutingPlan(options.graph)
  const timing = resolveMixerTiming(options.graph, options.sampleRate, options.bpm)
  if (initializedMasterInputs.has(options.masterInput)) {
    if (!options.automatedVolumeTargets?.has('master')) {
      rampAudioParam(options.masterInput.gain, plan.masterVolume, options.currentTime)
    }
  } else {
    if (!options.automatedVolumeTargets?.has('master')) {
      setAudioParamValue(options.masterInput.gain, plan.masterVolume)
    }
    initializedMasterInputs.add(options.masterInput)
  }
  const activeEdgeIds = new Set<string>()
  const resolvedChannels = new Map(options.graph.channels.map((entry) => [entry.channel.id, entry]))

  for (const channel of plan.channels) {
    const channelId = channel.channelId
    const resolvedChannel = resolvedChannels.get(channelId)
    const nodes = assertDefined(
      options.trackNodes.get(channelId),
      `Missing live mixer nodes for track ${channelId}`,
    )
    const staticGainSync = options.staticGainSync?.get(channelId)
    const channelGain = resolvedChannel && Number.isFinite(resolvedChannel.channel.volume)
      ? resolvedChannel.channel.volume
      : 0
    const muteGain = resolvedChannel?.channel.muted ? 0 : 1
    if (!options.staticGainSync) {
      setAudioParamValue(nodes.gain.gain, channelGain)
      setAudioParamValue(nodes.output.gain, channel.outputGain)
    } else if (staticGainSync?.gain) {
      if (!options.automatedVolumeTargets?.has(channelId)) {
        if (staticGainSync.created) setAudioParamValue(nodes.gain.gain, channelGain)
        else rampAudioParam(nodes.gain.gain, channelGain, options.currentTime)
      }
    }
    if (options.staticGainSync && staticGainSync?.outputGain) {
      if (staticGainSync.created) setAudioParamValue(nodes.output.gain, channel.outputGain)
      else rampAudioParam(nodes.output.gain, channel.outputGain, options.currentTime)
    }
    if (options.staticGainSync && staticGainSync?.muteGain) {
      if (nodes.mute) {
        if (staticGainSync.created) setAudioParamValue(nodes.mute.gain, muteGain)
        else rampAudioParam(nodes.mute.gain, muteGain, options.currentTime)
      }
    }
    nodes.postFx.connect(nodes.mute ?? nodes.gain)
    nodes.mute?.connect(nodes.gain)
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
      options.edgeRuntimes.set(outputEdgeId, {
        source: nodes.output,
        target: outputTarget,
        delay,
        releaseResources: options.observeEdgeResource ? [options.observeEdgeResource(delay)] : [],
      })
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
      const edgeId = sendEdgeId(channelId, send.targetId, send.tap)
      activeEdgeIds.add(edgeId)
      const delaySeconds = (timing.routeDelayFrames.get(edgeId) ?? 0) / options.sampleRate
      const sendGainValue = resolvedChannel?.channel.muted ? 0 : send.amount
      const existing = options.edgeRuntimes.get(edgeId)
      if (existing) {
        delete existing.fadeEndTime
        const gain = assertDefined(existing.gain, `Missing live mixer send gain for edge ${edgeId}`)
        rampAudioParam(gain.gain, sendGainValue, options.currentTime)
        updateDelay(existing.delay, delaySeconds, options.currentTime)
      } else {
        const sendGain = options.createGain()
        const delay = options.createDelay()
        setAudioParamValue(sendGain.gain, 0)
        rampAudioParam(sendGain.gain, sendGainValue, options.currentTime)
        delay.delayTime.value = delaySeconds
        sendSource.connect(sendGain)
        sendGain.connect(delay)
        delay.connect(target.input)
        options.edgeRuntimes.set(edgeId, {
          source: sendSource,
          target: target.input,
          gain: sendGain,
          delay,
          releaseResources: options.observeEdgeResource
            ? [options.observeEdgeResource(sendGain), options.observeEdgeResource(delay)]
            : [],
        })
      }
    }

    options.reconnectTrackMeters(channelId, nodes.output)
  }

  for (const [edgeId, edge] of Array.from(options.edgeRuntimes.entries())) {
    if (activeEdgeIds.has(edgeId)) continue
    if (edge.gain) {
      if (edge.fadeEndTime === undefined) {
        rampAudioParam(edge.gain.gain, 0, options.currentTime)
        // Keep the edge connected through its scheduled fade, then clean it on the next routing pass.
        edge.fadeEndTime = options.currentTime + LIVE_GAIN_RAMP_SEC
      }
      if (options.currentTime < edge.fadeEndTime) continue
    }
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
