import type { Track } from '~/types/timeline'
import { Output, BufferTarget, WavOutputFormat, AudioBufferSource } from 'mediabunny'

export type ExportRange =
  | { mode: 'whole' }
  | { mode: 'loop'; startSec: number; endSec: number }
  | { mode: 'custom'; startSec: number; endSec: number }

export type ExportRequest = {
  tracks: Track[]
  bpm: number
  range: ExportRange
  sampleRate?: number
  numberOfChannels?: number
  fx?: {
    masterEq?: EqParamsLite
    masterReverb?: ReverbParamsLite
    trackFx?: Record<string, { eq?: EqParamsLite; reverb?: ReverbParamsLite; arp?: ArpParams; synth?: SynthParams }>
  }
}

export type ExportResult = {
  audioBuffer: AudioBuffer
  blob: Blob
  mimeType: string
  fileExtension: string
  durationSec: number
  sampleRate: number
}

function lastClipEndSec(tracks: Track[]): number {
  let maxEnd = 0
  for (const t of tracks) {
    for (const c of t.clips) {
      maxEnd = Math.max(maxEnd, c.startSec + c.duration)
    }
  }
  // default to small length to avoid zero-length renders
  return Math.max(0.001, maxEnd)
}

function computeRangeSec(tracks: Track[], range: ExportRange): { start: number; end: number } {
  if (range.mode === 'whole') {
    return { start: 0, end: lastClipEndSec(tracks) }
  }
  const s = Math.max(0, range.startSec)
  const e = Math.max(s, range.endSec)
  return { start: s, end: e }
}

