import { disconnectAudioNodes } from './effects/chain'

const TRACK_METER_PROCESSOR_NAME = 'track-meter-processor'

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

export function createMeteringRuntime() {
  const analysers = new Map<string, AnalyserNode>()
  const meterArrays = new Map<string, Float32Array<ArrayBuffer>>()
  const spectrumTmp = new Map<string, Uint8Array<ArrayBuffer>>()
  const spectrumOut = new Map<string, Float32Array>()
  const spectrumLast = new Map<string, SpectrumFrame>()
  const workletNodes = new Map<string, AudioWorkletNode>()
  const workletLevels = new Map<string, TrackStereoLevels>()
  const pendingLevels = new Map<string, TrackStereoLevels>()
  const listeners = new Set<TrackStereoLevelsListener>()
  const zeroTrackStereoLevels: TrackStereoLevels = { left: 0, right: 0 }
  let workletReady: Promise<boolean> | null = null
  let flushHandle: number | null = null

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
    if (workletReady) return workletReady
    const source = `
      class TrackMeterProcessor extends AudioWorkletProcessor {
        constructor() {
          super()
          this.active = false
          this.frames = 0
          this.sumL = 0
          this.sumR = 0
          this.reportEveryFrames = 4096
          this.port.onmessage = (event) => {
            this.active = event.data?.active === true
            if (!this.active) {
              this.frames = 0
              this.sumL = 0
              this.sumR = 0
            }
          }
        }
        process(inputs) {
          if (!this.active) return true
          const input = inputs[0]
          const left = input && input[0]
          if (!left) {
            this.frames += 128
            if (this.frames >= this.reportEveryFrames) {
              this.port.postMessage({ left: 0, right: 0 })
              this.frames = 0
              this.sumL = 0
              this.sumR = 0
            }
            return true
          }
          const right = input[1] || left
          for (let i = 0; i < left.length; i++) {
            const l = left[i] || 0
            const r = right[i] || 0
            this.sumL += l * l
            this.sumR += r * r
          }
          this.frames += left.length
          if (this.frames >= this.reportEveryFrames) {
            this.port.postMessage({
              left: Math.min(1, Math.max(0, Math.sqrt(Math.sqrt(this.sumL / this.frames)))),
              right: Math.min(1, Math.max(0, Math.sqrt(Math.sqrt(this.sumR / this.frames)))),
            })
            this.frames = 0
            this.sumL = 0
            this.sumR = 0
          }
          return true
        }
      }
      registerProcessor('${TRACK_METER_PROCESSOR_NAME}', TrackMeterProcessor)
    `
    const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }))
    workletReady = ctx.audioWorklet.addModule(url)
      .then(() => true)
      .catch(() => false)
      .finally(() => URL.revokeObjectURL(url))
    return workletReady
  }

  const ensureTrackMeterWorklet = (ctx: AudioContext, trackId: string, gain: GainNode, isCurrentOutput: () => boolean) => {
    const existing = workletNodes.get(trackId)
    if (existing) {
      try { gain.connect(existing) } catch {}
      return
    }
    void ensureWorkletModule(ctx).then((ready) => {
      if (!ready || workletNodes.has(trackId) || !isCurrentOutput()) return
      const node = new AudioWorkletNode(ctx, TRACK_METER_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      })
      node.port.postMessage({ active: listeners.size > 0 })
      node.port.onmessage = (event) => {
        const data = event.data
        const next = {
          left: typeof data?.left === 'number' ? data.left : 0,
          right: typeof data?.right === 'number' ? data.right : 0,
        }
        workletLevels.set(trackId, next)
        queueLevels(trackId, next)
      }
      try { gain.connect(node) } catch {}
      workletNodes.set(trackId, node)
    })
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
      const analyser = analysers.get(trackId)
      disconnectAudioNodes([analyser])
      analysers.delete(trackId)
      meterArrays.delete(trackId)
      const meterNode = workletNodes.get(trackId)
      if (meterNode) {
        disconnectAudioNodes([meterNode])
        meterNode.port.onmessage = null
      }
      workletNodes.delete(trackId)
      if (workletLevels.has(trackId) || pendingLevels.has(trackId)) {
        queueLevels(trackId, zeroTrackStereoLevels)
      }
      workletLevels.delete(trackId)
      spectrumTmp.delete(trackId)
      spectrumOut.delete(trackId)
      spectrumLast.delete(trackId)
    },
    close: () => {
      for (const node of workletNodes.values()) {
        disconnectAudioNodes([node])
        node.port.onmessage = null
      }
      disconnectAudioNodes(Array.from(analysers.values()))
      workletNodes.clear()
      workletLevels.clear()
      pendingLevels.clear()
      if (flushHandle !== null) {
        cancelAnimationFrame(flushHandle)
        flushHandle = null
      }
      workletReady = null
      analysers.clear()
      meterArrays.clear()
      spectrumTmp.clear()
      spectrumOut.clear()
      spectrumLast.clear()
    },
  }
}
