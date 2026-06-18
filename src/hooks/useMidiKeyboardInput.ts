import { createEffect, createSignal, on, onCleanup } from 'solid-js'

import { canUseLocalStorage } from '~/lib/timeline-storage'

const BASE_C4 = 60
const VELOCITY = 0.9

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
  onStartLiveNote?: (pitch: number, velocity?: number) => void
  onStopLiveNote?: (pitch: number) => void
}

const codeToSemitone = (code: string): number | undefined => {
  const white = whiteKeySemitones[code]
  if (white !== undefined) return white
  return blackKeySemitones[code]
}

const isTextInputTarget = (target: EventTarget | null) => (
  target instanceof HTMLElement
  && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
)

export function useMidiKeyboardInput(options: UseMidiKeyboardInputOptions) {
  const storageKey = () => `mb:midi_kb:${options.projectId() || 'default'}`
  const octaveKey = () => `mb:midi_kb_oct:${options.projectId() || 'default'}`
  const readStoredEnabled = () => {
    if (!canUseLocalStorage()) return false
    try {
      return window.localStorage.getItem(storageKey()) === '1'
    } catch {
      return false
    }
  }
  const readStoredOctave = () => {
    if (!canUseLocalStorage()) return 0
    try {
      const raw = window.localStorage.getItem(octaveKey())
      if (raw === null) return 0
      const value = Number.parseInt(raw, 10)
      return Number.isFinite(value) ? Math.max(-4, Math.min(4, value)) : 0
    } catch {
      return 0
    }
  }
  const [enabled, setEnabled] = createSignal(readStoredEnabled())
  const [octave, setOctave] = createSignal(readStoredOctave())
  const [activeRows, setActiveRows] = createSignal<Set<number>>(new Set(), { equals: false })
  const pressed = new Map<string, number>()

  const stopPressedNotes = () => {
    for (const pitch of pressed.values()) {
      options.onStopLiveNote?.(pitch)
    }
    pressed.clear()
    setActiveRows(new Set<number>())
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (isTextInputTarget(event.target)) return

    if (event.code === 'KeyZ') {
      setOctave(value => Math.max(-4, Math.min(4, value - 1)))
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.code === 'KeyX') {
      setOctave(value => Math.max(-4, Math.min(4, value + 1)))
      event.preventDefault()
      event.stopPropagation()
      return
    }

    const semitone = codeToSemitone(event.code)
    if (semitone === undefined) return
    if (pressed.has(event.code)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }

    const pitch = BASE_C4 + semitone + octave() * 12
    pressed.set(event.code, pitch)
    setActiveRows(prev => {
      const next = new Set(prev)
      next.add(pitch)
      return next
    })
    options.onStartLiveNote?.(pitch, VELOCITY)
    event.preventDefault()
    event.stopPropagation()
  }

  const handleKeyUp = (event: KeyboardEvent) => {
    const semitone = codeToSemitone(event.code)
    if (semitone === undefined) return
    const pitch = pressed.get(event.code)
    if (pitch === undefined) return

    pressed.delete(event.code)
    options.onStopLiveNote?.(pitch)
    setActiveRows(prev => {
      const next = new Set(prev)
      next.delete(pitch)
      return next
    })
    event.preventDefault()
    event.stopPropagation()
  }

  createEffect(on(
    () => options.projectId(),
    () => {
      stopPressedNotes()
      setEnabled(readStoredEnabled())
      setOctave(readStoredOctave())
    },
    { defer: true },
  ))

  createEffect(() => {
    if (!canUseLocalStorage()) return
    try {
      window.localStorage.setItem(storageKey(), enabled() ? '1' : '0')
    } catch {}
  })

  createEffect(() => {
    if (!canUseLocalStorage()) return
    try {
      window.localStorage.setItem(octaveKey(), String(octave()))
    } catch {}
  })

  createEffect(() => {
    if (!enabled()) return
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
    enabled,
    toggle: () => setEnabled(value => !value),
    isActive: (pitch: number) => activeRows().has(pitch),
  }
}
