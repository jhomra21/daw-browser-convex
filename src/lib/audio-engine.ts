import type { Track, Clip } from '~/types/timeline'

// Lightweight EQ params shape used by the engine (kept in sync with UI)
export type EqParamsLite = {
  enabled: boolean
  bands: Array<{
    id: string
    type: BiquadFilterType
    frequency: number
    gainDb: number
    q: number
    enabled: boolean
  }>
}

// Lightweight Reverb params used by the engine (kept in sync with UI)
export type ReverbParamsLite = {
  enabled: boolean
  wet: number // 0..1
  decaySec: number // 0.1..10
  preDelayMs: number // 0..200
}

// Internal representation of an active MIDI note for realtime envelope retargeting
type ActiveNote = {
  trackId: string
  osc: OscillatorNode
  gain: GainNode
  amp: number
  startCtx: number
  // Hard end of the note (clip/note boundary translated to context time, also respects minimum attack)
  endCtx: number
  // When the release should start (context time)
  releaseStartCtx: number
  // Envelope params used when the note was scheduled
  attackSec: number
  releaseSec: number
  // Cleanup timer id for stopping oscillator at endCtx
  cleanupTimer: number | null
}

export class AudioEngine {
  private audioCtx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private destination: AudioDestinationNode | null = null
  private trackGains = new Map<string, GainNode>()
  private activeSources: AudioScheduledSourceNode[] = []
  private metronomeSources: AudioBufferSourceNode[] = []
  // New: per-track input prior to effects, and EQ chains
  private trackInputs = new Map<string, GainNode>()
  private eqChains = new Map<string, BiquadFilterNode[]>()
  private pendingEqParams = new Map<string, EqParamsLite>()
  // Master EQ chain
  private masterEqChain: BiquadFilterNode[] = []
  // --- Reverb: per-track and master ---
  private trackReverbs = new Map<string, {
    enabled: boolean
    dryGain: GainNode
    wetGain: GainNode
    preDelay: DelayNode
    convolver: ConvolverNode
  }>()
  private pendingReverbParams = new Map<string, ReverbParamsLite>()
  private masterReverb: {
    enabled: boolean
    dryGain: GainNode
    wetGain: GainNode
    preDelay: DelayNode
    convolver: ConvolverNode
  } | null = null
  // Pending master params to avoid creating AudioContext before a user gesture
  private pendingMasterEqParams: EqParamsLite | null = null
  private pendingMasterReverbParams: ReverbParamsLite | null = null
  private readonly impulseBucketSize = 0.1
  private impulseCache = new Map<string, AudioBuffer>()
  // Metronome & tempo
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
  // --- Simple per-track synth defaults for MIDI ---
  private trackSynths = new Map<string, { wave: OscillatorType; gain: number; attackMs: number; releaseMs: number }>()
  // Track currently active/scheduled oscillators per track for live param updates (e.g., waveform)
  private activeOscillatorsByTrack = new Map<string, Set<OscillatorNode>>()
  // Track-level synth gain node so gain updates affect active notes in real time
  private trackSynthGains = new Map<string, GainNode>()
  // Active notes by track for realtime envelope retargeting
  private activeNotesByTrack = new Map<string, Set<ActiveNote>>()
  // --- Arpeggiator per track ---
  private trackArpeggiators = new Map<string, { enabled: boolean; pattern: string; rate: string; octaves: number; gate: number; hold: boolean }>()
  // --- Realtime meters: per-track analysers and temp buffers ---
  private trackAnalysers = new Map<string, AnalyserNode>()
  private trackMeterArrays = new Map<string, Float32Array>()
  // Stereo analysers for per-channel meters
  private trackAnalysersStereo = new Map<string, {
    splitter: ChannelSplitterNode
    left: AnalyserNode
    right: AnalyserNode
    leftArr: Float32Array | null
    rightArr: Float32Array | null
  }>()

  private ensureTrackAnalyser(trackId: string, gain: GainNode) {
    if (!this.audioCtx) return
    let a = this.trackAnalysers.get(trackId)
    if (!a) {
      a = this.audioCtx.createAnalyser()
      a.fftSize = 512
      a.smoothingTimeConstant = 0.7
      try { gain.connect(a) } catch {}
      this.trackAnalysers.set(trackId, a)
    }
    // Also ensure stereo analyser chain for L/R metering
    this.ensureTrackAnalysersStereo(trackId, gain)
  }