export async function renderMixdown(req: ExportRequest): Promise<AudioBuffer> {
  const { tracks, bpm, range, sampleRate = 44100, numberOfChannels = 2, fx } = req
  const { start, end } = computeRangeSec(tracks, range)
  const duration = Math.max(0.001, end - start)
  const length = Math.ceil(duration * sampleRate)
  const ctx = new OfflineAudioContext(numberOfChannels, length, sampleRate)

  // Master chain: input -> (reverb/eq) -> destination
  const masterInput = ctx.createGain()
  masterInput.gain.value = 1

  const masterDest: AudioNode = buildMasterChain(ctx, masterInput, ctx.destination, fx?.masterEq, fx?.masterReverb)
  // Note: buildMasterChain connects nodes; masterDest is final (not used further)

  const anySoloed = tracks.some(t => t.soloed)

  const secondsPerBeat = () => 60 / Math.max(1, bpm || 120)

  for (const t of tracks) {
    // Track-level gain: respect mute/solo/volume
    // Track chain: trackInput -> (reverb/eq) -> trackGain -> masterInput
    const trackInput = ctx.createGain()
    const trackGain = ctx.createGain()
    const audible = (!t.muted) && (!anySoloed || !!t.soloed)
    const effective = audible ? t.volume : 0
    trackGain.gain.value = Number.isFinite(effective) ? effective : 0
    // Insert per-track FX between input and gain
    const fxCfg = fx?.trackFx?.[t.id]
    const destAfterFx = buildTrackChain(ctx, trackInput, trackGain, fxCfg?.eq, fxCfg?.reverb)
    // Finally route trackGain to master input
    trackGain.connect(masterInput)

    for (const c of t.clips) {
      // MIDI clip
      const midi: any = (c as any).midi
      if (midi && Array.isArray(midi.notes)) {
        const spb = secondsPerBeat()
        const midiOffBeats = Math.max(0, (c as any).midiOffsetBeats ?? 0)
        const clipStart = c.startSec
        const clipEnd = c.startSec + c.duration
        const fxCfg = fx?.trackFx?.[t.id]
        const synth = fxCfg?.synth
        const wave: OscillatorType = (synth?.wave as OscillatorType) || (midi.wave as OscillatorType) || 'sawtooth'
        const synthGain = typeof synth?.gain === 'number' ? Math.max(0, Math.min(1.5, synth.gain)) : 1.0
        const clipGain = typeof midi.gain === 'number' ? Math.max(0, Math.min(1.5, midi.gain)) : 1.0
        const attackSec = Math.max(0.001, ((synth?.attackMs ?? 5) / 1000))
        const releaseSec = Math.max(0.001, ((synth?.releaseMs ?? 30) / 1000))

        const clipDurationBeats = c.duration / spb
        let notesToSchedule = midi.notes as Array<{ beat: number; length: number; pitch: number; velocity?: number }>
        const arp = fxCfg?.arp
        if (arp && arp.enabled) {
          notesToSchedule = applyArpeggiator(notesToSchedule, arp, clipDurationBeats)
        }

        for (const note of notesToSchedule) {
          const noteBeatRaw = note.beat || 0
          const trimmedBeats = Math.max(0, midiOffBeats - noteBeatRaw)
          const effectiveLength = Math.max(0, (note.length || 0) - trimmedBeats)
          if (effectiveLength <= 0) continue
          const noteBeatEff = Math.max(0, noteBeatRaw - midiOffBeats)
          const noteStartTimeline = clipStart + noteBeatEff * spb
          const noteEndTimeline = noteStartTimeline + effectiveLength * spb
          const startTimeline = Math.max(noteStartTimeline, clipStart)
          const endTimeline = Math.min(noteEndTimeline, clipEnd)
          if (endTimeline <= startTimeline) continue

          // Clip to export window
          if (endTimeline <= start || startTimeline >= end) continue
          const when = Math.max(0, startTimeline - start)
          const noteDur = Math.min(end, endTimeline) - Math.max(start, startTimeline)
          if (noteDur <= 0) continue

          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          const vel = typeof note.velocity === 'number' ? Math.max(0, Math.min(1, note.velocity)) : 0.9
          const amp = vel * clipGain * synthGain
          osc.type = wave
          const freq = 440 * Math.pow(2, (note.pitch - 69) / 12)
          osc.frequency.setValueAtTime(freq, when)
          gain.gain.setValueAtTime(0, when)
          // Attack/Release from synth params
          const attack = attackSec
          const release = releaseSec
          gain.gain.linearRampToValueAtTime(amp, when + attack)
          const noteEnd = when + noteDur
          const relStart = Math.max(when + attack, noteEnd - release)
          gain.gain.setValueAtTime(amp, relStart)
          gain.gain.linearRampToValueAtTime(0, noteEnd)
          osc.connect(gain)
          gain.connect(trackInput)
          try { osc.start(when) } catch {}
          try { osc.stop(noteEnd) } catch {}
        }
        continue
      }

      // Audio clip
      if (!c.buffer) continue
      const buffer = c.buffer
      const leftPad = Math.max(0, c.leftPadSec ?? 0)
      const bufferOffsetRaw = Math.max(0, (c as any).bufferOffsetSec ?? 0)
      const windowStart = c.startSec
      const windowEnd = c.startSec + c.duration
      const audioStart = windowStart + leftPad
      const bufferDur = buffer.duration
      const bufferOffset = Math.min(bufferDur, bufferOffsetRaw)
      const bufferDurRemain = Math.max(0, bufferDur - bufferOffset)
      const audioEnd = Math.min(windowEnd, audioStart + bufferDurRemain)
      if (audioEnd <= audioStart) continue

      // Clip to export window
      const playableStart = Math.max(start, audioStart)
      const playableEnd = Math.min(end, audioEnd)
      if (playableEnd <= playableStart) continue

      const when = Math.max(0, playableStart - start)
      const offsetNoBase = Math.max(0, playableStart - audioStart)
      const offset = bufferOffset + offsetNoBase
      const playDur = Math.max(0, playableEnd - playableStart)
      if (playDur <= 0) continue

      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(trackInput)
      try { src.start(when, offset, playDur) } catch {}
    }
  }

  return await ctx.startRendering()
}

export async function encodeAudioBuffer(buffer: AudioBuffer): Promise<ExportResult> {
  const sr = buffer.sampleRate
  const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() })
  const src = new AudioBufferSource({ codec: 'pcm-s16' })
  output.addAudioTrack(src)
  await output.start()
  await src.add(buffer)
  src.close()
  await output.finalize()
  const buf = (output.target as BufferTarget).buffer!
  const blob = new Blob([buf], { type: 'audio/wav' })
  return { audioBuffer: buffer, blob, mimeType: 'audio/wav', fileExtension: '.wav', durationSec: buffer.duration, sampleRate: sr }
}

// --- Minimal FX chain helpers (keep in sync with audio-engine shapes) ---
export type EqParamsLite = {
  enabled: boolean
  bands: Array<{ id: string; type: BiquadFilterType; frequency: number; gainDb: number; q: number; enabled: boolean }>
}

