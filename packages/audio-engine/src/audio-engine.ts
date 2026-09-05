import type { AudioRuntime, AudioRuntimeOptions } from './audio-runtime'
import { closeAudioRuntime, createAudioRuntime, decodeAudioData, getOutputLatencySec } from './audio-runtime'
import { isPlanarPcmForAsset, type AudioAssetRef, type PlanarPcm } from '../../audio-core-contract/src/index'
import type { AudioAssetRegistration, AudioAssetRelease } from './audio-asset-types'
import { canFallbackToRepitchStretch, createClipScheduler, type DeferredStretchWindow, type ScheduleOptions, type ScheduleResult } from './clip-scheduler'
import { createAudioStretchCache, isStretchQualityWarning, type AudioStretchRenderState } from './audio-stretch-cache'
import { arpeggiatorParamsEqual, automationTargetKey, getAutomationParameterDescriptor, normalizeMasterVolume, parseSynthAutomationKey, valueAtAutomationTime, type ArpParams, type AutomationEnvelope, type MidiMappingTarget, type SynthParamsInput, type TrackInstrumentParams } from '@daw-browser/shared'
import { createLiveMixerRuntime } from './live-mixer-runtime'
import { createMasterFxRuntime } from './master-fx-runtime'
import { createMeteringRuntime, type MasterStereoLevelsListener, type SpectrumFrame, type TrackMeterFrame, type TrackMeterFrameBatch, type TrackMeterFrameListener, type TrackStereoLevels, type TrackStereoLevelsBatch, type TrackStereoLevelsListener } from './metering-runtime'
import type { CompressorMeterFrame, CompressorMeterListener } from './effects/compressor-worklet'
import type { GateMeterFrame, GateMeterListener } from './effects/static-worklet-chain'
import { createMetronomeRuntime } from './metronome-runtime'
import { createSourceRegistry, stopAndDisconnectSource } from './source-registry'
import { createInstrumentRuntime, type SetTrackInstrumentInput } from './instrument-runtime'
import type { DrumRackRegionUse, DrumRackResolvedBuffers } from './drum-rack-runtime'
import type { SamplerNoteMiss, SamplerRegionUse, SamplerResolvedBuffers } from './sampler-runtime'
import type { GranularInstalledBuffer } from './granular-runtime'
export { createSamplerBufferCache } from './sampler-core'
import { createTransportClock } from './transport-clock'
import { createMidiTimestampConverter, type AudioClockResult } from './audio-clock'
import type { Clip, ExternalSidechainRoute, Track } from '@daw-browser/timeline-core/types'
import { applyAutomationEnvelopeAtTime, scheduleAutomationEnvelope, type AutomationAudioBinding } from './automation'
import type { AudioEffectRuntimeInstance } from './effects/runtime-instance'
import { createRecordingRuntime, type RecordingRuntimeStatus, type StartRecordingCaptureOptions } from './recording/recording-runtime'
import { analyzeCalibrationCapture, createCalibrationStimulus, type RecordingCalibrationAnalysis } from './recording/calibration'
import { createRuntimeFaultCounter, type RuntimeFaultSnapshot } from './runtime-diagnostics'
import { createLiveWorkletBudget } from './effects/live-worklet-budget'
import { resolveTrackMidiExpressionSchedule } from './midi-expression-scheduling'
import type { AudioPcmSourceDescriptor } from './media-pages'
import type { AudioStretchRuntimeClip } from './audio-stretch-rendering'

type RuntimeClip = Clip<AudioBuffer>
type RuntimeTrack = Track<AudioBuffer>

const MASTER_FADE_DOWN_SEC = 0.002
const MASTER_FADE_HOLD_SEC = 0.001
const MASTER_FADE_UP_SEC = 0.006
const MASTER_STOP_DELAY_SEC = 0.004
export const LIVE_SCHEDULE_HORIZON_SEC = 30

