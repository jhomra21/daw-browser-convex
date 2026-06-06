import { getScheduledMidiEvents } from './audio-scheduling'
import { createSynthVoiceOscillators, getSynthVoiceConfig, getSynthVoiceVelocity, scheduleSynthVoiceEnvelope } from './synth-voice'
import { createDefaultSynthParams, normalizeSynthParams, type ArpParams, type SynthParamsInput } from '@daw-browser/shared'
import { disconnectAudioNodes } from './effects/chain'
import { stopAndDisconnectSource, type SourceRegistry } from './source-registry'
import type { Clip, Track } from '@daw-browser/timeline-core/types'

type RuntimeClip = Clip<AudioBuffer>
type RuntimeTrack = Track<AudioBuffer>

type ActiveNote = {
  trackId: string
  clipId: string
  oscs: OscillatorNode[]
  remainingOscillators: number
  gain: GainNode
  amp: number
  startCtx: number
  endCtx: number
  releaseStartCtx: number
  attackSec: number
  releaseSec: number
}

type TrackSynthConfig = {
  wave1: OscillatorType
  wave2: OscillatorType
  gain: number
  attackMs: number
  releaseMs: number
}

type SynthRuntimeOptions = {
  ensureAudio: () => void
  getAudioContext: () => AudioContext | null
  getBpm: () => number
  timelineToCtxTime: (timelineSec: number) => number
  ensureTrackInput: (trackId: string) => GainNode
  sources: SourceRegistry
}

