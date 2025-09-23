import type { Track, Clip } from '~/types/timeline'

export class AudioEngine {
  private audioCtx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private trackGains = new Map<string, GainNode>()
  private activeSources: AudioBufferSourceNode[] = []

  ensureAudio() {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext()
      this.masterGain = this.audioCtx.createGain()
      this.masterGain.gain.value = 1.0
      this.masterGain.connect(this.audioCtx.destination)
    }
  }

  updateTrackGains(tracks: Track[]) {
    if (!this.audioCtx || !this.masterGain) return

    const anySoloed = tracks.some(tt => tt.soloed)

    // Update existing gains and create new ones
    for (const t of tracks) {
      let g = this.trackGains.get(t.id)
      if (!g) {
        g = this.audioCtx.createGain()
        g.connect(this.masterGain)
        this.trackGains.set(t.id, g)
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
      let g = this.trackGains.get(t.id)
      if (!g) {
        g = this.audioCtx.createGain()
        const audible0 = (!t.muted) && (!anySoloed || !!t.soloed)
        g.gain.value = audible0 ? t.volume : 0
        g.connect(this.masterGain!)
        this.trackGains.set(t.id, g)
      }
      // Ensure gain reflects current mute/solo state
      const audible = (!t.muted) && (!anySoloed || !!t.soloed)
      const effective = audible ? t.volume : 0
      g.gain.value = effective

      for (const c of t.clips) {
        // Skip clips that do not have a decoded AudioBuffer yet
        if (!c.buffer) continue
        const offset = Math.max(0, playheadSec - c.startSec)
        const when = Math.max(0, c.startSec - playheadSec)
        if (offset >= c.duration) continue

        const s = this.audioCtx.createBufferSource()
        s.buffer = c.buffer
        s.connect(g)
        s.start(now + when, offset)
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
}