import { onMount, onCleanup } from 'solid-js'

type KeyboardHandlers = {
  onSpace: () => void
  onDelete: () => void
}

export function useTimelineKeyboard(handlers: KeyboardHandlers) {
  function onKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    
    if (e.code === 'Space') {
      e.preventDefault()
      handlers.onSpace()
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      handlers.onDelete()
    }
  }

  onMount(() => {
    window.addEventListener('keydown', onKeyDown)
  })

  onCleanup(() => {
    window.removeEventListener('keydown', onKeyDown)
  })
}