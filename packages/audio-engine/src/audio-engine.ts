import { closeAudioRuntime, createAudioRuntime, decodeAudioData, getOutputLatencySec, type AudioRuntime, type AudioRuntimeOptions } from './audio-runtime'
import { canFallbackToRepitchStretch, createClipScheduler, type DeferredStretchWindow, type ScheduleOptions, type ScheduleResult } from './clip-scheduler'
import { createAudioStretchCache, isStretchQualityWarning, type AudioStretchRenderState } from './audio-stretch-cache'
import { assert, getAutomationParameterDescriptor, normalizeMasterVolume, type ArpParams, type AutomationEnvelope, type ReverbParamsLite, type SynthParamsInput, type TrackInstrumentParams } from '@daw-browser/shared'
import { createReverbImpulseCache } from './effects/reverb-impulse-cache'
import { createLiveMixerRuntime } from './live-mixer-runtime'
import { createMasterFxRuntime } from './master-fx-runtime'
import { createMeteringRuntime, type SpectrumFrame, type TrackMeterFrame, type TrackMeterFrameBatch, type TrackMeterFrameListener, type TrackStereoLevels, type TrackStereoLevelsBatch, type TrackStereoLevelsListener } from './metering-runtime'
import type { CompressorMeterFrame, CompressorMeterListener } from './effects/compressor-worklet'
import type { GateMeterFrame, GateMeterListener } from './effects/static-worklet-chain'
import { createMetronomeRuntime } from './metronome-runtime'
import { createSourceRegistry, stopAndDisconnectSource } from './source-registry'
import { createInstrumentRuntime, type SetTrackInstrumentInput } from './instrument-runtime'
import type { DrumRackResolvedBuffers } from './drum-rack-runtime'
import type { SamplerNoteMiss, SamplerResolvedBuffers } from './sampler-runtime'
import type { GranularInstalledBuffer } from './granular-runtime'
export { createSamplerBufferCache } from './sampler-core'
import { createTransportClock } from './transport-clock'
import type { Clip, ExternalSidechainRoute, Track } from '@daw-browser/timeline-core/types'
import { applyAutomationEnvelopeAtTime, scheduleAutomationEnvelope } from './automation'
import type { AudioEffectRuntimeInstance } from './effects/runtime-instance'
import { createRecordingRuntime, type RecordingRuntimeStatus, type StartRecordingCaptureOptions } from './recording/recording-runtime'
import { analyzeCalibrationCapture, createCalibrationStimulus, type RecordingCalibrationAnalysis } from './recording/calibration'
import { createRuntimeFaultCounter, type RuntimeFaultSnapshot } from './runtime-diagnostics'

type RuntimeClip = Clip<AudioBuffer>
type RuntimeTrack = Track<AudioBuffer>

const MASTER_FADE_DOWN_SEC = 0.002
const MASTER_FADE_HOLD_SEC = 0.001
const MASTER_FADE_UP_SEC = 0.006
const MASTER_STOP_DELAY_SEC = 0.004
export const LIVE_SCHEDULE_HORIZON_SEC = 30

export { canFallbackToRepitchStretch, isStretchQualityWarning }
export type { AudioEffectRuntimeInstance, AudioRuntimeOptions, AudioStretchRenderState, CompressorMeterFrame, DeferredStretchWindow, GateMeterFrame, SpectrumFrame, TrackMeterFrame, TrackMeterFrameBatch, TrackStereoLevels, TrackStereoLevelsBatch }
export type { RecordingEpoch, RecordingMonitorMode, RecordingRuntimeStatus, StartRecordingCaptureOptions } from './recording/recording-runtime'
export type AudioRuntimeSnapshot = {
  state: AudioContextState | 'uninitialized'
  sampleRate: number | null
  requestedSampleRate: number | null
  latencyHint: AudioContextLatencyCategory | null
  baseLatencySec: number | null
  outputLatencySec: number | null
  totalOutputLatencySec: number | null
  graphPdcLatencyFrames: number | null
  workletFaultCount: number
  runtimeFaults: RuntimeFaultSnapshot
  inferredApplicationStallCount: number
}
type SinkSelectableAudioContext = AudioContext & {
  setSinkId: (sinkId: string) => Promise<void>
}
const supportsSinkSelection = (context: AudioContext): context is SinkSelectableAudioContext =>
  "setSinkId" in context && typeof context.setSinkId === "function"

