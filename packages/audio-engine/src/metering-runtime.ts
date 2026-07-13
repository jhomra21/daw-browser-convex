import { disconnectAudioNodes } from './effects/chain'
import { loadWorkletModule } from './worklet-loader'
import { resolveWorkletModuleUrl, trackMeterWorklet } from './worklet-manifest'
import { observeResource, type ResourceObserver } from './runtime-diagnostics'

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

export type TrackMeterChannelFrame = {
  samplePeak: number
  rms: number
  clipping: boolean
  dcMean: number
  truePeak: number | null
}

export type TrackMeterFrame = {
  frameCount: number
  channels: readonly [TrackMeterChannelFrame, TrackMeterChannelFrame]
  correlation: number
}

export type TrackMeterFrameBatch = ReadonlyMap<string, TrackMeterFrame>
export type TrackMeterFrameListener = (frames: TrackMeterFrameBatch) => void

const readChannelFrame = (value: unknown): TrackMeterChannelFrame | null => {
  if (!value || typeof value !== 'object') return null
  if (!('samplePeak' in value) || typeof value.samplePeak !== 'number' || !Number.isFinite(value.samplePeak) || value.samplePeak < 0) return null
  if (!('rms' in value) || typeof value.rms !== 'number' || !Number.isFinite(value.rms) || value.rms < 0) return null
  if (!('clipping' in value) || typeof value.clipping !== 'boolean') return null
  if (!('dcMean' in value) || typeof value.dcMean !== 'number' || !Number.isFinite(value.dcMean)) return null
  if (!('truePeak' in value) || (value.truePeak !== null
    && (typeof value.truePeak !== 'number' || !Number.isFinite(value.truePeak) || value.truePeak < 0))) return null
  return {
    samplePeak: value.samplePeak,
    rms: value.rms,
    clipping: value.clipping,
    dcMean: value.dcMean,
    truePeak: value.truePeak,
  }
}

export function readTrackMeterFrame(data: unknown): TrackMeterFrame | null {
  if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'meter-frame') return null
  if (!('frameCount' in data) || typeof data.frameCount !== 'number'
    || !Number.isInteger(data.frameCount) || data.frameCount < 0) return null
  if (!('channels' in data) || !Array.isArray(data.channels) || data.channels.length !== 2) return null
  if (!('correlation' in data) || typeof data.correlation !== 'number'
    || !Number.isFinite(data.correlation) || data.correlation < -1 || data.correlation > 1) return null
  const left = readChannelFrame(data.channels[0])
  const right = readChannelFrame(data.channels[1])
  if (!left || !right) return null
  return { frameCount: data.frameCount, channels: [left, right], correlation: data.correlation }
}

export function readTrackStereoLevels(data: unknown): TrackStereoLevels | null {
  if (!data || typeof data !== 'object') return null
  if (!('type' in data) || data.type !== 'levels') return null
  if (!('left' in data) || typeof data.left !== 'number' || !Number.isFinite(data.left)) return null
  if (!('right' in data) || typeof data.right !== 'number' || !Number.isFinite(data.right)) return null
  if (data.left < 0 || data.left > 1 || data.right < 0 || data.right > 1) return null
  return { left: data.left, right: data.right }
}

