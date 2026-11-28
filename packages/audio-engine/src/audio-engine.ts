import type { AudioRuntime, AudioRuntimeOptions } from './audio-runtime'
import { closeAudioRuntime, createAudioRuntime, decodeAudioData, getOutputLatencySec } from './audio-runtime'
import { isPlanarPcmForAsset, type AudioAssetRef, type PlanarPcm } from '../../audio-core-contract/src/index'
import type { AudioAssetRegistration, AudioAssetRelease } from './audio-asset-types'
import { createAudioStretchCache, isStretchQualityWarning, type AudioStretchRenderState } from './audio-stretch-cache'
import { arpeggiatorParamsEqual, automationTargetKey, getAutomationParameterDescriptor, normalizeMasterVolume, parseSynthAutomationKey, valueAtAutomationTime, type ArpParams, type AudioPcmSourceDescriptor, type AutomationEnvelope, type MidiMappingTarget, type SpectrumSettings, type SynthParamsInput, type TrackInstrumentParams } from '@daw-browser/shared'
import { createLiveMixerRuntime } from './live-mixer-runtime'
import { createMasterFxRuntime } from './master-fx-runtime'
import { createMeteringRuntime, type MasterStereoLevelsListener, type SpectrumFrame, type TrackMeterFrame, type TrackMeterFrameBatch, type TrackStereoLevels, type TrackStereoLevelsBatch, type TrackStereoLevelsListener } from './metering-runtime'
import type { CompressorMeterFrame } from './effects/compressor-worklet'
import type { GateMeterFrame } from './effects/static-worklet-chain'
import { createMetronomeRuntime } from './metronome-runtime'
import { createSourceRegistry, stopAndDisconnectSource } from './source-registry'
import { createInstrumentRuntime, type SetTrackInstrumentInput } from './instrument-runtime'


import { createTransportClock } from './transport-clock'
import { rampAudioParam } from './audio-param-ramp'
import { createMidiTimestampConverter, type AudioClockResult } from './audio-clock'
import type { Clip, ExternalSidechainRoute, Track } from '@daw-browser/timeline-core/types'
import { applyAutomationEnvelopeAtTime, scheduleAutomationEnvelope, type AutomationAudioBinding } from './automation'
import type { AudioEffectRuntimeInstance } from './effects/runtime-instance'
import type { EngineDisposition } from './engine-disposition'
import { createRecordingRuntime, type StartRecordingCaptureOptions } from './recording/recording-runtime'
import { analyzeCalibrationCapture, createCalibrationStimulus, type RecordingCalibrationAnalysis } from './recording/calibration'
import { createRuntimeFaultCounter, type RuntimeFaultSnapshot } from './runtime-diagnostics'
import { createLiveWorkletBudget } from './effects/live-worklet-budget'
import { findTrackAutomationEnvelope, indexTrackAutomationEnvelopes, resolveTrackMidiExpressionSchedule } from './midi-expression-scheduling'
import type { AudioStretchRuntimeClip } from './audio-stretch-rendering'

type RuntimeClip = Clip<AudioBuffer>

type RuntimeTrack = Track<AudioBuffer>

const MASTER_FADE_DOWN_SEC = 0.002
const MASTER_FADE_HOLD_SEC = 0.001
const MASTER_FADE_UP_SEC = 0.006
const MASTER_STOP_DELAY_SEC = 0.004
export const LIVE_SCHEDULE_HORIZON_SEC = 30

export { isStretchQualityWarning }

export { decodeEncodedAudioData } from './audio-runtime'