export class AudioEngine {
  private runtimeOptions: AudioRuntimeOptions
  private activeRuntimeOptions: AudioRuntimeOptions | null = null
  private runtimeListeners = new Set<() => void>()
  private runtimeStateChangeListener = () => this.publishRuntimeSnapshot()
  private runtime: AudioRuntime | null = null
  private audioCtx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private destination: AudioDestinationNode | null = null
  private graphPdcLatencyFrames: number | null = null
  private faultGeneration = 0
  private tracksSnapshot: RuntimeTrack[] = []
  private automationEnvelopes: AutomationEnvelope[] = []
  private masterVolume = 1
  private sources = createSourceRegistry()
  private instrumentRuntime = createInstrumentRuntime({
    ensureAudio: () => this.ensureAudio(),
    getAudioContext: () => this.audioCtx,
    getBpm: () => this.clock.getBpm(),
    timelineToCtxTime: (timelineSec) => this.timelineToCtxTime(timelineSec),
    ensureTrackInput: (trackId) => this.mixerRuntime.ensureTrackInput(trackId),
    sources: this.sources,
    getAutomationEnvelopes: () => this.automationEnvelopes,
  })
  private mixerRuntime = createLiveMixerRuntime({
    ensureAudio: () => this.ensureAudio(),
    getAudioContext: () => this.audioCtx,
    getMasterInput: () => this.masterGain,
    getDestination: () => this.destination,
    createImpulseResponse: (params) => this.createImpulseResponse(params),
    reconnectTrackMeters: (trackId, output, isCurrentOutput) => {
      if (!this.audioCtx) return
      this.metering.reconnectTrackMeters(this.audioCtx, trackId, output, isCurrentOutput)
    },
    disposeTrackMeters: (trackId) => this.metering.disposeTrack(trackId),
    disposeSynthTrack: (trackId) => this.disposeSynthTrack(trackId),
    getMasterFx: () => this.masterFx.getMixerFx(),
    getFaultGeneration: () => this.faultGeneration,
    onGraphLatencyChange: (frames) => {
      if (this.graphPdcLatencyFrames === frames) return
      this.graphPdcLatencyFrames = frames
      this.publishRuntimeSnapshot()
    },
    onWorkletFault: (generation, kind, code, context) => {
      if (this.runtimeFaultCounter.report(generation, { kind, code, context })) {
        this.publishRuntimeSnapshot()
      }
    },
  })
  private scheduler = createClipScheduler({
    getAudioContext: () => this.audioCtx,
    getBpm: () => this.clock.getBpm(),
    timelineToCtxTime: (timelineSec) => this.timelineToCtxTime(timelineSec),
    updateTrackGains: (tracks) => this.updateTrackGains(tracks),
    ensureTrackInput: (trackId) => this.mixerRuntime.ensureTrackInput(trackId),
    stopClipSources: () => this.stopClipSources(),
    stopSourcesForClip: (clipId) => this.stopSourcesForClip(clipId),
    scheduleMidiClip: (track, clip, playheadSec, nowCtx, startLimitSec, endLimitSec) => this.scheduleMidiClip(track, clip, playheadSec, nowCtx, startLimitSec, endLimitSec),
    ensureStretchedClip: (clip) => this.stretchCache.ensure(clip, this.clock.getBpm()),
    getStretchedClip: (clip) => this.stretchCache.getReady(clip, this.clock.getBpm()),
    stretchRenderAheadSec: LIVE_SCHEDULE_HORIZON_SEC,
    sources: this.sources,
  })
  private masterFx = createMasterFxRuntime({
    getFaultGeneration: () => this.faultGeneration,
    onWorkletFault: (generation, kind, code, context) => {
      if (this.runtimeFaultCounter.report(generation, { kind, code, context })) this.publishRuntimeSnapshot()
    },
  })
  private impulseCache = createReverbImpulseCache({ bucketSize: 0.1, limit: 48 })
  private clock = createTransportClock()
  private metronome = createMetronomeRuntime(this.clock)
  private runtimeFaultCounter = createRuntimeFaultCounter()
  private inferredApplicationStallCount = 0
  private metering = createMeteringRuntime({
    getFaultGeneration: () => this.faultGeneration,
    onWorkletFault: (generation, trackId) => {
      if (this.runtimeFaultCounter.report(generation, {
        kind: 'track-meter',
        code: 'processor-error',
        context: trackId,
      })) this.publishRuntimeSnapshot()
    },
  })
  private stretchCache = createAudioStretchCache({
    createBuffer: (channels, frames, sampleRate) => new AudioBuffer({ numberOfChannels: channels, length: frames, sampleRate }),
    persist: true,
  })
  private recording = createRecordingRuntime({
    getContext: () => this.audioCtx,
    connectMonitor: (trackId, source) => this.mixerRuntime.connectRecordingMonitor(trackId, source),
    getFaultGeneration: () => this.faultGeneration,
    onFault: (generation, code) => {
      if (this.runtimeFaultCounter.report(generation, { kind: 'recorder', code, context: 'recording-capture' })) {
        this.publishRuntimeSnapshot()
      }
    },
  })
  private calibrationReserved = false
  private recordingStartReserved = false