  private ensureTrackAnalysersStereo(trackId: string, gain: GainNode) {
    if (!this.audioCtx) return
    let entry = this.trackAnalysersStereo.get(trackId)
    if (!entry) {
      const splitter = this.audioCtx.createChannelSplitter(2)
      const left = this.audioCtx.createAnalyser()
      const right = this.audioCtx.createAnalyser()
      left.fftSize = 512; right.fftSize = 512
      left.smoothingTimeConstant = 0.7; right.smoothingTimeConstant = 0.7
      try { gain.connect(splitter) } catch {}
      try { splitter.connect(left, 0) } catch {}
      try { splitter.connect(right, 1) } catch {}
      entry = { splitter, left, right, leftArr: null, rightArr: null }
      this.trackAnalysersStereo.set(trackId, entry)
    }
  }

  // Returns a normalized 0..1 RMS level for a track's post-gain signal
  getTrackLevel(trackId: string): number {
    const a = this.trackAnalysers.get(trackId)
    if (!a || !this.audioCtx) return 0
    let arr = this.trackMeterArrays.get(trackId)
    if (!arr || arr.length !== a.fftSize) {
      arr = new Float32Array(a.fftSize)
      this.trackMeterArrays.set(trackId, arr)
    }
    try {
      a.getFloatTimeDomainData(arr)
    } catch {
      return 0
    }
    let sum = 0
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]
      sum += v * v
    }
    const rms = Math.sqrt(sum / Math.max(1, arr.length))
    // Light companding for visual feel
    const norm = Math.min(1, Math.max(0, Math.sqrt(rms)))
    return norm
  }

  // Returns normalized 0..1 RMS per channel [L, R]
  getTrackLevelsStereo(trackId: string): [number, number] {
    const e = this.trackAnalysersStereo.get(trackId)
    if (!e) {
      const m = this.getTrackLevel(trackId)
      return [m, m]
    }
    const { left, right } = e
    if (!left || !right) return [0, 0]
    // Ensure arrays
    if (!e.leftArr || e.leftArr.length !== left.fftSize) e.leftArr = new Float32Array(left.fftSize)
    if (!e.rightArr || e.rightArr.length !== right.fftSize) e.rightArr = new Float32Array(right.fftSize)
    try { left.getFloatTimeDomainData(e.leftArr!) } catch { return [0, 0] }
    try { right.getFloatTimeDomainData(e.rightArr!) } catch { return [0, 0] }
    const rms = (arr: Float32Array) => {
      let sum = 0
      for (let i = 0; i < arr.length; i++) { const v = arr[i]; sum += v * v }
      return Math.sqrt(sum / Math.max(1, arr.length))
    }
    const comp = (x: number) => Math.min(1, Math.max(0, Math.sqrt(x)))
    return [comp(rms(e.leftArr!)), comp(rms(e.rightArr!))]
  }

  ensureAudio() {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext()
      this.masterGain = this.audioCtx.createGain()
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
      this.ensureMetronomeNodes()
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

  setTrackSynth(trackId: string, params: { wave?: string; gain?: number; attackMs?: number; releaseMs?: number }) {
    // Normalize and store; used during scheduling of MIDI notes
    const wave: OscillatorType = (params.wave as OscillatorType) || 'sawtooth'
    const gain = typeof params.gain === 'number' ? Math.max(0, Math.min(1.5, params.gain)) : 0.8
    const attackMs = typeof params.attackMs === 'number' ? Math.max(0, params.attackMs) : 5
    const releaseMs = typeof params.releaseMs === 'number' ? Math.max(0, params.releaseMs) : 30
    this.trackSynths.set(trackId, { wave, gain, attackMs, releaseMs })
    // Live-update waveform for any oscillators currently active or scheduled on this track
    const set = this.activeOscillatorsByTrack.get(trackId)
    if (set) {
      for (const osc of Array.from(set)) {
        try { (osc as OscillatorNode).type = wave } catch {}
      }
    }
    // Live-update track-level synth gain node, if present
    const g = this.trackSynthGains.get(trackId)
    if (g) {
      try { g.gain.value = gain } catch {}
    }
    // Retarget envelopes of currently active notes on this track so attack/release changes apply live
    this.retargetActiveNotesForTrack(trackId)
  }

  setTrackArpeggiator(trackId: string, params: { enabled: boolean; pattern: string; rate: string; octaves: number; gate: number; hold: boolean }) {
    this.trackArpeggiators.set(trackId, params)
  }

  clearTrackArpeggiator(trackId: string) {
    this.trackArpeggiators.delete(trackId)
  }

  private applyArpeggiator(
    notes: Array<{ beat: number; length: number; pitch: number; velocity?: number }>,
    params: { enabled: boolean; pattern: string; rate: string; octaves: number; gate: number; hold: boolean },
    clipDurationBeats: number,
  ): Array<{ beat: number; length: number; pitch: number; velocity?: number }> {
    if (!params.enabled || notes.length === 0) return notes

    // Parse rate to get step duration in beats
    const rateMap: Record<string, number> = { '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/32': 0.125 }
    const stepBeats = rateMap[params.rate] ?? 0.25

    // Group notes into chords (notes within 50ms ~ 0.01 beats at 120 BPM)
    const chordThreshold = 0.02 // beats
    const sorted = notes.slice().sort((a, b) => a.beat - b.beat)
    const chords: Array<{ beat: number; endBeat: number; pitches: number[]; velocity: number }> = []
    
    for (const note of sorted) {
      const lastChord = chords[chords.length - 1]
      if (lastChord && Math.abs(note.beat - lastChord.beat) < chordThreshold) {
        lastChord.pitches.push(note.pitch)
        // Extend chord end time to longest note
        lastChord.endBeat = Math.max(lastChord.endBeat, note.beat + note.length)
      } else {
        chords.push({ 
          beat: note.beat, 
          endBeat: note.beat + note.length,
          pitches: [note.pitch], 
          velocity: note.velocity ?? 0.9 
        })
      }
    }

    // Expand each chord into arpeggiated notes
    const arpeggiated: Array<{ beat: number; length: number; pitch: number; velocity?: number }> = []
    
    for (const chord of chords) {
      // Sort pitches and expand with octaves
      const basePitches = chord.pitches.slice().sort((a, b) => a - b)
      if (basePitches.length === 0) {
        continue
      }
      const expandedPitches: number[] = []
      const octaves = Math.max(1, Math.floor(params.octaves || 1))
      for (let oct = 0; oct < octaves; oct++) {
        for (const pitch of basePitches) {
          expandedPitches.push(pitch + oct * 12)
        }
      }

      if (expandedPitches.length === 0) {
        continue
      }

      // Apply pattern
      let sequence: number[] = []
      switch (params.pattern) {
        case 'up':
          sequence = expandedPitches
          break
        case 'down':
          sequence = expandedPitches.slice().reverse()
          break
        case 'updown':
          sequence = [...expandedPitches, ...expandedPitches.slice(0, -1).reverse()]
          break
        case 'random': {
          sequence = expandedPitches.slice()
          if (sequence.length > 1) {
            // Deterministic shuffle seeded by chord signature for reproducible playback
            const signature = chord.pitches.reduce((acc, pitch, idx) => {
              const mixed = (acc ^ ((pitch + idx * 131) >>> 0)) >>> 0
              return ((mixed << 5) - mixed) >>> 0 // simple multiplicative+add hash
            }, Math.floor(chord.beat * 10_000) >>> 0)
            const rand = this.createSeededRandom(signature || 1)
            for (let i = sequence.length - 1; i > 0; i--) {
              const j = Math.floor(rand() * (i + 1))
              ;[sequence[i], sequence[j]] = [sequence[j], sequence[i]]
            }
          }
          break
        }
        default:
          sequence = expandedPitches
      }

      if (sequence.length === 0) {
        continue
      }

      // Determine how long to arpeggiate
      const endBeat = params.hold ? clipDurationBeats : chord.endBeat
      
      // Generate arpeggiated notes - loop the sequence until endBeat
      let currentBeat = chord.beat
      let seqIndex = 0
      while (currentBeat < endBeat && currentBeat < clipDurationBeats) {
        const pitch = sequence[seqIndex % sequence.length]
        const gate = Math.max(0, params.gate)
        if (gate <= 0) break
        const noteLength = stepBeats * gate
        arpeggiated.push({
          beat: currentBeat,
          length: noteLength,
          pitch,
          velocity: chord.velocity,
        })
        currentBeat += stepBeats
        seqIndex++
      }
    }

    return arpeggiated
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
      try { note.osc.stop() } catch {}
      try { note.gain.disconnect() } catch {}
      const set = this.activeOscillatorsByTrack.get(note.trackId)
      if (set) {
        set.delete(note.osc)
        if (set.size === 0) this.activeOscillatorsByTrack.delete(note.trackId)
      }
      const notes = this.activeNotesByTrack.get(note.trackId)
      if (notes) {
        notes.delete(note)
        if (notes.size === 0) this.activeNotesByTrack.delete(note.trackId)
      }
    }, delayMs) as unknown as number
  }

  private retargetActiveNotesForTrack(trackId: string) {
    if (!this.audioCtx) return
    const synth = this.trackSynths.get(trackId)
    if (!synth) return
    const notes = this.activeNotesByTrack.get(trackId)
    if (!notes || notes.size === 0) return
    const now = this.audioCtx.currentTime
    const attackSec = Math.max(0.001, (synth.attackMs ?? 5) / 1000)
    const releaseSec = Math.max(0.001, (synth.releaseMs ?? 30) / 1000)
    for (const note of Array.from(notes)) {
      const p = note.gain.gain
      try { p.cancelScheduledValues(now) } catch {}
      // Anchor to current amplitude to avoid clicks
      const currentAmp = this.computeCurrentAmp(note, now)
      try { p.setValueAtTime(currentAmp, now) } catch {}

      // Recompute new envelope times while preserving hard end at note.endCtx
      const attackEndNew = note.startCtx + attackSec
      const releaseStartNew = Math.max(attackEndNew, note.endCtx - releaseSec)

      if (now < attackEndNew) {
        try { p.linearRampToValueAtTime(note.amp, attackEndNew) } catch {}
      }
      if (releaseStartNew > Math.max(now, attackEndNew)) {
        try { p.setValueAtTime(note.amp, releaseStartNew) } catch {}
      }
      try { p.linearRampToValueAtTime(0, note.endCtx) } catch {}

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
    let node = this.trackSynthGains.get(trackId)
    if (!node) {
      node = this.audioCtx.createGain()
      const synth = this.trackSynths.get(trackId)
      node.gain.value = synth?.gain ?? 0.8
      // Route synth output into the track input (so EQ/reverb still apply downstream)
      node.connect(input)
      this.trackSynthGains.set(trackId, node)
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

  onTransportSeek(playheadSec: number) {
    if (!this.audioCtx) return
    this.transportEpochCtxTime = this.audioCtx.currentTime
    this.transportEpochTimelineSec = Math.max(0, playheadSec)
    if (this.metronomeEnabled && this.transportRunning) {
      this.resetMetronomeState()
      this.scheduleMetronomeTicks()
    }
  }

  // --- Effects: EQ chain management ---
  // Minimal shared type (avoid importing from UI component)
  private supportsGain(type: BiquadFilterType) {
    return type === 'peaking' || type === 'lowshelf' || type === 'highshelf'
  }

  private configureBiquadNode(node: BiquadFilterNode) {
    try {
      node.channelCountMode = 'explicit'
      node.channelInterpretation = 'speakers'
      const targetChannels = this.destination?.maxChannelCount ?? this.audioCtx?.destination?.maxChannelCount ?? 2
      node.channelCount = Math.max(1, Math.min(2, targetChannels))
    } catch {
      // Some browsers may not allow changing channel configuration; ignore.
    }
  }

  // --- Reverb helpers ---
  private createSeededRandom(seed: number) {
    let state = (seed >>> 0) || 1
    return () => {
      state = (state + 0x6D2B79F5) | 0
      let t = Math.imul(state ^ (state >>> 15), state | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  private createImpulseResponse(decaySec: number) {
    if (!this.audioCtx) return null
    const ctx = this.audioCtx
    const clampedDecay = Math.min(10, Math.max(0.05, decaySec))
    const bucketIndex = Math.max(1, Math.round(clampedDecay / this.impulseBucketSize))
    const bucketSec = Math.min(10, Math.max(this.impulseBucketSize, bucketIndex * this.impulseBucketSize))
    const length = Math.max(1, Math.floor(ctx.sampleRate * bucketSec))
    const cacheKey = `${ctx.sampleRate}:${bucketIndex}:${length}`
    const cached = this.impulseCache.get(cacheKey)
    if (cached) return cached

    const ir = ctx.createBuffer(2, length, ctx.sampleRate)
    for (let ch = 0; ch < ir.numberOfChannels; ch++) {
      const data = ir.getChannelData(ch)
      const noise = this.createSeededRandom(bucketIndex * 0x9E3779B1 + ch * 0x85EBCA77)
      for (let i = 0; i < length; i++) {
        const t = i / length
        const decay = Math.pow(1 - t, 3)
        data[i] = (noise() * 2 - 1) * decay
      }
    }
    this.impulseCache.set(cacheKey, ir)
    return ir
  }

  setTrackReverb(trackId: string, params: ReverbParamsLite) {
    if (!this.audioCtx) {
      // Defer until audio context exists (created on user gesture)
      this.pendingReverbParams.set(trackId, params)
      return
    }
    this.ensureTrackNodes(trackId)
    let rv = this.trackReverbs.get(trackId)
    if (!rv) {
      const dry = this.audioCtx.createGain()
      const wet = this.audioCtx.createGain()
      const pre = this.audioCtx.createDelay(2.0)
      const conv = this.audioCtx.createConvolver()
      // Initial params
      dry.gain.value = 1 - Math.max(0, Math.min(1, params.wet))
      wet.gain.value = Math.max(0, Math.min(1, params.wet))
      pre.delayTime.value = Math.max(0, Math.min(0.2, params.preDelayMs / 1000))
      conv.buffer = this.createImpulseResponse(params.decaySec)
      this.trackReverbs.set(trackId, {
        enabled: !!params.enabled,
        dryGain: dry,
        wetGain: wet,
        preDelay: pre,
        convolver: conv,
      })
    } else {
      rv.enabled = !!params.enabled
      rv.dryGain.gain.value = 1 - Math.max(0, Math.min(1, params.wet))
      rv.wetGain.gain.value = Math.max(0, Math.min(1, params.wet))
      rv.preDelay.delayTime.value = Math.max(0, Math.min(0.2, params.preDelayMs / 1000))
      rv.convolver.buffer = this.createImpulseResponse(params.decaySec)
    }
    // Rebuild to apply routing
    this.rebuildTrackRouting(trackId)
  }

  setMasterReverb(params: ReverbParamsLite) {
    if (!this.audioCtx || !this.masterGain) {
      // Defer until a user gesture creates the AudioContext
      this.pendingMasterReverbParams = params
      return
    }
    if (!this.masterReverb) {
      this.masterReverb = {
        enabled: !!params.enabled,
        dryGain: this.audioCtx.createGain(),
        wetGain: this.audioCtx.createGain(),
        preDelay: this.audioCtx.createDelay(2.0),
        convolver: this.audioCtx.createConvolver(),
      }
    }
    const rv = this.masterReverb
    rv.enabled = !!params.enabled
    rv.dryGain.gain.value = 1 - Math.max(0, Math.min(1, params.wet))
    rv.wetGain.gain.value = Math.max(0, Math.min(1, params.wet))
    rv.preDelay.delayTime.value = Math.max(0, Math.min(0.2, params.preDelayMs / 1000))
    rv.convolver.buffer = this.createImpulseResponse(params.decaySec)
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
    let input = this.trackInputs.get(trackId)
    if (!input) {
      input = this.audioCtx.createGain()
      this.trackInputs.set(trackId, input)
      // Ensure there is a track gain to terminate into
      let g = this.trackGains.get(trackId)
      if (!g) {
        g = this.audioCtx.createGain()
        g.gain.value = 1
        g.connect(this.masterGain)
        this.trackGains.set(trackId, g)
        // Create analyser tapped from post-gain for meters
        this.ensureTrackAnalyser(trackId, g)
      }
      // Connect by default input -> gain (no EQ)
      try { input.disconnect() } catch {}
      input.connect(g)

      // If there were pending EQ params, apply now
      const pending = this.pendingEqParams.get(trackId)
      if (pending) {
        this.pendingEqParams.delete(trackId)
        this.setTrackEq(trackId, pending)
      }
      // Apply pending reverb params if any
      const pendingRv = this.pendingReverbParams.get(trackId)
      if (pendingRv) {
        this.pendingReverbParams.delete(trackId)
        this.setTrackReverb(trackId, pendingRv)
      }
    }
    return input
  }

  private rebuildTrackRouting(trackId: string) {
    const input = this.trackInputs.get(trackId)
    const g = this.trackGains.get(trackId)
    if (!input || !g) return
    // Disconnect current output path
    try { input.disconnect() } catch {}
    const chain = this.eqChains.get(trackId) || []

    // Ensure EQ chain internal wiring to g
    if (chain.length > 0) {
      // Connect n1 -> n2 -> ... -> g
      for (let i = 0; i < chain.length; i++) {
        const node = chain[i]
        try { node.disconnect() } catch {}
        if (i < chain.length - 1) {
          node.connect(chain[i + 1])
        } else {
          node.connect(g)
        }
      }
    }

    const dest: AudioNode = chain.length > 0 ? chain[0] : g
    const rv = this.trackReverbs.get(trackId)
    if (rv && rv.enabled) {
      // Disconnect reverb nodes outputs first
      try { rv.dryGain.disconnect() } catch {}
      try { rv.wetGain.disconnect() } catch {}
      try { rv.preDelay.disconnect() } catch {}
      try { rv.convolver.disconnect() } catch {}
      // Wire: input -> dryGain -> dest
      input.connect(rv.dryGain)
      rv.dryGain.connect(dest)
      // Wire: input -> preDelay -> convolver -> wetGain -> dest
      input.connect(rv.preDelay)
      rv.preDelay.connect(rv.convolver)
      rv.convolver.connect(rv.wetGain)
      rv.wetGain.connect(dest)
    } else {
      if (rv) {
        try { rv.dryGain.disconnect() } catch {}
        try { rv.wetGain.disconnect() } catch {}
        try { rv.preDelay.disconnect() } catch {}
        try { rv.convolver.disconnect() } catch {}
      }
      input.connect(dest)
    }
  }

  setTrackEq(trackId: string, params: EqParamsLite) {
    if (!this.audioCtx) {
      // Defer until audio context exists
      this.pendingEqParams.set(trackId, params)
      return
    }
    this.ensureTrackNodes(trackId)
    // Tear down existing chain
    const old = this.eqChains.get(trackId)
    if (old) {
      for (const n of old) { try { n.disconnect() } catch {} }
    }
    const nodes: BiquadFilterNode[] = []
    if (params.enabled) {
      for (const b of params.bands) {
        if (!b.enabled) continue
        const f = this.audioCtx.createBiquadFilter()
        this.configureBiquadNode(f)
        f.type = b.type
        f.frequency.value = Math.max(20, Math.min(20000, b.frequency))
        f.Q.value = Math.max(0.001, b.q)
        if (this.supportsGain(b.type)) {
          f.gain.value = b.gainDb
        } else {
          f.gain.value = 0
        }
        nodes.push(f)
      }
    }
    this.eqChains.set(trackId, nodes)
    // Rewire
    this.rebuildTrackRouting(trackId)
  }

  updateTrackGains(tracks: Track[]) {
    if (!this.audioCtx || !this.masterGain) return

    const anySoloed = tracks.some(tt => tt.soloed)

    // Update existing gains and create new ones
    for (const t of tracks) {
      // Ensure track input exists and is connected to chain/gain
      this.ensureTrackNodes(t.id)
      let g = this.trackGains.get(t.id)
      if (!g) {
        g = this.audioCtx.createGain()
        g.connect(this.masterGain)
        this.trackGains.set(t.id, g)
        // Rebuild routing from input through chain to gain
        this.rebuildTrackRouting(t.id)
        // Ensure analyser exists and is wired to post-gain
        this.ensureTrackAnalyser(t.id, g)
      }
      const audible = (!t.muted) && (!anySoloed || !!t.soloed)
      const effective = audible ? t.volume : 0
      g.gain.value = effective
    }

    // Clean up removed tracks
    for (const [id, g] of Array.from(this.trackGains.entries())) {
      if (!tracks.find(t => t.id === id)) {
        try { g.disconnect() } catch {}
        this.trackGains.delete(id)
        const input = this.trackInputs.get(id)
        if (input) {
          try { input.disconnect() } catch {}
          this.trackInputs.delete(id)
        }
        const nodes = this.eqChains.get(id)
        if (nodes) {
          for (const n of nodes) { try { n.disconnect() } catch {} }
          this.eqChains.delete(id)
        }
        const rv = this.trackReverbs.get(id)
        if (rv) {
          try { rv.dryGain.disconnect() } catch {}
          try { rv.wetGain.disconnect() } catch {}
          try { rv.preDelay.disconnect() } catch {}
          try { rv.convolver.disconnect() } catch {}
          this.trackReverbs.delete(id)
        }
        const an = this.trackAnalysers.get(id)
        if (an) { try { an.disconnect() } catch {}; this.trackAnalysers.delete(id); this.trackMeterArrays.delete(id) }
        const stereo = this.trackAnalysersStereo.get(id)
        if (stereo) {
          try { stereo.splitter.disconnect() } catch {}
          try { stereo.left.disconnect() } catch {}
          try { stereo.right.disconnect() } catch {}
          this.trackAnalysersStereo.delete(id)
        }
        this.pendingEqParams.delete(id)
        this.pendingReverbParams.delete(id)
      }
    }
  }

  private stopClipSources() {
    for (const s of this.activeSources) {
      try { s.stop() } catch {}
      try { s.disconnect() } catch {}
    }
    this.activeSources = []
    // Clear tracked oscillators; onended would normally clean up, but force-clear to be safe
    this.activeOscillatorsByTrack.clear()
  }

  stopAllSources() {
    this.stopClipSources()
    this.resetMetronomeState()
  }

  scheduleAllClipsFromPlayhead(tracks: Track[], playheadSec: number) {
    if (!this.audioCtx) return
    
    this.stopClipSources()
    const now = this.audioCtx.currentTime
    const anySoloed = tracks.some(t => t.soloed)

    for (const t of tracks) {
      // Ensure per-track input/gain and routing exist
      this.ensureTrackNodes(t.id)
      let g = this.trackGains.get(t.id)
      if (!g) {
        g = this.audioCtx.createGain()
        const audible0 = (!t.muted) && (!anySoloed || !!t.soloed)
        g.gain.value = audible0 ? t.volume : 0
        g.connect(this.masterGain!)
        this.trackGains.set(t.id, g)
        // Rebuild routing in case EQ chain already exists
        this.rebuildTrackRouting(t.id)
        // Ensure analyser exists and is wired to post-gain
        this.ensureTrackAnalyser(t.id, g)
      }
      // Ensure gain reflects current mute/solo state
      const audible = (!t.muted) && (!anySoloed || !!t.soloed)
      const effective = audible ? t.volume : 0
      g.gain.value = effective

      const input = this.ensureTrackNodes(t.id)
      for (const c of t.clips) {
        // MIDI clip scheduling
        const midi: any = (c as any).midi
        if (midi && Array.isArray(midi.notes)) {
          const spb = this.secondsPerBeat()
          const synth = this.trackSynths.get(t.id)
          const wave = synth?.wave || (midi.wave as OscillatorType) || 'sawtooth'
          const clipStart = c.startSec
          const clipEnd = c.startSec + c.duration
          const clipDurationBeats = c.duration / spb
          
          // Apply arpeggiator if enabled for this track
          let notesToSchedule = midi.notes as Array<{ beat: number; length: number; pitch: number; velocity?: number }>
          const arp = this.trackArpeggiators.get(t.id)
          if (arp && arp.enabled) {
            notesToSchedule = this.applyArpeggiator(notesToSchedule, arp, clipDurationBeats)
          }
          
          for (const note of notesToSchedule) {
            const noteStartTimeline = clipStart + Math.max(0, note.beat) * spb
            const noteEndTimeline = noteStartTimeline + Math.max(0, note.length) * spb
            // Confine to clip window
            const startTimeline = Math.max(noteStartTimeline, clipStart)
            const endTimeline = Math.min(noteEndTimeline, clipEnd)
            if (endTimeline <= startTimeline) continue
            // Skip if playhead is after the note
            if (playheadSec >= endTimeline) continue
            // Compute remaining duration if playhead is inside the note
            const remaining = endTimeline - Math.max(playheadSec, startTimeline)
            if (remaining <= 0) continue

            // Start time in context
            const startCtx = Math.max(now, this.timelineToCtxTime(startTimeline))
            // Build oscillator + envelope
            const osc = this.audioCtx.createOscillator()
            // Track this oscillator under its track for live updates
            let trackOscs = this.activeOscillatorsByTrack.get(t.id)
            if (!trackOscs) { trackOscs = new Set<OscillatorNode>(); this.activeOscillatorsByTrack.set(t.id, trackOscs) }
            trackOscs.add(osc)
            const gain = this.audioCtx.createGain()
            const vel = typeof note.velocity === 'number' ? Math.max(0, Math.min(1, note.velocity)) : 0.9
            // Per-clip gain (track synth gain is handled by a dedicated track-level node for live updates)
            const clipGain = typeof midi.gain === 'number' ? Math.max(0, Math.min(1.5, midi.gain)) : 1.0
            const amp = vel * clipGain
            gain.gain.setValueAtTime(0, startCtx)
            // Simple AR envelope
            const attack = Math.max(0.001, (synth?.attackMs ?? 5) / 1000)
            const release = Math.max(0.001, (synth?.releaseMs ?? 30) / 1000)
            const attackEnd = startCtx + attack
            const releaseStart = startCtx + Math.max(0, remaining - release)
            const endCtx = startCtx + Math.max(attack, remaining)
            gain.gain.linearRampToValueAtTime(amp, attackEnd)
            if (releaseStart > attackEnd) {
              gain.gain.setValueAtTime(amp, releaseStart)
            }
            gain.gain.linearRampToValueAtTime(0, endCtx)

            osc.type = wave
            // MIDI note to Hz (A4=440, MIDI 69)
            const freq = 440 * Math.pow(2, (note.pitch - 69) / 12)
            osc.frequency.setValueAtTime(freq, startCtx)

            osc.connect(gain)
            // Route MIDI note through per-track synth gain node so live gain changes apply immediately
            gain.connect(this.ensureTrackSynthGainNode(t.id))

            try { osc.start(startCtx) } catch {}
            // Register active note for realtime retargeting and schedule cleanup at endCtx
            const noteEntry: ActiveNote = {
              trackId: t.id,
              osc,
              gain,
              amp,
              startCtx,
              endCtx,
              releaseStartCtx: releaseStart,
              attackSec: attack,
              releaseSec: release,
              cleanupTimer: null,
            }
            let notes = this.activeNotesByTrack.get(t.id)
            if (!notes) { notes = new Set<ActiveNote>(); this.activeNotesByTrack.set(t.id, notes) }
            notes.add(noteEntry)
            this.scheduleCleanupForNote(noteEntry)

            osc.onended = () => {
              try { gain.disconnect() } catch {}
              // Remove from tracking sets
              const set = this.activeOscillatorsByTrack.get(t.id)
              if (set) {
                set.delete(osc)
                if (set.size === 0) this.activeOscillatorsByTrack.delete(t.id)
              }
              const notes = this.activeNotesByTrack.get(t.id)
              if (notes) {
                for (const n of Array.from(notes)) {
                  if (n.osc === osc) {
                    if (n.cleanupTimer) { try { clearTimeout(n.cleanupTimer) } catch {} }
                    notes.delete(n)
                  }
                }
                if (notes.size === 0) this.activeNotesByTrack.delete(t.id)
              }
              const idx = this.activeSources.indexOf(osc)
              if (idx >= 0) this.activeSources.splice(idx, 1)
            }
            this.activeSources.push(osc)
          }
          continue // done with this clip
        }

        // Audio clip scheduling
        if (!c.buffer) continue
        const leftPad = Math.max(0, c.leftPadSec ?? 0)
        const windowStart = c.startSec
        const windowEnd = c.startSec + c.duration
        const audioStart = windowStart + leftPad
        const bufferDur = c.buffer.duration
        const audioEnd = Math.min(windowEnd, audioStart + bufferDur)

        // If playhead is outside the audio window, nothing to schedule
        if (playheadSec >= audioEnd) continue

        const when = Math.max(0, audioStart - playheadSec)
        const offset = Math.max(0, playheadSec - audioStart)
        if (offset >= bufferDur) continue

        // How long can we play starting from offset within clip and buffer
        const maxPlayableFromOffset = Math.max(0, bufferDur - offset)
        const clipWindowRemaining = Math.max(0, audioEnd - Math.max(playheadSec, audioStart))
        const playDur = Math.min(maxPlayableFromOffset, clipWindowRemaining)
        if (playDur <= 0) continue

        const s = this.audioCtx.createBufferSource()
        s.buffer = c.buffer
        s.connect(input)
        s.start(now + when, offset, playDur)
        this.activeSources.push(s)
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
    if (this.audioCtx) {
      try { this.audioCtx.close() } catch {}
    }
  }

  // --- Master EQ ---
  private rebuildMasterRouting() {
    if (!this.audioCtx || !this.masterGain) return
    // Disconnect masterGain from everything
    try { this.masterGain.disconnect() } catch {}
    const eq = this.masterEqChain

    // Prepare final destination
    const finalDest = this.destination ?? this.audioCtx.destination

    // Ensure EQ chain internal wiring to final destination
    if (!eq || eq.length === 0) {
      // No EQ; we will connect masterGain or reverb directly to destination
    } else {
      for (let i = 0; i < eq.length; i++) {
        const node = eq[i]
        try { node.disconnect() } catch {}
        if (i < eq.length - 1) node.connect(eq[i + 1])
        else node.connect(finalDest)
      }
    }

    const rv = this.masterReverb
    if (rv && rv.enabled) {
      // Disconnect reverb nodes
      try { rv.dryGain.disconnect() } catch {}
      try { rv.wetGain.disconnect() } catch {}
      try { rv.preDelay.disconnect() } catch {}
      try { rv.convolver.disconnect() } catch {}
      // Determine destination for dry/wet mix: first EQ node or finalDest
      const dest: AudioNode = (eq && eq.length > 0) ? eq[0] : finalDest
      // Wire: masterGain -> dryGain -> dest
      this.masterGain.connect(rv.dryGain)
      rv.dryGain.connect(dest)
      // Wire: masterGain -> preDelay -> convolver -> wetGain -> dest
      this.masterGain.connect(rv.preDelay)
      rv.preDelay.connect(rv.convolver)
      rv.convolver.connect(rv.wetGain)
      rv.wetGain.connect(dest)
    } else {
      if (rv) {
        try { rv.dryGain.disconnect() } catch {}
        try { rv.wetGain.disconnect() } catch {}
        try { rv.preDelay.disconnect() } catch {}
        try { rv.convolver.disconnect() } catch {}
      }
      // Bypass reverb: connect masterGain -> first EQ node or finalDest
      if (eq && eq.length > 0) {
        this.masterGain.connect(eq[0])
      } else {
        this.masterGain.connect(finalDest)
      }
    }
  }

  setMasterEq(params: EqParamsLite) {
    if (!this.audioCtx) {
      // Defer until AudioContext exists (created via user gesture)
      this.pendingMasterEqParams = params
      return
    }
    // Tear down existing nodes
    for (const n of this.masterEqChain) { try { n.disconnect() } catch {} }
    const nodes: BiquadFilterNode[] = []
    if (params.enabled) {
      for (const b of params.bands) {
        if (!b.enabled) continue
        const f = this.audioCtx.createBiquadFilter()
        f.type = b.type
        f.frequency.value = Math.max(20, Math.min(20000, b.frequency))
        f.Q.value = Math.max(0.001, b.q)
        if (this.supportsGain(b.type)) {
          f.gain.value = b.gainDb
        } else {
          f.gain.value = 0
        }
        nodes.push(f)
      }
    }
    this.masterEqChain = nodes
    this.rebuildMasterRouting()
  }
}