export type ReverbParamsLite = {
  enabled: boolean
  wet: number
  decaySec: number
  preDelayMs: number
}

export type ArpParams = { enabled: boolean; pattern: string; rate: string; octaves: number; gate: number; hold: boolean }
export type SynthParams = { wave: OscillatorType; gain?: number; attackMs?: number; releaseMs?: number }

function supportsGain(type: BiquadFilterType) {
  return type === 'peaking' || type === 'lowshelf' || type === 'highshelf'
}

function buildEqNodes(ctx: BaseAudioContext, params?: EqParamsLite, channels = 2): BiquadFilterNode[] {
  const nodes: BiquadFilterNode[] = []
  if (!params?.enabled) return nodes
  for (const b of params.bands) {
    if (!b.enabled) continue
    const f = ctx.createBiquadFilter()
    f.type = b.type
    f.frequency.value = Math.max(20, Math.min(20000, b.frequency))
    f.Q.value = Math.max(0.001, b.q)
    f.gain.value = supportsGain(b.type) ? b.gainDb : 0
    try {
      // Avoid channel count mode changes/glitches by pinning
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(f as any).channelCountMode = 'explicit'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(f as any).channelInterpretation = 'speakers'
      f.channelCount = Math.max(1, Math.min(2, channels))
    } catch {}
    nodes.push(f)
  }
  return nodes
}

function createImpulseResponse(ctx: BaseAudioContext, decaySec: number) {
  const clampedDecay = Math.min(10, Math.max(0.05, decaySec))
  const length = Math.max(1, Math.floor(ctx.sampleRate * clampedDecay))
  const ir = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let ch = 0; ch < ir.numberOfChannels; ch++) {
    const data = ir.getChannelData(ch)
    for (let i = 0; i < length; i++) {
      const t = i / length
      const decay = Math.pow(1 - t, 3)
      // simple white noise tail
      data[i] = (Math.random() * 2 - 1) * decay
    }
  }
  return ir
}

function wireEqChain(input: AudioNode, eq: BiquadFilterNode[], dest: AudioNode) {
  if (eq.length === 0) {
    input.connect(dest)
    return dest
  }
  input.connect(eq[0])
  for (let i = 0; i < eq.length - 1; i++) eq[i].connect(eq[i + 1])
  eq[eq.length - 1].connect(dest)
  return eq[0]
}

function buildTrackChain(ctx: OfflineAudioContext, trackInput: GainNode, trackGain: GainNode, eqParams?: EqParamsLite, rvParams?: ReverbParamsLite) {
  // Build EQ chain to final destination (trackGain)
  const eq = buildEqNodes(ctx, eqParams, ctx.destination.channelCount || 2)
  const dest: AudioNode = trackGain
  if (eq.length) {
    // Ensure eq chain outputs to dest
    for (let i = 0; i < eq.length - 1; i++) eq[i].connect(eq[i + 1])
    eq[eq.length - 1].connect(dest)
  }

  if (rvParams && rvParams.enabled) {
    // Parallel reverb around EQ (like live engine)
    const dry = ctx.createGain(); dry.gain.value = 1 - Math.max(0, Math.min(1, rvParams.wet))
    const wet = ctx.createGain(); wet.gain.value = Math.max(0, Math.min(1, rvParams.wet))
    const pre = ctx.createDelay(2.0); pre.delayTime.value = Math.max(0, Math.min(0.2, rvParams.preDelayMs / 1000))
    const conv = ctx.createConvolver(); conv.buffer = createImpulseResponse(ctx, rvParams.decaySec)

    // Wire dry/wet to EQ entry or dest when no EQ
    const eqEntry = eq.length ? eq[0] : dest
    trackInput.connect(dry); dry.connect(eqEntry)
    trackInput.connect(pre); pre.connect(conv); conv.connect(wet); wet.connect(eqEntry)
  } else {
    // No reverb: route through EQ (or directly) to dest
    if (eq.length) trackInput.connect(eq[0])
    else trackInput.connect(dest)
  }
  return dest
}