  constructor(options: AudioRuntimeOptions = { latencyHint: 'interactive' }) {
    this.runtimeOptions = options
  }

  configureNextRuntime(options: AudioRuntimeOptions) {
    this.runtimeOptions = options
  }

  getRuntimeSnapshot(): AudioRuntimeSnapshot {
    if (!this.audioCtx) {
      return {
        state: 'uninitialized',
        sampleRate: null,
        requestedSampleRate: null,
        latencyHint: null,
        baseLatencySec: null,
        outputLatencySec: null,
        totalOutputLatencySec: null,
        graphPdcLatencyFrames: this.graphPdcLatencyFrames,
        workletFaultCount: this.runtimeFaultCounter.snapshot().eventCount,
        runtimeFaults: this.runtimeFaultCounter.snapshot(),
        inferredApplicationStallCount: this.inferredApplicationStallCount,
      }
    }
    const baseLatencySec = Number.isFinite(this.audioCtx.baseLatency) ? this.audioCtx.baseLatency : null
    const outputLatencySec = Number.isFinite(this.audioCtx.outputLatency) ? this.audioCtx.outputLatency : null
    return {
      state: this.audioCtx.state,
      sampleRate: this.audioCtx.sampleRate,
      requestedSampleRate: this.activeRuntimeOptions?.sampleRate ?? null,
      latencyHint: this.activeRuntimeOptions?.latencyHint ?? null,
      baseLatencySec,
      outputLatencySec,
      totalOutputLatencySec: baseLatencySec !== null && outputLatencySec !== null ? baseLatencySec + outputLatencySec : null,
      graphPdcLatencyFrames: this.graphPdcLatencyFrames,
      workletFaultCount: this.runtimeFaultCounter.snapshot().eventCount,
      runtimeFaults: this.runtimeFaultCounter.snapshot(),
      inferredApplicationStallCount: this.inferredApplicationStallCount,
    }
  }

  subscribeRuntimeSnapshot(listener: () => void) {
    this.runtimeListeners.add(listener)
    return () => this.runtimeListeners.delete(listener)
  }

  reportInferredApplicationStall() {
    this.inferredApplicationStallCount += 1
    this.publishRuntimeSnapshot()
  }

  private publishRuntimeSnapshot() {
    for (const listener of this.runtimeListeners) listener()
  }

  async setOutputDevice(deviceId: string): Promise<'applied' | 'unsupported' | 'uninitialized'> {
    if (!this.audioCtx) return 'uninitialized'
    if (!supportsSinkSelection(this.audioCtx)) return 'unsupported'
    await this.audioCtx.setSinkId(deviceId)
    this.publishRuntimeSnapshot()
    return 'applied'
  }

  async playOutputTestTone(durationSec = 0.35) {
    this.ensureAudio()
    if (!this.audioCtx) return
    await this.resume()
    const oscillator = this.audioCtx.createOscillator()
    const gain = this.audioCtx.createGain()
    const now = this.audioCtx.currentTime
    gain.gain.setValueAtTime(0.08, now)
    gain.gain.linearRampToValueAtTime(0, now + durationSec)
    oscillator.frequency.value = 440
    oscillator.connect(gain)
    gain.connect(this.audioCtx.destination)
    oscillator.addEventListener('ended', () => {
      oscillator.disconnect()
      gain.disconnect()
    }, { once: true })
    oscillator.start(now)
    oscillator.stop(now + durationSec)
  }

  ensureStretchRender(clip: RuntimeClip) {
    this.stretchCache.ensure(clip, this.clock.getBpm())
  }

