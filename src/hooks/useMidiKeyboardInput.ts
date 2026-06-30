import { createEffect, createSignal, on, onCleanup } from 'solid-js'

import { isEditableKeyboardTarget } from '~/lib/keyboard-event-target'
import { canUseLocalStorage } from '~/lib/timeline-storage'

const BASE_C4 = 60
const DEFAULT_VELOCITY = 0.9
const VELOCITY_STEP = 0.1

const whiteKeySemitones: Record<string, number> = {
  KeyA: 0,
  KeyS: 2,
  KeyD: 4,
  KeyF: 5,
  KeyG: 7,
  KeyH: 9,
  KeyJ: 11,
  KeyK: 12,
  KeyL: 14,
  Semicolon: 16,
}

const blackKeySemitones: Record<string, number> = {
  KeyW: 1,
  KeyE: 3,
  KeyT: 6,
  KeyY: 8,
  KeyU: 10,
  KeyO: 13,
  KeyP: 15,
}

type UseMidiKeyboardInputOptions = {
  projectId: () => string | undefined
  targetId: () => string | null | undefined
  enabled: () => boolean
  canPlay: () => boolean
  onStartLiveNote?: (pitch: number, velocity?: number) => void
  onStopLiveNote?: (pitch: number) => void
}

export const midiKeyboardCodeToSemitone = (code: string): number | undefined => {
  const white = whiteKeySemitones[code]
  if (white !== undefined) return white
  return blackKeySemitones[code]
}

export const clampMidiKeyboardOctave = (value: number) => Math.max(-4, Math.min(4, value))
export const clampMidiKeyboardVelocity = (value: number) => Math.max(0.1, Math.min(1, value))

export function useMidiKeyboardInput(options: UseMidiKeyboardInputOptions) {
  const octaveKey = () => `mb:midi_kb_oct:${options.projectId() || 'default'}`
  const velocityKey = () => `mb:midi_kb_vel:${options.projectId() || 'default'}`
  const readStoredOctave = () => {
    if (!canUseLocalStorage()) return 0
    try {
      const raw = window.localStorage.getItem(octaveKey())
      if (raw === null) return 0
      const value = Number.parseInt(raw, 10)
      return Number.isFinite(value) ? clampMidiKeyboardOctave(value) : 0
    } catch {
      return 0
    }
  }
  const readStoredVelocity = () => {
    if (!canUseLocalStorage()) return DEFAULT_VELOCITY
    try {
      const raw = window.localStorage.getItem(velocityKey())
      if (raw === null) return DEFAULT_VELOCITY
      const value = Number.parseFloat(raw)
      return Number.isFinite(value) ? clampMidiKeyboardVelocity(value) : DEFAULT_VELOCITY
    } catch {
      return DEFAULT_VELOCITY
    }
  }
  const [octave, setOctave] = createSignal(readStoredOctave())
  const [velocity, setVelocity] = createSignal(readStoredVelocity())
  const [activeRows, setActiveRows] = createSignal<Set<number>>(new Set(), { equals: false })
  const pressed = new Map<string, number>()

  const stopPressedNotes = () => {
    for (const pitch of new Set(pressed.values())) {
      options.onStopLiveNote?.(pitch)
    }
    pressed.clear()
    setActiveRows(new Set<number>())
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (isEditableKeyboardTarget(event.target)) return
    if (!options.canPlay()) return

    if (event.code === 'KeyZ') {
      setOctave(value => clampMidiKeyboardOctave(value - 1))
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.code === 'KeyX') {
      setOctave(value => clampMidiKeyboardOctave(value + 1))
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.code === 'KeyC') {
      setVelocity(value => clampMidiKeyboardVelocity(value - VELOCITY_STEP))
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.code === 'KeyV') {
      setVelocity(value => clampMidiKeyboardVelocity(value + VELOCITY_STEP))
      event.preventDefault()
      event.stopPropagation()
      return
    }

    const semitone = midiKeyboardCodeToSemitone(event.code)
    if (semitone === undefined) return
    if (pressed.has(event.code)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }

    const pitch = BASE_C4 + semitone + octave() * 12
    pressed.set(event.code, pitch)
    setActiveRows(new Set(pressed.values()))
    options.onStartLiveNote?.(pitch, velocity())
    event.preventDefault()
    event.stopPropagation()
  }

  const handleKeyUp = (event: KeyboardEvent) => {
    const pitch = pressed.get(event.code)
    if (pitch === undefined) return

    pressed.delete(event.code)
    if (![...pressed.values()].includes(pitch)) {
      options.onStopLiveNote?.(pitch)
    }
    setActiveRows(new Set(pressed.values()))
    event.preventDefault()
    event.stopPropagation()
  }

  createEffect(on(
    () => options.projectId(),
    () => {
      stopPressedNotes()
      setOctave(readStoredOctave())
      setVelocity(readStoredVelocity())
    },
    { defer: true },
  ))

  createEffect(on(
    () => options.targetId(),
    () => stopPressedNotes(),
    { defer: true },
  ))

  createEffect(() => {
    if (!canUseLocalStorage()) return
    try {
      window.localStorage.setItem(octaveKey(), String(octave()))
    } catch {}
  })

  createEffect(() => {
    if (!canUseLocalStorage()) return
    try {
      window.localStorage.setItem(velocityKey(), velocity().toFixed(2))
    } catch {}
  })

  createEffect(() => {
    if (!options.enabled() || !options.canPlay()) {
      stopPressedNotes()
    }
  })

  createEffect(() => {
    if (!options.enabled()) return
    const listenerOptions: AddEventListenerOptions = { capture: true }
    window.addEventListener('keydown', handleKeyDown, listenerOptions)
    window.addEventListener('keyup', handleKeyUp, listenerOptions)
    window.addEventListener('blur', stopPressedNotes)
    onCleanup(() => {
      window.removeEventListener('keydown', handleKeyDown, listenerOptions)
      window.removeEventListener('keyup', handleKeyUp, listenerOptions)
      window.removeEventListener('blur', stopPressedNotes)
      stopPressedNotes()
    })
  })

  return {
    octave,
    hasActiveNotes: () => activeRows().size > 0,
    isActive: (pitch: number) => activeRows().has(pitch),
  }
}
