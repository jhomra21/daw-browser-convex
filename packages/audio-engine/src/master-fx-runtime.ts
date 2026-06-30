import { areAudioEffectOrdersEqual, normalizeAudioEffectOrder, normalizeEqParams, parseEqBandParameterId, type AudioEffectKind, type CompressorParamsLite, type DelayParamsLite, serializeNormalizedEqParams, type EqParamsLite, type ReverbParamsLite, type SaturatorParamsLite } from '@daw-browser/shared'
import { connectFxChain, disconnectAudioNodes, type CreateReverbImpulseResponse } from './effects/chain'
import { applyEqNodeParams, createEqNodes, getEqTopologySignature } from './effects/dsp'
import { createCompressorChainState } from './effects/compressor-chain-state'
import { createDelayChainState } from './effects/delay-chain-state'
import { createReverbChainState } from './effects/reverb-chain-state'
import { createSaturatorChainState } from './effects/saturator-chain-state'
import type { CompressorMeterListener } from './effects/compressor-worklet'
import type { SpectrumFrame } from './metering-runtime'
import type { AutomationAudioBinding } from './automation'

export function createMasterFxRuntime() {
  let eqChain: BiquadFilterNode[] = []
  let eqNodesByBand = new Map<string, BiquadFilterNode>()
  let eqSignature: string | null = null
  let eqTopologySignature: string | null = null
  let analyser: AnalyserNode | null = null
  let spectrumTmp: Uint8Array<ArrayBuffer> | null = null
  let spectrumLast: SpectrumFrame | null = null
  let analyserConnected = false
  const compressorState = createCompressorChainState()
  const reverbState = createReverbChainState()
  const saturatorState = createSaturatorChainState()
  const delayState = createDelayChainState()
  let pendingEqParams: EqParamsLite | null = null
  let pendingCompressorParams: CompressorParamsLite | null = null
  let pendingReverbParams: ReverbParamsLite | null = null
  let pendingSaturatorParams: SaturatorParamsLite | null = null
  let pendingDelayParams: DelayParamsLite | null = null
  let masterFxOrder: AudioEffectKind[] | undefined
  let currentBpm = 120

  const rebuildRouting = (ctx: AudioContext, masterGain: GainNode, destination: AudioDestinationNode) => {
    disconnectAudioNodes([masterGain])
    if (analyserConnected) analyserConnected = false
    connectFxChain(masterGain, destination, {
      eqNodes: eqChain,
      compressorChain: compressorState.chain(),
      saturatorChain: saturatorState.chain(),
      delayChain: delayState.chain(),
      reverbChain: reverbState.chain(),
      order: masterFxOrder,
    })
    if (analyser) {
      try {
        masterGain.connect(analyser)
        analyserConnected = true
      } catch {}
    }
  }

  const ensureAnalyser = (ctx: AudioContext | null, masterGain: GainNode | null) => {
    if (!ctx || !masterGain) return
    if (!analyser) {
      const next = ctx.createAnalyser()
      next.fftSize = 2048
      next.smoothingTimeConstant = 0.8
      analyser = next
    }
    if (analyser && !analyserConnected) {
      try {
        masterGain.connect(analyser)
        analyserConnected = true
      } catch {}
    }
  }

  return {
    applyPending: (ctx: AudioContext, masterGain: GainNode, destination: AudioDestinationNode, createImpulseResponse: CreateReverbImpulseResponse) => {
      if (pendingEqParams) {
        const params = pendingEqParams
        pendingEqParams = null
        const signature = serializeNormalizedEqParams(params)
        const topologySignature = getEqTopologySignature(params)
        eqChain = createEqNodes(ctx, params, ctx.destination.maxChannelCount || 2)
        eqNodesByBand = new Map(params.bands.filter((band) => band.enabled).flatMap((band, index) => {
          const node = eqChain[index]
          return node ? [[band.id, node]] : []
        }))
        eqSignature = signature
        eqTopologySignature = topologySignature
      }
      if (pendingCompressorParams) {
        const params = pendingCompressorParams
        pendingCompressorParams = null
        void compressorState.set(ctx, params).then((result) => { if (result.changed && result.requiresRoutingRebuild) rebuildRouting(ctx, masterGain, destination) })
      }
      if (pendingReverbParams) {
        const params = pendingReverbParams
        pendingReverbParams = null
        reverbState.set(ctx, params, createImpulseResponse)
      }
      if (pendingSaturatorParams) {
        const params = pendingSaturatorParams
        pendingSaturatorParams = null
        saturatorState.set(ctx, params)
      }
      if (pendingDelayParams) {
        const params = pendingDelayParams
        pendingDelayParams = null
        delayState.set(ctx, params, currentBpm)
      }
      rebuildRouting(ctx, masterGain, destination)
    },
    setEq: (ctx: AudioContext | null, masterGain: GainNode | null, destination: AudioDestinationNode | null, params: EqParamsLite) => {
      const normalized = normalizeEqParams(params)
      if (!ctx || !masterGain) {
        pendingEqParams = normalized
        return
      }
      const signature = serializeNormalizedEqParams(normalized)
      if (eqSignature === signature) return
      const topologySignature = getEqTopologySignature(normalized)
      if (eqTopologySignature === topologySignature) {
        applyEqNodeParams(eqChain, normalized)
        eqSignature = signature
        return
      }
      disconnectAudioNodes(eqChain)
      eqChain = createEqNodes(ctx, normalized, ctx.destination.maxChannelCount || 2)
      eqNodesByBand = new Map(normalized.bands.filter((band) => band.enabled).flatMap((band, index) => {
        const node = eqChain[index]
        return node ? [[band.id, node]] : []
      }))
      eqSignature = signature
      eqTopologySignature = topologySignature
      rebuildRouting(ctx, masterGain, destination ?? ctx.destination)
    },
    setReverb: (ctx: AudioContext | null, masterGain: GainNode | null, destination: AudioDestinationNode | null, params: ReverbParamsLite, createImpulseResponse: CreateReverbImpulseResponse) => {
      if (!ctx || !masterGain) {
        pendingReverbParams = params
        return
      }
      const result = reverbState.set(ctx, params, createImpulseResponse)
      if (!result.changed) return
      if (result.requiresRoutingRebuild) {
        rebuildRouting(ctx, masterGain, destination ?? ctx.destination)
      }
    },
    setCompressor: (ctx: AudioContext | null, masterGain: GainNode | null, destination: AudioDestinationNode | null, params: CompressorParamsLite) => {
      if (!ctx || !masterGain) {
        pendingCompressorParams = params
        return
      }
      void compressorState.set(ctx, params).then((result) => {
        if (result.changed && result.requiresRoutingRebuild) rebuildRouting(ctx, masterGain, destination ?? ctx.destination)
      })
    },
    subscribeCompressorMeter: (listener: CompressorMeterListener) => compressorState.subscribeMeter(listener),
    setSaturator: (ctx: AudioContext | null, masterGain: GainNode | null, destination: AudioDestinationNode | null, params: SaturatorParamsLite) => {
      if (!ctx || !masterGain) {
        pendingSaturatorParams = params
        return
      }
      const result = saturatorState.set(ctx, params)
      if (result.changed && result.requiresRoutingRebuild) rebuildRouting(ctx, masterGain, destination ?? ctx.destination)
    },
    setDelay: (ctx: AudioContext | null, masterGain: GainNode | null, destination: AudioDestinationNode | null, params: DelayParamsLite) => {
      if (!ctx || !masterGain) {
        pendingDelayParams = params
        return
      }
      const result = delayState.set(ctx, params, currentBpm)
      if (result.changed && result.requiresRoutingRebuild) rebuildRouting(ctx, masterGain, destination ?? ctx.destination)
    },
    setOrder: (ctx: AudioContext | null, masterGain: GainNode | null, destination: AudioDestinationNode | null, order: AudioEffectKind[]) => {
      const normalized = normalizeAudioEffectOrder(order, order)
      if (areAudioEffectOrdersEqual(masterFxOrder, normalized)) return
      masterFxOrder = normalized
      if (!ctx || !masterGain) return
      rebuildRouting(ctx, masterGain, destination ?? ctx.destination)
    },
    setBpm: (bpm: number) => {
      currentBpm = bpm
      delayState.setBpm(bpm)
    },
    resolveMasterAutomationBindings: (parameterId: string, masterGain: GainNode | null): AutomationAudioBinding[] => {
      if (parameterId === 'volume') return masterGain ? [{ param: masterGain.gain, valueToAudioValue: (value) => value }] : []
      const eq = parseEqBandParameterId(parameterId)
      if (!eq) return []
      const node = eqNodesByBand.get(eq.bandId)
      if (!node) return []
      if (eq.property === 'frequencyHz') return [{ param: node.frequency, valueToAudioValue: (value) => value }]
      if (eq.property === 'gainDb') return [{ param: node.gain, valueToAudioValue: (value) => value }]
      return [{ param: node.Q, valueToAudioValue: (value) => value }]
    },
    rebuildRouting,
    getSpectrum: (ctx: AudioContext | null, masterGain: GainNode | null) => {
      ensureAnalyser(ctx, masterGain)
      if (!analyser) return spectrumLast
      if (!spectrumTmp || spectrumTmp.length !== analyser.frequencyBinCount) {
        spectrumTmp = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
      }
      try { analyser.getByteFrequencyData(spectrumTmp) } catch { return spectrumLast }
      let sum = 0
      for (let i = 0; i < spectrumTmp.length; i++) sum += spectrumTmp[i]
      if (sum === 0) {
        spectrumLast = null
        return null
      }
      let out = spectrumLast?.data
      if (!out || out.length !== spectrumTmp.length) out = new Float32Array(spectrumTmp.length)
      for (let i = 0; i < out.length; i++) out[i] = spectrumTmp[i] / 255
      spectrumLast = { data: out, sampleRate: ctx?.sampleRate ?? 44100 }
      return spectrumLast
    },
    close: () => {
      eqSignature = null
      eqTopologySignature = null
      pendingEqParams = null
      pendingCompressorParams = null
      pendingReverbParams = null
      pendingSaturatorParams = null
      pendingDelayParams = null
      masterFxOrder = undefined
      disconnectAudioNodes(eqChain)
      eqChain = []
      eqNodesByBand = new Map()
      compressorState.close()
      reverbState.close()
      saturatorState.close()
      delayState.close()
      disconnectAudioNodes([analyser])
      analyser = null
      spectrumTmp = null
      spectrumLast = null
      analyserConnected = false
    },
  }
}
