import { getPlayableAudioWindow, getScheduledMidiEvents } from '~/lib/audio-scheduling'
import { normalizeSynthParams, serializeEqParams, serializeReverbParams, type ArpParams, type EqParamsLite, type ReverbParamsLite, type SynthParamsInput } from '~/lib/effects/params'
import { connectParallelFxChain, createReverbNodeChain, disconnectAudioNodes, applyReverbNodeChainParams, type ReverbNodeChain } from '~/lib/effects/chain'
import { createEqNodes, createImpulseResponseBuffer, getImpulseResponseBufferInfo } from '~/lib/effects/dsp'
import { applyLiveMixerGraph } from '~/lib/mixer/apply-live-routing'
import { createMixerChannels } from '~/lib/mixer/channels'
import { resolveMixerGraph } from '~/lib/mixer/resolve-routing'
import type { ResolvedMixerGraph } from '~/lib/mixer/types'
import { createSynthVoiceOscillators, getSynthVoiceConfig, getSynthVoiceVelocity, scheduleSynthVoiceEnvelope } from '~/lib/synth-voice'
import type { Track, Clip } from '~/types/timeline'

const MASTER_FADE_DOWN_SEC = 0.002
const MASTER_FADE_HOLD_SEC = 0.001
const MASTER_FADE_UP_SEC = 0.006
const MASTER_STOP_DELAY_SEC = 0.004
const TRACK_METER_PROCESSOR_NAME = 'track-meter-processor'

type ScheduleOptions = {
  atCtxTime?: number
  preserveExisting?: boolean
  endLimitSec?: number
}

type ActiveNote = {
  trackId: string
  clipId: string
  oscs: [OscillatorNode, OscillatorNode]
  gain: GainNode
  amp: number
  startCtx: number
  endCtx: number
  releaseStartCtx: number
  attackSec: number
  releaseSec: number
  cleanupTimer: number | null
}

export type SpectrumFrame = {
  data: Float32Array
  sampleRate: number
}

type TrackSynthConfig = {
  wave1: OscillatorType
  wave2: OscillatorType
  gain: number
  attackMs: number
  releaseMs: number
}

type TrackStereoMeters = {
  splitter: ChannelSplitterNode
  left: AnalyserNode
  right: AnalyserNode
  leftArr: Float32Array | null
  rightArr: Float32Array | null
  levels: TrackStereoLevels
}

export type TrackStereoLevels = {
  left: number
  right: number
}

type TrackStereoLevelsListener = (trackId: string, levels: TrackStereoLevels) => void

export class AudioEngine {
  private audioCtx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private destination: AudioDestinationNode | null = null
  private tracksSnapshot: Track[] = []
  private mixerRuntime = {
    gains: new Map<string, GainNode>(),
    outputs: new Map<string, GainNode>(),
    sendGains: new Map<string, Map<string, GainNode>>(),
    routingSignatures: new Map<string, string>(),
  }
  private activeSources: AudioScheduledSourceNode[] = []
  private activeSourcesByClip = new Map<string, Set<AudioScheduledSourceNode>>()
  private metronomeSources: AudioBufferSourceNode[] = []
  private effectsRuntime = {
    inputs: new Map<string, GainNode>(),
    eqChains: new Map<string, BiquadFilterNode[]>(),
    pendingEqParams: new Map<string, EqParamsLite>(),
    eqSignatures: new Map<string, string>(),
    reverbs: new Map<string, ReverbNodeChain>(),
    pendingReverbParams: new Map<string, ReverbParamsLite>(),
    reverbSignatures: new Map<string, string>(),
  }
  private masterEqChain: BiquadFilterNode[] = []
  private masterEqSignature: string | null = null
  private masterAnalyser: AnalyserNode | null = null
  private masterSpectrumTmp: Uint8Array | null = null
  private masterSpectrumLast: SpectrumFrame | null = null
  private masterAnalyserConnected = false
  private masterReverb: ReverbNodeChain | null = null
  private masterReverbSignature: string | null = null
  private pendingMasterEqParams: EqParamsLite | null = null
  private pendingMasterReverbParams: ReverbParamsLite | null = null
  private readonly impulseBucketSize = 0.1
  private impulseCache = new Map<string, AudioBuffer>()
  private bpm = 120
  private metronomeEnabled = false
  private metronomeGain: GainNode | null = null
  private metronomeBuffer: AudioBuffer | null = null
  private metronomeSchedulerId: number | null = null
  private nextMetronomeBeatTimelineSec: number | null = null
  private transportEpochCtxTime = 0
  private transportEpochTimelineSec = 0
  private transportRunning = false
  private readonly metronomeLookaheadSec = 0.25
  private readonly metronomeIntervalMs = 50
  private synthRuntime = {
    configs: new Map<string, TrackSynthConfig>(),
    activeOscillatorsByTrack: new Map<string, Set<OscillatorNode>>(),
    gainNodes: new Map<string, GainNode>(),
    activeNotesByTrack: new Map<string, Set<ActiveNote>>(),
    arpeggiators: new Map<string, ArpParams>(),
  }
  private meterRuntime = {
    analysers: new Map<string, AnalyserNode>(),
    meterArrays: new Map<string, Float32Array>(),
    stereoAnalysers: new Map<string, TrackStereoMeters>(),
    spectrumTmp: new Map<string, Uint8Array>(),
    spectrumLast: new Map<string, SpectrumFrame>(),
  }
  private meterWorkletReady: Promise<boolean> | null = null
  private meterWorkletNodes = new Map<string, AudioWorkletNode>()
  private meterWorkletLevels = new Map<string, TrackStereoLevels>()
  private meterListeners = new Set<TrackStereoLevelsListener>()