export function createMeteringRuntime(options: {
  getFaultGeneration?: () => number
  onWorkletFault?: (generation: number, trackId: string) => void
  resourceObserver?: ResourceObserver
} = {}) {
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
  const workletFrames = new Map<string, TrackMeterFrame>()
  const pendingFrames = new Map<string, TrackMeterFrame>()
  const listeners = new Set<TrackStereoLevelsListener>()
  const frameListeners = new Set<TrackMeterFrameListener>()
  const levelListenerReleases = new Map<TrackStereoLevelsListener, Set<() => void>>()
  const frameListenerReleases = new Map<TrackMeterFrameListener, Set<() => void>>()
  const workletReleases = new Map<string, () => void>()
  const workletGains = new Map<string, GainNode>()
  const zeroTrackStereoLevels: TrackStereoLevels = { left: 0, right: 0 }
  let flushHandle: number | null = null
  let releaseFlush: () => void = () => undefined
  let closed = false

  const emit = (levels: TrackStereoLevelsBatch) => {
    for (const listener of listeners) listener(levels)
  }

  const queueLevels = (trackId: string, levels: TrackStereoLevels) => {
    pendingLevels.set(trackId, levels)
    if (flushHandle !== null) return
    flushHandle = requestAnimationFrame(() => {
      flushHandle = null
      releaseFlush()
      releaseFlush = () => undefined
      if (pendingLevels.size === 0) return
      const batch = new Map(pendingLevels)
      pendingLevels.clear()
      emit(batch)
      if (pendingFrames.size > 0) {
        const frames = new Map(pendingFrames)
        pendingFrames.clear()
        for (const listener of frameListeners) listener(frames)
      }
    })
    releaseFlush = observeResource(options.resourceObserver, 'animation-frames', `track-meter-flush`)
  }

  const updateWorkletSubscriptionState = () => {
    const active = listeners.size > 0 || frameListeners.size > 0
    for (const node of workletNodes.values()) node.port.postMessage({ active, truePeak: frameListeners.size > 0 })
  }

  const ensureWorkletModule = (ctx: AudioContext) => {
    return loadWorkletModule(ctx, resolveWorkletModuleUrl(trackMeterWorklet.modulePath))
      .then(() => true)
      .catch(() => false)
  }

  const releaseTrackMeterWorklet = (trackId: string, expected?: AudioWorkletNode) => {
    const node = workletNodes.get(trackId)
    if (!node || (expected && node !== expected)) return
    const gain = workletGains.get(trackId)
    try { gain?.disconnect(node) } catch {}
    node.port.onmessage = null
    node.onprocessorerror = null
    try { node.port.close() } catch {}
    disconnectAudioNodes([node])
    workletNodes.delete(trackId)
    workletGains.delete(trackId)
    workletReleases.get(trackId)?.()
    workletReleases.delete(trackId)
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
      node.port.postMessage({ active: listeners.size > 0 || frameListeners.size > 0, truePeak: frameListeners.size > 0 })
      const faultGeneration = options.getFaultGeneration?.() ?? 0
      node.port.onmessage = (event) => {
        const frame = readTrackMeterFrame(event.data)
        if (!frame) return
        workletFrames.set(trackId, frame)
        pendingFrames.set(trackId, frame)
        const next = {
          left: Math.min(1, Math.max(0, Math.sqrt(frame.channels[0].rms))),
          right: Math.min(1, Math.max(0, Math.sqrt(frame.channels[1].rms))),
        }
        workletLevels.set(trackId, next)
        queueLevels(trackId, next)
      }
      node.onprocessorerror = () => {
        if (workletNodes.get(trackId) !== node || workletGenerations.get(trackId) !== generation) return
        releaseTrackMeterWorklet(trackId, node)
        workletLevels.delete(trackId)
        pendingLevels.delete(trackId)
        queueLevels(trackId, zeroTrackStereoLevels)
        options.onWorkletFault?.(faultGeneration, trackId)
        if (retriedWorkletGenerations.get(trackId) === generation || closed || !isCurrentOutput()) return
        retriedWorkletGenerations.set(trackId, generation)
        constructTrackMeterWorklet(ctx, trackId, gain, isCurrentOutput, generation)
      }
      gain.connect(node)
      workletNodes.set(trackId, node)
      workletGains.set(trackId, gain)
      workletReleases.set(trackId, observeResource(options.resourceObserver, 'audio-worklet-nodes', node))
    })
  }

  const ensureTrackMeterWorklet = (ctx: AudioContext, trackId: string, gain: GainNode, isCurrentOutput: () => boolean) => {
    const existing = workletNodes.get(trackId)
    if (existing) {
      gain.connect(existing)
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
    gain.connect(analyser)
    return analyser
  }

  return {
    subscribeTrackStereoLevels: (listener: TrackStereoLevelsListener) => {
      listeners.add(listener)
      const release = observeResource(options.resourceObserver, 'event-listeners', listener)
      const releases = levelListenerReleases.get(listener) ?? new Set<() => void>()
      releases.add(release)
      levelListenerReleases.set(listener, releases)
      if (workletLevels.size > 0) listener(new Map(workletLevels))
      updateWorkletSubscriptionState()
      let released = false
      return () => {
        if (released) return
        released = true
        release()
        releases.delete(release)
        if (releases.size === 0) {
          levelListenerReleases.delete(listener)
          listeners.delete(listener)
        }
        updateWorkletSubscriptionState()
      }
    },
    subscribeTrackMeterFrames: (listener: TrackMeterFrameListener) => {
      frameListeners.add(listener)
      const release = observeResource(options.resourceObserver, 'event-listeners', listener)
      const releases = frameListenerReleases.get(listener) ?? new Set<() => void>()
      releases.add(release)
      frameListenerReleases.set(listener, releases)
      if (workletFrames.size > 0) listener(new Map(workletFrames))
      updateWorkletSubscriptionState()
      let released = false
      return () => {
        if (released) return
        released = true
        release()
        releases.delete(release)
        if (releases.size === 0) {
          frameListenerReleases.delete(listener)
          frameListeners.delete(listener)
        }
        updateWorkletSubscriptionState()
      }
    },
    resetTrackMeters: () => {
      for (const node of workletNodes.values()) node.port.postMessage({ type: 'reset' })
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
      releaseTrackMeterWorklet(trackId)
      retriedWorkletGenerations.delete(trackId)
      if (workletLevels.has(trackId) || pendingLevels.has(trackId)) {
        queueLevels(trackId, zeroTrackStereoLevels)
      }
      workletLevels.delete(trackId)
      workletFrames.delete(trackId)
      pendingFrames.delete(trackId)
      spectrumTmp.delete(trackId)
      spectrumOut.delete(trackId)
      spectrumLast.delete(trackId)
    },
    close: () => {
      closed = true
      for (const trackId of Array.from(workletNodes.keys())) releaseTrackMeterWorklet(trackId)
      disconnectAudioNodes(Array.from(analysers.values()))
      workletGenerations.clear()
      retriedWorkletGenerations.clear()
      workletLevels.clear()
      workletFrames.clear()
      pendingLevels.clear()
      pendingFrames.clear()
      listeners.clear()
      frameListeners.clear()
      for (const releases of levelListenerReleases.values()) {
        for (const release of releases) release()
      }
      for (const releases of frameListenerReleases.values()) {
        for (const release of releases) release()
      }
      levelListenerReleases.clear()
      frameListenerReleases.clear()
      if (flushHandle !== null) {
        cancelAnimationFrame(flushHandle)
        flushHandle = null
        releaseFlush()
        releaseFlush = () => undefined
      }
      analysers.clear()
      meterArrays.clear()
      spectrumTmp.clear()
      spectrumOut.clear()
      spectrumLast.clear()
    },
  }
}
