import { normalizeEqParams, serializeNormalizedEqParams, type EqParamsLite, type ReverbParamsLite } from '@daw-browser/shared'
import { connectParallelFxChain, disconnectAudioNodes, type CreateReverbImpulseResponse } from './effects/chain'
import { applyEqNodeParams, createEqNodes, getEqTopologySignature } from './effects/dsp'
import { createReverbChainState } from './effects/reverb-chain-state'
import type { SpectrumFrame } from './metering-runtime'

export function createMasterFxRuntime() {
  let eqChain: BiquadFilterNode[] = []
  let eqSignature: string | null = null
  let eqTopologySignature: string | null = null
  let analyser: AnalyserNode | null = null
  let spectrumTmp: Uint8Array<ArrayBuffer> | null = null
  let spectrumLast: SpectrumFrame | null = null
  let analyserConnected = false
  const reverbState = createReverbChainState()
  let pendingEqParams: EqParamsLite | null = null
  let pendingReverbParams: ReverbParamsLite | null = null

  const rebuildRouting = (ctx: AudioContext, masterGain: GainNode, destination: AudioDestinationNode) => {
    disconnectAudioNodes([masterGain])
    if (analyserConnected) analyserConnected = false
    connectParallelFxChain(masterGain, destination, eqChain, reverbState.chain())
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
        eqSignature = signature
        eqTopologySignature = topologySignature
      }
      if (pendingReverbParams) {
        const params = pendingReverbParams
        pendingReverbParams = null
        reverbState.set(ctx, params, createImpulseResponse)
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
      if (sum === 0) return spectrumLast
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
      pendingReverbParams = null
      disconnectAudioNodes(eqChain)
      eqChain = []
      reverbState.close()
      disconnectAudioNodes([analyser])
      analyser = null
      spectrumTmp = null
      spectrumLast = null
      analyserConnected = false
    },
  }
}
