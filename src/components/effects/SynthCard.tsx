import { type Component, createSignal, onCleanup } from 'solid-js'
import Synth, { type SynthParams } from '~/components/effects/Synth'

export type SynthCardProps = {
  params: SynthParams
  onChange: (updates: Partial<SynthParams>) => void
  onReset?: () => void
  x: number
  y: number
  w: number
  h: number
  onClose: () => void
  onChangeBounds: (next: { x: number; y: number; w: number; h: number }) => void
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

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

  const sanitizeBounds = (bounds: { x: number; y: number; w: number; h: number }) => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const minW = Math.max(360, Math.min(640, vw - 40))
    const minH = Math.max(320, Math.min(420, vh - 80))
    const maxW = Math.max(minW, vw - 12)
    const maxH = Math.max(minH, vh - 24)
    const w = clamp(bounds.w, minW, maxW)
    const h = clamp(bounds.h, minH, maxH)
    const maxX = Math.max(0, vw - w)
    const maxY = Math.max(0, vh - h)
    const x = clamp(bounds.x, 0, maxX)
    const y = clamp(bounds.y, 0, maxY)
    return { x, y, w, h }
  }

  const onHeaderPointerDown = (e: PointerEvent) => {
    if (pointerId !== null) return
    try { e.preventDefault(); e.stopPropagation() } catch {}
    if ((e as any).button != null && (e as any).button !== 0) return
    pointerId = e.pointerId
    dragStartX = e.clientX
    dragStartY = e.clientY
    startLeft = props.x
    startTop = props.y
    setDragging(true)
    captureEl = e.currentTarget as HTMLElement
    try { captureEl.setPointerCapture?.(e.pointerId) } catch {}
    window.addEventListener('pointermove', onPointerMove, { passive: false, capture: true })
    window.addEventListener('pointerup', onPointerUp, { once: true, passive: false, capture: true })
  }

  const onResizerPointerDown = (e: PointerEvent) => {
    if (pointerId !== null) return
    try { e.preventDefault(); e.stopPropagation() } catch {}
    if ((e as any).button != null && (e as any).button !== 0) return
    pointerId = e.pointerId
    dragStartX = e.clientX
    dragStartY = e.clientY
    resizeStartW = props.w
    resizeStartH = props.h
    setResizing(true)
    captureEl = e.currentTarget as HTMLElement
    try { captureEl.setPointerCapture?.(e.pointerId) } catch {}
    window.addEventListener('pointermove', onPointerMove, { passive: false, capture: true })
    window.addEventListener('pointerup', onPointerUp, { once: true, passive: false, capture: true })
  }

  const onPointerMove = (e: PointerEvent) => {
    try { e.preventDefault(); e.stopPropagation() } catch {}
    if (dragging()) {
      const dx = e.clientX - dragStartX
      const dy = e.clientY - dragStartY
      const next = sanitizeBounds({
        x: startLeft + dx,
        y: startTop + dy,
        w: props.w,
        h: props.h,
      })
      props.onChangeBounds(next)
    } else if (resizing()) {
      const dx = e.clientX - dragStartX
      const dy = e.clientY - dragStartY
      const next = sanitizeBounds({
        x: props.x,
        y: props.y,
        w: resizeStartW + dx,
        h: resizeStartH + dy,
      })
      props.onChangeBounds(next)
    }
  }

  const onPointerUp = (e: PointerEvent) => {
    dragging() && setDragging(false)
    resizing() && setResizing(false)
    if (pointerId !== null) {
      try { captureEl?.releasePointerCapture?.(pointerId) } catch {}
    }
    captureEl = null
    pointerId = null
    try { window.removeEventListener('pointermove', onPointerMove, { capture: true } as any) } catch {}
  }

  onCleanup(() => {
    try { window.removeEventListener('pointermove', onPointerMove, { capture: true } as any) } catch {}
  })

  return (
    <div
      class="fixed z-[9999] rounded-md border border-neutral-700 bg-neutral-900 shadow-xl overflow-hidden"
      style={{ left: `${props.x}px`, top: `${props.y}px`, width: `${props.w}px`, height: `${props.h}px` }}
      onPointerDown={(e) => { e.stopPropagation() }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
    >
      <div
        class="flex items-center justify-between px-3 py-2 bg-neutral-800 border-b border-neutral-700 cursor-move select-none"
        style={{ 'touch-action': 'none' }}
        onPointerDown={onHeaderPointerDown as any}
      >
        <div class="text-sm font-semibold text-neutral-200">Synth</div>
        <button
          class="text-neutral-300 hover:text-white rounded px-2 py-0.5 text-sm"
          onPointerDown={(e) => { e.stopPropagation() }}
          onClick={props.onClose}
          aria-label="Close Synth editor"
        >
          ✕
        </button>
      </div>
      <div class="p-2 w-full h-[calc(100%-36px)] overflow-hidden" style={{ 'touch-action': 'manipulation' }}>
        <Synth params={props.params} onChange={props.onChange} onReset={props.onReset} variant="expanded" class="min-w-[640px]" />
      </div>
      <div
        class="absolute right-1 bottom-1 w-4 h-4 cursor-se-resize rounded-sm bg-neutral-700/60 hover:bg-neutral-600/70"
        style={{ 'touch-action': 'none' }}
        onPointerDown={onResizerPointerDown as any}
        title="Resize"
      />
    </div>
  )
}

export default SynthCard