export { canFallbackToRepitchStretch, isStretchQualityWarning }
export { decodeEncodedAudioData } from './audio-runtime'
export type { AudioEffectRuntimeInstance, AudioRuntimeOptions, AudioStretchRenderState, CompressorMeterFrame, DeferredStretchWindow, GateMeterFrame, MasterStereoLevelsListener, SpectrumFrame, TrackMeterFrame, TrackMeterFrameBatch, TrackStereoLevels, TrackStereoLevelsBatch }
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
export type LiveMidiNoteHandle = {
  readonly id: number
}
type LiveMidiNote = {
  trackId: string
  instrumentKind: TrackInstrumentParams['kind']
  synthNoteInstanceId?: number
  synthGeneration?: number
  stop?: (when: number, force?: boolean) => boolean | void
  cleanupTimer?: ReturnType<typeof setTimeout>
}
type LiveNoteCleanupScheduler = {
  schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clear: (timer: ReturnType<typeof setTimeout>) => void
}
const defaultLiveNoteCleanupScheduler: LiveNoteCleanupScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (timer) => clearTimeout(timer),
}
const LIVE_GRANULAR_NOTE_DURATION_SEC = 0.5
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
  private workletBudget = createLiveWorkletBudget()
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
    reconnectTrackMeters: (trackId, output, isCurrentOutput) => {
      if (!this.audioCtx) return
      this.metering.reconnectTrackMeters(this.audioCtx, trackId, output, isCurrentOutput)
    },
    disposeTrackMeters: (trackId) => this.metering.disposeTrack(trackId),
    disposeSynthTrack: (trackId) => this.disposeSynthTrack(trackId),
    getMasterFx: () => this.masterFx.getMixerFx(),
    workletBudget: this.workletBudget,
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
    workletBudget: this.workletBudget,
    onWorkletFault: (generation, kind, code, context) => {
      if (this.runtimeFaultCounter.report(generation, { kind, code, context })) this.publishRuntimeSnapshot()
    },
  })
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
  private nextLiveMidiNoteId = 1
  private liveMidiNotes = new Map<number, LiveMidiNote>()
  private arpeggiatorListeners = new Set<(trackId: string) => void>()
  private liveNoteCleanupScheduler: LiveNoteCleanupScheduler
  private transientMidiMappingBaselines = new Map<string, {
    values: Map<AutomationAudioBinding['param'], number>
    restoreTime?: number
    sourceIds: Set<string>
    sourceValues: Map<string, number>
  }>()
  private scheduledMidiMappingParams = new Map<string, Set<AutomationAudioBinding['param']>>()
  private transientMidiMappingTargets = new Map<string, { trackId: string; target: MidiMappingTarget }>()
  private nextAssetSlot = 0
  private assets = new Map<string, {
    readonly handle: { slot: number; generation: number }
    readonly projectGeneration: number
    retainCount: number
  }>()
  private midiTimestampConverter = createMidiTimestampConverter({
    context: () => this.audioCtx,
    performanceNow: () => performance.now(),
    contextTimeToTimeline: (contextTime) => this.clock.ctxTimeToTimeline(contextTime),
  })

  constructor(options: AudioRuntimeOptions = { latencyHint: 'interactive' }, liveNoteCleanupScheduler = defaultLiveNoteCleanupScheduler) {
    this.runtimeOptions = options
    this.liveNoteCleanupScheduler = liveNoteCleanupScheduler
  }

  setAudioSourceResolver(resolver: (clip: AudioStretchRuntimeClip, signal?: AbortSignal) => Promise<AudioPcmSourceDescriptor>) {
    this.stretchCache.setSourceResolver(resolver)
  }

  invalidateAudioSourceCache() {
    this.stretchCache.invalidate()
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

  subscribeMasterStereoLevels(listener: MasterStereoLevelsListener) {
    return this.metering.subscribeMasterStereoLevels(listener)
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

  midiEventTimes(timeStamp: number): AudioClockResult | undefined {
    return this.midiTimestampConverter(timeStamp)
  }

  triggerSynthNote(input: {
    trackId: string
    pitch: number
    velocity?: number
    when: number
    durationSec: number
    live?: boolean
  }) {
    this.ensureAudio()
    return this.instrumentRuntime.triggerSynthNote(input)
  }

  previewSynthNote(trackId: string, pitch: number, velocity?: number, durationSec?: number) {
    this.ensureAudio()
    return this.instrumentRuntime.previewSynthNote(trackId, pitch, velocity, durationSec)
  }

  startSynthPreviewNote(trackId: string, pitch: number, velocity?: number) {
    this.ensureAudio()
    return this.instrumentRuntime.startSynthPreviewNote(trackId, pitch, velocity)
  }

  releaseSynthPreviewNote(trackId: string, noteInstanceId: number, when?: number) {
    this.instrumentRuntime.releaseSynthPreviewNote(trackId, noteInstanceId, when)
  }

  startLiveMidiNote(input: {
    trackId: string
    pitch: number
    velocity: number
    when: number
  }): LiveMidiNoteHandle | undefined {
    this.ensureAudio()
    const instrumentKind = this.instrumentRuntime.getTrackInstrumentKind(input.trackId)
    if (!instrumentKind) return undefined
    const id = this.nextLiveMidiNoteId++
    if (instrumentKind === 'synth') {
      const synthNoteInstanceId = this.instrumentRuntime.triggerSynthNote({
        ...input,
        durationSec: 86_400,
        live: true,
      })
      if (synthNoteInstanceId === undefined) return undefined
      const synthGeneration = this.instrumentRuntime.getSynthLiveVoiceGeneration(input.trackId)
      if (synthGeneration === undefined) return undefined
      this.liveMidiNotes.set(id, { trackId: input.trackId, instrumentKind, synthNoteInstanceId, synthGeneration })
      return { id }
    }
    let endedBeforeRegistration = false
    const onEnded = () => {
      if (this.liveMidiNotes.has(id)) this.removeLiveMidiNote(id)
      else endedBeforeRegistration = true
    }
    const stop = instrumentKind === 'sampler'
      ? this.instrumentRuntime.startLiveSamplerNote(input.trackId, input.pitch, input.velocity, undefined, onEnded)
      : instrumentKind === 'drum-rack'
        ? this.instrumentRuntime.startLiveDrumRackNote(input.trackId, input.pitch, input.velocity, onEnded)
        : instrumentKind === 'granular'
          ? this.instrumentRuntime.startLiveGranularNote(
              input.trackId,
              input.when,
              LIVE_GRANULAR_NOTE_DURATION_SEC,
              `live-granular:${id}`,
            )
        : undefined
    if (!stop) return undefined
    const note: LiveMidiNote = { trackId: input.trackId, instrumentKind, stop }
    this.liveMidiNotes.set(id, note)
    if (instrumentKind === 'granular') {
      // AudioWorklet gates expose no ended event, so one bounded cleanup timer releases
      // ownership after the scheduled note end. It is cleared by force-stop and close.
      note.cleanupTimer = this.liveNoteCleanupScheduler.schedule(
        () => this.expireLiveMidiNote(id),
        Math.max(0, input.when - (this.audioCtx?.currentTime ?? input.when) + LIVE_GRANULAR_NOTE_DURATION_SEC) * 1_000,
      )
    }
    if (endedBeforeRegistration) this.removeLiveMidiNote(id)
    return { id }
  }

  releaseLiveMidiNote(handle: LiveMidiNoteHandle, when: number, force = false, gate = false) {
    const note = this.liveMidiNotes.get(handle.id)
    if (!note) return
    if (note.synthNoteInstanceId !== undefined) {
      this.removeLiveMidiNote(handle.id)
      this.instrumentRuntime.releaseSynthPreviewNote(
        note.trackId,
        note.synthNoteInstanceId,
        when,
        force,
        note.synthGeneration,
      )
    } else if (force || (gate && note.instrumentKind === 'granular')) {
      this.removeLiveMidiNote(handle.id)
      note.stop?.(when, force)
    } else if (note.instrumentKind === 'sampler' && note.stop?.(when) === true) {
      this.removeLiveMidiNote(handle.id)
    }
  }

  private removeLiveMidiNote(id: number) {
    const note = this.liveMidiNotes.get(id)
    if (!note) return
    this.liveMidiNotes.delete(id)
    if (note.cleanupTimer) this.liveNoteCleanupScheduler.clear(note.cleanupTimer)
  }

  private expireLiveMidiNote(id: number) {
    const note = this.liveMidiNotes.get(id)
    if (!note) return
    this.removeLiveMidiNote(id)
    note.stop?.(this.audioCtx?.currentTime ?? 0)
  }

  panicLiveMidi() {
    const now = this.audioCtx?.currentTime ?? 0
    for (const id of Array.from(this.liveMidiNotes.keys())) this.releaseLiveMidiNote({ id }, now, true)
  }

  getTrackInstrumentKind(trackId: string): TrackInstrumentParams['kind'] | undefined {
    return this.instrumentRuntime.getTrackInstrumentKind(trackId)
  }

  ensureAudio(opts?: { applyCachedTrackGains?: boolean }) {
    if (!this.audioCtx) {
      this.midiTimestampConverter.reset()
      this.runtime = createAudioRuntime(this.runtimeOptions)
      this.faultGeneration = this.runtimeFaultCounter.generation()
      this.activeRuntimeOptions = this.runtimeOptions
      this.audioCtx = this.runtime.ctx
      this.audioCtx.addEventListener('statechange', this.runtimeStateChangeListener)
      this.masterGain = this.runtime.masterGain
      this.masterGain.gain.value = this.masterVolume
      this.destination = this.runtime.destination
      this.metering.reconnectMasterMeter(this.audioCtx, this.masterGain, () => this.masterGain === this.runtime?.masterGain)
      this.masterFx.applyPending(this.audioCtx, this.masterGain, this.destination)
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

  setTrackSynth(trackId: string, params: SynthParamsInput, instanceId?: string) {
    this.instrumentRuntime.setTrackSynth(trackId, params, instanceId)
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
    onAssetUse?: (use: SamplerRegionUse) => void
    onDrumRackAssetUse?: (use: DrumRackRegionUse) => void
  }) {
    this.instrumentRuntime.setSamplerRuntimeListeners(listeners)
  }

  addSamplerRuntimeListeners(listeners: {
    onNoteMiss?: (miss: SamplerNoteMiss) => void
    onAssetUse?: (use: SamplerRegionUse) => void
    onDrumRackAssetUse?: (use: DrumRackRegionUse) => void
  }) {
    return this.instrumentRuntime.addSamplerRuntimeListeners(listeners)
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
    if (arpeggiatorParamsEqual(this.instrumentRuntime.getTrackArpeggiator(trackId), params)) return
    this.instrumentRuntime.setTrackArpeggiator(trackId, params)
    for (const listener of this.arpeggiatorListeners) listener(trackId)
  }

  getTrackArpeggiator(trackId: string): ArpParams | undefined {
    return this.instrumentRuntime.getTrackArpeggiator(trackId)
  }

  clearTrackArpeggiator(trackId: string) {
    if (this.instrumentRuntime.getTrackArpeggiator(trackId) === undefined) return
    this.instrumentRuntime.clearTrackArpeggiator(trackId)
    for (const listener of this.arpeggiatorListeners) listener(trackId)
  }

  subscribeArpeggiator(listener: (trackId: string) => void) {
    this.arpeggiatorListeners.add(listener)
    return () => this.arpeggiatorListeners.delete(listener)
  }

  getBpm() {
    return this.clock.getBpm()
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
    this.clock.pause(this.audioCtx?.currentTime ?? 0)
    this.metronome.onTransportPause()
  }

  onTransportStop() {
    this.cancelAutomationSchedules()
    this.clock.stop(this.audioCtx?.currentTime ?? 0)
    this.metronome.onTransportPause()
  }

  onTransportSeek(playheadSec: number, offsetSec = 0, opts?: { resetMetronome?: boolean }) {
    if (!this.audioCtx) return
    this.clock.seek(this.audioCtx.currentTime, playheadSec, offsetSec)
    this.metronome.onTransportSeek(this.audioCtx, opts?.resetMetronome !== false)
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

  scheduleAutomationFromPlayhead(playheadSec: number, opts?: {
    horizonSec?: number
    targetKeys?: ReadonlySet<string>
    tracks?: RuntimeTrack[]
  }) {
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
      const bindings = this.resolveAutomationBindings(envelope)
      scheduleAutomationEnvelope(bindings, envelope, window, (timeSec) => this.timelineToCtxTime(timeSec), fallback)
    }
    this.scheduleMidiExpressionFromPlayhead(playheadSec, horizonSec, opts?.targetKeys, opts?.tracks)
  }

  applyAutomationAtTimelineSec(timeSec: number) {
    if (!this.audioCtx) return
    const now = this.audioCtx.currentTime
    for (const envelope of this.automationEnvelopes) {
      if (!envelope.enabled) continue
      const descriptor = getAutomationParameterDescriptor(envelope.parameterId)
      const fallback = descriptor?.defaultValue ?? 0
      const bindings = this.resolveAutomationBindings(envelope)
      applyAutomationEnvelopeAtTime(bindings, envelope, timeSec, now, fallback)
    }
    this.scheduleMidiExpressionFromPlayhead(timeSec, 0)
  }

  writeTransientMidiMapping(
    trackId: string,
    target: MidiMappingTarget,
    value: number,
    when = this.audioCtx?.currentTime ?? 0,
    sourceId?: string,
  ) {
    const bindings = this.mixerRuntime.resolveTrackAutomationBindings(trackId, target.parameterId, target.effectInstanceId)
    const key = this.midiMappingTargetKey(trackId, target)
    this.transientMidiMappingTargets.set(key, { trackId, target })
    const baselineState = this.transientMidiMappingBaselines.get(key)
    const baselines = baselineState?.values ?? new Map<AutomationAudioBinding['param'], number>()
    for (const binding of bindings) {
      if (!baselines.has(binding.param)) baselines.set(binding.param, binding.param.value ?? binding.valueToAudioValue(value))
      binding.param.setValueAtTime(binding.valueToAudioValue(value), when)
    }
    if (baselines.size > 0) {
      const sourceIds = baselineState?.sourceIds ?? new Set<string>()
      const sourceValues = baselineState?.sourceValues ?? new Map<string, number>()
      if (sourceId !== undefined) {
        sourceIds.add(sourceId)
        sourceValues.delete(sourceId)
        sourceValues.set(sourceId, value)
      }
      this.transientMidiMappingBaselines.set(key, { values: baselines, sourceIds, sourceValues })
    }
  }

  restoreTransientMidiMapping(
    trackId: string,
    target: MidiMappingTarget,
    when = this.audioCtx?.currentTime ?? 0,
    sourceId?: string,
  ) {
    const descriptor = getAutomationParameterDescriptor(target.parameterId)
    const timelineSec = this.clock.ctxTimeToTimeline(when)
    const envelope = this.automationEnvelopes.find((candidate) => (
      candidate.enabled
      && candidate.target.kind === 'track'
      && candidate.target.trackId === trackId
      && candidate.target.effectInstanceId === target.effectInstanceId
      && candidate.parameterId === target.parameterId
    ))
    const key = this.midiMappingTargetKey(trackId, target)
    const baseline = this.transientMidiMappingBaselines.get(key)
    if (sourceId !== undefined && baseline) {
      baseline.sourceIds.delete(sourceId)
      baseline.sourceValues.delete(sourceId)
      const activeValue = Array.from(baseline.sourceValues.values()).at(-1)
      if (baseline.sourceIds.size > 0 && activeValue !== undefined) {
        const bindings = this.mixerRuntime.resolveTrackAutomationBindings(
          trackId,
          target.parameterId,
          target.effectInstanceId,
        )
        for (const binding of bindings) binding.param.setValueAtTime(binding.valueToAudioValue(activeValue), when)
        return
      }
    }
    if (!envelope && baseline) {
      if (baseline.restoreTime === undefined || when < baseline.restoreTime) {
        for (const [param, value] of baseline.values) param.setValueAtTime(value, when)
      }
      this.transientMidiMappingBaselines.delete(key)
      this.transientMidiMappingTargets.delete(key)
      return
    }
    const track = this.tracksSnapshot.find((candidate) => candidate.id === trackId)
    const value = envelope
      ? valueAtAutomationTime(envelope.points, timelineSec, descriptor?.defaultValue ?? 0)
      : target.parameterId === 'volume'
        ? track?.volume ?? descriptor?.defaultValue ?? 0
        : descriptor?.defaultValue ?? 0
    this.writeTransientMidiMapping(trackId, target, value, when)
    this.transientMidiMappingBaselines.delete(key)
    this.transientMidiMappingTargets.delete(key)
  }

  private scheduleMidiExpressionFromPlayhead(
    playheadSec: number,
    horizonSec: number,
    targetKeys?: ReadonlySet<string>,
    tracks = this.tracksSnapshot,
  ) {
    if (!this.audioCtx) return
    for (const [key, state] of this.transientMidiMappingBaselines) {
      if (state.restoreTime !== undefined && state.restoreTime <= this.audioCtx.currentTime) {
        this.transientMidiMappingBaselines.delete(key)
        this.transientMidiMappingTargets.delete(key)
      }
    }
    const endSec = playheadSec + horizonSec
    for (const track of tracks) {
      const events = resolveTrackMidiExpressionSchedule({
        clips: track.clips,
        trackId: track.id,
        trackVolume: track.volume,
        automationEnvelopes: this.automationEnvelopes,
        bpm: this.clock.getBpm(),
        rangeStartSec: playheadSec,
        rangeEndSec: endSec,
      })
      for (const event of events) {
        const targetKey = this.midiMappingTargetKey(track.id, event.target)
        if (targetKeys && !targetKeys.has(targetKey)) continue
        const bindings = this.mixerRuntime.resolveTrackAutomationBindings(
          track.id,
          event.target.parameterId,
          event.target.effectInstanceId,
        )
        if (bindings.length === 0) continue
        const value = event.value
        const hasAutomationEnvelope = this.automationEnvelopes.some((candidate) => (
          candidate.enabled
          && candidate.target.kind === 'track'
          && candidate.target.trackId === track.id
          && candidate.target.effectInstanceId === event.target.effectInstanceId
          && candidate.parameterId === event.target.parameterId
        ))
        const contextTime = this.timelineToCtxTime(event.timeSec)
        this.transientMidiMappingTargets.set(targetKey, { trackId: track.id, target: event.target })
        const baselineState = this.transientMidiMappingBaselines.get(targetKey)
        const baselines = baselineState?.values ?? new Map<AutomationAudioBinding['param'], number>()
        const scheduledParams = this.scheduledMidiMappingParams.get(targetKey) ?? new Set<AutomationAudioBinding['param']>()
        for (const binding of bindings) {
          if (!baselines.has(binding.param)) baselines.set(binding.param, binding.param.value ?? binding.valueToAudioValue(value))
          scheduledParams.add(binding.param)
          const configuredValue = event.phase === 'restore' && !hasAutomationEnvelope
            ? baselines.get(binding.param)
            : undefined
          binding.param.setValueAtTime(configuredValue ?? binding.valueToAudioValue(value), contextTime)
        }
        if (baselines.size > 0) this.transientMidiMappingBaselines.set(targetKey, {
          values: baselines,
          sourceIds: baselineState?.sourceIds ?? new Set<string>(),
          sourceValues: baselineState?.sourceValues ?? new Map<string, number>(),
          restoreTime: event.phase === 'restore' ? contextTime : undefined,
        })
        if (scheduledParams.size > 0) this.scheduledMidiMappingParams.set(targetKey, scheduledParams)
      }
    }
  }

  cancelAutomationSchedules(targetKeys?: ReadonlySet<string>, envelopes = this.automationEnvelopes) {
    const now = this.audioCtx?.currentTime ?? 0
    for (const envelope of envelopes) {
      if (targetKeys && !targetKeys.has(envelope.targetKey)) continue
      const bindings = this.resolveAutomationBindings(envelope)
      for (const binding of bindings) binding.param.cancelScheduledValues(now)
    }
    for (const [key, params] of this.scheduledMidiMappingParams) {
      if (targetKeys && !targetKeys.has(key)) continue
      for (const param of params) param.cancelScheduledValues(now)
      this.scheduledMidiMappingParams.delete(key)
      const target = this.transientMidiMappingTargets.get(key)
      if (target) this.restoreTransientMidiMapping(target.trackId, target.target, now)
    }
  }

  restoreAutomationTargets(targetKeys: ReadonlySet<string>, envelopes: readonly AutomationEnvelope[]) {
    const now = this.audioCtx?.currentTime ?? 0
    for (const envelope of envelopes) {
      if (!targetKeys.has(envelope.targetKey)) continue
      for (const binding of this.resolveAutomationBindings(envelope)) {
        const value = binding.param.value
        if (value === undefined) continue
        binding.param.cancelScheduledValues(now)
        binding.param.setValueAtTime(value, now)
      }
    }
  }

  private midiMappingTargetKey(trackId: string, target: MidiMappingTarget) {
    return automationTargetKey({
      kind: 'track',
      trackId,
      effectInstanceId: target.effectInstanceId,
    }, target.parameterId)
  }

  private disposeSynthTrack(id: string) {
    this.instrumentRuntime.disposeTrack(id)
  }

  private resolveAutomationBindings(envelope: AutomationEnvelope) {
    return envelope.target.kind === 'master'
      ? this.masterFx.resolveMasterAutomationBindings(envelope.parameterId, this.masterGain, envelope.target.effectInstanceId)
      : parseSynthAutomationKey(envelope.parameterId)
        ? this.instrumentRuntime.resolveSynthAutomationBindings(envelope.target.trackId, envelope.parameterId)
        : this.mixerRuntime.resolveTrackAutomationBindings(envelope.target.trackId, envelope.parameterId, envelope.target.effectInstanceId)
  }

  private stopClipSources() {
    this.panicLiveMidi()
    this.stopAllActiveNotes()
    // Snapshot currently active sources to avoid stopping newly scheduled ones
    const toStop = this.sources.snapshot()
    // Reset tracking immediately so subsequent schedules are isolated
    this.sources.clear()

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
    return this.instrumentRuntime.scheduleMidiClip(
      track,
      clip,
      startLimitSec ?? playheadSec,
      nowCtx,
      endLimitSec,
      { scheduleVoiceAutomation: false },
    )
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
    return this.clock.ctxTimeToTimeline(this.audioCtx?.currentTime ?? 0)
  }

  // Sum of output and base latency (seconds) if available; used for A/V visual alignment
  get outputLatencySec() {
    return getOutputLatencySec(this.runtime)
  }

  async decodeAudioData(arrayBuffer: ArrayBuffer, targetSampleRate?: number) {
    return decodeAudioData(this.runtime, arrayBuffer, targetSampleRate)
  }

  registerAsset(asset: AudioAssetRef, pcm: PlanarPcm, projectGeneration: number): AudioAssetRegistration {
    if (!isPlanarPcmForAsset(asset, pcm)) return { status: 'invalid-pcm' }
    const existing = this.assets.get(asset.assetId)
    if (existing) {
      if (existing.projectGeneration !== projectGeneration) return { status: 'stale-generation' }
      existing.retainCount += 1
      return { status: 'registered', handle: existing.handle }
    }
    const handle = { slot: this.nextAssetSlot, generation: 1 }
    this.nextAssetSlot += 1
    this.assets.set(asset.assetId, { handle, projectGeneration, retainCount: 1 })
    return { status: 'registered', handle }
  }

  retainAsset(assetId: string, projectGeneration: number): AudioAssetRegistration {
    const existing = this.assets.get(assetId)
    if (!existing || existing.projectGeneration !== projectGeneration) return { status: 'stale-generation' }
    existing.retainCount += 1
    return { status: 'registered', handle: existing.handle }
  }

  releaseAsset(assetId: string, projectGeneration: number): AudioAssetRelease {
    const existing = this.assets.get(assetId)
    if (!existing || existing.projectGeneration !== projectGeneration) return { status: 'stale-generation' }
    existing.retainCount -= 1
    if (existing.retainCount === 0) this.assets.delete(assetId)
    return { status: 'released' }
  }

  retireAssetGeneration(projectGeneration: number) {
    for (const [assetId, asset] of this.assets) {
      if (asset.projectGeneration === projectGeneration) this.assets.delete(assetId)
    }
  }

  close() {
    this.recording.cancel()
    this.cancelAutomationSchedules()
    this.stopAllSources()
    this.metronome.close()
    this.mixerRuntime.clear()
    this.metering.close()
    this.instrumentRuntime.clear()
    this.stretchCache.dispose()
    this.arpeggiatorListeners.clear()
    this.automationEnvelopes = []
    this.transientMidiMappingBaselines.clear()
    this.scheduledMidiMappingParams.clear()
    this.transientMidiMappingTargets.clear()
    this.midiTimestampConverter.reset()
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
