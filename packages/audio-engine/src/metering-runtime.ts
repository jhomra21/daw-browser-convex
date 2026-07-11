import { disconnectAudioNodes } from './effects/chain'
import { loadWorkletModule } from './worklet-loader'
import { resolveWorkletModuleUrl, trackMeterWorklet } from './worklet-manifest'

export type SpectrumFrame = {
  data: Float32Array
  sampleRate: number
}

export type TrackStereoLevels = {
  left: number
  right: number
}

export type TrackStereoLevelsBatch = ReadonlyMap<string, TrackStereoLevels>

export type TrackStereoLevelsListener = (levels: TrackStereoLevelsBatch) => void

export function readTrackStereoLevels(data: unknown): TrackStereoLevels | null {
  if (!data || typeof data !== 'object') return null
  if (!('type' in data) || data.type !== 'levels') return null
  if (!('left' in data) || typeof data.left !== 'number' || !Number.isFinite(data.left)) return null
  if (!('right' in data) || typeof data.right !== 'number' || !Number.isFinite(data.right)) return null
  if (data.left < 0 || data.left > 1 || data.right < 0 || data.right > 1) return null
  return { left: data.left, right: data.right }
}

export function createMeteringRuntime() {
  const analysers = new Map<string, AnalyserNode>()
  const meterArrays = new Map<string, Float32Array<ArrayBuffer>>()
  const spectrumTmp = new Map<string, Uint8Array<ArrayBuffer>>()
  const spectrumOut = new Map<string, Float32Array>()
  const spectrumLast = new Map<string, SpectrumFrame>()
  const workletNodes = new Map<string, AudioWorkletNode>()
  const workletGenerations = new Map<string, number>()
  const retriedWorkletGenerations = new Map<string, number>()
  const workletLevels = new Map<string, TrackStereoLevels>()
  const pendingLevels = new Map<string, TrackStereoLevels>()
  const listeners = new Set<TrackStereoLevelsListener>()
  const zeroTrackStereoLevels: TrackStereoLevels = { left: 0, right: 0 }
  let flushHandle: number | null = null
  let closed = false

  const emit = (levels: TrackStereoLevelsBatch) => {
    for (const listener of listeners) listener(levels)
  }

  const queueLevels = (trackId: string, levels: TrackStereoLevels) => {
    pendingLevels.set(trackId, levels)
    if (flushHandle !== null) return
    flushHandle = requestAnimationFrame(() => {
      flushHandle = null
      if (pendingLevels.size === 0) return
      const batch = new Map(pendingLevels)
      pendingLevels.clear()
      emit(batch)
    })
  }

  const updateWorkletSubscriptionState = () => {
    const active = listeners.size > 0
    for (const node of workletNodes.values()) node.port.postMessage({ active })
  }

  const ensureWorkletModule = (ctx: AudioContext) => {
    return loadWorkletModule(ctx, resolveWorkletModuleUrl(trackMeterWorklet.modulePath))
      .then(() => true)
      .catch(() => false)
  }

  const constructTrackMeterWorklet = (
    ctx: AudioContext,
    trackId: string,
    gain: GainNode,
    isCurrentOutput: () => boolean,
    generation: number,
  ) => {
    void ensureWorkletModule(ctx).then((ready) => {
      if (!ready || closed || workletGenerations.get(trackId) !== generation || workletNodes.has(trackId) || !isCurrentOutput()) return
      let node: AudioWorkletNode
      try {
        node = new AudioWorkletNode(ctx, trackMeterWorklet.processorName, {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
        })
      } catch {
        return
      }
      node.port.postMessage({ active: listeners.size > 0 })
      node.port.onmessage = (event) => {
        const next = readTrackStereoLevels(event.data)
        if (!next) return
        workletLevels.set(trackId, next)
        queueLevels(trackId, next)
      }
      node.onprocessorerror = () => {
        if (workletNodes.get(trackId) !== node || workletGenerations.get(trackId) !== generation) return
        node.onprocessorerror = null
        node.port.onmessage = null
        disconnectAudioNodes([node])
        workletNodes.delete(trackId)
        workletLevels.delete(trackId)
        pendingLevels.delete(trackId)
        queueLevels(trackId, zeroTrackStereoLevels)
        if (retriedWorkletGenerations.get(trackId) === generation || closed || !isCurrentOutput()) return
        retriedWorkletGenerations.set(trackId, generation)
        constructTrackMeterWorklet(ctx, trackId, gain, isCurrentOutput, generation)
      }
      try { gain.connect(node) } catch {}
      workletNodes.set(trackId, node)
    })
  }

  const ensureTrackMeterWorklet = (ctx: AudioContext, trackId: string, gain: GainNode, isCurrentOutput: () => boolean) => {
    const existing = workletNodes.get(trackId)
    if (existing) {
      try { gain.connect(existing) } catch {}
      return
    }
    const generation = (workletGenerations.get(trackId) ?? 0) + 1
    workletGenerations.set(trackId, generation)
    constructTrackMeterWorklet(ctx, trackId, gain, isCurrentOutput, generation)
  }

  const ensureTrackAnalyser = (ctx: AudioContext, trackId: string, gain: GainNode) => {
    let analyser = analysers.get(trackId)
    if (!analyser) {
      analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.7
      analysers.set(trackId, analyser)
    }
    try { gain.connect(analyser) } catch {}
    return analyser
  }

  return {
    subscribeTrackStereoLevels: (listener: TrackStereoLevelsListener) => {
      listeners.add(listener)
      if (workletLevels.size > 0) listener(new Map(workletLevels))
      updateWorkletSubscriptionState()
      return () => {
        listeners.delete(listener)
        updateWorkletSubscriptionState()
      }
    },
    reconnectTrackMeters: (ctx: AudioContext, trackId: string, output: GainNode, isCurrentOutput: () => boolean) => {
      ensureTrackMeterWorklet(ctx, trackId, output, isCurrentOutput)
    },
    getTrackLevel: (trackId: string) => {
      const analyser = analysers.get(trackId)
      if (!analyser) return 0
      let arr = meterArrays.get(trackId)
      if (!arr || arr.length !== analyser.fftSize) {
        arr = new Float32Array(new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT))
        meterArrays.set(trackId, arr)
      }
      try { analyser.getFloatTimeDomainData(arr) } catch { return 0 }
      let sum = 0
      for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i]
      return Math.min(1, Math.max(0, Math.sqrt(Math.sqrt(sum / arr.length))))
    },
    getTrackSpectrum: (ctx: AudioContext | null, trackId: string, output: GainNode | undefined) => {
      if (ctx && output) ensureTrackAnalyser(ctx, trackId, output)
      const analyser = analysers.get(trackId)
      if (!analyser) return spectrumLast.get(trackId) ?? null
      let tmp = spectrumTmp.get(trackId)
      if (!tmp || tmp.length !== analyser.frequencyBinCount) {
        tmp = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
        spectrumTmp.set(trackId, tmp)
      }
      try { analyser.getByteFrequencyData(tmp) } catch { return spectrumLast.get(trackId) ?? null }
      let sum = 0
      for (let i = 0; i < tmp.length; i++) sum += tmp[i]
      if (sum === 0) {
        spectrumLast.delete(trackId)
        return null
      }
      let out = spectrumOut.get(trackId)
      if (!out || out.length !== tmp.length) {
        out = new Float32Array(tmp.length)
        spectrumOut.set(trackId, out)
      }
      for (let i = 0; i < tmp.length; i++) out[i] = tmp[i] / 255
      const frame: SpectrumFrame = { data: out, sampleRate: ctx?.sampleRate ?? 44100 }
      spectrumLast.set(trackId, frame)
      return frame
    },
    disposeTrack: (trackId: string) => {
      workletGenerations.set(trackId, (workletGenerations.get(trackId) ?? 0) + 1)
      const analyser = analysers.get(trackId)
      disconnectAudioNodes([analyser])
      analysers.delete(trackId)
      meterArrays.delete(trackId)
      const meterNode = workletNodes.get(trackId)
      if (meterNode) {
        disconnectAudioNodes([meterNode])
        meterNode.port.onmessage = null
        meterNode.onprocessorerror = null
        meterNode.port.close()
      }
      workletNodes.delete(trackId)
      retriedWorkletGenerations.delete(trackId)
      if (workletLevels.has(trackId) || pendingLevels.has(trackId)) {
        queueLevels(trackId, zeroTrackStereoLevels)
      }
      workletLevels.delete(trackId)
      spectrumTmp.delete(trackId)
      spectrumOut.delete(trackId)
      spectrumLast.delete(trackId)
    },
    close: () => {
      closed = true
      for (const node of workletNodes.values()) {
        disconnectAudioNodes([node])
        node.port.onmessage = null
        node.onprocessorerror = null
        node.port.close()
      }
      disconnectAudioNodes(Array.from(analysers.values()))
      workletNodes.clear()
      workletGenerations.clear()
      retriedWorkletGenerations.clear()
      workletLevels.clear()
      pendingLevels.clear()
      if (flushHandle !== null) {
        cancelAnimationFrame(flushHandle)
        flushHandle = null
      }
      analysers.clear()
      meterArrays.clear()
      spectrumTmp.clear()
      spectrumOut.clear()
      spectrumLast.clear()
    },
  }
}
