import { type Component, createMemo, createSignal, onCleanup, createEffect, For } from 'solid-js'
import { cn } from '~/lib/utils'
import { useDrag } from '~/hooks/useDrag'
import { useMidiEditorPersistence } from '~/hooks/useMidiEditorPersistence'
import {
  createTimelineMidiBoundsDrag,
  type TimelineMidiBounds,
} from '~/lib/timeline-midi-bounds'
import { createMidiEditorGrid, type MidiEditorNote, type MidiNoteDrag } from '~/lib/midi-editor-grid'
import type { Clip } from '@daw-browser/timeline-core/types'

type MidiEditorCardProps = {
  clipId: string
  bpm: number
  // Align grid to timeline
  gridDenominator: number
  // Clip window to size grid to
  clipDurationSec: number
  bounds: TimelineMidiBounds
  onClose: () => void
  onChangeBounds: (next: TimelineMidiBounds) => void
  midi?: Clip['midi']
  userId?: string
  // Optional: preview note when adding/dragging
  onAuditionNote?: (pitch: number, velocity?: number, durSec?: number) => void
  // Local-only: current room id for per-room persistence
  projectId?: string
  midiKeyboard?: {
    isActive: (pitch: number) => boolean
  }
  onLocalMidiSaved?: (clipId: string, midi: Clip['midi']) => void
}

