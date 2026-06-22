import { normalizeEqParams, serializeNormalizedEqParams, type EqParamsLite, type ReverbParamsLite } from '@daw-browser/shared'
import { connectParallelFxChain, createReverbNodeChain, disconnectAudioNodes, disconnectReverbChain, applyReverbNodeChainParams, type CreateReverbImpulseResponse, type ReverbNodeChain } from './effects/chain'
import { applyEqNodeParams, createEqNodes, getEqTopologySignature } from './effects/dsp'
import { getAppliedReverbSignature, getReverbTopologySignature } from './effects/reverb-signature'
import { applyLiveMixerGraph } from './mixer/apply-live-routing'
import { createMixerChannels } from './mixer/channels'
import { resolveMixerGraph } from './mixer/resolve-routing'
import type { Track } from '@daw-browser/timeline-core/types'

type RuntimeTrack = Track<AudioBuffer>

type TrackNodeGroup = {
  input: GainNode
  gain: GainNode
  output: GainNode
}

type LiveMixerRuntimeOptions = {
  ensureAudio: () => void
  getAudioContext: () => AudioContext | null
  getMasterInput: () => GainNode | null
  getDestination: () => AudioDestinationNode | null
  createImpulseResponse: CreateReverbImpulseResponse
  reconnectTrackMeters: (trackId: string, output: GainNode, isCurrentOutput: () => boolean) => void
  disposeTrackMeters: (trackId: string) => void
  disposeSynthTrack: (trackId: string) => void
}

