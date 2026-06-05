import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import type { Accessor } from 'solid-js'

import type { TimelineMidiBounds } from '~/components/timeline/timeline-overlays'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { canUseLocalStorage } from '~/lib/timeline-storage'
import { createTimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import type { Track } from '@daw-browser/timeline-core/types'

import type { TimelineSelectionController } from './useTimelineSelectionState'

type UseTimelineMidiOverlayOptions = {
  audioEngine: AudioEngine
  tracks: Accessor<Track[]>
  projectId: Accessor<string>
  selection: TimelineSelectionController
}

type UseTimelineMidiOverlayReturn = {
  midiEditorClipId: Accessor<string | null>
  midiCard: Accessor<TimelineMidiBounds>
  closeMidiEditor: () => void
  openMidiEditorFor: (clipId: string) => void
  changeMidiCardBounds: (next: TimelineMidiBounds) => void
  auditionNote: (pitch: number, velocity?: number, durSec?: number) => void
  startLiveNote: (pitch: number, velocity?: number) => void
  stopLiveNote: (pitch: number) => void
}

type LiveNote = {
  oscs: OscillatorNode[]
  gain: GainNode
}

function readMidiBounds(value: unknown): TimelineMidiBounds | null {
  if (!value || typeof value !== 'object') return null
  if (!('x' in value) || !('y' in value) || !('w' in value) || !('h' in value)) return null
  const x = value.x
  const y = value.y
  const w = value.w
  const h = value.h
  if (typeof x !== 'number' || !Number.isFinite(x)) return null
  if (typeof y !== 'number' || !Number.isFinite(y)) return null
  if (typeof w !== 'number' || !Number.isFinite(w)) return null
  if (typeof h !== 'number' || !Number.isFinite(h)) return null
  return { x, y, w, h }
}

export function useTimelineMidiOverlay(
  options: UseTimelineMidiOverlayOptions,
): UseTimelineMidiOverlayReturn {
  const [midiEditorClipId, setMidiEditorClipId] = createSignal<string | null>(null)
  const [midiCard, setMidiCard] = createSignal<TimelineMidiBounds>({ x: 80, y: 80, w: 720, h: 360 })
  const activeLiveNotes = new Map<number, LiveNote>()
  let midiCardPersistTimer: number | null = null
  const trackIndex = createMemo(() => createTimelineTrackIndex(options.tracks()))

  const midiCardStorageKey = () => {
    const projectId = options.projectId() || 'default'
    return `mb:midi_card:${projectId}`
  }

  const persistMidiCard = () => {
    if (!canUseLocalStorage()) return
    try {
      window.localStorage.setItem(midiCardStorageKey(), JSON.stringify(midiCard()))
    } catch {}
  }

  const schedulePersistMidiCard = () => {
    if (midiCardPersistTimer) {
      clearTimeout(midiCardPersistTimer)
      midiCardPersistTimer = null
    }
    // Debounce card-position writes while the user drags the editor and always
    // clear the timer on cleanup so it never outlives the overlay.
    midiCardPersistTimer = window.setTimeout(() => {
      midiCardPersistTimer = null
      persistMidiCard()
    }, 250)
  }

  const resolveTargetTrackId = () => {
    const clipId = midiEditorClipId()
    if (clipId) {
      const match = trackIndex().clipEntryById.get(clipId)
      if (match) return match.track.id
    }
    return options.selection.selectedFXTarget() || options.selection.selectedTrackId()
  }

  const stopLiveNote = (pitch: number) => {
    try {
      const entry = activeLiveNotes.get(pitch)
      if (!entry) return
      activeLiveNotes.delete(pitch)
      const ctx = options.audioEngine.getAudioContext()
      if (!ctx) {
        for (const osc of entry.oscs) {
          try { osc.stop() } catch {}
        }
        try { entry.gain.disconnect() } catch {}
        return
      }
      const now = ctx.currentTime
      try {
        entry.gain.gain.cancelScheduledValues(now)
        const current = entry.gain.gain.value
        entry.gain.gain.setValueAtTime(current, now)
        entry.gain.gain.linearRampToValueAtTime(0, now + 0.05)
        for (const osc of entry.oscs) {
          try { osc.stop(now + 0.06) } catch {}
        }
      } catch {}
      for (const osc of entry.oscs) {
        osc.onended = () => {
          try { entry.gain.disconnect() } catch {}
        }
      }
    } catch {}
  }

  const stopAllLiveNotes = () => {
    try {
      for (const pitch of Array.from(activeLiveNotes.keys())) {
        stopLiveNote(pitch)
      }
    } catch {}
  }

  const closeMidiEditor = () => setMidiEditorClipId(null)

  const openMidiEditorFor = (clipId: string) => {
    const match = trackIndex().clipEntryById.get(clipId)
    if (match?.clip.midi) {
      setMidiEditorClipId(clipId)
    }
  }

  const changeMidiCardBounds = (next: TimelineMidiBounds) => {
    setMidiCard(next)
    schedulePersistMidiCard()
  }

  const auditionNote = (pitch: number, velocity = 0.9, durSec = 0.35) => {
    try {
      options.audioEngine.ensureAudio()
      const ctx = options.audioEngine.getAudioContext()
      if (!ctx) return
      const trackId = resolveTargetTrackId() || 'master'
      const synthGain = options.audioEngine.getTrackSynthGainNode(trackId)
      if (!synthGain) return
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const start = ctx.currentTime
      const end = start + Math.max(0.05, durSec)
      const amp = Math.max(0, Math.min(1.5, velocity))
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(440 * Math.pow(2, (pitch - 69) / 12), start)
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(amp, start + 0.01)
      gain.gain.linearRampToValueAtTime(0, end)
      osc.connect(gain)
      gain.connect(synthGain)
      osc.start(start)
      osc.stop(end)
    } catch {}
  }

  const startLiveNote = (pitch: number, velocity = 0.9) => {
    try {
      options.audioEngine.ensureAudio()
      const ctx = options.audioEngine.getAudioContext()
      if (!ctx || activeLiveNotes.has(pitch)) return
      const trackId = resolveTargetTrackId()
      if (!trackId) return
      const synthGain = options.audioEngine.getTrackSynthGainNode(trackId)
      if (!synthGain) return
      const osc1 = ctx.createOscillator()
      const osc2 = ctx.createOscillator()
      const gain = ctx.createGain()
      const start = ctx.currentTime
      const synth = options.audioEngine.getTrackSynthPreviewState(trackId)
      const wave1 = synth?.wave1 ?? 'sawtooth'
      const wave2 = synth?.wave2 ?? wave1
      const targetAmp = Math.max(0, Math.min(1.5, velocity)) / 2
      try { osc1.type = wave1 } catch {}
      try { osc2.type = wave2 } catch {}
      const freq = 440 * Math.pow(2, (pitch - 69) / 12)
      const epsilon = 1e-4
      osc1.frequency.setValueAtTime(freq, start)
      osc2.frequency.setValueAtTime(freq, start)
      gain.gain.setValueAtTime(epsilon, start)
      gain.gain.exponentialRampToValueAtTime(Math.max(epsilon, targetAmp), start + 0.01)
      osc1.connect(gain)
      osc2.connect(gain)
      gain.connect(synthGain)
      osc1.start(start)
      osc2.start(start)
      activeLiveNotes.set(pitch, { oscs: [osc1, osc2], gain })
    } catch {}
  }

  createEffect(() => {
    const key = midiCardStorageKey()
    if (!canUseLocalStorage()) return
    try {
      const raw = window.localStorage.getItem(key)
      if (!raw) return
      const parsed = readMidiBounds(JSON.parse(raw))
      if (parsed) {
        setMidiCard(parsed)
      }
    } catch {}
  })

  createEffect(() => {
    const clipId = midiEditorClipId()
    if (!clipId) return
    const match = trackIndex().clipEntryById.get(clipId)
    if (!match?.clip.midi) {
      setMidiEditorClipId(null)
    }
  })

  createEffect(() => {
    if (!midiEditorClipId()) {
      stopAllLiveNotes()
    }
  })

  onCleanup(() => {
    if (midiCardPersistTimer) {
      clearTimeout(midiCardPersistTimer)
      midiCardPersistTimer = null
    }
    stopAllLiveNotes()
  })

  return {
    midiEditorClipId,
    midiCard,
    closeMidiEditor,
    openMidiEditorFor,
    changeMidiCardBounds,
    auditionNote,
    startLiveNote,
    stopLiveNote,
  }
}
