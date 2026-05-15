import type { Accessor } from 'solid-js'
import { onCleanup } from 'solid-js'

type UseTimelineSidebarResizeOptions = {
  sidebarWidth: Accessor<number>
  setSidebarWidth: (value: number) => void
  getContainerElement: () => HTMLDivElement | undefined
}

type UseTimelineSidebarResizeReturn = {
  onSidebarMouseDown: (event: MouseEvent) => void
}

export function useTimelineSidebarResize(
  options: UseTimelineSidebarResizeOptions,
): UseTimelineSidebarResizeReturn {
  let resizing = false
  let resizeStartX = 0
  let resizeStartWidth = 0

  function onSidebarMouseMove(event: MouseEvent): void {
    if (!resizing) return
    const containerWidth = options.getContainerElement()?.clientWidth ?? 0
    const delta = resizeStartX - event.clientX
    const minWidth = 320
    const maxWidth = Math.floor(containerWidth * 0.7)
    const nextWidth = Math.max(minWidth, Math.min(maxWidth, resizeStartWidth + delta))
    options.setSidebarWidth(nextWidth)
  }

  function onSidebarMouseUp(): void {
    resizing = false
    window.removeEventListener('mousemove', onSidebarMouseMove)
    window.removeEventListener('mouseup', onSidebarMouseUp)
  }

  function onSidebarMouseDown(event: MouseEvent): void {
    event.preventDefault()
    resizing = true
    resizeStartX = event.clientX
    resizeStartWidth = options.sidebarWidth()
    window.addEventListener('mousemove', onSidebarMouseMove)
    window.addEventListener('mouseup', onSidebarMouseUp)
  }

  onCleanup(() => {
    window.removeEventListener('mousemove', onSidebarMouseMove)
    window.removeEventListener('mouseup', onSidebarMouseUp)
  })

  return {
    onSidebarMouseDown,
  }
}