  getStretchRenderState(clip: RuntimeClip): AudioStretchRenderState {
    return this.stretchCache.getState(clip, this.clock.getBpm())
  }

  subscribeStretchRenderState(listener: () => void) {
    return this.stretchCache.subscribe(listener)
  }

  subscribeTrackStereoLevels(listener: TrackStereoLevelsListener) {
    return this.metering.subscribeTrackStereoLevels(listener)
  }

  subscribeTrackMeterFrames(listener: TrackMeterFrameListener) {
    return this.metering.subscribeTrackMeterFrames(listener)
  }

  resetTrackMeters() {
    this.metering.resetTrackMeters()
  }

  startRecordingCapture(options: StartRecordingCaptureOptions) {
    if (this.calibrationReserved) throw new Error('Wait for recording calibration to finish.')
    this.recordingStartReserved = true
    return this.recording.start(options).finally(() => {
      this.recordingStartReserved = false
    })
  }

  stopRecordingCapture() {
    return this.recording.stop()
  }

  cancelRecordingCapture() {
    this.recording.cancel()
  }

  getRecordingStatus(): RecordingRuntimeStatus {
    return this.recording.getStatus()
  }

  subscribeRecordingStatus(listener: (status: RecordingRuntimeStatus) => void) {
    return this.recording.subscribe(listener)
  }

  async calibrateRecording(input: {
    stream: MediaStream
    inputDeviceId: string
    outputDeviceId: string
    signal: AbortSignal
  }): Promise<RecordingCalibrationAnalysis> {
    if (this.calibrationReserved) throw new Error('Recording calibration is already running.')
    this.calibrationReserved = true
    let aborted = input.signal.aborted
    const onAbort = () => {
      aborted = true
    }
    input.signal.addEventListener('abort', onAbort, { once: true })
    const throwIfAborted = () => {
      if (aborted) throw new DOMException('Calibration cancelled.', 'AbortError')
    }
    try {
      throwIfAborted()
      if (this.recordingStartReserved || this.recording.getStatus().state === 'recording') throw new Error('Stop recording before calibration.')
      if (this.clock.isRunning()) throw new Error('Stop project playback before calibration.')
      if (!input.inputDeviceId || !input.outputDeviceId) throw new Error('Calibration requires explicit input and output devices.')
      this.ensureAudio()
      if (!this.audioCtx || !this.destination) throw new Error('Audio is unavailable.')
      throwIfAborted()
      await this.resume()
      throwIfAborted()
      await this.setOutputDevice(input.outputDeviceId)
      throwIfAborted()
      const context = this.audioCtx
      const track = input.stream.getAudioTracks()[0]
      if (!track || track.readyState === 'ended') throw new Error('Calibration input is unavailable.')
      const source = context.createMediaStreamSource(input.stream)
      const capture = context.createScriptProcessor(2048, 1, 1)
      const silent = context.createGain()
      silent.gain.value = 0
      const stimulus = createCalibrationStimulus(context.sampleRate)
      const buffer = context.createBuffer(1, stimulus.length, context.sampleRate)
      buffer.getChannelData(0).set(stimulus)
      const playback = context.createBufferSource()
      playback.buffer = buffer
      playback.connect(this.destination)
      source.connect(capture)
      capture.connect(silent)
      silent.connect(this.destination)
      const captured: number[] = []
      const captureFrames = stimulus.length + Math.ceil(context.sampleRate * 0.75)
      return await new Promise<RecordingCalibrationAnalysis>((resolve, reject) => {
      let settled = false
      // ScriptProcessor delivery can stop without a terminal event. Bound the wait to the
      // requested capture window plus one second of scheduling tolerance.
      const deadline = window.setTimeout(
        () => fail(new Error('Calibration capture timed out.')),
        Math.ceil(captureFrames / context.sampleRate * 1000) + 1_000,
      )
      const onTrackEnded = () => fail(new Error('Calibration input ended.'))
      const onContextStateChange = () => {
        if (context.state !== 'running') fail(new Error('Audio context stopped during calibration.'))
      }
      const cleanup = () => {
        window.clearTimeout(deadline)
        input.signal.removeEventListener('abort', cancel)
        track.removeEventListener('ended', onTrackEnded)
        context.removeEventListener('statechange', onContextStateChange)
        playback.onended = null
        capture.onaudioprocess = null
        try { playback.stop() } catch {}
        playback.disconnect()
        source.disconnect()
        capture.disconnect()
        silent.disconnect()
      }
      const finish = (result: RecordingCalibrationAnalysis) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      const cancel = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(new DOMException('Calibration cancelled.', 'AbortError'))
      }
      function fail(error: Error) {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      if (aborted) {
        cancel()
        return
      }
      input.signal.addEventListener('abort', cancel, { once: true })
      track.addEventListener('ended', onTrackEnded, { once: true })
      context.addEventListener('statechange', onContextStateChange)
      playback.onended = () => {
        if (captured.length >= captureFrames) {
          finish(analyzeCalibrationCapture(Float32Array.from(captured.slice(0, captureFrames)), context.sampleRate))
        }
      }
      capture.onaudioprocess = (event) => {
        const channel = event.inputBuffer.getChannelData(0)
        for (const sample of channel) captured.push(sample)
        if (captured.length >= captureFrames) {
          finish(analyzeCalibrationCapture(Float32Array.from(captured.slice(0, captureFrames)), context.sampleRate))
        }
      }
      playback.start()
      })
    } finally {
      input.signal.removeEventListener('abort', onAbort)
      this.calibrationReserved = false
    }
  }

