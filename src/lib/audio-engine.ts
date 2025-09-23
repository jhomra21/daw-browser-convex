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

export class AudioEngine {
  private audioCtx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private destination: AudioDestinationNode | null = null
  private trackGains = new Map<string, GainNode>()
  private activeSources: AudioBufferSourceNode[] = []
  // New: per-track input prior to effects, and EQ chains
  private trackInputs = new Map<string, GainNode>()
  private eqChains = new Map<string, BiquadFilterNode[]>()
  private pendingEqParams = new Map<string, EqParamsLite>()
  // Master EQ chain
  private masterEqChain: BiquadFilterNode[] = []

  ensureAudio() {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext()
      this.masterGain = this.audioCtx.createGain()
      this.destination = this.audioCtx.destination
      this.masterGain.gain.value = 1.0
      // Connect master routing initially (no EQ)
      this.rebuildMasterRouting()
    }
  }

  // --- Effects: EQ chain management ---
  // Minimal shared type (avoid importing from UI component)
  private supportsGain(type: BiquadFilterType) {
    return type === 'peaking' || type === 'lowshelf' || type === 'highshelf'
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
        this.setTrackEq(trackId, pending)
        this.pendingEqParams.delete(trackId)
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
    const chain = this.eqChains.get(trackId)
    if (!chain || chain.length === 0) {
      input.connect(g)
      return
    }
    // Connect input -> n1 -> n2 -> ... -> g
    let prev: AudioNode = input
    for (const node of chain) {
      try { prev.disconnect() } catch {}
      prev.connect(node)
      prev = node
    }
    try { prev.disconnect() } catch {}
    prev.connect(g)
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
        this.pendingEqParams.delete(id)
      }
    }
  }

  stopAllSources() {
    for (const s of this.activeSources) {
      try { s.stop() } catch {}
      try { s.disconnect() } catch {}
    }
    this.activeSources = []
  }

  scheduleAllClipsFromPlayhead(tracks: Track[], playheadSec: number) {
    if (!this.audioCtx) return
    
    this.stopAllSources()
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
        // Skip clips without audio
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
    if (this.audioCtx) {
      try { this.audioCtx.close() } catch {}
    }
  }

  // --- Master EQ ---
  private rebuildMasterRouting() {
    if (!this.audioCtx || !this.masterGain) return
    // Disconnect masterGain from everything
    try { this.masterGain.disconnect() } catch {}
    const chain = this.masterEqChain
    if (!chain || chain.length === 0) {
      this.masterGain.connect(this.destination ?? this.audioCtx.destination)
      return
    }
    let prev: AudioNode = this.masterGain
    for (const node of chain) {
      try { prev.disconnect() } catch {}
      prev.connect(node)
      prev = node
    }
    try { prev.disconnect() } catch {}
    prev.connect(this.destination ?? this.audioCtx.destination)
  }

  setMasterEq(params: EqParamsLite) {
    if (!this.audioCtx) this.ensureAudio()
    if (!this.audioCtx) return
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