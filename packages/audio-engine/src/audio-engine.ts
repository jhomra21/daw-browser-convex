import { closeAudioRuntime, createAudioRuntime, decodeAudioData, getOutputLatencySec, type AudioRuntime } from './audio-runtime'
import { canFallbackToRepitchStretch, createClipScheduler, type DeferredStretchWindow, type ScheduleOptions, type ScheduleResult } from './clip-scheduler'
import { createAudioStretchCache, isStretchQualityWarning, type AudioStretchRenderState } from './audio-stretch-cache'
import { getAutomationParameterDescriptor, normalizeMasterVolume, type ArpParams, type AudioEffectKind, type AutomationEnvelope, type CompressorParamsLite, type DelayParamsLite, type EqParamsLite, type ReverbParamsLite, type SaturatorParamsLite, type SynthParamsInput, type TrackInstrumentParams } from '@daw-browser/shared'
import { createReverbImpulseCache } from './effects/reverb-impulse-cache'
import { createLiveMixerRuntime } from './live-mixer-runtime'
import { createMasterFxRuntime } from './master-fx-runtime'
import { createMeteringRuntime, type SpectrumFrame, type TrackStereoLevels, type TrackStereoLevelsBatch, type TrackStereoLevelsListener } from './metering-runtime'
import type { CompressorMeterFrame, CompressorMeterListener } from './effects/compressor-worklet'
import { createMetronomeRuntime } from './metronome-runtime'
import { createSourceRegistry, stopAndDisconnectSource } from './source-registry'
import { createInstrumentRuntime, type SetTrackInstrumentInput } from './instrument-runtime'
import type { DrumRackResolvedBuffers } from './drum-rack-runtime'
import { createTransportClock } from './transport-clock'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import { applyAutomationEnvelopeAtTime, scheduleAutomationEnvelope } from './automation'

type RuntimeClip = Clip<AudioBuffer>
type RuntimeTrack = Track<AudioBuffer>

const MASTER_FADE_DOWN_SEC = 0.002
const MASTER_FADE_HOLD_SEC = 0.001
const MASTER_FADE_UP_SEC = 0.006
const MASTER_STOP_DELAY_SEC = 0.004
export const LIVE_SCHEDULE_HORIZON_SEC = 30

export { canFallbackToRepitchStretch, isStretchQualityWarning }
export type { AudioStretchRenderState, CompressorMeterFrame, DeferredStretchWindow, SpectrumFrame, TrackStereoLevels, TrackStereoLevelsBatch }

export class AudioEngine {
  private runtime: AudioRuntime | null = null
  private audioCtx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private destination: AudioDestinationNode | null = null
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
  private masterFx = createMasterFxRuntime()
  private impulseCache = createReverbImpulseCache({ bucketSize: 0.1, limit: 48 })
  private clock = createTransportClock()
  private metronome = createMetronomeRuntime(this.clock)
  private metering = createMeteringRuntime()
  private stretchCache = createAudioStretchCache({
    createBuffer: (channels, frames, sampleRate) => new AudioBuffer({ numberOfChannels: channels, length: frames, sampleRate }),
    persist: true,
  })

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
      this.runtime = createAudioRuntime()
      this.audioCtx = this.runtime.ctx
      this.masterGain = this.runtime.masterGain
      this.masterGain.gain.value = this.masterVolume
      this.destination = this.runtime.destination
      this.masterFx.applyPending(this.audioCtx, this.masterGain, this.destination, (params) => this.createImpulseResponse(params))
      if (opts?.applyCachedTrackGains !== false) {
        this.updateTrackGains(this.tracksSnapshot)
      }
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
    if (!this.audioCtx) throw new Error('Audio runtime was not initialized')
    return this.impulseCache.get(this.audioCtx, params)
  }

  setTrackReverb(trackId: string, params: ReverbParamsLite) {
    this.mixerRuntime.setTrackReverb(trackId, params)
  }

  setTrackCompressor(trackId: string, params: CompressorParamsLite) {
    this.mixerRuntime.setTrackCompressor(trackId, params)
  }

  subscribeTrackCompressorMeter(trackId: string, listener: CompressorMeterListener) {
    return this.mixerRuntime.subscribeTrackCompressorMeter(trackId, listener)
  }

  setTrackSaturator(trackId: string, params: SaturatorParamsLite) {
    this.mixerRuntime.setTrackSaturator(trackId, params)
  }

  setTrackDelay(trackId: string, params: DelayParamsLite) {
    this.mixerRuntime.setTrackDelay(trackId, params)
  }

  setTrackFxOrder(trackId: string, order: AudioEffectKind[]) {
    this.mixerRuntime.setTrackFxOrder(trackId, order)
  }

  setMasterReverb(params: ReverbParamsLite) {
    this.masterFx.setReverb(
      this.audioCtx,
      this.masterGain,
      this.destination,
      params,
      (nextParams) => this.createImpulseResponse(nextParams),
    )
  }

  setMasterCompressor(params: CompressorParamsLite) {
    this.masterFx.setCompressor(this.audioCtx, this.masterGain, this.destination, params)
  }

  subscribeMasterCompressorMeter(listener: CompressorMeterListener) {
    return this.masterFx.subscribeCompressorMeter(listener)
  }

  setMasterSaturator(params: SaturatorParamsLite) {
    this.masterFx.setSaturator(this.audioCtx, this.masterGain, this.destination, params)
  }

  setMasterDelay(params: DelayParamsLite) {
    this.masterFx.setDelay(this.audioCtx, this.masterGain, this.destination, params)
  }

  setMasterFxOrder(order: AudioEffectKind[]) {
    this.masterFx.setOrder(this.audioCtx, this.masterGain, this.destination, order)
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

  setTrackEq(trackId: string, params: EqParamsLite) {
    this.mixerRuntime.setTrackEq(trackId, params)
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
        ? this.masterFx.resolveMasterAutomationBindings(envelope.parameterId, this.masterGain)
        : this.mixerRuntime.resolveTrackAutomationBindings(envelope.target.trackId, envelope.parameterId)
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
        ? this.masterFx.resolveMasterAutomationBindings(envelope.parameterId, this.masterGain)
        : this.mixerRuntime.resolveTrackAutomationBindings(envelope.target.trackId, envelope.parameterId)
      applyAutomationEnvelopeAtTime(bindings, envelope, timeSec, now, fallback)
    }
  }

  cancelAutomationSchedules(targetKeys?: ReadonlySet<string>, envelopes = this.automationEnvelopes) {
    const now = this.audioCtx?.currentTime ?? 0
    for (const envelope of envelopes) {
      if (targetKeys && !targetKeys.has(envelope.targetKey)) continue
      const bindings = envelope.target.kind === 'master'
        ? this.masterFx.resolveMasterAutomationBindings(envelope.parameterId, this.masterGain)
        : this.mixerRuntime.resolveTrackAutomationBindings(envelope.target.trackId, envelope.parameterId)
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
    this.stopAllSources()
    this.metronome.close()
    this.impulseCache.clear()
    this.mixerRuntime.clear()
    this.metering.close()
    this.instrumentRuntime.clear()
    this.automationEnvelopes = []
    this.masterFx.close()
    closeAudioRuntime(this.runtime)
    this.masterGain = null
    this.destination = null
    this.audioCtx = null
    this.runtime = null
  }

  setMasterEq(params: EqParamsLite) {
    this.masterFx.setEq(this.audioCtx, this.masterGain, this.destination, params)
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
