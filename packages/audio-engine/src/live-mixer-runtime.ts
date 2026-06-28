import { areAudioEffectOrdersEqual, normalizeAudioEffectOrder, normalizeCompressorParams, normalizeEqParams, type AudioEffectKind, type CompressorParamsLite, type DelayParamsLite, serializeNormalizedEqParams, type EqParamsLite, type ReverbParamsLite, type SaturatorParamsLite } from '@daw-browser/shared'
import { connectFxChain, disconnectAudioNodes, type CreateReverbImpulseResponse } from './effects/chain'
import { applyEqNodeParams, createEqNodes, getEqTopologySignature } from './effects/dsp'
import { createCompressorChainState, type CompressorChainState } from './effects/compressor-chain-state'
import type { CompressorMeterListener } from './effects/compressor-worklet'
import { createDelayChainState, type DelayChainState } from './effects/delay-chain-state'
import { createReverbChainState, type ReverbChainState } from './effects/reverb-chain-state'
import { createSaturatorChainState, type SaturatorChainState } from './effects/saturator-chain-state'
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
  const compressorChains = new Map<string, CompressorChainState>()
  const pendingCompressorParams = new Map<string, CompressorParamsLite>()
  const reverbChains = new Map<string, ReverbChainState>()
  const pendingReverbParams = new Map<string, ReverbParamsLite>()
  const saturatorChains = new Map<string, SaturatorChainState>()
  const pendingSaturatorParams = new Map<string, SaturatorParamsLite>()
  const delayChains = new Map<string, DelayChainState>()
  const pendingDelayParams = new Map<string, DelayParamsLite>()
  const trackFxOrders = new Map<string, AudioEffectKind[]>()
  let currentBpm = 120

  const cleanupTrackSendGains = (trackId: string) => {
    const sendMap = sendGains.get(trackId)
    if (!sendMap) return
    disconnectAudioNodes(Array.from(sendMap.values()))
    sendGains.delete(trackId)
  }

  const rebuildTrackRouting = (trackId: string, nodes: Pick<TrackNodeGroup, 'input' | 'gain'>) => {
    disconnectAudioNodes([nodes.input])
    connectFxChain(nodes.input, nodes.gain, {
      eqNodes: eqChains.get(trackId) || [],
      compressorChain: compressorChains.get(trackId)?.chain(),
      saturatorChain: saturatorChains.get(trackId)?.chain(),
      delayChain: delayChains.get(trackId)?.chain(),
      reverbChain: reverbChains.get(trackId)?.chain(),
      order: trackFxOrders.get(trackId),
    })
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

      const pendingCompressor = pendingCompressorParams.get(trackId)
      if (pendingCompressor) {
        pendingCompressorParams.delete(trackId)
        void setTrackCompressor(trackId, pendingCompressor)
      }

      const pendingReverb = pendingReverbParams.get(trackId)
      if (pendingReverb) {
        pendingReverbParams.delete(trackId)
        setTrackReverb(trackId, pendingReverb)
      }
      const pendingSaturator = pendingSaturatorParams.get(trackId)
      if (pendingSaturator) {
        pendingSaturatorParams.delete(trackId)
        setTrackSaturator(trackId, pendingSaturator)
      }
      const pendingDelay = pendingDelayParams.get(trackId)
      if (pendingDelay) {
        pendingDelayParams.delete(trackId)
        setTrackDelay(trackId, pendingDelay)
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
    let reverbState = reverbChains.get(trackId)
    if (!reverbState) {
      reverbState = createReverbChainState()
      reverbChains.set(trackId, reverbState)
    }
    const result = reverbState.set(ctx, params, options.createImpulseResponse)
    if (!result.changed) return
    if (result.requiresRoutingRebuild) {
      const trackNodes = ensureTrackNodes(trackId)
      rebuildTrackRouting(trackId, trackNodes)
    }
  }

  const setTrackCompressor = async (trackId: string, params: CompressorParamsLite) => {
    const normalized = normalizeCompressorParams(params)
    const ctx = options.getAudioContext()
    if (!ctx) {
      pendingCompressorParams.set(trackId, normalized)
      return
    }
    let state = compressorChains.get(trackId)
    if (!state && !normalized.enabled) return
    if (!state) {
      state = createCompressorChainState()
      compressorChains.set(trackId, state)
    }
    const result = await state.set(ctx, normalized)
    if (state.isIdle()) compressorChains.delete(trackId)
    if (result.changed && result.requiresRoutingRebuild) rebuildTrackRouting(trackId, ensureTrackNodes(trackId))
  }

  const setTrackSaturator = (trackId: string, params: SaturatorParamsLite) => {
    const ctx = options.getAudioContext()
    if (!ctx) {
      pendingSaturatorParams.set(trackId, params)
      return
    }
    let state = saturatorChains.get(trackId)
    if (!state) {
      state = createSaturatorChainState()
      saturatorChains.set(trackId, state)
    }
    const result = state.set(ctx, params)
    if (result.changed && result.requiresRoutingRebuild) rebuildTrackRouting(trackId, ensureTrackNodes(trackId))
  }

  const setTrackDelay = (trackId: string, params: DelayParamsLite) => {
    const ctx = options.getAudioContext()
    if (!ctx) {
      pendingDelayParams.set(trackId, params)
      return
    }
    let state = delayChains.get(trackId)
    if (!state) {
      state = createDelayChainState()
      delayChains.set(trackId, state)
    }
    const result = state.set(ctx, params, currentBpm)
    if (result.changed && result.requiresRoutingRebuild) rebuildTrackRouting(trackId, ensureTrackNodes(trackId))
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

    compressorChains.get(trackId)?.close()
    compressorChains.delete(trackId)
    reverbChains.get(trackId)?.close()
    reverbChains.delete(trackId)
    saturatorChains.get(trackId)?.close()
    saturatorChains.delete(trackId)
    delayChains.get(trackId)?.close()
    delayChains.delete(trackId)
    pendingEqParams.delete(trackId)
    pendingCompressorParams.delete(trackId)
    pendingReverbParams.delete(trackId)
    pendingSaturatorParams.delete(trackId)
    pendingDelayParams.delete(trackId)
    trackFxOrders.delete(trackId)

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
    for (const compressorState of compressorChains.values()) compressorState.close()
    compressorChains.clear()
    pendingCompressorParams.clear()
    for (const reverbState of reverbChains.values()) reverbState.close()
    reverbChains.clear()
    pendingReverbParams.clear()
    for (const state of saturatorChains.values()) state.close()
    saturatorChains.clear()
    pendingSaturatorParams.clear()
    for (const state of delayChains.values()) state.close()
    delayChains.clear()
    pendingDelayParams.clear()
    trackFxOrders.clear()
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
    setTrackSaturator,
    setTrackDelay,
    setTrackFxOrder: (trackId: string, order: AudioEffectKind[]) => {
      const normalized = normalizeAudioEffectOrder(order, order)
      if (areAudioEffectOrdersEqual(trackFxOrders.get(trackId), normalized)) return
      trackFxOrders.set(trackId, normalized)
      const input = inputs.get(trackId)
      const gain = gains.get(trackId)
      if (input && gain) rebuildTrackRouting(trackId, { input, gain })
    },
    setTrackCompressor: (trackId: string, params: CompressorParamsLite) => { void setTrackCompressor(trackId, params) },
    subscribeTrackCompressorMeter: (trackId: string, listener: CompressorMeterListener) => {
      let state = compressorChains.get(trackId)
      if (!state) {
        state = createCompressorChainState()
        compressorChains.set(trackId, state)
      }
      const unsubscribe = state.subscribeMeter(listener)
      return () => {
        unsubscribe()
        if (state.isIdle()) compressorChains.delete(trackId)
      }
    },
    setTrackReverb,
    setBpm: (bpm: number) => {
      currentBpm = bpm
      for (const state of delayChains.values()) state.setBpm(bpm)
    },
    disposeTrack,
    clear,
  }
}