  // Returns a normalized 0..1 RMS level for a track's post-gain signal
  getTrackLevel(trackId: string): number {
    return this.metering.getTrackLevel(trackId)
  }

  getAudioContext() {
    return this.audioCtx
  }

  getTrackSynthGainNode(trackId: string) {
    this.ensureAudio()
    return this.instrumentRuntime.getTrackSynthGainNode(trackId)
  }

  getTrackSynthPreviewState(trackId: string) {
    return this.instrumentRuntime.getTrackSynthPreviewState(trackId)
  }

  getTrackInstrumentKind(trackId: string): TrackInstrumentParams['kind'] | undefined {
    return this.instrumentRuntime.getTrackInstrumentKind(trackId)
  }

  ensureAudio(opts?: { applyCachedTrackGains?: boolean }) {
    if (!this.audioCtx) {
      this.runtime = createAudioRuntime(this.runtimeOptions)
      this.faultGeneration = this.runtimeFaultCounter.generation()
      this.activeRuntimeOptions = this.runtimeOptions
      this.audioCtx = this.runtime.ctx
      this.audioCtx.addEventListener('statechange', this.runtimeStateChangeListener)
      this.masterGain = this.runtime.masterGain
      this.masterGain.gain.value = this.masterVolume
      this.destination = this.runtime.destination
      this.masterFx.applyPending(this.audioCtx, this.masterGain, this.destination, (params) => this.createImpulseResponse(params))
      if (opts?.applyCachedTrackGains !== false) {
        this.updateTrackGains(this.tracksSnapshot)
      }
      this.publishRuntimeSnapshot()
    }
  }

  private timelineToCtxTime(timelineSec: number) {
    if (!this.audioCtx) return 0
    return this.clock.timelineToCtxTime(timelineSec)
  }

  setTrackSynth(trackId: string, params: SynthParamsInput) {
    this.instrumentRuntime.setTrackSynth(trackId, params)
  }

  setTrackInstrument(trackId: string, input: SetTrackInstrumentInput) {
    this.instrumentRuntime.setTrackInstrument(trackId, input)
  }

  setTrackDrumRack(trackId: string, params: Extract<SetTrackInstrumentInput['instrument'], { kind: 'drum-rack' }>['params'], buffers?: DrumRackResolvedBuffers) {
    this.instrumentRuntime.setTrackDrumRack(trackId, params, buffers)
  }

  setTrackSampler(trackId: string, params: Extract<SetTrackInstrumentInput['instrument'], { kind: 'sampler' }>['params'], buffers?: SamplerResolvedBuffers, instanceId?: string) {
    this.instrumentRuntime.setTrackSampler(trackId, params, buffers, instanceId)
  }

  setTrackGranular(trackId: string, params: Extract<SetTrackInstrumentInput['instrument'], { kind: 'granular' }>['params'], installedBuffer?: GranularInstalledBuffer, instanceId?: string) {
    return this.instrumentRuntime.setTrackGranular(trackId, params, installedBuffer, instanceId)
  }