  private ensureMeterWorkletModule() {
    if (!this.audioCtx) return Promise.resolve(false)
    if (this.meterWorkletReady) return this.meterWorkletReady
    const source = `
      class TrackMeterProcessor extends AudioWorkletProcessor {
        constructor() {
          super()
          this.active = false
          this.frames = 0
          this.sumL = 0
          this.sumR = 0
          this.reportEveryFrames = 2048
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
          if (!left) return true
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
    this.meterWorkletReady = this.audioCtx.audioWorklet.addModule(url)
      .then(() => true)
      .catch(() => false)
      .finally(() => URL.revokeObjectURL(url))
    return this.meterWorkletReady
  }

  private emitTrackStereoLevels(trackId: string, levels: TrackStereoLevels) {
    for (const listener of this.meterListeners) {
      listener(trackId, levels)
    }
  }

  private updateMeterWorkletSubscriptionState() {
    const active = this.meterListeners.size > 0
    for (const node of this.meterWorkletNodes.values()) {
      node.port.postMessage({ active })
    }
  }

  private ensureTrackMeterWorklet(trackId: string, gain: GainNode) {
    if (!this.audioCtx) return
    const existing = this.meterWorkletNodes.get(trackId)
    if (existing) {
      try { gain.connect(existing) } catch {}
      return
    }
    void this.ensureMeterWorkletModule().then((ready) => {
      if (!ready || !this.audioCtx || this.meterWorkletNodes.has(trackId)) return
      if (this.mixerRuntime.outputs.get(trackId) !== gain) return
      const node = new AudioWorkletNode(this.audioCtx, TRACK_METER_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      })
      node.port.postMessage({ active: this.meterListeners.size > 0 })
      node.port.onmessage = (event) => {
        const data = event.data
        const next = {
          left: typeof data?.left === 'number' ? data.left : 0,
          right: typeof data?.right === 'number' ? data.right : 0,
        }
        this.meterWorkletLevels.set(trackId, next)
        this.emitTrackStereoLevels(trackId, next)
      }
      try { gain.connect(node) } catch {}
      this.meterWorkletNodes.set(trackId, node)
    })
  }

  subscribeTrackStereoLevels(listener: TrackStereoLevelsListener) {
    this.meterListeners.add(listener)
    this.updateMeterWorkletSubscriptionState()
    return () => {
      this.meterListeners.delete(listener)
      this.updateMeterWorkletSubscriptionState()
    }
  }

  private ensureTrackAnalyser(trackId: string, gain: GainNode) {
    if (!this.audioCtx) return
    let a = this.meterRuntime.analysers.get(trackId)
    if (!a) {
      a = this.audioCtx.createAnalyser()
      a.fftSize = 512
      a.smoothingTimeConstant = 0.7
      this.meterRuntime.analysers.set(trackId, a)
    }
    try { gain.connect(a) } catch {}
    this.ensureTrackAnalysersStereo(trackId, gain)
    this.ensureTrackMeterWorklet(trackId, gain)
  }

  private ensureTrackAnalysersStereo(trackId: string, gain: GainNode) {
    if (!this.audioCtx) return
    let entry = this.meterRuntime.stereoAnalysers.get(trackId)
    if (!entry) {
      const splitter = this.audioCtx.createChannelSplitter(2)
      const left = this.audioCtx.createAnalyser()
      const right = this.audioCtx.createAnalyser()
      left.fftSize = 512; right.fftSize = 512
      left.smoothingTimeConstant = 0.7; right.smoothingTimeConstant = 0.7
      try { splitter.connect(left, 0) } catch {}
      try { splitter.connect(right, 1) } catch {}
      entry = { splitter, left, right, leftArr: null, rightArr: null, levels: { left: 0, right: 0 } }
      this.meterRuntime.stereoAnalysers.set(trackId, entry)
    }
    try { gain.connect(entry.splitter) } catch {}
  }

  private reconnectTrackMeters(trackId: string, output: GainNode) {
    this.ensureTrackAnalyser(trackId, output)
  }

  private cleanupTrackSendGains(trackId: string) {
    const sendMap = this.mixerRuntime.sendGains.get(trackId)
    if (!sendMap) return
    for (const sendGain of sendMap.values()) {
      try { sendGain.disconnect() } catch {}
    }
    this.mixerRuntime.sendGains.delete(trackId)
  }

  private buildResolvedMixerGraph(tracks: Track[]): ResolvedMixerGraph {
    return resolveMixerGraph({ channels: createMixerChannels(tracks) })
  }

  // Returns a normalized 0..1 RMS level for a track's post-gain signal
  getTrackLevel(trackId: string): number {
    const a = this.meterRuntime.analysers.get(trackId)
    if (!a || !this.audioCtx) return 0
    let arr = this.meterRuntime.meterArrays.get(trackId)
    if (!arr || arr.length !== a.fftSize) {
      arr = new Float32Array(a.fftSize)
      this.meterRuntime.meterArrays.set(trackId, arr)
    }
    try {
      a.getFloatTimeDomainData(arr as any)
    } catch {
      return 0
    }
    return this.getCompandedLevel(this.getRms(arr))
  }

  private getRms(arr: Float32Array) {
    let sum = 0
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]
      sum += v * v
    }
    return Math.sqrt(sum / arr.length)
  }

  private getCompandedLevel(value: number) {
    return Math.min(1, Math.max(0, Math.sqrt(value)))
  }

  // Returns normalized 0..1 RMS per channel.
  getTrackLevelsStereo(trackId: string): TrackStereoLevels {
    const workletLevels = this.meterWorkletLevels.get(trackId)
    if (workletLevels) return workletLevels
    const e = this.meterRuntime.stereoAnalysers.get(trackId)
    if (!e) {
      const m = this.getTrackLevel(trackId)
      return { left: m, right: m }
    }
    const { left, right } = e
    // Ensure arrays
    if (!e.leftArr || e.leftArr.length !== left.fftSize) e.leftArr = new Float32Array(left.fftSize)
    if (!e.rightArr || e.rightArr.length !== right.fftSize) e.rightArr = new Float32Array(right.fftSize)
    try { left.getFloatTimeDomainData(e.leftArr! as any) } catch { return e.levels }
    try { right.getFloatTimeDomainData(e.rightArr! as any) } catch { return e.levels }
    e.levels.left = this.getCompandedLevel(this.getRms(e.leftArr!))
    e.levels.right = this.getCompandedLevel(this.getRms(e.rightArr!))
    return e.levels
  }

  getAudioContext() {
    return this.audioCtx
  }

  getTrackSynthGainNode(trackId: string) {
    this.ensureAudio()
    return this.ensureTrackSynthGainNode(trackId)
  }

  getTrackSynthPreviewState(trackId: string) {
    const synth = this.synthRuntime.configs.get(trackId)
    if (!synth) return null
    return {
      wave1: synth.wave1,
      wave2: synth.wave2,
    }
  }

  ensureAudio() {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext()
      this.masterGain = this.audioCtx.createGain()
      this.masterAnalyserConnected = false
      this.destination = this.audioCtx.destination
      this.masterGain.gain.value = 1.0
      // Apply any pending master effects, then build routing
      if (this.pendingMasterEqParams) {
        const p = this.pendingMasterEqParams
        this.pendingMasterEqParams = null
        this.setMasterEq(p)
      }
      if (this.pendingMasterReverbParams) {
        const p = this.pendingMasterReverbParams
        this.pendingMasterReverbParams = null
        this.setMasterReverb(p)
      }
      // If nothing pending, ensure we at least connect master to destination
      this.rebuildMasterRouting()
      this.updateTrackGains(this.tracksSnapshot)
      this.ensureMetronomeNodes()
    }
  }

  private ensureMasterAnalyser() {
    if (!this.audioCtx || !this.masterGain) return
    if (!this.masterAnalyser) {
      const a = this.audioCtx.createAnalyser()
      a.fftSize = 2048
      a.smoothingTimeConstant = 0.8
      this.masterAnalyser = a
    }
    if (this.masterAnalyser && !this.masterAnalyserConnected) {
      try {
        this.masterGain.connect(this.masterAnalyser)
        this.masterAnalyserConnected = true
      } catch {}
    }
  }

  private ensureMetronomeNodes() {
    if (!this.audioCtx || !this.masterGain) return
    if (!this.metronomeGain) {
      const gain = this.audioCtx.createGain()
      gain.gain.value = 0.35
      gain.connect(this.masterGain)
      this.metronomeGain = gain
    }
    if (!this.metronomeBuffer) {
      this.metronomeBuffer = this.createMetronomeBuffer(this.audioCtx)
    }
  }

  private createMetronomeBuffer(ctx: AudioContext) {
    const durationSec = 0.06
    const sampleRate = ctx.sampleRate
    const totalSamples = Math.max(1, Math.floor(durationSec * sampleRate))
    const buffer = ctx.createBuffer(1, totalSamples, sampleRate)
    const data = buffer.getChannelData(0)
    const attackSamples = Math.floor(sampleRate * 0.002)
    const decaySamples = totalSamples - attackSamples
    for (let i = 0; i < totalSamples; i++) {
      if (i < attackSamples) {
        data[i] = i / Math.max(1, attackSamples)
      } else {
        const t = (i - attackSamples) / Math.max(1, decaySamples)
        data[i] = Math.pow(1 - t, 3)
      }
    }
    return buffer
  }

  private setMetronomeInterval() {
    if (this.metronomeSchedulerId !== null) return
    this.metronomeSchedulerId = setInterval(() => {
      try {
        this.scheduleMetronomeTicks()
      } catch (err) {
        console.error('[AudioEngine] metronome scheduling error', err)
      }
    }, this.metronomeIntervalMs) as unknown as number
  }

  private clearMetronomeInterval() {
    if (this.metronomeSchedulerId !== null) {
      clearInterval(this.metronomeSchedulerId)
      this.metronomeSchedulerId = null
    }
  }

  private secondsPerBeat() {
    return 60 / Math.max(1, this.bpm)
  }

  private timelineToCtxTime(timelineSec: number) {
    if (!this.audioCtx) return 0
    const delta = timelineSec - this.transportEpochTimelineSec
    return this.transportEpochCtxTime + Math.max(0, delta)
  }

  private ctxTimeToTimeline(ctxTime: number) {
    const delta = ctxTime - this.transportEpochCtxTime
    return this.transportEpochTimelineSec + Math.max(0, delta)
  }

  private computeNextBeatTimelineSec(fromTimelineSec: number) {
    const epsilon = 1e-6
    const spb = this.secondsPerBeat()
    if (!isFinite(spb) || spb <= 0) return fromTimelineSec
    const beats = Math.ceil((fromTimelineSec - epsilon) / spb)
    return Math.max(0, beats) * spb
  }

  setTrackSynth(trackId: string, params: SynthParamsInput) {
    const synth = normalizeSynthParams(params)
    const { wave1, wave2, gain, attackMs, releaseMs } = synth
    this.synthRuntime.configs.set(trackId, { wave1, wave2, gain, attackMs, releaseMs })
    const g = this.synthRuntime.gainNodes.get(trackId)
    if (g) {
      try { g.gain.value = gain } catch {}
    }
    const activeNotes = this.synthRuntime.activeNotesByTrack.get(trackId)
    if (activeNotes) {
      for (const note of activeNotes) {
        const [osc1, osc2] = note.oscs
        if (osc1) {
          try { osc1.type = wave1 } catch {}
        }
        if (osc2) {
          try { osc2.type = wave2 } catch {}
        }
      }
    }
    this.retargetActiveNotesForTrack(trackId)
  }

  setTrackArpeggiator(trackId: string, params: ArpParams) {
    this.synthRuntime.arpeggiators.set(trackId, params)
  }

  clearTrackArpeggiator(trackId: string) {
    this.synthRuntime.arpeggiators.delete(trackId)
  }

  clearTrackSynth(trackId: string) {
    this.synthRuntime.configs.delete(trackId)
    const gain = this.synthRuntime.gainNodes.get(trackId)
    if (gain) {
      try { gain.gain.value = normalizeSynthParams({}).gain } catch {}
    }
  }

  private computeCurrentAmp(note: ActiveNote, nowCtx: number) {
    const { startCtx, endCtx, releaseStartCtx, attackSec, amp } = note
    if (nowCtx <= startCtx) return 0
    const attackEnd = startCtx + Math.max(0.001, attackSec)
    if (nowCtx <= attackEnd) {
      const t = (nowCtx - startCtx) / Math.max(0.001, attackSec)
      return amp * Math.max(0, Math.min(1, t))
    }
    if (nowCtx <= releaseStartCtx) return amp
    if (nowCtx >= endCtx) return 0
    const relDur = Math.max(0.001, endCtx - releaseStartCtx)
    const t = (nowCtx - releaseStartCtx) / relDur
    return amp * Math.max(0, Math.min(1, 1 - t))
  }

  private scheduleCleanupForNote(note: ActiveNote) {
    if (!this.audioCtx) return
    const nowCtx = this.audioCtx.currentTime
    const delayMs = Math.max(0, (note.endCtx - nowCtx) * 1000) + 5
    if (note.cleanupTimer) try { clearTimeout(note.cleanupTimer) } catch {}
    note.cleanupTimer = setTimeout(() => {
      for (const o of note.oscs) {
        try { o.stop() } catch {}
      }
      try { note.gain.disconnect() } catch {}
      const set = this.synthRuntime.activeOscillatorsByTrack.get(note.trackId)
      if (set) {
        for (const o of note.oscs) set.delete(o)
        if (set.size === 0) this.synthRuntime.activeOscillatorsByTrack.delete(note.trackId)
      }
      const notes = this.synthRuntime.activeNotesByTrack.get(note.trackId)
      if (notes) {
        notes.delete(note)
        if (notes.size === 0) this.synthRuntime.activeNotesByTrack.delete(note.trackId)
      }
    }, delayMs) as unknown as number
  }

  private stopActiveNote(note: ActiveNote) {
    if (note.cleanupTimer) { try { clearTimeout(note.cleanupTimer) } catch {} }
    for (const o of note.oscs) {
      try { o.stop() } catch {}
      try { o.disconnect() } catch {}
      const idx = this.activeSources.indexOf(o)
      if (idx >= 0) this.activeSources.splice(idx, 1)
      const clipSources = this.activeSourcesByClip.get(note.clipId)
      if (clipSources) {
        clipSources.delete(o)
        if (clipSources.size === 0) this.activeSourcesByClip.delete(note.clipId)
      }
    }
    try { note.gain.disconnect() } catch {}

    const trackOscs = this.synthRuntime.activeOscillatorsByTrack.get(note.trackId)
    if (trackOscs) {
      for (const o of note.oscs) trackOscs.delete(o)
      if (trackOscs.size === 0) this.synthRuntime.activeOscillatorsByTrack.delete(note.trackId)
    }

    const notes = this.synthRuntime.activeNotesByTrack.get(note.trackId)
    if (notes) {
      notes.delete(note)
      if (notes.size === 0) this.synthRuntime.activeNotesByTrack.delete(note.trackId)
    }
  }

  private stopActiveNotesForClip(clipId: string) {
    for (const notes of Array.from(this.synthRuntime.activeNotesByTrack.values())) {
      for (const note of Array.from(notes)) {
        if (note.clipId === clipId) this.stopActiveNote(note)
      }
    }
  }

  private stopAllActiveNotes() {
    for (const notes of Array.from(this.synthRuntime.activeNotesByTrack.values())) {
      for (const note of Array.from(notes)) this.stopActiveNote(note)
    }
  }

  private retargetActiveNotesForTrack(trackId: string) {
    if (!this.audioCtx) return
    const synth = this.synthRuntime.configs.get(trackId)
    if (!synth) return
    const notes = this.synthRuntime.activeNotesByTrack.get(trackId)
    if (!notes || notes.size === 0) return
    const now = this.audioCtx.currentTime
    const attackSec = Math.max(0.001, (synth.attackMs ?? 5) / 1000)
    const releaseSec = Math.max(0.001, (synth.releaseMs ?? 30) / 1000)
    const EPS = 1e-4
    for (const note of Array.from(notes)) {
      const p = note.gain.gain
      try { p.cancelScheduledValues(now) } catch {}
      // Anchor to current amplitude (use epsilon floor for exponential ramp)
      const currentAmp = Math.max(EPS, this.computeCurrentAmp(note, now))
      try { p.setValueAtTime(currentAmp, now) } catch {}

      // Recompute new envelope times while preserving hard end at note.endCtx
      const attackEndNew = note.startCtx + attackSec
      const releaseStartNew = Math.max(attackEndNew, note.endCtx - releaseSec)

      if (now < attackEndNew) {
        try { p.exponentialRampToValueAtTime(Math.max(EPS, note.amp), attackEndNew) } catch {}
      }
      if (releaseStartNew > Math.max(now, attackEndNew)) {
        try { p.setValueAtTime(Math.max(EPS, note.amp), releaseStartNew) } catch {}
      }
      try { p.exponentialRampToValueAtTime(EPS, note.endCtx) } catch {}
      try { p.setValueAtTime(0, note.endCtx + 1e-4) } catch {}

      // Update stored params and schedule cleanup according to new end (unchanged) but reset timer
      note.attackSec = attackSec
      note.releaseSec = releaseSec
      note.releaseStartCtx = releaseStartNew
      this.scheduleCleanupForNote(note)
    }
  }

  private ensureTrackSynthGainNode(trackId: string): GainNode {
    if (!this.audioCtx) this.ensureAudio()
    const input = this.ensureTrackNodes(trackId)
    if (!this.audioCtx) return input
    let node = this.synthRuntime.gainNodes.get(trackId)
    if (!node) {
      node = this.audioCtx.createGain()
      const synth = this.synthRuntime.configs.get(trackId)
      node.gain.value = synth?.gain ?? 0.8
      // Route synth output into the track input (so EQ/reverb still apply downstream)
      node.connect(input)
      this.synthRuntime.gainNodes.set(trackId, node)
    }
    return node
  }

  private scheduleMetronomeTicks() {
    if (!this.audioCtx || !this.metronomeEnabled || !this.transportRunning) return
    if (!this.metronomeGain || !this.metronomeBuffer) return
    const nowCtx = this.audioCtx.currentTime
    const scheduleUntil = nowCtx + this.metronomeLookaheadSec
    const spb = this.secondsPerBeat()
    if (!isFinite(spb) || spb <= 0) return

    let nextTimelineBeat = this.nextMetronomeBeatTimelineSec
    if (nextTimelineBeat === null) {
      const nowTimeline = this.ctxTimeToTimeline(nowCtx)
      nextTimelineBeat = this.computeNextBeatTimelineSec(nowTimeline)
    }

    let iterations = 0
    while (iterations < 128 && nextTimelineBeat !== null) {
      iterations += 1
      const eventCtxTime = this.timelineToCtxTime(nextTimelineBeat)
      if (eventCtxTime > scheduleUntil + 1e-3) break
      if (eventCtxTime >= nowCtx - 0.02) {
        const source = this.audioCtx.createBufferSource()
        source.buffer = this.metronomeBuffer
        source.connect(this.metronomeGain)
        source.start(eventCtxTime)
        source.onended = () => {
          const idx = this.metronomeSources.indexOf(source)
          if (idx >= 0) this.metronomeSources.splice(idx, 1)
        }
        this.metronomeSources.push(source)
      }
      nextTimelineBeat += spb
      if (nextTimelineBeat < 0) break
    }

    this.nextMetronomeBeatTimelineSec = nextTimelineBeat
  }

  private resetMetronomeState() {
    this.nextMetronomeBeatTimelineSec = null
    for (const s of this.metronomeSources) {
      try { s.stop() } catch {}
      try { s.disconnect() } catch {}
    }
    this.metronomeSources = []
  }

  setBpm(nextBpm: number) {
    const sanitized = Math.min(300, Math.max(30, Math.round(nextBpm)))
    if (sanitized === this.bpm) return
    this.bpm = sanitized
    if (this.metronomeEnabled && this.transportRunning) {
      this.resetMetronomeState()
      this.nextMetronomeBeatTimelineSec = null
      this.scheduleMetronomeTicks()
    }
  }

  setMetronomeEnabled(enabled: boolean) {
    this.metronomeEnabled = enabled
    if (!enabled) {
      this.clearMetronomeInterval()
      this.resetMetronomeState()
    } else {
      this.ensureAudio()
      this.ensureMetronomeNodes()
      this.nextMetronomeBeatTimelineSec = null
      if (this.transportRunning) {
        this.scheduleMetronomeTicks()
        this.setMetronomeInterval()
      }
    }
  }

  onTransportStart(playheadSec: number) {
    if (!this.audioCtx) return
    this.ensureMetronomeNodes()
    this.transportEpochCtxTime = this.audioCtx.currentTime
    this.transportEpochTimelineSec = Math.max(0, playheadSec)
    this.transportRunning = true
    this.resetMetronomeState()
    if (this.metronomeEnabled) {
      this.scheduleMetronomeTicks()
      this.setMetronomeInterval()
    }
  }

  onTransportPause() {
    this.transportRunning = false
    this.resetMetronomeState()
    this.clearMetronomeInterval()
  }

  onTransportStop() {
    this.onTransportPause()
    this.transportEpochTimelineSec = 0
    this.transportEpochCtxTime = this.audioCtx?.currentTime ?? 0
  }

  onTransportSeek(playheadSec: number, offsetSec = 0, opts?: { resetMetronome?: boolean }) {
    if (!this.audioCtx) return
    const now = this.audioCtx.currentTime
    this.transportEpochCtxTime = now + Math.max(0, offsetSec)
    this.transportEpochTimelineSec = Math.max(0, playheadSec)
    const shouldReset = opts?.resetMetronome !== false
    if (shouldReset && this.metronomeEnabled && this.transportRunning) {
      this.resetMetronomeState()
      this.scheduleMetronomeTicks()
    }
  }

  // --- Reverb helpers ---
  private createImpulseResponse(decaySec: number) {
    if (!this.audioCtx) return null
    const ctx = this.audioCtx
    const info = getImpulseResponseBufferInfo(ctx, decaySec, {
      bucketSize: this.impulseBucketSize,
    })
    const cacheKey = `${ctx.sampleRate}:${info.bucketIndex}:${info.length}`
    const cached = this.impulseCache.get(cacheKey)
    if (cached) return cached
    const { buffer } = createImpulseResponseBuffer(ctx, decaySec, {
      bucketSize: this.impulseBucketSize,
    })
    this.impulseCache.set(cacheKey, buffer)
    return buffer
  }

  setTrackReverb(trackId: string, params: ReverbParamsLite) {
    if (!this.audioCtx) {
      this.effectsRuntime.pendingReverbParams.set(trackId, params)
      return
    }
    const signature = serializeReverbParams(params)
    if (this.effectsRuntime.reverbSignatures.get(trackId) === signature) return
    this.ensureTrackNodes(trackId)
    const createImpulseResponse = (decaySec: number) => this.createImpulseResponse(decaySec)
    let rv = this.effectsRuntime.reverbs.get(trackId)
    if (!rv) {
      rv = createReverbNodeChain(this.audioCtx, params, createImpulseResponse)
      this.effectsRuntime.reverbs.set(trackId, rv)
    } else {
      applyReverbNodeChainParams(rv, params, createImpulseResponse)
    }
    this.effectsRuntime.reverbSignatures.set(trackId, signature)
    this.rebuildTrackRouting(trackId)
  }

  setMasterReverb(params: ReverbParamsLite) {
    if (!this.audioCtx || !this.masterGain) {
      this.pendingMasterReverbParams = params
      return
    }
    const signature = serializeReverbParams(params)
    if (this.masterReverbSignature === signature) return
    const createImpulseResponse = (decaySec: number) => this.createImpulseResponse(decaySec)
    if (!this.masterReverb) {
      this.masterReverb = createReverbNodeChain(this.audioCtx, params, createImpulseResponse)
    } else {
      applyReverbNodeChainParams(this.masterReverb, params, createImpulseResponse)
    }
    this.masterReverbSignature = signature
    this.rebuildMasterRouting()
  }

  private ensureTrackNodes(trackId: string): GainNode {
    if (!this.audioCtx) this.ensureAudio()
    // At this point audioCtx/masterGain should exist
    if (!this.audioCtx || !this.masterGain) {
      // Fallback: create a dummy gain node disconnected (shouldn't happen)
      const dummy = new GainNode(new AudioContext())
      return dummy
    }
    let input = this.effectsRuntime.inputs.get(trackId)
    const createdInput = !input
    if (!input) {
      input = this.audioCtx.createGain()
      this.effectsRuntime.inputs.set(trackId, input)
    }
    let g = this.mixerRuntime.gains.get(trackId)
    if (!g) {
      g = this.audioCtx.createGain()
      g.gain.value = 1
      this.mixerRuntime.gains.set(trackId, g)
    }
    let output = this.mixerRuntime.outputs.get(trackId)
    if (!output) {
      output = this.audioCtx.createGain()
      output.gain.value = 1
      this.mixerRuntime.outputs.set(trackId, output)
    }
    if (createdInput) {
      // Connect by default input -> gain (no EQ)
      try { input.disconnect() } catch {}
      input.connect(g)

      // If there were pending EQ params, apply now
      const pending = this.effectsRuntime.pendingEqParams.get(trackId)
      if (pending) {
        this.effectsRuntime.pendingEqParams.delete(trackId)
        this.setTrackEq(trackId, pending)
      }
      // Apply pending reverb params if any
      const pendingRv = this.effectsRuntime.pendingReverbParams.get(trackId)
      if (pendingRv) {
        this.effectsRuntime.pendingReverbParams.delete(trackId)
        this.setTrackReverb(trackId, pendingRv)
      }
    }
    return input
  }

  private rebuildTrackRouting(trackId: string) {
    const input = this.effectsRuntime.inputs.get(trackId)
    const g = this.mixerRuntime.gains.get(trackId)
    if (!input || !g) return
    try { input.disconnect() } catch {}
    const chain = this.effectsRuntime.eqChains.get(trackId) || []
    connectParallelFxChain(input, g, chain, this.effectsRuntime.reverbs.get(trackId))
  }

  previewTrackVolume(trackId: string, volume: number, muted: boolean) {
    const gain = this.mixerRuntime.gains.get(trackId)
    if (!gain) return
    const next = !muted && Number.isFinite(volume) ? Math.max(0, volume) : 0
    try { gain.gain.value = next } catch {}
  }

  setTrackEq(trackId: string, params: EqParamsLite) {
    if (!this.audioCtx) {
      // Defer until audio context exists
      this.effectsRuntime.pendingEqParams.set(trackId, params)
      return
    }
    const signature = serializeEqParams(params)
    if (this.effectsRuntime.eqSignatures.get(trackId) === signature) return
    this.ensureTrackNodes(trackId)
    // Tear down existing chain
    const old = this.effectsRuntime.eqChains.get(trackId)
    if (old) {
      for (const n of old) { try { n.disconnect() } catch {} }
    }
    const targetChannels = this.destination?.maxChannelCount ?? this.audioCtx.destination.maxChannelCount ?? 2
    const nodes = createEqNodes(this.audioCtx, params, targetChannels)
    this.effectsRuntime.eqChains.set(trackId, nodes)
    this.effectsRuntime.eqSignatures.set(trackId, signature)
    // Rewire
    this.rebuildTrackRouting(trackId)
  }

  updateTrackGains(tracks: Track[]) {
    this.tracksSnapshot = tracks
    if (!this.audioCtx || !this.masterGain) return

    const graph = this.buildResolvedMixerGraph(tracks)
    const trackNodes = new Map<string, { input: GainNode; gain: GainNode; output: GainNode }>()
    for (const resolvedTrack of graph.channels) {
      const channelId = resolvedTrack.channel.id
      const input = this.ensureTrackNodes(channelId)
      const gain = this.mixerRuntime.gains.get(channelId)
      const output = this.mixerRuntime.outputs.get(channelId)
      if (!gain || !output) continue
      trackNodes.set(channelId, { input, gain, output })
    }

    applyLiveMixerGraph({
      graph,
      masterInput: this.masterGain,
      trackNodes,
      trackSendGains: this.mixerRuntime.sendGains,
      trackRoutingSignatures: this.mixerRuntime.routingSignatures,
      createGain: () => this.audioCtx!.createGain(),
      reconnectTrackMeters: (trackId, gain) => this.reconnectTrackMeters(trackId, gain),
    })

    const activeTrackIds = new Set<string>(graph.channels.map((entry) => entry.channel.id))
    for (const [id, g] of Array.from(this.mixerRuntime.gains.entries())) {
      if (activeTrackIds.has(id)) continue
      try { g.disconnect() } catch {}
      this.mixerRuntime.gains.delete(id)
      this.mixerRuntime.routingSignatures.delete(id)
      this.cleanupTrackSendGains(id)
      const input = this.effectsRuntime.inputs.get(id)
      if (input) {
        try { input.disconnect() } catch {}
        this.effectsRuntime.inputs.delete(id)
      }
      const output = this.mixerRuntime.outputs.get(id)
      if (output) {
        try { output.disconnect() } catch {}
        this.mixerRuntime.outputs.delete(id)
      }
      const nodes = this.effectsRuntime.eqChains.get(id)
      if (nodes) {
        for (const n of nodes) { try { n.disconnect() } catch {} }
        this.effectsRuntime.eqChains.delete(id)
      }
      this.effectsRuntime.eqSignatures.delete(id)
      const rv = this.effectsRuntime.reverbs.get(id)
      if (rv) {
        disconnectAudioNodes([rv.dryGain, rv.wetGain, rv.preDelay, rv.convolver])
        this.effectsRuntime.reverbs.delete(id)
      }
      const synthGain = this.synthRuntime.gainNodes.get(id)
      if (synthGain) {
        try { synthGain.disconnect() } catch {}
        this.synthRuntime.gainNodes.delete(id)
      }
      const an = this.meterRuntime.analysers.get(id)
      if (an) { try { an.disconnect() } catch {}; this.meterRuntime.analysers.delete(id); this.meterRuntime.meterArrays.delete(id) }
      const stereo = this.meterRuntime.stereoAnalysers.get(id)
      if (stereo) {
        try { stereo.splitter.disconnect() } catch {}
        try { stereo.left.disconnect() } catch {}
        try { stereo.right.disconnect() } catch {}
        this.meterRuntime.stereoAnalysers.delete(id)
      }
      const meterNode = this.meterWorkletNodes.get(id)
      if (meterNode) {
        try { meterNode.disconnect() } catch {}
        meterNode.port.onmessage = null
        this.meterWorkletNodes.delete(id)
      }
      this.meterWorkletLevels.delete(id)
      this.meterRuntime.spectrumTmp.delete(id)
      this.meterRuntime.spectrumLast.delete(id)
      this.effectsRuntime.pendingEqParams.delete(id)
      this.effectsRuntime.pendingReverbParams.delete(id)
      this.effectsRuntime.reverbSignatures.delete(id)
    }
  }

  private stopClipSources() {
    this.stopAllActiveNotes()
    // Snapshot currently active sources to avoid stopping newly scheduled ones
    const toStop = Array.from(this.activeSources)
    // Reset tracking immediately so subsequent schedules are isolated
    this.activeSources = []
    this.activeSourcesByClip.clear()
    this.synthRuntime.activeOscillatorsByTrack.clear()

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

    const doStop = () => {
      for (const s of toStop) {
        try {
          if (stopAt !== null) {
            s.stop(stopAt)
          } else {
            s.stop()
          }
        } catch {
          try { s.stop() } catch {}
        }
        try { s.disconnect() } catch {}
      }
    }

    doStop()
  }

  stopAllSources() {
    this.stopClipSources()
    this.resetMetronomeState()
  }

  private scheduleMidiClip(track: Track, clip: Clip, playheadSec: number, nowCtx: number, endLimitSec?: number): boolean {
    if (!this.audioCtx) return false
    const midi: any = clip.midi
    if (!midi || !Array.isArray(midi.notes)) return false

    const scheduledNotes = getScheduledMidiEvents({
      clip,
      bpm: this.bpm,
      notes: midi.notes,
      rangeStartSec: playheadSec,
      rangeEndSec: endLimitSec,
      arp: this.synthRuntime.arpeggiators.get(track.id),
    })
    const voice = getSynthVoiceConfig({ synth: this.synthRuntime.configs.get(track.id), midi })

    for (const note of scheduledNotes) {
      const durationSec = note.endSec - note.startSec
      if (durationSec <= 0) continue

      const startCtx = Math.max(nowCtx, this.timelineToCtxTime(note.startSec))
      const { osc1, osc2 } = createSynthVoiceOscillators(this.audioCtx, {
        startTime: startCtx,
        pitch: note.pitch,
        wave1: voice.wave1,
        wave2: voice.wave2,
      })
      let trackOscs = this.synthRuntime.activeOscillatorsByTrack.get(track.id)
      if (!trackOscs) { trackOscs = new Set<OscillatorNode>(); this.synthRuntime.activeOscillatorsByTrack.set(track.id, trackOscs) }
      trackOscs.add(osc1)
      trackOscs.add(osc2)
      const gain = this.audioCtx.createGain()
      const peakGain = (getSynthVoiceVelocity(note.velocity) * voice.clipGain) / 2
      const envelope = scheduleSynthVoiceEnvelope(gain.gain, {
        startTime: startCtx,
        durationSec,
        attackSec: voice.attackSec,
        releaseSec: voice.releaseSec,
        peakGain,
      })
      osc1.connect(gain)
      osc2.connect(gain)
      gain.connect(this.ensureTrackSynthGainNode(track.id))

      try { osc1.start(startCtx) } catch {}
      try { osc2.start(startCtx) } catch {}
      const noteEntry: ActiveNote = {
        trackId: track.id,
        clipId: clip.id,
        oscs: [osc1, osc2],
        gain,
        amp: peakGain,
        startCtx,
        endCtx: envelope.endTime,
        releaseStartCtx: envelope.releaseStartTime,
        attackSec: voice.attackSec,
        releaseSec: voice.releaseSec,
        cleanupTimer: null,
      }
      let notes = this.synthRuntime.activeNotesByTrack.get(track.id)
      if (!notes) { notes = new Set<ActiveNote>(); this.synthRuntime.activeNotesByTrack.set(track.id, notes) }
      notes.add(noteEntry)
      this.scheduleCleanupForNote(noteEntry)
      const onOscEnded = (osc: OscillatorNode) => {
        const set = this.synthRuntime.activeOscillatorsByTrack.get(track.id)
        if (set) {
          set.delete(osc)
          if (set.size === 0) this.synthRuntime.activeOscillatorsByTrack.delete(track.id)
        }
        const idx = this.activeSources.indexOf(osc)
        if (idx >= 0) this.activeSources.splice(idx, 1)
        const setByClip = this.activeSourcesByClip.get(clip.id)
        if (setByClip) {
          setByClip.delete(osc)
          if (setByClip.size === 0) this.activeSourcesByClip.delete(clip.id)
        }
      }
      osc1.onended = () => onOscEnded(osc1)
      osc2.onended = () => onOscEnded(osc2)
      this.activeSources.push(osc1)
      this.activeSources.push(osc2)
      let clipSet = this.activeSourcesByClip.get(clip.id)
      if (!clipSet) { clipSet = new Set(); this.activeSourcesByClip.set(clip.id, clipSet) }
      clipSet.add(osc1)
      clipSet.add(osc2)
    }

    return true
  }
  private scheduleAudioClip(clip: Clip, input: GainNode, playheadSec: number, nowCtx: number, endLimitSec?: number) {
    if (!this.audioCtx || !clip.buffer) return

    const window = getPlayableAudioWindow({
      clip,
      bufferDurationSec: clip.buffer.duration,
      rangeStartSec: playheadSec,
      rangeEndSec: endLimitSec,
    })
    if (!window) return

    const source = this.audioCtx.createBufferSource()
    source.buffer = clip.buffer
    source.connect(input)
    source.start(nowCtx + Math.max(0, window.startSec - playheadSec), window.offsetSec, window.durationSec)
    source.onended = () => {
      const idx = this.activeSources.indexOf(source)
      if (idx >= 0) this.activeSources.splice(idx, 1)
      const setByClip = this.activeSourcesByClip.get(clip.id)
      if (setByClip) {
        setByClip.delete(source)
        if (setByClip.size === 0) this.activeSourcesByClip.delete(clip.id)
      }
    }
    this.activeSources.push(source)
    let clipSet = this.activeSourcesByClip.get(clip.id)
    if (!clipSet) { clipSet = new Set(); this.activeSourcesByClip.set(clip.id, clipSet) }
    clipSet.add(source)
  }
  scheduleAllClipsFromPlayhead(tracks: Track[], playheadSec: number, opts?: ScheduleOptions) {
    if (!this.audioCtx) return

    if (!opts?.preserveExisting) this.stopClipSources()
    const hasOverride = typeof opts?.atCtxTime === 'number'
    const now = hasOverride ? (opts!.atCtxTime as number) : this.timelineToCtxTime(playheadSec)
    this.updateTrackGains(tracks)

    for (const t of tracks) {
      const input = this.ensureTrackNodes(t.id)
      for (const c of t.clips) {
        if (this.scheduleMidiClip(t, c, playheadSec, now, opts?.endLimitSec)) {
          continue
        }

        this.scheduleAudioClip(c, input, playheadSec, now, opts?.endLimitSec)
      }
    }
  }

  private stopSourcesForClip(clipId: string) {
    // Stop audio buffer sources for this clip
    const set = this.activeSourcesByClip.get(clipId)
    if (set) {
      for (const src of Array.from(set)) {
        try { src.stop() } catch {}
        try { src.disconnect() } catch {}
        const idx = this.activeSources.indexOf(src)
        if (idx >= 0) this.activeSources.splice(idx, 1)
      }
      this.activeSourcesByClip.delete(clipId)
    }
    this.stopActiveNotesForClip(clipId)
  }

  rescheduleClipsAtPlayhead(tracks: Track[], playheadSec: number, clipIds: string[], opts?: ScheduleOptions) {
    if (!this.audioCtx) return
    if (!clipIds || clipIds.length === 0) return
    const idsSet = new Set<string>(clipIds)
    const now = this.timelineToCtxTime(playheadSec)
    this.updateTrackGains(tracks)
    for (const id of idsSet) this.stopSourcesForClip(id)

    for (const t of tracks) {
      const input = this.ensureTrackNodes(t.id)
      for (const c of t.clips) {
        if (!idsSet.has(c.id)) continue
        if (this.scheduleMidiClip(t, c, playheadSec, now, opts?.endLimitSec)) {
          continue
        }

        this.scheduleAudioClip(c, input, playheadSec, now, opts?.endLimitSec)
      }
    }
  }

  async resume() {
    if (this.audioCtx) {
      await this.audioCtx.resume()
    }
  }

  get currentTime() {
    return this.audioCtx?.currentTime ?? 0
  }

  // Sum of output and base latency (seconds) if available; used for A/V visual alignment
  get outputLatencySec() {
    const ctx = this.audioCtx
    if (!ctx) return 0
    const base = (ctx as any).baseLatency ?? 0
    const out = (ctx as any).outputLatency ?? 0
    const total = (typeof base === 'number' ? base : 0) + (typeof out === 'number' ? out : 0)
    return Number.isFinite(total) ? total : 0
  }

  async decodeAudioData(arrayBuffer: ArrayBuffer) {
    // Avoid creating a real AudioContext during decode to prevent
    // autoplay policy warnings before a user gesture occurs.
    if (this.audioCtx) {
      return this.audioCtx.decodeAudioData(arrayBuffer)
    }
    const offline = new OfflineAudioContext(2, 1, 44100)
    return offline.decodeAudioData(arrayBuffer)
  }

  close() {
    this.stopAllSources()
    this.clearMetronomeInterval()
    this.impulseCache.clear()
    this.effectsRuntime.eqSignatures.clear()
    this.effectsRuntime.reverbSignatures.clear()
    this.masterEqSignature = null
    this.masterReverbSignature = null
    this.meterRuntime.spectrumTmp.clear()
    this.meterRuntime.spectrumLast.clear()
    for (const meterNode of this.meterWorkletNodes.values()) {
      try { meterNode.disconnect() } catch {}
      meterNode.port.onmessage = null
    }
    this.meterWorkletNodes.clear()
    this.meterWorkletLevels.clear()
    this.meterWorkletReady = null
    for (const sendMap of this.mixerRuntime.sendGains.values()) {
      for (const sendGain of sendMap.values()) {
        try { sendGain.disconnect() } catch {}
      }
    }
    this.mixerRuntime.sendGains.clear()
    for (const output of this.mixerRuntime.outputs.values()) {
      try { output.disconnect() } catch {}
    }
    this.mixerRuntime.outputs.clear()
    this.masterSpectrumTmp = null
    this.masterSpectrumLast = null
    this.masterAnalyserConnected = false
    if (this.audioCtx) {
      try { this.audioCtx.close() } catch {}
    }
    this.masterAnalyser = null
  }

  // --- Master EQ ---
  private rebuildMasterRouting() {
    if (!this.audioCtx || !this.masterGain) return
    try { this.masterGain.disconnect() } catch {}
    if (this.masterAnalyserConnected) this.masterAnalyserConnected = false
    const eq = this.masterEqChain
    const finalDest = this.destination ?? this.audioCtx.destination
    connectParallelFxChain(this.masterGain, finalDest, eq, this.masterReverb)
    this.ensureMasterAnalyser()
  }

  setMasterEq(params: EqParamsLite) {
    if (!this.audioCtx) {
      // Defer until AudioContext exists (created via user gesture)
      this.pendingMasterEqParams = params
      return
    }
    const signature = serializeEqParams(params)
    if (this.masterEqSignature === signature) return
    // Tear down existing nodes
    for (const n of this.masterEqChain) { try { n.disconnect() } catch {} }
    this.masterEqChain = createEqNodes(this.audioCtx, params, this.audioCtx.destination.maxChannelCount || 2)
    this.masterEqSignature = signature
    this.rebuildMasterRouting()
  }

  // --- Live spectrum sampling (Ableton-like) ---
  getTrackSpectrum(trackId: string): SpectrumFrame | null {
    const a = this.meterRuntime.analysers.get(trackId)
    if (!a) return this.meterRuntime.spectrumLast.get(trackId) ?? null
    let tmp = this.meterRuntime.spectrumTmp.get(trackId)
    if (!tmp || tmp.length !== a.frequencyBinCount) {
      tmp = new Uint8Array(a.frequencyBinCount)
      this.meterRuntime.spectrumTmp.set(trackId, tmp)
    }
    try { a.getByteFrequencyData(tmp as any) } catch { return this.meterRuntime.spectrumLast.get(trackId) ?? null }
    let sum = 0
    for (let i = 0; i < tmp.length; i++) sum += tmp[i]
    if (sum === 0) return this.meterRuntime.spectrumLast.get(trackId) ?? null
    const out = new Float32Array(tmp.length)
    for (let i = 0; i < tmp.length; i++) out[i] = tmp[i] / 255
    const frame: SpectrumFrame = { data: out, sampleRate: this.audioCtx?.sampleRate ?? 44100 }
    this.meterRuntime.spectrumLast.set(trackId, frame)
    return frame
  }

  getMasterSpectrum(): SpectrumFrame | null {
    // Do not auto-create AudioContext here to avoid autoplay policy warnings.
    // Only sample if an AudioContext already exists (created after a user gesture).
    this.ensureMasterAnalyser()
    const a = this.masterAnalyser
    if (!a) return this.masterSpectrumLast
    if (!this.masterSpectrumTmp || this.masterSpectrumTmp.length !== a.frequencyBinCount) {
      this.masterSpectrumTmp = new Uint8Array(a.frequencyBinCount)
    }
    try { a.getByteFrequencyData(this.masterSpectrumTmp as any) } catch { return this.masterSpectrumLast }
    let sum = 0
    for (let i = 0; i < this.masterSpectrumTmp.length; i++) sum += this.masterSpectrumTmp[i]
    if (sum === 0) return this.masterSpectrumLast
    const out = new Float32Array(this.masterSpectrumTmp.length)
    for (let i = 0; i < out.length; i++) out[i] = this.masterSpectrumTmp[i] / 255
    this.masterSpectrumLast = { data: out, sampleRate: this.audioCtx?.sampleRate ?? 44100 }
    return this.masterSpectrumLast
  }
}
