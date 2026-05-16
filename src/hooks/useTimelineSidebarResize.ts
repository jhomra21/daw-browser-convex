import type { Accessor } from 'solid-js'
import { onCleanup } from 'solid-js'
import { TIMELINE_SIDEBAR_MIN_WIDTH } from '~/lib/timeline-layout'

type UseTimelineSidebarResizeOptions = {
  sidebarWidth: Accessor<number>
  setSidebarWidth: (value: number) => void
  getContainerElement: () => HTMLDivElement | undefined
}

type UseTimelineSidebarResizeReturn = {
  onSidebarPointerDown: (event: PointerEvent) => void
}

export function useTimelineSidebarResize(
  options: UseTimelineSidebarResizeOptions,
): UseTimelineSidebarResizeReturn {
  let resizing = false
  let resizeStartX = 0
  let resizeStartWidth = 0

  function onSidebarPointerMove(event: PointerEvent): void {
    if (!resizing) return
    const containerWidth = options.getContainerElement()?.clientWidth ?? 0
    const delta = resizeStartX - event.clientX
    const maxWidth = Math.floor(containerWidth * 0.7)
    const nextWidth = Math.max(TIMELINE_SIDEBAR_MIN_WIDTH, Math.min(maxWidth, resizeStartWidth + delta))
    options.setSidebarWidth(nextWidth)
  }

  function onSidebarPointerUp(): void {
    resizing = false
    window.removeEventListener('pointermove', onSidebarPointerMove)
    window.removeEventListener('pointerup', onSidebarPointerUp)
    window.removeEventListener('pointercancel', onSidebarPointerUp)
  }

  function onSidebarPointerDown(event: PointerEvent): void {
    event.preventDefault()
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    resizing = true
    resizeStartX = event.clientX
    resizeStartWidth = options.sidebarWidth()
    window.addEventListener('pointermove', onSidebarPointerMove)
    window.addEventListener('pointerup', onSidebarPointerUp)
    window.addEventListener('pointercancel', onSidebarPointerUp)
  }

  onCleanup(() => {
    window.removeEventListener('pointermove', onSidebarPointerMove)
    window.removeEventListener('pointerup', onSidebarPointerUp)
    window.removeEventListener('pointercancel', onSidebarPointerUp)
  })

  return {
    onSidebarPointerDown,
  }
}