  setSamplerRuntimeListeners(listeners: {
    onNoteMiss?: (miss: SamplerNoteMiss) => void
    onAssetUse?: (assetKey: string, active: boolean) => void
  }) {
    this.instrumentRuntime.setSamplerRuntimeListeners(listeners)
  }

  previewSamplerNote(trackId: string, pitch: number, velocity = 1) {
    return this.instrumentRuntime.previewSamplerNote(trackId, pitch, velocity)
  }

  previewDrumRackPad(trackId: string, padId: string, velocity = 1) {
    this.instrumentRuntime.previewDrumRackPad(trackId, padId, velocity)
  }

  previewDrumRackNote(trackId: string, pitch: number, velocity = 1) {
    return this.instrumentRuntime.previewDrumRackNote(trackId, pitch, velocity)
  }

  setTrackArpeggiator(trackId: string, params: ArpParams) {
    this.instrumentRuntime.setTrackArpeggiator(trackId, params)
  }

  clearTrackArpeggiator(trackId: string) {
    this.instrumentRuntime.clearTrackArpeggiator(trackId)
  }

  clearTrackSynth(trackId: string) {
    this.instrumentRuntime.clearTrackSynth(trackId)
  }

  clearTrackDrumRack(trackId: string) {
    this.instrumentRuntime.clearTrackDrumRack(trackId)
  }

  clearTrackInstrument(trackId: string) {
    this.instrumentRuntime.clearTrackInstrument(trackId)
  }

  private stopActiveNotesForClip(clipId: string) {
    this.instrumentRuntime.stopClip(clipId)
  }

  private stopAllActiveNotes() {
    this.instrumentRuntime.stopAll()
  }

  setBpm(nextBpm: number) {
    if (!this.clock.setBpm(nextBpm)) return
    this.metronome.onBpmChange(this.audioCtx)
    this.mixerRuntime.setBpm(nextBpm)
    this.masterFx.setBpm(nextBpm)
  }

  setMetronomeEnabled(enabled: boolean) {
    if (!enabled) {
      if (this.audioCtx && this.masterGain) this.metronome.setEnabled(false, this.audioCtx, this.masterGain)
      return
    }
    this.ensureAudio()
    if (this.audioCtx && this.masterGain) this.metronome.setEnabled(true, this.audioCtx, this.masterGain)
  }

  onTransportStart(playheadSec: number) {
    if (this.calibrationReserved) throw new Error('Wait for recording calibration to finish.')
    if (!this.audioCtx || !this.masterGain) return
    this.clock.start(this.audioCtx.currentTime, playheadSec)
    this.metronome.onTransportStart(this.audioCtx, this.masterGain)
  }

  onTransportPause() {
    this.clock.pause()
    this.metronome.onTransportPause()
  }

  onTransportStop() {
    this.clock.stop(this.audioCtx?.currentTime ?? 0)
    this.metronome.onTransportPause()
  }

  onTransportSeek(playheadSec: number, offsetSec = 0, opts?: { resetMetronome?: boolean }) {
    if (!this.audioCtx) return
    this.clock.seek(this.audioCtx.currentTime, playheadSec, offsetSec)
    this.metronome.onTransportSeek(this.audioCtx, opts?.resetMetronome !== false)
  }

  // --- Reverb helpers ---
  private createImpulseResponse(params: ReverbParamsLite) {
    const ctx = this.audioCtx
    assert(ctx, 'Audio runtime was not initialized')
    return this.impulseCache.get(ctx, params)
  }

  subscribeTrackCompressorMeter(trackId: string, effectInstanceId: string, listener: CompressorMeterListener) {
    return this.mixerRuntime.subscribeTrackCompressorMeter(trackId, effectInstanceId, listener)
  }

  subscribeTrackGateMeter(trackId: string, effectInstanceId: string, listener: GateMeterListener) {
    return this.mixerRuntime.subscribeTrackGateMeter(trackId, effectInstanceId, listener)
  }

  async setTrackFxInstances(trackId: string, instances: AudioEffectRuntimeInstance[]) {
    await this.mixerRuntime.setTrackFxInstances(trackId, instances)
  }

  setExternalSidechainRoutes(routes: ExternalSidechainRoute[]) {
    this.mixerRuntime.setExternalSidechainRoutes(routes)
  }

  setCueTrackIds(trackIds: readonly string[]) {
    this.mixerRuntime.setCueTrackIds(trackIds)
  }

