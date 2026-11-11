import type { Accessor } from 'solid-js'
import { TIMELINE_SIDEBAR_MIN_WIDTH } from '~/lib/timeline-layout'
import { useDrag } from '~/hooks/useDrag'

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
  let resizeStartX = 0
  let resizeStartWidth = 0

  const drag = useDrag({
    onDragStart: (pos) => {
      resizeStartX = pos.x
      resizeStartWidth = options.sidebarWidth()
    },
    onDragMove: (pos) => {
      const containerWidth = options.getContainerElement()?.clientWidth ?? 0
      const delta = resizeStartX - pos.x
      const maxWidth = Math.floor(containerWidth * 0.7)
      options.setSidebarWidth(Math.max(TIMELINE_SIDEBAR_MIN_WIDTH, Math.min(maxWidth, resizeStartWidth + delta)))
    },
    onDragCancel: () => options.setSidebarWidth(resizeStartWidth),
  })

  return {
    onSidebarPointerDown: drag.onPointerDown,
  }
}
