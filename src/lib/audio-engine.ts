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
          const wave = (midi.wave as OscillatorType) || synth?.wave || 'sawtooth'
          const clipStart = c.startSec
          const clipEnd = c.startSec + c.duration
          for (const note of midi.notes as Array<{ beat: number; length: number; pitch: number; velocity?: number }>) {
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
            const gain = this.audioCtx.createGain()
            const vel = typeof note.velocity === 'number' ? Math.max(0, Math.min(1, note.velocity)) : 0.9
            const clipGain = typeof midi.gain === 'number' ? Math.max(0, Math.min(1.5, midi.gain)) : (synth?.gain ?? 0.8)
            const amp = vel * clipGain
            gain.gain.setValueAtTime(0, startCtx)
            // Simple AR envelope
            const attack = Math.max(0.001, (synth?.attackMs ?? 5) / 1000)
            const release = Math.max(0.001, (synth?.releaseMs ?? 30) / 1000)
            gain.gain.linearRampToValueAtTime(amp, startCtx + attack)
            gain.gain.setValueAtTime(amp, startCtx + Math.max(0, remaining - release))
            gain.gain.linearRampToValueAtTime(0, startCtx + Math.max(attack, remaining))

            osc.type = wave
            // MIDI note to Hz (A4=440, MIDI 69)
            const freq = 440 * Math.pow(2, (note.pitch - 69) / 12)
            osc.frequency.setValueAtTime(freq, startCtx)

            osc.connect(gain)
            gain.connect(input)

            try { osc.start(startCtx) } catch {}
            try { osc.stop(startCtx + Math.max(attack, remaining)) } catch {}
            osc.onended = () => {
              try { gain.disconnect() } catch {}
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