  setCueDestination(destination: AudioNode | null) {
    this.mixerRuntime.setCueDestination(destination)
  }

  subscribeMasterCompressorMeter(effectInstanceId: string, listener: CompressorMeterListener) {
    return this.masterFx.subscribeCompressorMeter(effectInstanceId, listener)
  }

  subscribeMasterGateMeter(effectInstanceId: string, listener: GateMeterListener) {
    return this.masterFx.subscribeGateMeter(effectInstanceId, listener)
  }

  async setMasterFxInstances(instances: AudioEffectRuntimeInstance[]) {
    await this.masterFx.setFxInstances(
      this.audioCtx,
      this.masterGain,
      this.destination,
      instances,
      (nextParams) => this.createImpulseResponse(nextParams),
    )
    this.mixerRuntime.publishGraphLatency()
  }

  previewTrackVolume(trackId: string, volume: number, muted: boolean) {
    this.mixerRuntime.previewTrackVolume(trackId, volume, muted)
  }

  setMasterVolume(volume: number) {
    const nextVolume = normalizeMasterVolume(volume)
    if (nextVolume === this.masterVolume) return
    this.masterVolume = nextVolume
    if (!this.masterGain) return
    this.masterGain.gain.value = nextVolume
  }

  updateTrackGains(tracks: RuntimeTrack[]) {
    this.tracksSnapshot = tracks
    this.mixerRuntime.updateTrackGains(tracks)
  }

  setAutomationEnvelopes(envelopes: AutomationEnvelope[]) {
    this.automationEnvelopes = envelopes
  }

  scheduleAutomationFromPlayhead(playheadSec: number, opts?: { horizonSec?: number; targetKeys?: ReadonlySet<string> }) {
    if (!this.audioCtx) return
    const horizonSec = opts?.horizonSec ?? LIVE_SCHEDULE_HORIZON_SEC
    const window = {
      playheadSec,
      startLimitSec: playheadSec,
      endLimitSec: playheadSec + horizonSec,
    }
    for (const envelope of this.automationEnvelopes) {
      if (opts?.targetKeys && !opts.targetKeys.has(envelope.targetKey)) continue
      if (!envelope.enabled) continue
      const descriptor = getAutomationParameterDescriptor(envelope.parameterId)
      const fallback = descriptor?.defaultValue ?? 0
      const bindings = envelope.target.kind === 'master'
        ? this.masterFx.resolveMasterAutomationBindings(envelope.parameterId, this.masterGain, envelope.target.effectInstanceId)
        : this.mixerRuntime.resolveTrackAutomationBindings(envelope.target.trackId, envelope.parameterId, envelope.target.effectInstanceId)
      scheduleAutomationEnvelope(bindings, envelope, window, (timeSec) => this.timelineToCtxTime(timeSec), fallback)
    }
  }

  applyAutomationAtTimelineSec(timeSec: number) {
    if (!this.audioCtx) return
    const now = this.audioCtx.currentTime
    for (const envelope of this.automationEnvelopes) {
      if (!envelope.enabled) continue
      const descriptor = getAutomationParameterDescriptor(envelope.parameterId)
      const fallback = descriptor?.defaultValue ?? 0
      const bindings = envelope.target.kind === 'master'
        ? this.masterFx.resolveMasterAutomationBindings(envelope.parameterId, this.masterGain, envelope.target.effectInstanceId)
        : this.mixerRuntime.resolveTrackAutomationBindings(envelope.target.trackId, envelope.parameterId, envelope.target.effectInstanceId)
      applyAutomationEnvelopeAtTime(bindings, envelope, timeSec, now, fallback)
    }
  }

  cancelAutomationSchedules(targetKeys?: ReadonlySet<string>, envelopes = this.automationEnvelopes) {
    const now = this.audioCtx?.currentTime ?? 0
    for (const envelope of envelopes) {
      if (targetKeys && !targetKeys.has(envelope.targetKey)) continue
      const bindings = envelope.target.kind === 'master'
        ? this.masterFx.resolveMasterAutomationBindings(envelope.parameterId, this.masterGain, envelope.target.effectInstanceId)
        : this.mixerRuntime.resolveTrackAutomationBindings(envelope.target.trackId, envelope.parameterId, envelope.target.effectInstanceId)
      for (const binding of bindings) binding.param.cancelScheduledValues(now)
    }
  }

  private disposeSynthTrack(id: string) {
    this.instrumentRuntime.disposeTrack(id)
  }