const MidiEditorCard: Component<MidiEditorCardProps> = (props) => {
  const [notes, setNotes] = createSignal<MidiEditorNote[]>([])
  const [lastCreatedNoteLength, setLastCreatedNoteLength] = createSignal(0)
  const warnMissingUser = () => console.warn('[MidiEditorCard] Cannot edit or persist MIDI without a writable project.')
  const grid = createMemo(() => createMidiEditorGrid(
    props.bpm,
    props.gridDenominator,
    props.clipDurationSec,
  ))
  let boundsDrag: ReturnType<typeof createTimelineMidiBoundsDrag> | null = null
  const clearBoundsDrag = () => {
    boundsDrag = null
  }
  const currentMidi = (): NonNullable<Clip['midi']> => ({
    wave: props.midi?.wave ?? 'sawtooth',
    gain: props.midi?.gain ?? 0.8,
    notes: notes().slice().sort((a, b) => a.beat - b.beat || b.pitch - a.pitch),
  })
  const persistence = useMidiEditorPersistence({
    clipId: () => props.clipId,
    projectId: () => props.projectId,
    userId: () => props.userId,
    midi: currentMidi,
    onLocalMidiSaved: (clipId, midi) => props.onLocalMidiSaved?.(clipId, midi),
    onCannotPersist: warnMissingUser,
  })

  const cardDrag = useDrag({
    dragCursorClass: 'cursor-grabbing',
    onDragStart: (pos) => {
      boundsDrag = createTimelineMidiBoundsDrag(props.bounds, pos)
    },
    onDragMove: (pos) => {
      const drag = boundsDrag
      if (drag) props.onChangeBounds(drag.moveTo(pos))
    },
    onDragEnd: clearBoundsDrag,
    onDragCancel: clearBoundsDrag,
  })

  const resizeDrag = useDrag({
    dragCursorClass: 'cursor-se-resize',
    onDragStart: (pos) => {
      boundsDrag = createTimelineMidiBoundsDrag(props.bounds, pos)
    },
    onDragMove: (pos) => {
      const drag = boundsDrag
      if (drag) props.onChangeBounds(drag.resizeTo(pos))
    },
    onDragEnd: clearBoundsDrag,
    onDragCancel: clearBoundsDrag,
  })

  const onHeaderPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    event.stopPropagation()
    cardDrag.onPointerDown(event)
  }

  const onResizerPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    event.stopPropagation()
    resizeDrag.onPointerDown(event)
  }

  const stopEditorEvent = (event: Event) => {
    event.stopPropagation()
  }

  const stopAndPreventEditorEvent = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
  }

  // Sync incoming midi
  createEffect(() => {
    const m = props.midi
    if (m && Array.isArray(m.notes)) {
      setNotes(m.notes.slice())
    } else {
      setNotes([])
    }
  })

  let gridRef: HTMLDivElement | undefined
  const pointToCell = (container: HTMLElement, event: PointerEvent) => (
    grid().cellFromPointer(container, event)
  )

  const onGridClick = (e: PointerEvent) => {
    if (dragNote) { e.preventDefault(); return }
    if (!persistence.canPersist()) { warnMissingUser(); return }
    if (e.button !== 0) return
    const target = e.target
    if (target instanceof HTMLElement && target.closest('[data-midi-note="1"]')) return
    const el = gridRef; if (!el) return
    const cell = pointToCell(el, e)
    const note = grid().noteFromCell(cell)
    const existingIdx = grid().findNoteAtCell(notes(), cell)
    if (existingIdx >= 0) {
      setNotes(prev => prev.filter((_, i) => i !== existingIdx))
    } else {
      const length = lastCreatedNoteLength() || note.length
      const nextNote = { ...note, length }
      setNotes(prev => [...prev, nextNote])
      props.onAuditionNote?.(nextNote.pitch, nextNote.velocity, grid().noteDurationSeconds(nextNote.length, 0.5))
    }
    persistence.saveSoon()
  }

  // Drag to move/resize notes
  type DragState = {
    idx: number
    drag: MidiNoteDrag
    started: boolean
    changed: boolean
  }
  let dragNote: DragState | null = null
  const noteDragListenerOptions: AddEventListenerOptions = { capture: true }
  const cleanupNoteDragListeners = () => {
    window.removeEventListener('pointermove', onNotePointerMove, noteDragListenerOptions)
    window.removeEventListener('pointerup', onNotePointerUp, noteDragListenerOptions)
    window.removeEventListener('pointercancel', onNotePointerUp, noteDragListenerOptions)
  }
  const onNotePointerDown = (idx: number, target: HTMLElement, e: PointerEvent) => {
    if (!persistence.canPersist()) { warnMissingUser(); return }
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    // If this is a double-click, don't start dragging; deletion is handled by onDblClick
    if (e.detail >= 2) {
      return
    }
    const n = notes()[idx]; if (!n) return
    const el = gridRef; if (!el) return
    const rect = target.getBoundingClientRect()
    const nearRight = (e.clientX - rect.left) > rect.width * 0.7
    const cell = pointToCell(el, e)
    dragNote = {
      idx,
      drag: grid().createNoteDrag({
        note: n,
        mode: nearRight ? 'resize' : 'move',
        cell,
        pointerStep: grid().pointerStep(el, e),
      }),
      started: false,
      changed: false,
    }
    window.addEventListener('pointermove', onNotePointerMove, noteDragListenerOptions)
    window.addEventListener('pointerup', onNotePointerUp, noteDragListenerOptions)
    window.addEventListener('pointercancel', onNotePointerUp, noteDragListenerOptions)
    try { target.setPointerCapture(e.pointerId) } catch {}
    // Audition on drag start
    const dur = Math.max(0.05, grid().noteDurationSeconds(n.length, 0.6))
    props.onAuditionNote?.(n.pitch, n.velocity ?? 0.9, dur)
  }
  const onNotePointerMove = (e: PointerEvent) => {
    const drag = dragNote
    if (!drag) return
    if (!persistence.canPersist()) { return }
    const el = gridRef; if (!el) return
    const cell = pointToCell(el, e)
    const note = notes()[drag.idx]
    if (!note) return

    const pointerStep = grid().pointerStep(el, e)
    if (
      !drag.started
      && !grid().hasStartedNoteDrag(
        pointerStep,
        drag.drag.pointerStep,
        cell.row,
        drag.drag.startCell.row,
      )
    ) return
    drag.started = true

    const next = grid().noteFromDrag(drag.drag, cell, pointerStep)
    if (grid().notesEqual(note, next)) return
    drag.changed = true
    setNotes(prev => grid().replaceNote(prev, drag.idx, next))
    if (drag.drag.mode === 'move' && note.pitch !== next.pitch) {
      props.onAuditionNote?.(next.pitch, next.velocity ?? 0.9, grid().noteDurationSeconds(next.length, 0.25))
    }
  }
  const onNotePointerUp = (_e: PointerEvent) => {
    const drag = dragNote
    cleanupNoteDragListeners()
    if (!persistence.canPersist()) {
      dragNote = null
      return
    }
    if (drag?.changed) {
      const note = notes()[drag.idx]
      if (note) setLastCreatedNoteLength(note.length)
      persistence.saveSoon()
    }
    dragNote = null
  }
  onCleanup(cleanupNoteDragListeners)

  const renderHeader = () => (
    <div
      class="flex items-center justify-between px-3 py-2 bg-neutral-800 border-b border-neutral-700 cursor-move select-none"
      onPointerDown={onHeaderPointerDown}
    >
      <div class="flex items-center gap-3 text-sm font-semibold text-neutral-200">
        <div class="flex items-center gap-2">
          <span>MIDI Editor</span>
        </div>
        <span class="text-neutral-400">•</span>
        <span class="text-neutral-300 text-xs">Clip: {props.clipId.slice(0, 8)}</span>
        <span class="text-neutral-500 text-xs">BPM: {props.bpm}</span>
      </div>
      <button
        class="text-neutral-300 hover:text-white px-2 py-0.5 text-sm"
        onPointerDown={stopEditorEvent}
        onClick={props.onClose}
        aria-label="Close MIDI editor"
      >
        ✕
      </button>
    </div>
  )

  const renderPianoGutter = () => (
    <div class="bg-neutral-900 border-r border-neutral-800 select-none">
      <div class="grid w-full" style={{ 'grid-template-rows': grid().rowTemplate }}>
        <For each={grid().rows}>
          {(row) => {
            const pitch = grid().pitchForRow(row)
            const isBlackKey = grid().isBlackKey(pitch)
            return (
              <div
                class={cn(
                  'relative flex cursor-pointer items-center justify-center border-b border-neutral-800 font-mono text-2xs',
                  props.midiKeyboard?.isActive(pitch)
                    ? 'border-green-400 bg-green-600/50 text-white'
                    : isBlackKey
                      ? 'bg-neutral-700/70 text-neutral-100'
                      : 'bg-neutral-800/70 text-neutral-200',
                )}
                onPointerDown={(event) => {
                  stopEditorEvent(event)
                  props.onAuditionNote?.(pitch, 0.9, grid().noteDurationSeconds(1, 0.6))
                }}
                title={grid().noteName(pitch)}
              >
                <span class="opacity-80">{grid().noteName(pitch)}</span>
              </div>
            )
          }}
        </For>
      </div>
    </div>
  )

  const renderGridCells = () => (
    <div class="w-full grid" style={{ 'grid-template-rows': grid().rowTemplate, 'grid-template-columns': grid().columnTemplate }}>
      <For each={grid().cells}>
        {(major) => (
          <div class={cn('border', major ? 'border-neutral-700' : 'border-neutral-800')} />
        )}
      </For>
    </div>
  )

  const renderNotes = () => (
    <div class="absolute left-0 right-0 pointer-events-none" style={{ top: '0px', height: `${grid().contentHeight}px` }}>
      <For each={notes()}>
        {(note, idx) => (
          <div
            class="absolute bg-green-500/70 border border-green-400/80 pointer-events-auto"
            style={{
              left: `${grid().noteLeftPercent(note)}%`,
              top: `${grid().noteTop(note)}px`,
              width: `${grid().noteWidthPercent(note)}%`,
              height: `${grid().noteHeight}px`,
              cursor: 'grab',
            }}
            onPointerDown={(event) => onNotePointerDown(idx(), event.currentTarget, event)}
            onClick={stopAndPreventEditorEvent}
            onDblClick={(event) => {
              stopAndPreventEditorEvent(event)
              if (!persistence.canPersist()) { warnMissingUser(); return }
              setNotes(prev => prev.filter((_, i) => i !== idx()))
              persistence.saveSoon()
            }}
            data-midi-note="1"
          />
        )}
      </For>
    </div>
  )

  const renderBody = () => (
    <div class="relative w-full" style={{ height: 'calc(100% - 36px)' }}>
      <div class="absolute inset-0 grid overflow-y-auto" style={{ 'grid-template-columns': '44px 1fr' }}>
        {renderPianoGutter()}
        <div class="relative bg-neutral-900" ref={(el) => (gridRef = el)} onPointerDown={onGridClick}>
          {renderGridCells()}
          {renderNotes()}
        </div>
      </div>
      <div
        class="absolute right-1 bottom-1 w-4 h-4 cursor-se-resize bg-neutral-700/60 hover:bg-neutral-600/70"
        onPointerDown={onResizerPointerDown}
        title="Resize"
      />
    </div>
  )

  return (
    <div
      class="absolute z-50 border border-neutral-700 bg-neutral-900 shadow-xl overflow-hidden"
      style={{ left: `${props.bounds.x}px`, top: `${props.bounds.y}px`, width: `${props.bounds.w}px`, height: `${props.bounds.h}px` }}
      onPointerDown={stopEditorEvent}
      onClick={stopEditorEvent}
      onWheel={stopEditorEvent}
      onContextMenu={stopAndPreventEditorEvent}
    >
      {renderHeader()}
      {renderBody()}
    </div>
  )
}

export default MidiEditorCard
