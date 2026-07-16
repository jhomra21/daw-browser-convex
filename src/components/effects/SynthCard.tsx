import { type Component, createSignal, onCleanup, onMount } from 'solid-js'
import Synth from '~/components/effects/Synth'
import {
  clampSynthCardBounds,
  type SynthCardBounds,
} from '~/components/effects/synth-card-bounds'
import type { SynthAutomationParameterId, SynthParams, SynthParamsUpdate } from '@daw-browser/shared'

type SynthCardProps = {
  params: SynthParams
  onChange: (updates: SynthParamsUpdate) => void
  onReset?: () => void
  x: number
  y: number
  w: number
  h: number
  onClose: () => void
  onChangeBounds: (next: SynthCardBounds) => void
  automationRangesByParameterId?: ReadonlyMap<string, { min: number; max: number }>
  onAutomationParameterTouch?: (parameterId: SynthAutomationParameterId) => void
  onManualAutomationOverride?: (parameterId: SynthAutomationParameterId) => void
}

type PointerMode = 'drag' | 'resize'

const SynthCard: Component<SynthCardProps> = (props) => {
  const [dragging, setDragging] = createSignal(false)
  let pointerId: number | null = null
  let captureEl: HTMLElement | null = null
  let dragStartX = 0
  let dragStartY = 0
  let startLeft = 0
  let startTop = 0
  let resizeStartW = 0
  let resizeStartH = 0

  function endPointerInteraction(event?: PointerEvent): void {
    if (event && event.pointerId !== pointerId) return
    if (pointerId !== null) {
      try {
        captureEl?.releasePointerCapture(pointerId)
      } catch {}
    }
    setDragging(false)
    pointerId = null
    captureEl = null
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerup', endPointerInteraction, true)
    window.removeEventListener('pointercancel', endPointerInteraction, true)
    window.removeEventListener('blur', handleWindowBlur)
  }

  function beginPointerInteraction(e: PointerEvent, mode: PointerMode): void {
    if (pointerId !== null) return

    e.preventDefault()
    e.stopPropagation()

    if (e.button !== 0) return
    if (!(e.currentTarget instanceof HTMLElement)) return

    pointerId = e.pointerId
    dragStartX = e.clientX
    dragStartY = e.clientY
    captureEl = e.currentTarget

    if (mode === 'drag') {
      startLeft = props.x
      startTop = props.y
      setDragging(true)
      capturePointer(e)
      return
    }

    resizeStartW = props.w
    resizeStartH = props.h
    capturePointer(e)
  }

  function capturePointer(e: PointerEvent): void {
    try { captureEl?.setPointerCapture(e.pointerId) } catch {}
    window.addEventListener('pointermove', onPointerMove, { passive: false, capture: true })
    window.addEventListener('pointerup', endPointerInteraction, { capture: true })
    window.addEventListener('pointercancel', endPointerInteraction, { capture: true })
    window.addEventListener('blur', handleWindowBlur)
  }

  function onHeaderPointerDown(e: PointerEvent): void {
    beginPointerInteraction(e, 'drag')
  }

  function onResizerPointerDown(e: PointerEvent): void {
    beginPointerInteraction(e, 'resize')
  }

  function onPointerMove(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return
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

    props.onChangeBounds(clampSynthCardBounds({
      x: props.x,
      y: props.y,
      w: resizeStartW + dx,
      h: resizeStartH + dy,
    }))
  }

  function handleWindowBlur(): void {
    endPointerInteraction()
  }

  onMount(() => {
    const reclampBounds = () => props.onChangeBounds(clampSynthCardBounds({
      x: props.x,
      y: props.y,
      w: props.w,
      h: props.h,
    }))
    window.addEventListener('resize', reclampBounds)
    onCleanup(() => window.removeEventListener('resize', reclampBounds))
  })
  onCleanup(endPointerInteraction)

  return (
    <div
      class="fixed z-[9999] flex flex-col border border-border bg-app-surface shadow-xl overflow-hidden"
      style={{ left: `${props.x}px`, top: `${props.y}px`, width: `${props.w}px`, height: `${props.h}px` }}
      onPointerDown={(e) => { e.stopPropagation() }}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
    >
      <div
        class="flex items-center justify-between px-3 py-2 bg-muted border-b border-border cursor-move select-none"
        style={{ 'touch-action': 'none' }}
        onPointerDown={(e) => onHeaderPointerDown(e)}
        onLostPointerCapture={endPointerInteraction}
      >
        <div class="text-sm font-semibold text-foreground">Synth</div>
        <button
          class="text-muted-foreground hover:text-foreground px-2 py-0.5 text-sm"
          onPointerDown={(e) => { e.stopPropagation() }}
          onClick={() => {
            endPointerInteraction()
            props.onClose()
          }}
          aria-label="Close Synth editor"
        >
          X
        </button>
      </div>
      <div class="min-h-0 w-full flex-1 overflow-auto p-2" style={{ 'touch-action': 'manipulation' }}>
        <Synth params={props.params} onChange={props.onChange} onReset={props.onReset} variant="expanded" automationRangesByParameterId={props.automationRangesByParameterId} onAutomationParameterTouch={props.onAutomationParameterTouch} onManualAutomationOverride={props.onManualAutomationOverride} />
      </div>
      <div
        class="absolute right-1 bottom-1 w-4 h-4 cursor-se-resize bg-secondary/60 hover:bg-secondary/70"
        style={{ 'touch-action': 'none' }}
        onPointerDown={(e) => onResizerPointerDown(e)}
        onLostPointerCapture={endPointerInteraction}
        title="Resize"
      />
    </div>
  )
}

export default SynthCard