export function createSynthRuntime(options: SynthRuntimeOptions) {
  const configs = new Map<string, TrackSynthConfig>()
  const activeOscillatorsByTrack = new Map<string, Set<OscillatorNode>>()
  const gainNodes = new Map<string, GainNode>()
  const activeNotesByTrack = new Map<string, Set<ActiveNote>>()
  const arpeggiators = new Map<string, ArpParams>()

  const computeCurrentAmp = (note: ActiveNote, nowCtx: number) => {
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

  const stopActiveNote = (note: ActiveNote) => {
    for (const oscillator of note.oscs) {
      stopAndDisconnectSource(oscillator)
      options.sources.remove(note.clipId, oscillator)
    }
    disconnectAudioNodes([note.gain])

    const trackOscs = activeOscillatorsByTrack.get(note.trackId)
    if (trackOscs) {
      for (const oscillator of note.oscs) trackOscs.delete(oscillator)
      if (trackOscs.size === 0) activeOscillatorsByTrack.delete(note.trackId)
    }

    const notes = activeNotesByTrack.get(note.trackId)
    if (notes) {
      notes.delete(note)
      if (notes.size === 0) activeNotesByTrack.delete(note.trackId)
    }
  }

  const stopClip = (clipId: string) => {
    for (const notes of Array.from(activeNotesByTrack.values())) {
      for (const note of Array.from(notes)) {
        if (note.clipId === clipId) stopActiveNote(note)
      }
    }
  }

  const stopAll = () => {
    for (const notes of Array.from(activeNotesByTrack.values())) {
      for (const note of Array.from(notes)) stopActiveNote(note)
    }
  }

  const retargetActiveNotesForTrack = (trackId: string) => {
    const ctx = options.getAudioContext()
    if (!ctx) return
    const synth = configs.get(trackId)
    if (!synth) return
    const notes = activeNotesByTrack.get(trackId)
    if (!notes || notes.size === 0) return
    const now = ctx.currentTime
    const attackSec = Math.max(0.001, (synth.attackMs ?? 5) / 1000)
    const releaseSec = Math.max(0.001, (synth.releaseMs ?? 30) / 1000)
    const EPS = 1e-4
    for (const note of Array.from(notes)) {
      const param = note.gain.gain
      try { param.cancelScheduledValues(now) } catch {}
      const currentAmp = Math.max(EPS, computeCurrentAmp(note, now))
      try { param.setValueAtTime(currentAmp, now) } catch {}

      const attackEndNew = note.startCtx + attackSec
      const releaseStartNew = Math.max(attackEndNew, note.endCtx - releaseSec)

      if (now < attackEndNew) {
        try { param.exponentialRampToValueAtTime(Math.max(EPS, note.amp), attackEndNew) } catch {}
      }
      if (releaseStartNew > Math.max(now, attackEndNew)) {
        try { param.setValueAtTime(Math.max(EPS, note.amp), releaseStartNew) } catch {}
      }
      try { param.exponentialRampToValueAtTime(EPS, note.endCtx) } catch {}
      try { param.setValueAtTime(0, note.endCtx + 1e-4) } catch {}

      note.attackSec = attackSec
      note.releaseSec = releaseSec
      note.releaseStartCtx = releaseStartNew
    }
  }

  const ensureTrackSynthGainNode = (trackId: string): GainNode => {
    options.ensureAudio()
    const trackInput = options.ensureTrackInput(trackId)
    const ctx = options.getAudioContext()
    if (!ctx) return trackInput
    let node = gainNodes.get(trackId)
    if (!node) {
      node = ctx.createGain()
      const synth = configs.get(trackId)
      node.gain.value = synth?.gain ?? 0.8
      node.connect(trackInput)
      gainNodes.set(trackId, node)
    }
    return node
  }

  const disposeTrack = (trackId: string) => {
    const synthGain = gainNodes.get(trackId)
    disconnectAudioNodes([synthGain])
    gainNodes.delete(trackId)
    configs.delete(trackId)
    arpeggiators.delete(trackId)

    const notes = activeNotesByTrack.get(trackId)
    if (notes) for (const note of Array.from(notes)) stopActiveNote(note)
    activeNotesByTrack.delete(trackId)
    activeOscillatorsByTrack.delete(trackId)
  }

  return {
    setTrackSynth: (trackId: string, params: SynthParamsInput) => {
      const synth = normalizeSynthParams(params)
      const { wave1, wave2, gain, attackMs, releaseMs } = synth
      configs.set(trackId, { wave1, wave2, gain, attackMs, releaseMs })
      const gainNode = gainNodes.get(trackId)
      if (gainNode) {
        try { gainNode.gain.value = gain } catch {}
      }
      const activeNotes = activeNotesByTrack.get(trackId)
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
      retargetActiveNotesForTrack(trackId)
    },
    setTrackArpeggiator: (trackId: string, params: ArpParams) => {
      arpeggiators.set(trackId, params)
    },
    clearTrackArpeggiator: (trackId: string) => {
      arpeggiators.delete(trackId)
    },
    clearTrackSynth: (trackId: string) => {
      configs.delete(trackId)
      const gainNode = gainNodes.get(trackId)
      if (gainNode) {
        try { gainNode.gain.value = createDefaultSynthParams().gain } catch {}
      }
    },
    getTrackSynthGainNode: ensureTrackSynthGainNode,
    getTrackSynthPreviewState: (trackId: string) => {
      const synth = configs.get(trackId)
      if (!synth) return null
      return {
        wave1: synth.wave1,
        wave2: synth.wave2,
      }
    },
    scheduleMidiClip: (track: RuntimeTrack, clip: RuntimeClip, playheadSec: number, nowCtx: number, endLimitSec?: number): boolean => {
      const ctx = options.getAudioContext()
      if (!ctx) return false
      const midi = clip.midi
      if (!midi || !Array.isArray(midi.notes)) return false

      const scheduledNotes = getScheduledMidiEvents({
        clip,
        bpm: options.getBpm(),
        notes: midi.notes,
        rangeStartSec: playheadSec,
        rangeEndSec: endLimitSec,
        arp: arpeggiators.get(track.id),
      })
      const voice = getSynthVoiceConfig({ synth: configs.get(track.id), midi })

      for (const note of scheduledNotes) {
        const durationSec = note.endSec - note.startSec
        if (durationSec <= 0) continue

        const startCtx = Math.max(nowCtx, options.timelineToCtxTime(note.startSec))
        const oscs = createSynthVoiceOscillators(ctx, {
          startTime: startCtx,
          pitch: note.pitch,
          wave1: voice.wave1,
          wave2: voice.wave2,
        })
        let trackOscs = activeOscillatorsByTrack.get(track.id)
        if (!trackOscs) {
          trackOscs = new Set<OscillatorNode>()
          activeOscillatorsByTrack.set(track.id, trackOscs)
        }
        for (const osc of oscs) trackOscs.add(osc)
        const gain = ctx.createGain()
        const peakGain = (getSynthVoiceVelocity(note.velocity) * voice.clipGain) / oscs.length
        const envelope = scheduleSynthVoiceEnvelope(gain.gain, {
          startTime: startCtx,
          durationSec,
          attackSec: voice.attackSec,
          releaseSec: voice.releaseSec,
          peakGain,
        })
        for (const osc of oscs) osc.connect(gain)
        gain.connect(ensureTrackSynthGainNode(track.id))

        for (const osc of oscs) {
          try { osc.start(startCtx) } catch {}
          try { osc.stop(envelope.endTime) } catch {}
        }
        const noteEntry: ActiveNote = {
          trackId: track.id,
          clipId: clip.id,
          oscs,
          remainingOscillators: oscs.length,
          gain,
          amp: peakGain,
          startCtx,
          endCtx: envelope.endTime,
          releaseStartCtx: envelope.releaseStartTime,
          attackSec: voice.attackSec,
          releaseSec: voice.releaseSec,
        }
        let notes = activeNotesByTrack.get(track.id)
        if (!notes) {
          notes = new Set<ActiveNote>()
          activeNotesByTrack.set(track.id, notes)
        }
        notes.add(noteEntry)
        const onOscEnded = (osc: OscillatorNode) => {
          const set = activeOscillatorsByTrack.get(track.id)
          if (set) {
            set.delete(osc)
            if (set.size === 0) activeOscillatorsByTrack.delete(track.id)
          }
          options.sources.remove(clip.id, osc)
          const activeNotes = activeNotesByTrack.get(track.id)
          if (activeNotes && !activeNotes.has(noteEntry)) return
          noteEntry.remainingOscillators = Math.max(0, noteEntry.remainingOscillators - 1)
          if (noteEntry.remainingOscillators > 0) return
          disconnectAudioNodes([noteEntry.gain])
          if (activeNotes) {
            activeNotes.delete(noteEntry)
            if (activeNotes.size === 0) activeNotesByTrack.delete(track.id)
          }
        }
        for (const osc of oscs) {
          osc.onended = () => onOscEnded(osc)
          options.sources.add(clip.id, osc)
        }
      }

      return true
    },
    stopClip,
    stopAll,
    disposeTrack,
    clearActiveOscillators: () => {
      activeOscillatorsByTrack.clear()
    },
    clear: () => {
      configs.clear()
      arpeggiators.clear()
      gainNodes.clear()
      activeNotesByTrack.clear()
      activeOscillatorsByTrack.clear()
    },
  }
}
