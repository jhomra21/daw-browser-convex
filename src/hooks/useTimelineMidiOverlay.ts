import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import type { Accessor } from 'solid-js'

import {
  clampTimelineMidiBounds,
  timelineMidiBoundsEqual,
  type TimelineMidiBounds,
} from '~/lib/timeline-midi-bounds'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { canUseLocalStorage } from '~/lib/timeline-storage'
import { clampMidiVelocity, midiPitchFrequency } from '~/lib/midi-note-audio'
import { createTimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import type { Track } from '@daw-browser/timeline-core/types'
import { useMidiKeyboardInput } from './useMidiKeyboardInput'

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
  midiKeyboard: {
    enabled: Accessor<boolean>
    canPlay: Accessor<boolean>
    targetLabel: Accessor<string | null>
    octave: Accessor<number>
    velocity: Accessor<number>
    toggle: () => void
    isActive: (pitch: number) => boolean
  }
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
  const [midiKeyboardEnabled, setMidiKeyboardEnabled] = createSignal(false)
  const [midiCard, setMidiCard] = createSignal<TimelineMidiBounds>(
    clampTimelineMidiBounds({ x: 80, y: 80, w: 720, h: 360 }),
  )
  const activeLiveNotes = new Map<number, LiveNote>()
  let midiCardPersistTimer: number | null = null
  const trackIndex = createMemo(() => createTimelineTrackIndex(options.tracks()))

  const midiKeyboardStorageKey = () => {
    const projectId = options.projectId() || 'default'
    return `mb:midi_kb:${projectId}`
  }

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

  const isPlayableMidiTrack = (track: Track | undefined) => (
    track?.kind === 'instrument' && track.channelRole !== 'return' && track.channelRole !== 'group'
  )

  const resolveTargetTrack = () => {
    const clipId = midiEditorClipId()
    if (clipId) {
      const match = trackIndex().clipEntryById.get(clipId)
      if (isPlayableMidiTrack(match?.track)) return match?.track
    }
    const fxTarget = options.selection.selectedFXTarget()
    if (fxTarget !== 'master') {
      const track = trackIndex().trackById.get(fxTarget)
      if (isPlayableMidiTrack(track)) return track
    }
    const selectedTrack = trackIndex().trackById.get(options.selection.selectedTrackId())
    if (isPlayableMidiTrack(selectedTrack)) return selectedTrack
    return undefined
  }

  const resolveTargetTrackId = () => resolveTargetTrack()?.id
  const midiKeyboardCanPlay = createMemo(() => Boolean(resolveTargetTrack()))
  const midiKeyboardTargetLabel = createMemo(() => resolveTargetTrack()?.name ?? null)

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
    const clamped = clampTimelineMidiBounds(next)
    if (timelineMidiBoundsEqual(midiCard(), clamped)) return
    setMidiCard(clamped)
    schedulePersistMidiCard()
  }

  const auditionNote = (pitch: number, velocity = 0.9, durSec = 0.35) => {
    try {
      options.audioEngine.ensureAudio()
      const ctx = options.audioEngine.getAudioContext()
      if (!ctx) return
      const trackId = resolveTargetTrackId()
      if (!trackId) return
      const instrumentKind = options.audioEngine.getTrackInstrumentKind(trackId)
      if (options.audioEngine.previewDrumRackNote(trackId, pitch, velocity) || instrumentKind === 'drum-rack') {
        return
      }
      const synthGain = options.audioEngine.getTrackSynthGainNode(trackId)
      if (!synthGain) return
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const start = ctx.currentTime
      const end = start + Math.max(0.05, durSec)
      const amp = clampMidiVelocity(velocity)
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(midiPitchFrequency(pitch), start)
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
      const instrumentKind = options.audioEngine.getTrackInstrumentKind(trackId)
      if (options.audioEngine.previewDrumRackNote(trackId, pitch, velocity) || instrumentKind === 'drum-rack') {
        return
      }
      const synthGain = options.audioEngine.getTrackSynthGainNode(trackId)
      if (!synthGain) return
      const osc1 = ctx.createOscillator()
      const osc2 = ctx.createOscillator()
      const gain = ctx.createGain()
      const start = ctx.currentTime
      const synth = options.audioEngine.getTrackSynthPreviewState(trackId)
      const wave1 = synth?.wave1 ?? 'sawtooth'
      const wave2 = synth?.wave2 ?? wave1
      const targetAmp = clampMidiVelocity(velocity) / 2
      try { osc1.type = wave1 } catch {}
      try { osc2.type = wave2 } catch {}
      const freq = midiPitchFrequency(pitch)
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
        setMidiCard(clampTimelineMidiBounds(parsed))
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

  createEffect(() => {
    const key = midiKeyboardStorageKey()
    if (!canUseLocalStorage()) {
      setMidiKeyboardEnabled(false)
      return
    }
    try {
      setMidiKeyboardEnabled(window.localStorage.getItem(key) === '1')
    } catch {
      setMidiKeyboardEnabled(false)
    }
  })

  createEffect(() => {
    if (!canUseLocalStorage()) return
    try {
      window.localStorage.setItem(midiKeyboardStorageKey(), midiKeyboardEnabled() ? '1' : '0')
    } catch {}
  })

  createEffect(() => {
    if (!midiKeyboardEnabled() || midiKeyboardCanPlay()) return
    stopAllLiveNotes()
  })

  const midiKeyboard = useMidiKeyboardInput({
    projectId: () => options.projectId(),
    enabled: midiKeyboardEnabled,
    canPlay: midiKeyboardCanPlay,
    onStartLiveNote: startLiveNote,
    onStopLiveNote: stopLiveNote,
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
    midiKeyboard: {
      enabled: midiKeyboardEnabled,
      canPlay: midiKeyboardCanPlay,
      targetLabel: midiKeyboardTargetLabel,
      octave: midiKeyboard.octave,
      velocity: midiKeyboard.velocity,
      toggle: () => setMidiKeyboardEnabled(value => !value),
      isActive: midiKeyboard.isActive,
    },
  }
}
