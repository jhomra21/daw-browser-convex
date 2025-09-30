import { type Component, createSignal, onCleanup, createEffect, For } from 'solid-js'
import { convexClient, convexApi } from '~/lib/convex'
import type { Clip } from '~/types/timeline'

export type MidiEditorCardProps = {
  clipId: string
  bpm: number
  // Align grid to timeline
  gridDenominator: number
  // Clip window to size grid to
  clipDurationSec: number
  x: number
  y: number
  w: number
  h: number
  onClose: () => void
  onChangeBounds: (next: { x: number; y: number; w: number; h: number }) => void
  midi?: Clip['midi']
  userId?: string
  // Optional: preview note when adding/dragging
  onAuditionNote?: (pitch: number, velocity?: number, durSec?: number) => void
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

const MidiEditorCard: Component<MidiEditorCardProps> = (props) => {
  const [dragging, setDragging] = createSignal(false)
  const [resizing, setResizing] = createSignal(false)
  const [notes, setNotes] = createSignal<Array<{ beat: number; length: number; pitch: number; velocity?: number }>>([])
  // Grid derived from BPM/denominator/clip length
  const stepsPerBeat = () => Math.max(1, Math.round((props.gridDenominator || 4) / 4))
  const secondsPerBeat = () => 60 / Math.max(1e-6, props.bpm || 120)
  const clipBeats = () => Math.max(1 / stepsPerBeat(), (props.clipDurationSec || 1) / secondsPerBeat())
  const cols = () => Math.max(stepsPerBeat(), Math.ceil(clipBeats() * stepsPerBeat()))
  // Full piano range C0..C8 (MIDI 12..108 inclusive)
  const minPitch = 12
  const maxPitch = 108
  const rows = () => (maxPitch - minPitch + 1) // 97 rows
  const topPitch = () => maxPitch
  const rowPx = 20
  const contentHeightPx = () => rows() * rowPx
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
    try { (e as any).preventDefault?.() } catch {}
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
  let scrollerRef: HTMLDivElement | undefined
  const pointToCell = (container: HTMLElement, e: MouseEvent | PointerEvent) => {
    const rect = container.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
    // gridRef moves with scrolling, so rect.top already accounts for scroll.
    const yInContent = e.clientY - rect.top
    const yWithin = Math.max(0, Math.min(contentHeightPx() - 1, yInContent))
    const c = Math.floor((x / Math.max(1, rect.width)) * cols())
    const r = Math.floor(yWithin / rowPx)
    return { col: Math.max(0, Math.min(cols() - 1, c)), row: Math.max(0, Math.min(rows() - 1, r)) }
  }

  // Simple click-to-toggle note (length=1 grid step => fractional beat)
  let gridRef: HTMLDivElement | undefined
  // Top row is highest pitch (C8), bottom is C0
  const noteName = (midi: number) => {
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'] as const
    const name = names[((midi % 12) + 12) % 12]
    const octave = Math.floor(midi / 12) - 1
    return `${name}${octave}`
  }
  const isBlackKey = (midi: number) => {
    const n = ((midi % 12) + 12) % 12
    return n === 1 || n === 3 || n === 6 || n === 8 || n === 10
  }
  const onGridClick = (e: MouseEvent | PointerEvent) => {
    if (dragNote) { e.preventDefault(); return }
    if ((e as PointerEvent).button != null && (e as PointerEvent).button !== 0) return
    const t = e.target as HTMLElement | null
    if (t && t.closest('[data-midi-note="1"]')) return
    const el = gridRef; if (!el) return
    const { col, row } = pointToCell(el, e)
    const pitch = Math.max(minPitch, Math.min(maxPitch, topPitch() - row))
    const beat = col / stepsPerBeat()
    const EPS = 1e-6
    const existingIdx = notes().findIndex(n => Math.abs(n.beat - beat) < EPS && n.pitch === pitch)
    if (existingIdx >= 0) {
      setNotes(prev => prev.filter((_, i) => i !== existingIdx))
    } else {
      const lengthBeats = 1 / stepsPerBeat()
      const velocity = 0.9
      setNotes(prev => [...prev, { beat, length: lengthBeats, pitch, velocity }])
      // Audition new note
      props.onAuditionNote?.(pitch, velocity, Math.min(0.5, lengthBeats * secondsPerBeat()))
    }
    scheduleSave()
  }

  // Drag to move/resize notes
  type DragState = {
    idx: number;
    mode: 'move' | 'resize';
    startBeat: number;
    startPitch: number;
    startLength: number;
    startCol: number;
    grabOffsetSteps: number; // integer fallback
    startStep: number;
    // pixel-stable dragging helpers
    stepWidthPx: number;
    grabOffsetStepsF: number;
    startPointerStepF: number;
    startRow: number;
    started: boolean;
  }
  let dragNote: DragState | null = null
  const onNotePointerDown = (idx: number) => (e: PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    // If this is a double-click, don't start dragging; deletion is handled by onDblClick
    if ((e as unknown as MouseEvent).detail && (e as unknown as MouseEvent).detail >= 2) {
      return
    }
    const n = notes()[idx]; if (!n) return
    const el = gridRef; if (!el) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const nearRight = (e.clientX - rect.left) > rect.width * 0.7
    const { col } = pointToCell(el, e)
    const startStep = Math.round(n.beat * stepsPerBeat())
    const containerRect = el.getBoundingClientRect()
    const stepWidthPx = Math.max(1e-6, containerRect.width / cols())
    const pointerStepF = (e.clientX - containerRect.left) / stepWidthPx
    const grabOffsetSteps = col - startStep
    const grabOffsetStepsF = pointerStepF - (n.beat * stepsPerBeat())
    dragNote = {
      idx,
      mode: nearRight ? 'resize' : 'move',
      startBeat: n.beat,
      startPitch: n.pitch,
      startLength: n.length,
      startCol: col,
      grabOffsetSteps,
      startStep,
      stepWidthPx,
      grabOffsetStepsF,
      startPointerStepF: pointerStepF,
      startRow: Math.round((topPitch() - n.pitch)),
      started: false,
    }
    window.addEventListener('pointermove', onNotePointerMove)
    window.addEventListener('pointerup', onNotePointerUp, { once: true })
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch {}
    // Audition on drag start
    const dur = Math.min(0.6, Math.max(0.05, n.length * secondsPerBeat()))
    props.onAuditionNote?.(n.pitch, n.velocity ?? 0.9, dur)
  }
  const onNotePointerMove = (e: PointerEvent) => {
    if (!dragNote) return
    const el = gridRef; if (!el) return
    const { col, row } = pointToCell(el, e)
    setNotes(prev => prev.map((nn, i) => {
      if (i !== dragNote!.idx) return nn
      if (dragNote!.mode === 'move') {
        const pitch = Math.max(minPitch, Math.min(maxPitch, topPitch() - row))
        // Pixel-stable step under pointer
        const containerRect = el.getBoundingClientRect()
        const stepW = dragNote!.stepWidthPx || Math.max(1e-6, containerRect.width / cols())
        const pointerStepF = (e.clientX - containerRect.left) / stepW
        const newStepF = pointerStepF - dragNote!.grabOffsetStepsF
        // Deadzone: wait until movement exceeds small threshold to avoid initial jump
        const stepDelta = Math.abs(pointerStepF - dragNote!.startPointerStepF)
        const rowDelta = Math.abs(row - dragNote!.startRow)
        if (!dragNote!.started && stepDelta < 0.25 && rowDelta < 0.5) {
          return nn
        }
        dragNote!.started = true
        const newStep = Math.max(0, Math.min(cols() - 1, Math.round(newStepF)))
        const nextBeat = newStep / stepsPerBeat()
        return { ...nn, beat: nextBeat, pitch }
      } else {
        const deltaSteps = Math.max(1, col - dragNote!.startCol + 1)
        const nextLen = Math.max(1 / stepsPerBeat(), deltaSteps / stepsPerBeat())
        return { ...nn, length: nextLen }
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
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
    >
      {/* Header: draggable */}
      <div
        class="flex items-center justify-between px-3 py-2 bg-neutral-800 border-b border-neutral-700 cursor-move select-none"
        onPointerDown={onHeaderPointerDown as any}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
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

      {/* Body: piano gutter + grid */}
      <div class="relative w-full h-[calc(100%-36px)]">
        <div class="absolute inset-0 grid overflow-y-auto" style={{ 'grid-template-columns': '44px 1fr' }} ref={(el) => (scrollerRef = el || undefined)}>
          {/* Piano gutter */}
          <div class="bg-neutral-900 border-r border-neutral-800 select-none">
            <div class="grid w-full" style={{ 'grid-template-rows': `repeat(${rows()}, ${rowPx}px)` }}>
              <For each={[...Array(rows()).keys()]}> 
                {(r) => {
                  const pitch = Math.max(minPitch, Math.min(maxPitch, topPitch() - r))
                  const black = isBlackKey(pitch)
                  return (
                    <div
                      class={`relative flex items-center justify-center text-[10px] font-mono ${black ? 'bg-neutral-700/70 text-neutral-100' : 'bg-neutral-800/70 text-neutral-200'} border-b border-neutral-800 cursor-pointer`}
                      onPointerDown={(e) => { e.stopPropagation(); props.onAuditionNote?.(pitch, 0.9, Math.min(0.6, secondsPerBeat())) }}
                      title={noteName(pitch)}
                    >
                      <span class="opacity-80">{noteName(pitch)}</span>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
          {/* Grid area */}
          <div class="relative bg-neutral-900" ref={(el) => (gridRef = el || undefined)} onPointerDown={onGridClick as any}>
            <div class="w-full grid" style={{ 'grid-template-rows': `repeat(${rows()}, ${rowPx}px)`, 'grid-template-columns': `repeat(${cols()}, minmax(0, 1fr))` }}>
              {[...Array(rows() * cols())].map((_, i) => {
                const colIdx = i % cols()
                const major = (colIdx % (stepsPerBeat() * 4)) === 0
                return <div class={`border ${major ? 'border-neutral-700' : 'border-neutral-800'}`} />
              })}
            </div>
            {/* Notes overlay (scrolls with content) */}
            <div class="absolute left-0 right-0 pointer-events-none" style={{ top: '0px', height: `${contentHeightPx()}px` }}>
              {notes().map((n, idx) => (
                <div
                  class="absolute rounded-sm bg-green-500/70 border border-green-400/80 pointer-events-auto"
                  style={{
                    left: `${(n.beat / clipBeats()) * 100}%`,
                    top: `${(topPitch() - n.pitch) * rowPx}px`,
                    width: `${Math.max(1 / (clipBeats() * stepsPerBeat()), (n.length / clipBeats())) * 100}%`,
                    height: `${Math.max(2, rowPx - 2)}px`,
                    cursor: 'grab',
                  }}
                  onPointerDown={onNotePointerDown(idx) as any}
                  onClick={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                  onDblClick={(ev) => { ev.stopPropagation(); ev.preventDefault(); setNotes(prev => prev.filter((_, i) => i !== idx)); scheduleSave() }}
                  data-midi-note="1"
                />
              ))}
            </div>
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
