import { type Component, createMemo, createSignal, onCleanup, createEffect, For, onMount } from 'solid-js'
import { convexClient, convexApi } from '~/lib/convex'
import { isLocalId } from '@daw-browser/shared'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { cn } from '~/lib/utils'
import { useDrag } from '~/hooks/useDrag'
import {
  clampTimelineMidiBounds,
  type TimelineMidiBounds,
} from '~/lib/timeline-midi-bounds'
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
  // Live note callbacks for computer keyboard play
  onStartLiveNote?: (pitch: number, velocity?: number) => void
  onStopLiveNote?: (pitch: number) => void
  onLocalMidiSaved?: (clipId: string, midi: Clip['midi']) => void
}

const MidiEditorCard: Component<MidiEditorCardProps> = (props) => {
  const [notes, setNotes] = createSignal<Array<{ beat: number; length: number; pitch: number; velocity?: number }>>([])
  // Local-only toggle to capture keyboard for playing notes
  const storageKey = () => `mb:midi_kb:${props.projectId || 'default'}`
  const [kbEnabled, setKbEnabled] = createSignal(false)
  const octaveKey = () => `mb:midi_kb_oct:${props.projectId || 'default'}`
  const [octave, setOctave] = createSignal(0)
  // Track active rows for gutter highlighting
  const [activeRows, setActiveRows] = createSignal<Set<number>>(new Set(), { equals: false })
  const isLocalProject = () => Boolean(props.projectId && isLocalId('project', props.projectId))
  const canPersist = () => isLocalProject() || Boolean(props.userId)
  const warnMissingUser = () => console.warn('[MidiEditorCard] Cannot edit or persist MIDI without a writable project.')
  // Grid derived from BPM/denominator/clip length
  const stepsPerBeat = () => Math.max(1, Math.round((props.gridDenominator || 4) / 4))
  const secondsPerBeat = () => 60 / Math.max(1e-6, props.bpm || 120)
  const clipBeats = () => Math.max(1 / stepsPerBeat(), (props.clipDurationSec || 1) / secondsPerBeat())
  const cols = () => Math.max(stepsPerBeat(), Math.ceil(clipBeats() * stepsPerBeat()))
  // Full piano range C0..C8 (MIDI 12..108 inclusive)
  const minPitch = 12
  const maxPitch = 108
  const rows = () => (maxPitch - minPitch + 1) // 97 rows
  const gridCells = createMemo(() => {
    const columnCount = cols()
    const majorStep = stepsPerBeat() * 4
    return Array.from({ length: rows() * columnCount }, (_, i) => i % columnCount % majorStep === 0)
  })
  const topPitch = () => maxPitch
  const rowPx = 20
  const contentHeightPx = () => rows() * rowPx
  let dragStartX = 0
  let dragStartY = 0
  let startLeft = 0
  let startTop = 0
  let resizeStartW = 0
  let resizeStartH = 0
  let saveTimer: number | null = null
  type PendingMidiSave = {
    clipId: string
    projectId?: string
    userId?: string
    midi: Clip['midi']
  }
  let pendingMidiSave: PendingMidiSave | null = null
  const currentMidi = (): Clip['midi'] => ({
    wave: props.midi?.wave ?? 'sawtooth',
    gain: props.midi?.gain ?? 0.8,
    notes: notes().slice().sort((a, b) => a.beat - b.beat || b.pitch - a.pitch),
  })
  const canPersistSave = (save: PendingMidiSave) => (
    Boolean(save.projectId && isLocalId('project', save.projectId)) || Boolean(save.userId)
  )
  const saveMidi = async (save: PendingMidiSave) => {
    if (save.projectId && isLocalId('project', save.projectId)) {
      const updated = await createLocalTimelineRepository(save.projectId).updateClip({ clipId: save.clipId, midi: save.midi })
      if (updated && props.projectId === save.projectId && props.clipId === save.clipId) {
        props.onLocalMidiSaved?.(save.clipId, save.midi)
      }
      return
    }
    await convexClient.mutation((convexApi as any).clips.setMidi, { clipId: save.clipId as any, midi: save.midi })
  }
  const scheduleSave = () => {
    const pending = {
      clipId: props.clipId,
      projectId: props.projectId,
      userId: props.userId,
      midi: currentMidi(),
    }
    if (!canPersistSave(pending)) {
      warnMissingUser()
      return
    }
    pendingMidiSave = pending
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = window.setTimeout(async () => {
      try {
        saveTimer = null
        const save = pendingMidiSave
        pendingMidiSave = null
        if (save) await saveMidi(save)
      } catch {}
    }, 200)
  }

  const cardDrag = useDrag({
    dragCursorClass: 'cursor-grabbing',
    onDragStart: (pos) => {
      dragStartX = pos.x
      dragStartY = pos.y
      startLeft = props.bounds.x
      startTop = props.bounds.y
    },
    onDragMove: (pos) => {
      props.onChangeBounds(clampTimelineMidiBounds({
        x: startLeft + pos.x - dragStartX,
        y: startTop + pos.y - dragStartY,
        w: props.bounds.w,
        h: props.bounds.h,
      }))
    },
  })

  const resizeDrag = useDrag({
    dragCursorClass: 'cursor-se-resize',
    onDragStart: (pos) => {
      dragStartX = pos.x
      dragStartY = pos.y
      resizeStartW = props.bounds.w
      resizeStartH = props.bounds.h
    },
    onDragMove: (pos) => {
      props.onChangeBounds(clampTimelineMidiBounds({
        x: props.bounds.x,
        y: props.bounds.y,
        w: resizeStartW + pos.x - dragStartX,
        h: resizeStartH + pos.y - dragStartY,
      }))
    },
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

  onCleanup(() => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
      const save = pendingMidiSave
      pendingMidiSave = null
      if (save) void saveMidi(save).catch(() => {})
    }
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
  const pointToCell = (container: HTMLElement, e: PointerEvent) => {
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
  const onGridClick = (e: PointerEvent) => {
    if (dragNote) { e.preventDefault(); return }
    if (!canPersist()) { warnMissingUser(); return }
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
    startCol: number;
    stepWidthPx: number;
    grabOffsetStepsF: number;
    startPointerStepF: number;
    startRow: number;
    started: boolean;
    changed: boolean;
  }
  let dragNote: DragState | null = null
  const cleanupNoteDragListeners = () => {
    try { window.removeEventListener('pointermove', onNotePointerMove, { capture: true } as EventListenerOptions) } catch {}
    try { window.removeEventListener('pointerup', onNotePointerUp, { capture: true } as EventListenerOptions) } catch {}
    try { window.removeEventListener('pointercancel', onNotePointerUp, { capture: true } as EventListenerOptions) } catch {}
  }
  const onNotePointerDown = (idx: number) => (e: PointerEvent) => {
    if (!canPersist()) { warnMissingUser(); return }
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    // If this is a double-click, don't start dragging; deletion is handled by onDblClick
    if (e.detail >= 2) {
      return
    }
    const n = notes()[idx]; if (!n) return
    const el = gridRef; if (!el) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const nearRight = (e.clientX - rect.left) > rect.width * 0.7
    const { col } = pointToCell(el, e)
    const containerRect = el.getBoundingClientRect()
    const stepWidthPx = Math.max(1e-6, containerRect.width / cols())
    const pointerStepF = (e.clientX - containerRect.left) / stepWidthPx
    const grabOffsetStepsF = pointerStepF - (n.beat * stepsPerBeat())
    dragNote = {
      idx,
      mode: nearRight ? 'resize' : 'move',
      startCol: col,
      stepWidthPx,
      grabOffsetStepsF,
      startPointerStepF: pointerStepF,
      startRow: Math.round((topPitch() - n.pitch)),
      started: false,
      changed: false,
    }
    window.addEventListener('pointermove', onNotePointerMove, { capture: true })
    window.addEventListener('pointerup', onNotePointerUp, { capture: true })
    window.addEventListener('pointercancel', onNotePointerUp, { capture: true })
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch {}
    // Audition on drag start
    const dur = Math.min(0.6, Math.max(0.05, n.length * secondsPerBeat()))
    props.onAuditionNote?.(n.pitch, n.velocity ?? 0.9, dur)
  }
  const onNotePointerMove = (e: PointerEvent) => {
    const drag = dragNote
    if (!drag) return
    if (!canPersist()) { return }
    const el = gridRef; if (!el) return
    const { col, row } = pointToCell(el, e)
    const note = notes()[drag.idx]
    if (!note) return

    if (drag.mode === 'move') {
      const pitch = Math.max(minPitch, Math.min(maxPitch, topPitch() - row))
      const containerRect = el.getBoundingClientRect()
      const stepW = drag.stepWidthPx || Math.max(1e-6, containerRect.width / cols())
      const pointerStepF = (e.clientX - containerRect.left) / stepW
      const stepDelta = Math.abs(pointerStepF - drag.startPointerStepF)
      const rowDelta = Math.abs(row - drag.startRow)
      if (!drag.started && stepDelta < 0.25 && rowDelta < 0.5) return
      drag.started = true

      const newStep = Math.max(0, Math.min(cols() - 1, Math.round(pointerStepF - drag.grabOffsetStepsF)))
      const nextBeat = newStep / stepsPerBeat()
      if (note.pitch === pitch && note.beat === nextBeat) return
      drag.changed = true
      setNotes(prev => prev.map((nn, i) => i === drag.idx ? { ...nn, beat: nextBeat, pitch } : nn))
      return
    }

    const deltaSteps = Math.max(1, col - drag.startCol + 1)
    const nextLen = Math.max(1 / stepsPerBeat(), deltaSteps / stepsPerBeat())
    if (note.length === nextLen) return
    drag.changed = true
    setNotes(prev => prev.map((nn, i) => i === drag.idx ? { ...nn, length: nextLen } : nn))
  }
  const onNotePointerUp = (_e: PointerEvent) => {
    const drag = dragNote
    cleanupNoteDragListeners()
    if (!canPersist()) {
      dragNote = null
      return
    }
    if (drag?.changed) scheduleSave()
    dragNote = null
  }
  onCleanup(cleanupNoteDragListeners)

  // --- Computer keyboard play mode (A/S/D/F/G row mapping) ---
  // Mapping based on event.code for US QWERTY; anchor A as C4 (MIDI 60)
  const BASE_C4 = 60
  const whiteMap: Record<string, number> = {
    KeyA: 0, // C4
    KeyS: 2, // D4
    KeyD: 4, // E4
    KeyF: 5, // F4
    KeyG: 7, // G4
    KeyH: 9, // A4
    KeyJ: 11, // B4
    KeyK: 12, // C5
    KeyL: 14, // D5
    Semicolon: 16, // E5
  }
  const blackMap: Record<string, number> = {
    KeyW: 1,  // C#4
    KeyE: 3,  // D#4
    KeyT: 6,  // F#4
    KeyY: 8,  // G#4
    KeyU: 10, // A#4
    KeyO: 13, // C#5
    KeyP: 15, // D#5
  }
  const codeToSemitone = (code: string): number | undefined => {
    if (whiteMap[code] != null) return whiteMap[code]
    if (blackMap[code] != null) return blackMap[code]
    return undefined
  }
  const pressed = new Map<string, number>()
  const velocity = 0.9
  const handleKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    // Octave shift with Z/X
    if (e.code === 'KeyZ') {
      setOctave(v => Math.max(-4, Math.min(4, v - 1)))
      e.preventDefault(); e.stopPropagation();
      return
    }
    if (e.code === 'KeyX') {
      setOctave(v => Math.max(-4, Math.min(4, v + 1)))
      e.preventDefault(); e.stopPropagation();
      return
    }
    const semi = codeToSemitone(e.code)
    if (semi == null) return
    if (pressed.has(e.code)) { e.preventDefault(); e.stopPropagation(); return }
    const pitch = BASE_C4 + semi + octave() * 12
    pressed.set(e.code, pitch)
    // highlight row
    setActiveRows(prev => { const n = new Set(prev); n.add(pitch); return n })
    props.onStartLiveNote?.(pitch, velocity)
    e.preventDefault()
    e.stopPropagation()
  }
  const handleKeyUp = (e: KeyboardEvent) => {
    const semi = codeToSemitone(e.code)
    if (semi == null) return
    const pitch = pressed.get(e.code)
    if (pitch == null) return
    pressed.delete(e.code)
    props.onStopLiveNote?.(pitch)
    setActiveRows(prev => { const n = new Set(prev); n.delete(pitch); return n })
    e.preventDefault()
    e.stopPropagation()
  }
  // Persist toggle locally per room
  onMount(() => {
    try {
      const raw = window.localStorage.getItem(storageKey())
      if (raw != null) setKbEnabled(raw === '1')
      const oct = window.localStorage.getItem(octaveKey())
      if (oct != null) {
        const v = parseInt(oct, 10); if (Number.isFinite(v)) setOctave(Math.max(-4, Math.min(4, v)))
      }
    } catch {}
  })
  createEffect(() => {
    try { window.localStorage.setItem(storageKey(), kbEnabled() ? '1' : '0') } catch {}
  })
  createEffect(() => {
    try { window.localStorage.setItem(octaveKey(), String(octave())) } catch {}
  })
  // Manage listeners only when enabled
  createEffect(() => {
    if (!kbEnabled()) return
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    window.addEventListener('keyup', handleKeyUp, { capture: true })
    onCleanup(() => {
      try { window.removeEventListener('keydown', handleKeyDown, { capture: true } as EventListenerOptions) } catch {}
      try { window.removeEventListener('keyup', handleKeyUp, { capture: true } as EventListenerOptions) } catch {}
      // Release any still-held notes
      try {
        for (const pitch of pressed.values()) {
          props.onStopLiveNote?.(pitch)
        }
        pressed.clear()
        setActiveRows(new Set<number>())
      } catch {}
    })
  })


  return (
    <div
      class="absolute z-50 border border-neutral-700 bg-neutral-900 shadow-xl overflow-hidden"
      style={{ left: `${props.bounds.x}px`, top: `${props.bounds.y}px`, width: `${props.bounds.w}px`, height: `${props.bounds.h}px` }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
    >
      {/* Header: draggable */}
      <div
        class="flex items-center justify-between px-3 py-2 bg-neutral-800 border-b border-neutral-700 cursor-move select-none"
        onPointerDown={onHeaderPointerDown}
      >
        <div class="flex items-center gap-3 text-sm font-semibold text-neutral-200">
          <div class="flex items-center gap-2">
            <button
              class={cn(
                'border px-2 py-0.5 text-xs',
                kbEnabled() ? 'border-green-500 bg-green-600/20 text-green-300' : 'border-neutral-600 bg-neutral-700/30 text-neutral-300',
              )}
              onPointerDown={(e) => { e.stopPropagation() }}
              onClick={(e) => { e.stopPropagation(); setKbEnabled(v => !v) }}
              title="Toggle computer keyboard input (local only)"
            >
              ⌨ MIDI Keys
            </button>
            <span class="text-neutral-400">•</span>
            <span>MIDI Editor</span>
          </div>
          <span class="text-neutral-400">•</span>
          <span class="text-neutral-300 text-xs">Clip: {props.clipId.slice(0, 8)}</span>
          <span class="text-neutral-500 text-xs">BPM: {props.bpm}</span>
        </div>
        <button
          class="text-neutral-300 hover:text-white px-2 py-0.5 text-sm"
          onPointerDown={(e) => { e.stopPropagation() }}
          onClick={props.onClose}
          aria-label="Close MIDI editor"
        >
          ✕
        </button>
      </div>

      {/* Body: piano gutter + grid */}
      <div class="relative w-full" style={{ height: 'calc(100% - 36px)' }}>
        <div class="absolute inset-0 grid overflow-y-auto" style={{ 'grid-template-columns': '44px 1fr' }}>
          {/* Piano gutter */}
          <div class="bg-neutral-900 border-r border-neutral-800 select-none">
            <div class="grid w-full" style={{ 'grid-template-rows': `repeat(${rows()}, ${rowPx}px)` }}>
              <For each={[...Array(rows()).keys()]}> 
                {(r) => {
                  const pitch = Math.max(minPitch, Math.min(maxPitch, topPitch() - r))
                  const black = isBlackKey(pitch)
                  const active = () => activeRows().has(pitch)
                  return (
                    <div
                      class={cn(
                        'relative flex cursor-pointer items-center justify-center border-b border-neutral-800 font-mono text-2xs',
                        active()
                          ? 'border-green-400 bg-green-600/50 text-white'
                          : black
                            ? 'bg-neutral-700/70 text-neutral-100'
                            : 'bg-neutral-800/70 text-neutral-200',
                      )}
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
              <For each={gridCells()}>
                {(major) => (
                  <div class={cn('border', major ? 'border-neutral-700' : 'border-neutral-800')} />
                )}
              </For>
            </div>
            {/* Notes overlay (scrolls with content) */}
            <div class="absolute left-0 right-0 pointer-events-none" style={{ top: '0px', height: `${contentHeightPx()}px` }}>
              <For each={notes()}>
                {(n, idx) => (
                <div
                  class="absolute bg-green-500/70 border border-green-400/80 pointer-events-auto"
                  style={{
                    left: `${(n.beat / clipBeats()) * 100}%`,
                    top: `${(topPitch() - n.pitch) * rowPx}px`,
                    width: `${Math.max(1 / (clipBeats() * stepsPerBeat()), (n.length / clipBeats())) * 100}%`,
                    height: `${Math.max(2, rowPx - 2)}px`,
                    cursor: 'grab',
                  }}
                  onPointerDown={(ev) => onNotePointerDown(idx())(ev)}
                  onClick={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                  onDblClick={(ev) => {
                    ev.stopPropagation()
                    ev.preventDefault()
                    if (!canPersist()) { warnMissingUser(); return }
                    setNotes(prev => prev.filter((_, i) => i !== idx()))
                    scheduleSave()
                  }}
                  data-midi-note="1"
                />
                )}
              </For>
            </div>
          </div>
        </div>
        {/* Bottom-right resizer */}
        <div
          class="absolute right-1 bottom-1 w-4 h-4 cursor-se-resize bg-neutral-700/60 hover:bg-neutral-600/70"
          onPointerDown={onResizerPointerDown}
          title="Resize"
        />
      </div>
    </div>
  )
}

export default MidiEditorCard
