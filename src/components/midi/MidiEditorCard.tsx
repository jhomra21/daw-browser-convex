import { type Component, createSignal, onCleanup, createEffect } from 'solid-js'
import { convexClient, convexApi } from '~/lib/convex'
import type { Clip } from '~/types/timeline'

export type MidiEditorCardProps = {
  clipId: string
  bpm: number
  x: number
  y: number
  w: number
  h: number
  onClose: () => void
  onChangeBounds: (next: { x: number; y: number; w: number; h: number }) => void
  midi?: Clip['midi']
  userId?: string
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

const MidiEditorCard: Component<MidiEditorCardProps> = (props) => {
  const [dragging, setDragging] = createSignal(false)
  const [resizing, setResizing] = createSignal(false)
  const [notes, setNotes] = createSignal<Array<{ beat: number; length: number; pitch: number; velocity?: number }>>([])
  const [cols] = createSignal(16)
  const [rows] = createSignal(12)
  let dragStartX = 0
  let dragStartY = 0
  let startLeft = 0
  let startTop = 0
  let resizeStartW = 0
  let resizeStartH = 0
  let pointerId: number | null = null
  let saveTimer: number | null = null
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = window.setTimeout(async () => {
      try {
        const midi = {
          wave: props.midi?.wave ?? 'sawtooth',
          gain: props.midi?.gain ?? 0.8,
          notes: notes().slice().sort((a, b) => a.beat - b.beat || b.pitch - a.pitch),
        }
        if (!props.userId) return
        await convexClient.mutation((convexApi as any).clips.setMidi, { clipId: props.clipId as any, midi, userId: props.userId })
      } catch {}
    }, 200)
  }

  const onHeaderPointerDown = (e: PointerEvent) => {
    if (pointerId !== null) return
    pointerId = e.pointerId
    dragStartX = e.clientX
    dragStartY = e.clientY
    startLeft = props.x
    startTop = props.y
    setDragging(true)
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch {}
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
  }

  const onResizerPointerDown = (e: PointerEvent) => {
    if (pointerId !== null) return
    pointerId = e.pointerId
    dragStartX = e.clientX
    dragStartY = e.clientY
    resizeStartW = props.w
    resizeStartH = props.h
    setResizing(true)
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch {}
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
  }

  const onPointerMove = (e: PointerEvent) => {
    if (dragging()) {
      const dx = e.clientX - dragStartX
      const dy = e.clientY - dragStartY
      const next = { x: clamp(startLeft + dx, 0, window.innerWidth - 80), y: clamp(startTop + dy, 0, window.innerHeight - 80), w: props.w, h: props.h }
      props.onChangeBounds(next)
    } else if (resizing()) {
      const dx = e.clientX - dragStartX
      const dy = e.clientY - dragStartY
      const nextW = clamp(resizeStartW + dx, 320, window.innerWidth)
      const nextH = clamp(resizeStartH + dy, 200, window.innerHeight)
      props.onChangeBounds({ x: props.x, y: props.y, w: nextW, h: nextH })
    }
  }

  const onPointerUp = (_e: PointerEvent) => {
    dragging() && setDragging(false)
    resizing() && setResizing(false)
    pointerId = null
    try { window.removeEventListener('pointermove', onPointerMove) } catch {}
  }

  onCleanup(() => {
    try { window.removeEventListener('pointermove', onPointerMove) } catch {}
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  })

  // Sync incoming midi
  createEffect(() => {
    const m = props.midi
    if (m && Array.isArray(m.notes)) {
      setNotes(m.notes.slice())
    } else {
      setNotes([])
    }
  })

  // Helpers to compute grid cell from pointer
  const pointToCell = (container: HTMLElement, e: MouseEvent | PointerEvent) => {
    const rect = container.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top))
    const c = Math.floor((x / Math.max(1, rect.width)) * cols())
    const r = Math.floor((y / Math.max(1, rect.height)) * rows())
    return { col: Math.max(0, Math.min(cols() - 1, c)), row: Math.max(0, Math.min(rows() - 1, r)) }
  }

  // Simple click-to-toggle note (length=1 beat)
  let gridRef: HTMLDivElement | undefined
  const basePitch = 72 // top row
  const onGridClick = (e: MouseEvent) => {
    const el = gridRef; if (!el) return
    const { col, row } = pointToCell(el, e)
    const pitch = basePitch - row
    const existingIdx = notes().findIndex(n => n.beat === col && n.pitch === pitch)
    if (existingIdx >= 0) {
      setNotes(prev => prev.filter((_, i) => i !== existingIdx))
    } else {
      setNotes(prev => [...prev, { beat: col, length: 1, pitch, velocity: 0.9 }])
    }
    scheduleSave()
  }

  // Drag to move/resize notes
  type DragState = { idx: number; mode: 'move' | 'resize'; startBeat: number; startPitch: number; startLength: number; startCol: number }
  let dragNote: DragState | null = null
  const onNotePointerDown = (idx: number) => (e: PointerEvent) => {
    e.stopPropagation()
    const n = notes()[idx]; if (!n) return
    const el = gridRef; if (!el) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const nearRight = (e.clientX - rect.left) > rect.width * 0.7
    const { col } = pointToCell(el, e)
    dragNote = { idx, mode: nearRight ? 'resize' : 'move', startBeat: n.beat, startPitch: n.pitch, startLength: n.length, startCol: col }
    window.addEventListener('pointermove', onNotePointerMove)
    window.addEventListener('pointerup', onNotePointerUp, { once: true })
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch {}
  }
  const onNotePointerMove = (e: PointerEvent) => {
    if (!dragNote) return
    const el = gridRef; if (!el) return
    const { col, row } = pointToCell(el, e)
    setNotes(prev => prev.map((nn, i) => {
      if (i !== dragNote!.idx) return nn
      if (dragNote!.mode === 'move') {
        const pitch = basePitch - row
        const nextBeat = Math.max(0, Math.min(cols() - 1, col))
        return { ...nn, beat: nextBeat, pitch }
      } else {
        const deltaCols = Math.max(1, col - dragNote!.startCol + 1)
        return { ...nn, length: deltaCols }
      }
    }))
  }
  const onNotePointerUp = (_e: PointerEvent) => {
    scheduleSave()
    dragNote = null
    try { window.removeEventListener('pointermove', onNotePointerMove) } catch {}
  }

  return (
    <div
      class="absolute z-50 rounded-md border border-neutral-700 bg-neutral-900 shadow-xl overflow-hidden"
      style={{ left: `${props.x}px`, top: `${props.y}px`, width: `${props.w}px`, height: `${props.h}px` }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* Header: draggable */}
      <div
        class="flex items-center justify-between px-3 py-2 bg-neutral-800 border-b border-neutral-700 cursor-move select-none"
        onPointerDown={onHeaderPointerDown as any}
      >
        <div class="flex items-center gap-2 text-sm font-semibold text-neutral-200">
          <span>MIDI Editor</span>
          <span class="text-neutral-400">•</span>
          <span class="text-neutral-300 text-xs">Clip: {props.clipId.slice(0, 8)}</span>
          <span class="text-neutral-500 text-xs">BPM: {props.bpm}</span>
        </div>
        <button
          class="text-neutral-300 hover:text-white rounded px-2 py-0.5 text-sm"
          onPointerDown={(e) => { e.stopPropagation() }}
          onClick={props.onClose}
          aria-label="Close MIDI editor"
        >
          ✕
        </button>
      </div>

      {/* Body: simple MIDI grid */}
      <div class="relative w-full h-[calc(100%-36px)]">
        <div class="absolute inset-0 bg-neutral-900" ref={(el) => (gridRef = el || undefined)} onClick={onGridClick}>
          <div class="w-full h-full grid" style={{ 'grid-template-rows': `repeat(${rows()}, minmax(0, 1fr))`, 'grid-template-columns': `repeat(${cols()}, minmax(0, 1fr))` }}>
            {[...Array(rows() * cols())].map((_, i) => (
              <div class={`border ${i % cols() === 0 ? 'border-neutral-700' : 'border-neutral-800'}`} />
            ))}
          </div>
          {/* Notes overlay */}
          <div class="absolute inset-0 pointer-events-none">
            {notes().map((n, idx) => (
              <div
                class="absolute rounded-sm bg-green-500/70 border border-green-400/80 pointer-events-auto"
                style={{
                  left: `${(n.beat / cols()) * 100}%`,
                  top: `${((basePitch - n.pitch) / rows()) * 100}%`,
                  width: `${Math.max(1 / cols(), (n.length / cols())) * 100}%`,
                  height: `${(1 / rows()) * 100}%`,
                  cursor: 'grab',
                }}
                onPointerDown={onNotePointerDown(idx) as any}
              />
            ))}
          </div>
        </div>
        {/* Bottom-right resizer */}
        <div
          class="absolute right-1 bottom-1 w-4 h-4 cursor-se-resize rounded-sm bg-neutral-700/60 hover:bg-neutral-600/70"
          onPointerDown={onResizerPointerDown as any}
          title="Resize"
        />
      </div>
    </div>
  )
}

export default MidiEditorCard