export function createLiveMixerRuntime(options: LiveMixerRuntimeOptions) {
  const inputs = new Map<string, GainNode>()
  const gains = new Map<string, GainNode>()
  const outputs = new Map<string, GainNode>()
  const sendGains = new Map<string, Map<string, GainNode>>()
  const routingSignatures = new Map<string, string>()
  const eqChains = new Map<string, BiquadFilterNode[]>()
  const pendingEqParams = new Map<string, EqParamsLite>()
  const eqSignatures = new Map<string, string>()
  const eqTopologySignatures = new Map<string, string>()
  const reverbs = new Map<string, ReverbNodeChain>()
  const pendingReverbParams = new Map<string, ReverbParamsLite>()
  const reverbSignatures = new Map<string, string>()
  const reverbTopologySignatures = new Map<string, string>()

  const cleanupTrackSendGains = (trackId: string) => {
    const sendMap = sendGains.get(trackId)
    if (!sendMap) return
    disconnectAudioNodes(Array.from(sendMap.values()))
    sendGains.delete(trackId)
  }

  const rebuildTrackRouting = (trackId: string, nodes: Pick<TrackNodeGroup, 'input' | 'gain'>) => {
    disconnectAudioNodes([nodes.input])
    connectParallelFxChain(nodes.input, nodes.gain, eqChains.get(trackId) || [], reverbs.get(trackId))
  }

  const ensureTrackNodes = (trackId: string): TrackNodeGroup => {
    options.ensureAudio()
    const ctx = options.getAudioContext()
    if (!ctx) {
      throw new Error('Audio runtime was not initialized')
    }

    let input = inputs.get(trackId)
    const createdInput = !input
    if (!input) {
      input = ctx.createGain()
      inputs.set(trackId, input)
    }

    let gain = gains.get(trackId)
    if (!gain) {
      gain = ctx.createGain()
      gain.gain.value = 1
      gains.set(trackId, gain)
    }

    let output = outputs.get(trackId)
    if (!output) {
      output = ctx.createGain()
      output.gain.value = 1
      outputs.set(trackId, output)
    }

    if (createdInput) {
      disconnectAudioNodes([input])
      input.connect(gain)

      const pendingEq = pendingEqParams.get(trackId)
      if (pendingEq) {
        pendingEqParams.delete(trackId)
        applyTrackEq(ctx, trackId, pendingEq)
      }

      const pendingReverb = pendingReverbParams.get(trackId)
      if (pendingReverb) {
        pendingReverbParams.delete(trackId)
        setTrackReverb(trackId, pendingReverb)
      }
    }

    return { input, gain, output }
  }

  const applyTrackEq = (ctx: AudioContext, trackId: string, normalized: EqParamsLite) => {
    const signature = serializeNormalizedEqParams(normalized)
    if (eqSignatures.get(trackId) === signature) return
    const trackNodes = ensureTrackNodes(trackId)
    const topologySignature = getEqTopologySignature(normalized)
    const old = eqChains.get(trackId)
    if (old && eqTopologySignatures.get(trackId) === topologySignature) {
      applyEqNodeParams(old, normalized)
      eqSignatures.set(trackId, signature)
      return
    }
    if (old) disconnectAudioNodes(old)
    const destination = options.getDestination()
    const targetChannels = destination?.maxChannelCount ?? ctx.destination.maxChannelCount ?? 2
    const eqNodes = createEqNodes(ctx, normalized, targetChannels)
    eqChains.set(trackId, eqNodes)
    eqSignatures.set(trackId, signature)
    eqTopologySignatures.set(trackId, topologySignature)
    rebuildTrackRouting(trackId, trackNodes)
  }

  const setTrackEq = (trackId: string, params: EqParamsLite) => {
    const normalized = normalizeEqParams(params)
    const ctx = options.getAudioContext()
    if (!ctx) {
      pendingEqParams.set(trackId, normalized)
      return
    }
    applyTrackEq(ctx, trackId, normalized)
  }

  const setTrackReverb = (trackId: string, params: ReverbParamsLite) => {
    const ctx = options.getAudioContext()
    if (!ctx) {
      pendingReverbParams.set(trackId, params)
      return
    }
    const signature = getAppliedReverbSignature(params)
    if (reverbSignatures.get(trackId) === signature) return
    const topologySignature = getReverbTopologySignature(params)
    const previousTopologySignature = reverbTopologySignatures.get(trackId)
    let reverb = reverbs.get(trackId)
    if (topologySignature === 'disabled') {
      if (reverb) {
        disconnectReverbChain(reverb)
        reverbs.delete(trackId)
      }
      reverbSignatures.set(trackId, signature)
      reverbTopologySignatures.set(trackId, topologySignature)
      if (previousTopologySignature !== undefined && previousTopologySignature !== topologySignature) {
        const trackNodes = ensureTrackNodes(trackId)
        rebuildTrackRouting(trackId, trackNodes)
      }
      return
    }
    const trackNodes = ensureTrackNodes(trackId)
    if (!reverb) {
      reverb = createReverbNodeChain(ctx, params, options.createImpulseResponse)
      reverbs.set(trackId, reverb)
    } else {
      applyReverbNodeChainParams(reverb, params, options.createImpulseResponse)
    }
    reverbSignatures.set(trackId, signature)
    reverbTopologySignatures.set(trackId, topologySignature)
    if (previousTopologySignature !== topologySignature && (previousTopologySignature !== undefined || topologySignature === 'enabled')) {
      rebuildTrackRouting(trackId, trackNodes)
    }
  }

  const disposeTrack = (trackId: string) => {
    const gain = gains.get(trackId)
    disconnectAudioNodes([gain])
    gains.delete(trackId)
    routingSignatures.delete(trackId)
    cleanupTrackSendGains(trackId)

    const input = inputs.get(trackId)
    disconnectAudioNodes([input])
    inputs.delete(trackId)

    const output = outputs.get(trackId)
    disconnectAudioNodes([output])
    outputs.delete(trackId)

    const nodes = eqChains.get(trackId)
    if (nodes) disconnectAudioNodes(nodes)
    eqChains.delete(trackId)
    eqSignatures.delete(trackId)
    eqTopologySignatures.delete(trackId)

    const reverb = reverbs.get(trackId)
    if (reverb) disconnectReverbChain(reverb)
    reverbs.delete(trackId)
    reverbSignatures.delete(trackId)
    reverbTopologySignatures.delete(trackId)
    pendingEqParams.delete(trackId)
    pendingReverbParams.delete(trackId)

    options.disposeSynthTrack(trackId)
    options.disposeTrackMeters(trackId)
  }

  const clear = () => {
    for (const trackId of Array.from(gains.keys())) disposeTrack(trackId)
    for (const trackId of Array.from(inputs.keys())) disposeTrack(trackId)
    sendGains.clear()
    outputs.clear()
    gains.clear()
    routingSignatures.clear()
    inputs.clear()
    eqChains.clear()
    pendingEqParams.clear()
    eqSignatures.clear()
    eqTopologySignatures.clear()
    reverbs.clear()
    pendingReverbParams.clear()
    reverbSignatures.clear()
    reverbTopologySignatures.clear()
  }

  return {
    ensureTrackInput: (trackId: string) => ensureTrackNodes(trackId).input,
    getTrackOutput: (trackId: string) => outputs.get(trackId),
    updateTrackGains: (tracks: RuntimeTrack[]) => {
      const ctx = options.getAudioContext()
      const masterInput = options.getMasterInput()
      if (!ctx || !masterInput) return

      const graph = resolveMixerGraph({ channels: createMixerChannels(tracks) })
      const trackNodes = new Map<string, TrackNodeGroup>()
      for (const resolvedTrack of graph.channels) {
        const channelId = resolvedTrack.channel.id
        trackNodes.set(channelId, ensureTrackNodes(channelId))
      }

      const activeMeterTrackIds = new Set<string>(
        graph.channels
          .filter((entry) => entry.outputGain > 0 || entry.sends.length > 0)
          .map((entry) => entry.channel.id),
      )
      applyLiveMixerGraph({
        graph,
        masterInput,
        trackNodes,
        trackSendGains: sendGains,
        trackRoutingSignatures: routingSignatures,
        createGain: () => ctx.createGain(),
        reconnectTrackMeters: (trackId, gain) => {
          if (!activeMeterTrackIds.has(trackId)) {
            options.disposeTrackMeters(trackId)
            return
          }
          options.reconnectTrackMeters(trackId, gain, () => outputs.get(trackId) === gain)
        },
      })

      const activeTrackIds = new Set<string>(graph.channels.map((entry) => entry.channel.id))
      for (const id of Array.from(gains.keys())) {
        if (activeTrackIds.has(id)) continue
        disposeTrack(id)
      }
    },
    previewTrackVolume: (trackId: string, volume: number, muted: boolean) => {
      const gain = gains.get(trackId)
      if (!gain) return
      const next = !muted && Number.isFinite(volume) ? Math.max(0, volume) : 0
      try { gain.gain.value = next } catch {}
    },
    setTrackEq,
    setTrackReverb,
    disposeTrack,
    clear,
  }
}
