import { type Component, createSignal, onCleanup } from 'solid-js'
import Synth from '~/components/effects/Synth'
import {
  clampSynthCardBounds,
  type SynthCardBounds,
} from '~/components/effects/synth-card-bounds'
import type { SynthParams } from '@daw-browser/shared'

type SynthCardProps = {
  params: SynthParams
  onChange: (updates: Partial<SynthParams>) => void
  onReset?: () => void
  x: number
  y: number
  w: number
  h: number
  onClose: () => void
  onChangeBounds: (next: SynthCardBounds) => void
}

type PointerMode = 'drag' | 'resize'

const SynthCard: Component<SynthCardProps> = (props) => {
  const [dragging, setDragging] = createSignal(false)
  const [resizing, setResizing] = createSignal(false)
  let pointerId: number | null = null
  let captureEl: HTMLElement | null = null
  let dragStartX = 0
  let dragStartY = 0
  let startLeft = 0
  let startTop = 0
  let resizeStartW = 0
  let resizeStartH = 0

  function beginPointerInteraction(e: PointerEvent, mode: PointerMode): void {
    if (pointerId !== null) return

    e.preventDefault()
    e.stopPropagation()

    if (e.button !== 0) return

    pointerId = e.pointerId
    dragStartX = e.clientX
    dragStartY = e.clientY
    captureEl = e.currentTarget as HTMLElement

    if (mode === 'drag') {
      startLeft = props.x
      startTop = props.y
      setDragging(true)
      return capturePointer(e)
    }

    resizeStartW = props.w
    resizeStartH = props.h
    setResizing(true)
    capturePointer(e)
  }

  function capturePointer(e: PointerEvent): void {
    try { captureEl?.setPointerCapture?.(e.pointerId) } catch {}
    window.addEventListener('pointermove', onPointerMove, { passive: false, capture: true })
    window.addEventListener('pointerup', onPointerUp, { once: true, passive: false, capture: true })
  }

  function onHeaderPointerDown(e: PointerEvent): void {
    beginPointerInteraction(e, 'drag')
  }

  function onResizerPointerDown(e: PointerEvent): void {
    beginPointerInteraction(e, 'resize')
  }

  function onPointerMove(e: PointerEvent): void {
    e.preventDefault()
    e.stopPropagation()

    const dx = e.clientX - dragStartX
    const dy = e.clientY - dragStartY

    if (dragging()) {
      props.onChangeBounds(clampSynthCardBounds({
        x: startLeft + dx,
        y: startTop + dy,
        w: props.w,
        h: props.h,
      }))
      return
    }

    if (resizing()) {
      props.onChangeBounds(clampSynthCardBounds({
        x: props.x,
        y: props.y,
        w: resizeStartW + dx,
        h: resizeStartH + dy,
      }))
    }
  }

  function onPointerUp(): void {
    if (dragging()) setDragging(false)
    if (resizing()) setResizing(false)
    if (pointerId !== null) {
      try { captureEl?.releasePointerCapture?.(pointerId) } catch {}
    }
    captureEl = null
    pointerId = null
    window.removeEventListener('pointermove', onPointerMove, { capture: true })
  }

  onCleanup(() => {
    window.removeEventListener('pointermove', onPointerMove, { capture: true })
  })

  return (
    <div
      class="fixed z-[9999] border border-neutral-700 bg-neutral-900 shadow-xl overflow-hidden"
      style={{ left: `${props.x}px`, top: `${props.y}px`, width: `${props.w}px`, height: `${props.h}px` }}
      onPointerDown={(e) => { e.stopPropagation() }}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
    >
      <div
        class="flex items-center justify-between px-3 py-2 bg-neutral-800 border-b border-neutral-700 cursor-move select-none"
        style={{ 'touch-action': 'none' }}
        onPointerDown={(e) => onHeaderPointerDown(e)}
      >
        <div class="text-sm font-semibold text-neutral-200">Synth</div>
        <button
          class="text-neutral-300 hover:text-white px-2 py-0.5 text-sm"
          onPointerDown={(e) => { e.stopPropagation() }}
          onClick={props.onClose}
          aria-label="Close Synth editor"
        >
          X
        </button>
      </div>
      <div class="w-full overflow-hidden p-2" style={{ height: 'calc(100% - 36px)', 'touch-action': 'manipulation' }}>
        <Synth params={props.params} onChange={props.onChange} onReset={props.onReset} variant="expanded" />
      </div>
      <div
        class="absolute right-1 bottom-1 w-4 h-4 cursor-se-resize bg-neutral-700/60 hover:bg-neutral-600/70"
        style={{ 'touch-action': 'none' }}
        onPointerDown={(e) => onResizerPointerDown(e)}
        title="Resize"
      />
    </div>
  )
}

export default SynthCard
