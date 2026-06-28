import { createSignal, onCleanup } from 'solid-js'

type Point = { x: number; y: number }

type UseDragOptions = {
  onDragStart?: (pos: Point, event: PointerEvent) => void | Promise<void>
  onDragMove?: (pos: Point, event: PointerEvent) => void | Promise<void>
  onDragEnd?: (pos: Point, event: PointerEvent) => void | Promise<void>
  onDragCancel?: (pos: Point, event: PointerEvent) => void | Promise<void>
  disabled?: () => boolean
  dragCursorClass?: string
  preventDefaultOnPointerDown?: boolean
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
    window.removeEventListener('pointerup', handlePointerUp, { capture: true })
    window.removeEventListener('pointercancel', handlePointerCancel, { capture: true })
    document.body.classList.remove('select-none')
    if (options.dragCursorClass) document.body.classList.remove(options.dragCursorClass)
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

  const finishDrag = (event: PointerEvent, callback: UseDragOptions['onDragEnd']) => {
    if (activePointerId !== null && event.pointerId !== activePointerId) return
    activePointerId = null
    setIsDragging(false)
    removeGlobalListeners()
    void callback?.(getPointerPos(event), event)
  }

  const handlePointerUp = (event: PointerEvent) => finishDrag(event, options.onDragEnd)

  const handlePointerCancel = (event: PointerEvent) => finishDrag(event, options.onDragCancel)

  const onPointerDown = (event: PointerEvent) => {
    if (options.disabled?.()) return
    if (options.preventDefaultOnPointerDown !== false) event.preventDefault()
    ;(event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
    activePointerId = event.pointerId
    setIsDragging(true)
    document.body.classList.add('select-none')
    if (options.dragCursorClass) document.body.classList.add(options.dragCursorClass)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp, { capture: true })
    window.addEventListener('pointercancel', handlePointerCancel, { capture: true })
    void options.onDragStart?.(getPointerPos(event), event)
  }

  onCleanup(cancelDrag)

  return {
    isDragging,
    onPointerDown,
    cancelDrag,
  }
}
