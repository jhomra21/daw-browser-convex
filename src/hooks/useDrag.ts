import { createSignal, onCleanup } from 'solid-js'

type Point = { x: number; y: number }

export type UseDragOptions = {
  onDragStart?: (pos: Point, event: PointerEvent) => void | Promise<void>
  onDragMove?: (pos: Point, event: PointerEvent) => void | Promise<void>
  onDragEnd?: (pos: Point, event: PointerEvent) => void | Promise<void>
  disabled?: () => boolean
}

export function useDrag(options: UseDragOptions = {}) {
  const [isDragging, setIsDragging] = createSignal(false)
  let activePointerId: number | null = null

  const getPointerPos = (event: PointerEvent): Point => ({
    x: event.clientX,
    y: event.clientY,
  })

  const removeGlobalListeners = () => {
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
    window.removeEventListener('pointercancel', handlePointerUp)
    document.body.classList.remove('select-none')
  }

  const cancelDrag = () => {
    activePointerId = null
    setIsDragging(false)
    removeGlobalListeners()
  }

  const handlePointerMove = (event: PointerEvent) => {
    if (activePointerId !== null && event.pointerId !== activePointerId) return
    void options.onDragMove?.(getPointerPos(event), event)
  }

  const handlePointerUp = (event: PointerEvent) => {
    if (activePointerId !== null && event.pointerId !== activePointerId) return
    activePointerId = null
    setIsDragging(false)
    removeGlobalListeners()
    void options.onDragEnd?.(getPointerPos(event), event)
  }

  const onPointerDown = (event: PointerEvent) => {
    if (options.disabled?.()) return
    event.preventDefault()
    ;(event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
    activePointerId = event.pointerId
    setIsDragging(true)
    document.body.classList.add('select-none')
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    void options.onDragStart?.(getPointerPos(event), event)
  }

  onCleanup(cancelDrag)

  return {
    isDragging,
    onPointerDown,
    cancelDrag,
  }
}