  private stopClipSources() {
    this.stopAllActiveNotes()
    // Snapshot currently active sources to avoid stopping newly scheduled ones
    const toStop = this.sources.snapshot()
    // Reset tracking immediately so subsequent schedules are isolated
    this.sources.clear()
    this.instrumentRuntime.clearActiveOscillators()

    // Quick master fade to avoid clicks
    const ctx = this.audioCtx
    const mg = this.masterGain
    let stopAt: number | null = null
    if (ctx && mg) {
      try {
        const now = ctx.currentTime
        const prev = mg.gain.value
        mg.gain.cancelScheduledValues(now)
        mg.gain.setValueAtTime(prev, now)
        mg.gain.linearRampToValueAtTime(0, now + MASTER_FADE_DOWN_SEC)
        const holdStart = now + MASTER_FADE_DOWN_SEC
        mg.gain.setValueAtTime(0, holdStart + MASTER_FADE_HOLD_SEC)
        mg.gain.linearRampToValueAtTime(prev, now + MASTER_FADE_UP_SEC)
        stopAt = now + MASTER_STOP_DELAY_SEC
      } catch {}
    }

    for (const source of toStop) stopAndDisconnectSource(source, stopAt ?? undefined)
  }

  stopAllSources() {
    this.stopClipSources()
    this.metronome.reset()
  }

  private scheduleMidiClip(track: RuntimeTrack, clip: RuntimeClip, playheadSec: number, nowCtx: number, startLimitSec?: number, endLimitSec?: number): boolean {
    if (!this.audioCtx) return false
    return this.instrumentRuntime.scheduleMidiClip(track, clip, startLimitSec ?? playheadSec, nowCtx, endLimitSec)
  }
  scheduleAllClipsFromPlayhead(tracks: RuntimeTrack[], playheadSec: number, opts?: ScheduleOptions): ScheduleResult {
    return this.scheduler.scheduleAllClipsFromPlayhead(tracks, playheadSec, opts)
  }

  private stopSourcesForClip(clipId: string) {
    // Stop audio buffer sources for this clip
    this.sources.stopClip(clipId)
    this.stopActiveNotesForClip(clipId)
  }

  rescheduleClipsAtPlayhead(tracks: RuntimeTrack[], playheadSec: number, clipIds: string[], opts?: ScheduleOptions) {
    return this.scheduler.rescheduleClipsAtPlayhead(tracks, playheadSec, clipIds, opts)
  }

  async resume() {
    if (this.audioCtx) {
      await this.audioCtx.resume()
    }
  }

  get currentTime() {
    return this.audioCtx?.currentTime ?? 0
  }

  get currentTimelineSec() {
    if (!this.audioCtx || !this.clock.isRunning()) return 0
    return this.clock.ctxTimeToTimeline(this.audioCtx.currentTime)
  }

  // Sum of output and base latency (seconds) if available; used for A/V visual alignment
  get outputLatencySec() {
    return getOutputLatencySec(this.runtime)
  }

  async decodeAudioData(arrayBuffer: ArrayBuffer) {
    return decodeAudioData(this.runtime, arrayBuffer)
  }

  close() {
    this.recording.cancel()
    this.stopAllSources()
    this.metronome.close()
    this.impulseCache.clear()
    this.mixerRuntime.clear()
    this.metering.close()
    this.instrumentRuntime.clear()
    this.automationEnvelopes = []
    this.masterFx.close()
    this.audioCtx?.removeEventListener('statechange', this.runtimeStateChangeListener)
    closeAudioRuntime(this.runtime)
    this.masterGain = null
    this.destination = null
    this.audioCtx = null
    this.runtime = null
    this.activeRuntimeOptions = null
    this.graphPdcLatencyFrames = null
    this.faultGeneration = this.runtimeFaultCounter.reset()
    this.inferredApplicationStallCount = 0
    this.publishRuntimeSnapshot()
  }

  // --- Live spectrum sampling (Ableton-like) ---
  getTrackSpectrum(trackId: string): SpectrumFrame | null {
    const output = this.mixerRuntime.getTrackOutput(trackId)
    return this.metering.getTrackSpectrum(this.audioCtx, trackId, output)
  }

  getMasterSpectrum(): SpectrumFrame | null {
    return this.masterFx.getSpectrum(this.audioCtx, this.masterGain)
  }
}
