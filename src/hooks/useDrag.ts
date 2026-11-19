import { createSignal, onCleanup } from 'solid-js'

type Point = { x: number; y: number }
type DragCancelReason = 'cancel' | 'dispose'

type UseDragOptions = {
  onDragStart?: (pos: Point, event: PointerEvent) => void | Promise<void>
  onDragMove?: (pos: Point, event: PointerEvent) => void | Promise<void>
  onDragEnd?: (pos: Point, event: PointerEvent) => void | Promise<void>
  /** Pointer cancel, Escape, window blur, or losing pointer capture abandons the gesture. */
  onDragCancel?: (reason: DragCancelReason) => void | Promise<void>
  disabled?: () => boolean
  dragCursorClass?: string
  preventDefaultOnPointerDown?: boolean
}

export function useDrag(options: UseDragOptions = {}) {
  const [isDragging, setIsDragging] = createSignal(false)
  let activePointerId: number | null = null
  let captureTarget: HTMLElement | null = null

  const getPointerPos = (event: PointerEvent): Point => ({
    x: event.clientX,
    y: event.clientY,
  })

  const removeGlobalListeners = () => {
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp, { capture: true })
    window.removeEventListener('pointercancel', handlePointerCancel, { capture: true })
    window.removeEventListener('keydown', handleKeyDown, { capture: true })
    window.removeEventListener('blur', handleWindowBlur)
    captureTarget?.removeEventListener('lostpointercapture', handleLostPointerCapture)
    captureTarget = null
    document.body.classList.remove('select-none')
    if (options.dragCursorClass) document.body.classList.remove(options.dragCursorClass)
  }

  const cancelDrag = () => {
    activePointerId = null
    setIsDragging(false)
    removeGlobalListeners()
  }

  const abortDrag = (reason: DragCancelReason = 'cancel') => {
    const pointerId = activePointerId
    if (pointerId === null) return
    const target = captureTarget
    cancelDrag()
    if (pointerId !== null && target?.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId)
    }
    void options.onDragCancel?.(reason)
  }

  const handleWindowBlur = () => abortDrag()

  const isForeignPointer = (event: PointerEvent) => activePointerId !== null && event.pointerId !== activePointerId

  const handlePointerMove = (event: PointerEvent) => {
    if (isForeignPointer(event)) return
    void options.onDragMove?.(getPointerPos(event), event)
  }

  const handlePointerUp = (event: PointerEvent) => {
    if (isForeignPointer(event)) return
    cancelDrag()
    void options.onDragEnd?.(getPointerPos(event), event)
  }

  const handlePointerCancel = (event: PointerEvent) => {
    if (!isForeignPointer(event)) abortDrag()
  }

  const handleLostPointerCapture = (event: PointerEvent) => {
    if (!isForeignPointer(event)) abortDrag()
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    abortDrag()
  }

  const onPointerDown = (event: PointerEvent) => {
    if (options.disabled?.()) return
    if (activePointerId !== null) return
    if (options.preventDefaultOnPointerDown !== false) event.preventDefault()
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture(event.pointerId)
      captureTarget = event.currentTarget
      captureTarget.addEventListener('lostpointercapture', handleLostPointerCapture)
    }
    activePointerId = event.pointerId
    setIsDragging(true)
    document.body.classList.add('select-none')
    if (options.dragCursorClass) document.body.classList.add(options.dragCursorClass)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp, { capture: true })
    window.addEventListener('pointercancel', handlePointerCancel, { capture: true })
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    window.addEventListener('blur', handleWindowBlur)
    void options.onDragStart?.(getPointerPos(event), event)
  }

  onCleanup(() => {
    if (activePointerId !== null) abortDrag('dispose')
    else cancelDrag()
  })

  return {
    isDragging,
    onPointerDown,
    cancelDrag,
    abortDrag,
  }
}
