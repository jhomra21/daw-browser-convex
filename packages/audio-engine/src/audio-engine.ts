import { closeAudioRuntime, createAudioRuntime, decodeAudioData, getOutputLatencySec, type AudioRuntime } from './audio-runtime'
import { canFallbackToRepitchStretch, createClipScheduler, type DeferredStretchWindow, type ScheduleOptions, type ScheduleResult } from './clip-scheduler'
import { createAudioStretchCache, isStretchQualityWarning, type AudioStretchRenderState } from './audio-stretch-cache'
import { normalizeMasterVolume, type ArpParams, type EqParamsLite, type ReverbParamsLite, type SynthParamsInput } from '@daw-browser/shared'
import { createReverbImpulseCache } from './effects/reverb-impulse-cache'
import { createLiveMixerRuntime } from './live-mixer-runtime'
import { createMasterFxRuntime } from './master-fx-runtime'
import { createMeteringRuntime, type SpectrumFrame, type TrackStereoLevels, type TrackStereoLevelsBatch, type TrackStereoLevelsListener } from './metering-runtime'
import { createMetronomeRuntime } from './metronome-runtime'
import { createSourceRegistry, stopAndDisconnectSource } from './source-registry'
import { createSynthRuntime } from './synth-runtime'
import { createTransportClock } from './transport-clock'
import type { Clip, Track } from '@daw-browser/timeline-core/types'

type RuntimeClip = Clip<AudioBuffer>
type RuntimeTrack = Track<AudioBuffer>

const MASTER_FADE_DOWN_SEC = 0.002
const MASTER_FADE_HOLD_SEC = 0.001
const MASTER_FADE_UP_SEC = 0.006
const MASTER_STOP_DELAY_SEC = 0.004
export const LIVE_SCHEDULE_HORIZON_SEC = 30

export { canFallbackToRepitchStretch, isStretchQualityWarning }
export type { AudioStretchRenderState, DeferredStretchWindow, SpectrumFrame, TrackStereoLevels, TrackStereoLevelsBatch }

export class AudioEngine {
  private runtime: AudioRuntime | null = null
  private audioCtx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private destination: AudioDestinationNode | null = null
  private tracksSnapshot: RuntimeTrack[] = []
  private masterVolume = 1
  private sources = createSourceRegistry()
  private synthRuntime = createSynthRuntime({
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
    return this.synthRuntime.getTrackSynthGainNode(trackId)
  }

  getTrackSynthPreviewState(trackId: string) {
    return this.synthRuntime.getTrackSynthPreviewState(trackId)
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
    this.synthRuntime.setTrackSynth(trackId, params)
  }

  setTrackArpeggiator(trackId: string, params: ArpParams) {
    this.synthRuntime.setTrackArpeggiator(trackId, params)
  }

  clearTrackArpeggiator(trackId: string) {
    this.synthRuntime.clearTrackArpeggiator(trackId)
  }

  clearTrackSynth(trackId: string) {
    this.synthRuntime.clearTrackSynth(trackId)
  }

  private stopActiveNotesForClip(clipId: string) {
    this.synthRuntime.stopClip(clipId)
  }

  private stopAllActiveNotes() {
    this.synthRuntime.stopAll()
  }

  setBpm(nextBpm: number) {
    if (!this.clock.setBpm(nextBpm)) return
    this.metronome.onBpmChange(this.audioCtx)
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

  setMasterReverb(params: ReverbParamsLite) {
    this.masterFx.setReverb(
      this.audioCtx,
      this.masterGain,
      this.destination,
      params,
      (nextParams) => this.createImpulseResponse(nextParams),
    )
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

  private disposeSynthTrack(id: string) {
    this.synthRuntime.disposeTrack(id)
  }

  private stopClipSources() {
    this.stopAllActiveNotes()
    // Snapshot currently active sources to avoid stopping newly scheduled ones
    const toStop = this.sources.snapshot()
    // Reset tracking immediately so subsequent schedules are isolated
    this.sources.clear()
    this.synthRuntime.clearActiveOscillators()

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
    return this.synthRuntime.scheduleMidiClip(track, clip, startLimitSec ?? playheadSec, nowCtx, endLimitSec)
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
    this.synthRuntime.clear()
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
