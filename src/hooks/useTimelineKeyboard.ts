import { onMount, onCleanup } from 'solid-js'

type KeyboardHandlers = {
  onSpace: () => void
  onDelete: () => void
  onDuplicate?: () => void
  onAddAudioTrack?: () => void
  onAddInstrumentTrack?: () => void
}

export function useTimelineKeyboard(handlers: KeyboardHandlers) {
  const captureOptions = { capture: true } as const

  function onKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    
    // Add Track
    // Instrument: Ctrl/Cmd + Shift + T
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault()
      e.stopPropagation()
      handlers.onAddInstrumentTrack?.()
      return
    }
    // Audio: Shift + T (no Ctrl/Cmd)
    if (!e.ctrlKey && !e.metaKey && e.shiftKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault()
      e.stopPropagation()
      handlers.onAddAudioTrack?.()
      return
    }

    // Duplicate: Ctrl/Cmd + D
    if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault()
      e.stopPropagation()
      handlers.onDuplicate?.()
      return
    }

    if (e.code === 'Space') {
      e.preventDefault()
      e.stopPropagation()
      handlers.onSpace()
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      handlers.onDelete()
    }
  }

  onMount(() => {
    window.addEventListener('keydown', onKeyDown, captureOptions)
  })

  onCleanup(() => {
    window.removeEventListener('keydown', onKeyDown, captureOptions)
  })
}