function buildMasterChain(ctx: OfflineAudioContext, masterInput: GainNode, finalDest: AudioNode, eqParams?: EqParamsLite, rvParams?: ReverbParamsLite) {
  const eq = buildEqNodes(ctx, eqParams, ctx.destination.channelCount || 2)
  if (eq.length) {
    for (let i = 0; i < eq.length - 1; i++) eq[i].connect(eq[i + 1])
    eq[eq.length - 1].connect(finalDest)
  }

  if (rvParams && rvParams.enabled) {
    const dry = ctx.createGain(); dry.gain.value = 1 - Math.max(0, Math.min(1, rvParams.wet))
    const wet = ctx.createGain(); wet.gain.value = Math.max(0, Math.min(1, rvParams.wet))
    const pre = ctx.createDelay(2.0); pre.delayTime.value = Math.max(0, Math.min(0.2, rvParams.preDelayMs / 1000))
    const conv = ctx.createConvolver(); conv.buffer = createImpulseResponse(ctx, rvParams.decaySec)
    const eqEntry = eq.length ? eq[0] : finalDest
    masterInput.connect(dry); dry.connect(eqEntry)
    masterInput.connect(pre); pre.connect(conv); conv.connect(wet); wet.connect(eqEntry)
  } else {
    if (eq.length) masterInput.connect(eq[0])
    else masterInput.connect(finalDest)
  }
  return finalDest
}

// Arpeggiator expansion (copied/adapted from live engine)
function createSeededRandom(seed: number) {
  let state = (seed >>> 0) || 1
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), state | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function applyArpeggiator(
  notes: Array<{ beat: number; length: number; pitch: number; velocity?: number }>,
  params: ArpParams,
  clipDurationBeats: number,
): Array<{ beat: number; length: number; pitch: number; velocity?: number }> {
  if (!params.enabled || notes.length === 0) return notes

  const rateMap: Record<string, number> = { '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/32': 0.125 }
  const stepBeats = rateMap[params.rate] ?? 0.25
  const chordThreshold = 0.02
  const sorted = notes.slice().sort((a, b) => a.beat - b.beat)
  const chords: Array<{ beat: number; endBeat: number; pitches: number[]; velocity: number }> = []

  for (const note of sorted) {
    const lastChord = chords[chords.length - 1]
    if (lastChord && Math.abs(note.beat - lastChord.beat) < chordThreshold) {
      lastChord.pitches.push(note.pitch)
      lastChord.endBeat = Math.max(lastChord.endBeat, note.beat + note.length)
    } else {
      chords.push({ beat: note.beat, endBeat: note.beat + note.length, pitches: [note.pitch], velocity: note.velocity ?? 0.9 })
    }
  }

  const arpeggiated: Array<{ beat: number; length: number; pitch: number; velocity?: number }> = []
  for (const chord of chords) {
    const basePitches = chord.pitches.slice().sort((a, b) => a - b)
    if (basePitches.length === 0) continue
    const expandedPitches: number[] = []
    const octaves = Math.max(1, Math.floor(params.octaves || 1))
    for (let oct = 0; oct < octaves; oct++) {
      for (const pitch of basePitches) expandedPitches.push(pitch + oct * 12)
    }
    if (expandedPitches.length === 0) continue

    let sequence: number[] = []
    switch (params.pattern) {
      case 'up': sequence = expandedPitches; break
      case 'down': sequence = expandedPitches.slice().reverse(); break
      case 'updown': sequence = [...expandedPitches, ...expandedPitches.slice(0, -1).reverse()]; break
      case 'random': {
        sequence = expandedPitches.slice()
        if (sequence.length > 1) {
          const signature = chord.pitches.reduce((acc, p, idx) => (((acc ^ ((p + idx * 131) >>> 0)) >>> 0) * 33) >>> 0, Math.floor(chord.beat * 10000) >>> 0)
          const rand = createSeededRandom(signature || 1)
          for (let i = sequence.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1))
            ;[sequence[i], sequence[j]] = [sequence[j], sequence[i]]
          }
        }
        break
      }
      default: sequence = expandedPitches
    }

    const endBeat = params.hold ? clipDurationBeats : chord.endBeat
    let currentBeat = chord.beat
    let seqIndex = 0
    const gate = Math.max(0, params.gate)
    if (gate <= 0) continue
    const noteLen = stepBeats * gate
    while (currentBeat < endBeat && currentBeat < clipDurationBeats) {
      const pitch = sequence[seqIndex % sequence.length]
      arpeggiated.push({ beat: currentBeat, length: noteLen, pitch, velocity: chord.velocity })
      currentBeat += stepBeats
      seqIndex++
    }
  }
  return arpeggiated
}