export type { AudioEffectRuntimeInstance, AudioRuntimeOptions, EngineDisposition, AudioStretchRenderState, CompressorMeterFrame, GateMeterFrame, MasterStereoLevelsListener, SpectrumFrame, TrackMeterFrame, TrackMeterFrameBatch, TrackStereoLevels, TrackStereoLevelsBatch }

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
  private workletBudget = createLiveWorkletBudget()
  readonly instruments = createInstrumentRuntime()
  readonly mixer = createLiveMixerRuntime({
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
  readonly masterFx = createMasterFxRuntime({
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
  readonly metering = createMeteringRuntime({
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
  readonly recording = createRecordingRuntime({
    getContext: () => this.audioCtx,
    connectMonitor: (trackId, source) => this.mixer.connectRecordingMonitor(trackId, source),
    getFaultGeneration: () => this.faultGeneration,
    onFault: (generation, code) => {
      if (this.runtimeFaultCounter.report(generation, { kind: 'recorder', code, context: 'recording-capture' })) {
        this.publishRuntimeSnapshot()
      }
    },
  })
  private calibrationReserved = false
  private recordingStartReserved = false
  private arpeggiatorListeners = new Set<(trackId: string) => void>()
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

  constructor(options: AudioRuntimeOptions = { latencyHint: 'interactive' }) {
    this.runtimeOptions = options
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

  startRecordingCapture(options: StartRecordingCaptureOptions) {
    if (this.calibrationReserved) throw new Error('Wait for recording calibration to finish.')
    this.recordingStartReserved = true

    return this.recording.start(options).finally(() => {
      this.recordingStartReserved = false
    })
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

  getAudioContext() {
    return this.audioCtx
  }

  midiEventTimes(timeStamp: number): AudioClockResult | undefined {
    return this.midiTimestampConverter(timeStamp)
  }

  getTrackInstrumentKind(trackId: string): TrackInstrumentParams['kind'] | undefined {
    return this.instruments.getTrackInstrumentKind(trackId)
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

  setTrackSynth(trackId: string, params: SynthParamsInput, instanceId?: string): EngineDisposition {
    return this.instruments.setTrackSynth(trackId, params, instanceId)
  }

  setTrackInstrument(trackId: string, input: SetTrackInstrumentInput): EngineDisposition {
    return this.instruments.setTrackInstrument(trackId, input)
  }

  setTrackArpeggiator(trackId: string, params: ArpParams): EngineDisposition {
    if (arpeggiatorParamsEqual(this.instruments.getTrackArpeggiator(trackId), params)) return 'skipped'
    this.instruments.setTrackArpeggiator(trackId, params)

    for (const listener of this.arpeggiatorListeners) listener(trackId)

    return 'applied'
  }

  clearTrackArpeggiator(trackId: string) {
    if (this.instruments.getTrackArpeggiator(trackId) === undefined) return
    this.instruments.clearTrackArpeggiator(trackId)

    for (const listener of this.arpeggiatorListeners) listener(trackId)
  }

  subscribeArpeggiator(listener: (trackId: string) => void) {
    this.arpeggiatorListeners.add(listener)

    return () => this.arpeggiatorListeners.delete(listener)
  }

  getBpm() {
    return this.clock.getBpm()
  }

  clearTrackInstrument(trackId: string) {
    this.instruments.clearTrackInstrument(trackId)
  }

  setBpm(nextBpm: number) {
    if (!this.clock.setBpm(nextBpm)) return
    this.metronome.onBpmChange(this.audioCtx)
    // A failed track delay write must not leave the master delays on the old tempo; the first failure is the one reported.
    let failure: unknown

    for (const runtime of [this.mixer, this.masterFx]) {
      try {
        runtime.setBpm(nextBpm)
      } catch (error) {
        failure ??= error
      }
    }

    if (failure !== undefined) throw failure
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

  setTrackFxInstances(trackId: string, instances: AudioEffectRuntimeInstance[]): Promise<EngineDisposition> {
    return this.mixer.setTrackFxInstances(trackId, instances)
  }

  setExternalSidechainRoutes(routes: ExternalSidechainRoute[]) {
    this.mixer.setExternalSidechainRoutes(routes)
  }

  setMasterFxInstances(instances: AudioEffectRuntimeInstance[]): Promise<EngineDisposition> {
    return this.applyMasterFxInstances(instances)
  }

  private async applyMasterFxInstances(instances: AudioEffectRuntimeInstance[]): Promise<EngineDisposition> {
    const { disposition, inPlace } = await this.masterFx.setFxInstances(
      this.audioCtx,
      this.masterGain,
      this.destination,
      instances,
    )

    if (!inPlace) this.mixer.publishGraphLatency()

    return disposition
  }

  /** Replaces one instance of the retained chain. Resolves 'not-held' when the chain does not hold it: send the whole chain. */
  setTrackFxInstance(trackId: string, instance: AudioEffectRuntimeInstance) {
    return this.mixer.replaceTrackFxInstance(trackId, instance)
  }

  /** Master twin of {@link setTrackFxInstance}. */
  async setMasterFxInstance(instance: AudioEffectRuntimeInstance): Promise<EngineDisposition | 'not-held'> {
    const retained = this.masterFx.retainedInstances()

    if (!retained.some((entry) => entry.id === instance.id)) return 'not-held'

    return this.applyMasterFxInstances(retained.map((entry) => entry.id === instance.id ? instance : entry))
  }

  setMasterVolume(volume: number) {
    const nextVolume = normalizeMasterVolume(volume)

    if (nextVolume === this.masterVolume) return
    this.masterVolume = nextVolume
    const context = this.audioCtx

    if (!this.masterGain || !context) return

    if (!this.automationEnvelopes.some((envelope) => (
      envelope.enabled && envelope.target.kind === 'master' && envelope.parameterId === 'volume'
    ))) {
      rampAudioParam(this.masterGain.gain, nextVolume, context.currentTime)
    }
  }

  updateTrackGains(tracks: RuntimeTrack[]) {
    this.tracksSnapshot = tracks
    this.mixer.updateTrackGains(tracks)
  }

  setAutomationEnvelopes(envelopes: AutomationEnvelope[]) {
    this.automationEnvelopes = envelopes
    this.mixer.setAutomatedVolumeTargets(envelopes)
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
    const bindings = this.mixer.resolveTrackAutomationBindings(trackId, target.parameterId, target.effectInstanceId)
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
        const bindings = this.mixer.resolveTrackAutomationBindings(
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
    const envelopeIndex = indexTrackAutomationEnvelopes(this.automationEnvelopes)

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

        const bindings = this.mixer.resolveTrackAutomationBindings(
          track.id,
          event.target.parameterId,
          event.target.effectInstanceId,
        )

        if (bindings.length === 0) continue
        const value = event.value
        const hasAutomationEnvelope = findTrackAutomationEnvelope(envelopeIndex, track.id, event.target) !== undefined
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
    this.instruments.disposeTrack(id)
  }

  private resolveAutomationBindings(envelope: AutomationEnvelope) {
    return envelope.target.kind === 'master'
      ? this.masterFx.resolveMasterAutomationBindings(envelope.parameterId, this.masterGain, envelope.target.effectInstanceId)
      : parseSynthAutomationKey(envelope.parameterId)
        ? []
        : this.mixer.resolveTrackAutomationBindings(envelope.target.trackId, envelope.parameterId, envelope.target.effectInstanceId)
  }

  private stopClipSources() {
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

  get outputLatencySec() {
  // Sum of output and base latency (seconds) if available; used for A/V visual alignment
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
    this.mixer.clear()
    this.metering.close()
    this.instruments.clear()
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

  getTrackSpectrum(trackId: string, settings: SpectrumSettings): SpectrumFrame | null {
    const output = this.mixer.getTrackOutput(trackId)

    return this.metering.getTrackSpectrum(this.audioCtx, trackId, output, settings)
  }

  getMasterSpectrum(settings: SpectrumSettings): SpectrumFrame | null {
    return this.masterFx.getSpectrum(this.audioCtx, this.masterGain, settings)
  }
}
