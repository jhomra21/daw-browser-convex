import { createEffect, createSignal, untrack } from 'solid-js'

import { isEditableKeyboardTarget } from '~/lib/keyboard-event-target'
import { createStoredValue } from '~/lib/stored-value'
import { DEFAULT_NOTE_VELOCITY } from '~/lib/midi-editor-grid'

const BASE_C4 = 60
const VELOCITY_STEP = 0.1

const whiteKeySemitones = new Map<string, number>([
  ['KeyA', 0],
  ['KeyS', 2],
  ['KeyD', 4],
  ['KeyF', 5],
  ['KeyG', 7],
  ['KeyH', 9],
  ['KeyJ', 11],
  ['KeyK', 12],
  ['KeyL', 14],
  ['Semicolon', 16],
])

const blackKeySemitones = new Map<string, number>([
  ['KeyW', 1],
  ['KeyE', 3],
  ['KeyT', 6],
  ['KeyY', 8],
  ['KeyU', 10],
  ['KeyO', 13],
  ['KeyP', 15],
])

type UseMidiKeyboardInputOptions = {
  projectId: () => string | undefined
  enabled: () => boolean
  canPlay: () => boolean
  onStartLiveNote?: (pitch: number, velocity?: number) => void
  onStopLiveNote?: (pitch: number) => void
}

export const midiKeyboardCodeToSemitone = (code: string): number | undefined => {
  const white = whiteKeySemitones.get(code)

  if (white !== undefined) return white

  return blackKeySemitones.get(code)
}

export const clampMidiKeyboardOctave = (value: number) => Math.max(-4, Math.min(4, value))
export const clampMidiKeyboardVelocity = (value: number) => Math.max(0.1, Math.min(1, value))

const storedOctave = createStoredValue<number>({
  key: (scope) => `mb:midi_kb_oct:${scope}`,
  fallback: () => 0,
  parse: (raw) => {
    const value = Number.parseInt(raw, 10)

    return Number.isFinite(value) ? clampMidiKeyboardOctave(value) : undefined
  },
  serialize: String,
})

const storedVelocity = createStoredValue<number>({
  key: (scope) => `mb:midi_kb_vel:${scope}`,
  fallback: () => DEFAULT_NOTE_VELOCITY,
  parse: (raw) => {
    const value = Number.parseFloat(raw)

    return Number.isFinite(value) ? clampMidiKeyboardVelocity(value) : undefined
  },
  serialize: (value) => value.toFixed(2),
})

export function useMidiKeyboardInput(options: UseMidiKeyboardInputOptions) {
  const storageScope = () => options.projectId() || 'default'

  const [octave, setOctave] = createSignal(storedOctave.read(storageScope()))
  const [velocity, setVelocity] = createSignal(storedVelocity.read(storageScope()))
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

  createEffect(
    () => options.projectId(),
    () => untrack(() => {
      stopPressedNotes()
      setOctave(storedOctave.read(storageScope()))
      setVelocity(storedVelocity.read(storageScope()))
    }),
    { defer: true },
  )

  createEffect(
    () => ({ scope: storageScope(), value: octave() }),
    ({ scope, value }) => {
      storedOctave.write(scope, value)
    },
  )

  createEffect(
    () => ({ scope: storageScope(), value: velocity() }),
    ({ scope, value }) => {
      storedVelocity.write(scope, value)
    },
  )

  createEffect(
    () => options.enabled(),
    (enabled) => {
      if (!enabled) {
        stopPressedNotes()
      }
    },
  )

  createEffect(
    () => options.enabled(),
    (enabled) => {
      if (!enabled) return
      const listenerOptions: AddEventListenerOptions = { capture: true }

      const handleVisibilityChange = () => {
        if (document.hidden) stopPressedNotes()
      }

      // Window blur also fires when focus moves to the native editor window.
      window.addEventListener('keydown', handleKeyDown, listenerOptions)
      window.addEventListener('keyup', handleKeyUp, listenerOptions)
      document.addEventListener('visibilitychange', handleVisibilityChange)

      const removeListeners = () => {
        window.removeEventListener('keydown', handleKeyDown, listenerOptions)
        window.removeEventListener('keyup', handleKeyUp, listenerOptions)
        document.removeEventListener('visibilitychange', handleVisibilityChange)
        untrack(stopPressedNotes)
      }

      return removeListeners
    },
  )

  return {
    octave,
    isActive: (pitch: number) => activeRows().has(pitch),
  }
}
