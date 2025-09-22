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
      e.stopPropagation()
      handlers.onSpace()
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      handlers.onDelete()
    }
  }

  onMount(() => {
    window.addEventListener('keydown', onKeyDown, { capture: true })
  })

  onCleanup(() => {
    window.removeEventListener('keydown', onKeyDown, { capture: true } as EventListenerOptions)
  })
}