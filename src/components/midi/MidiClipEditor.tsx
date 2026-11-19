import { type Component, createMemo, createSignal, onCleanup, createEffect, For, on, Show } from 'solid-js'
import { cn } from '~/lib/utils'
import { useDrag } from '~/hooks/useDrag'
import { useMidiEditorPersistence } from '~/hooks/useMidiEditorPersistence'
import { isButtonKeyboardTarget, isEditableKeyboardTarget } from '~/lib/keyboard-event-target'
import {
  createMidiEditorGrid,
  DEFAULT_NOTE_VELOCITY,
  midiNoteVelocity,
  midiVelocityFromDrag,
  midiVelocityValue,
  type MidiEditorNote,
  type MidiNoteDrag,
} from '~/lib/midi-editor-grid'
import {
  getAutomationParameterOptionsForTarget,
  isMidiMappingTargetSupported,
  midiMappingTargetKey,
  normalizeLegacyMidiClip,
  type AutomationTargetDeviceInstance,
  type MidiMapping,
} from '@daw-browser/shared'
import type { Clip } from '@daw-browser/timeline-core/types'

type MidiClipEditorProps = {
  clipId: string
  clipName: string
  bpm: number
  // Align grid to timeline
  gridDenominator: number
  // Clip window to size grid to
  clipDurationSec: number
  midi?: Clip['midi']
  userId?: string
  canWrite: boolean
  // Optional: preview note when adding/dragging
  onAuditionNote?: (trackId: string, pitch: number, velocity?: number, durSec?: number) => void
  // Local-only: current room id for per-room persistence
  projectId?: string
  midiKeyboard: {
    isActive: (pitch: number) => boolean
  }
  onLocalMidiSaved?: (clipId: string, midi: Clip['midi']) => void
  // Called once per completed user edit with the full note list before and after it.
  onNotesEdited?: (clipId: string, from: MidiEditorNote[], to: MidiEditorNote[]) => void
  // Reports a note drag start and end, so the clip detail panel's Escape closes nothing mid-drag.
  onNoteDragStateChange?: (dragging: boolean) => void
  trackId?: string
  effectInstances?: readonly AutomationTargetDeviceInstance[]
}

const MidiClipEditor: Component<MidiClipEditorProps> = (props) => {
  const [notes, setNotes] = createSignal<MidiEditorNote[]>([])
  const [selectedNoteIds, setSelectedNoteIds] = createSignal<string[]>([])
  const [mappings, setMappings] = createSignal<MidiMapping[]>([])
  const [lastCreatedNoteLength, setLastCreatedNoteLength] = createSignal(0)
  const warnMissingUser = () => console.warn('[MidiClipEditor] Cannot edit or persist MIDI without a writable project.')
  const grid = createMemo(() => createMidiEditorGrid(
    props.bpm,
    props.gridDenominator,
    props.clipDurationSec,
  ))
  const persistence = useMidiEditorPersistence({
    clipId: () => props.clipId,
    projectId: () => props.projectId,
    userId: () => props.userId,
    canWrite: () => props.canWrite,
    onLocalMidiSaved: (clipId, midi) => props.onLocalMidiSaved?.(clipId, midi),
    onCannotPersist: warnMissingUser,
  })
  const projectedMidi = createMemo(() => {
    const midi = props.midi
    const normalized = midi && Array.isArray(midi.notes) ? normalizeLegacyMidiClip(midi) : undefined
    return normalized ? persistence.project(normalized) : undefined
  })
  const clipId = createMemo(() => props.clipId)
  const mappingTargets = createMemo(() => getAutomationParameterOptionsForTarget(
    props.effectInstances ?? [],
    props.trackId,
  ).filter((option) => isMidiMappingTargetSupported({
    parameterId: option.parameterId,
    effectInstanceId: option.effectInstanceId,
  })))

  type DragState = {
    pointerId: number
    noteId: string
    drag: MidiNoteDrag
    draft: MidiEditorNote
    started: boolean
    changed: boolean
  }
  let dragNote: DragState | null = null
  let projectedNotes: MidiEditorNote[] = []
  let root: HTMLDivElement | undefined

  const stopEditorEvent = (event: Event) => {
    event.stopPropagation()
  }

  const stopAndPreventEditorEvent = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
  }

  createEffect(() => {
    const m = props.midi
    const normalized = m && Array.isArray(m.notes) ? normalizeLegacyMidiClip(m) : undefined
    if (normalized) persistence.reconcile(normalized)
    const projected = projectedMidi()
    const nextNotes = projected
      ? projected.notes.flatMap((note) => (
        note.id === undefined ? [] : [{ ...note, id: note.id, channel: note.channel ?? 1 }]
      ))
      : []
    setMappings(projected?.mappings ?? [])
    projectedNotes = nextNotes
    const drag = dragNote
    if (drag && !nextNotes.some((note) => note.id === drag.noteId)) {
      cleanupNoteDragListeners()
      dragNote = null
      setNotes(nextNotes)
      return
    }
    if (drag) {
      const draft = drag.draft
      setNotes(nextNotes.map((note) => note.id === draft.id ? draft : note))
      return
    }
    setNotes(nextNotes)
  })
  createEffect(on(clipId, () => setSelectedNoteIds([])))
  createEffect(on(notes, (currentNotes) => {
    const currentIds = new Set(currentNotes.map((note) => note.id))
    setSelectedNoteIds((selected) => selected.filter((id) => currentIds.has(id)))
  }))

  let gridRef: HTMLDivElement | undefined
  const pointToCell = (container: HTMLElement, event: PointerEvent) => (
    grid().cellFromPointer(container, event)
  )

  const deleteNote = (id: string) => {
    const before = notes()
    const after = grid().removeNoteById(before, id)
    setNotes(after)
    persistence.saveSoon({ kind: 'delete', id })
    props.onNotesEdited?.(props.clipId, before, after)
  }

  const deleteSelectedNotes = () => {
    const selectedIds = new Set(selectedNoteIds())
    const before = notes()
    const deleted = before.filter((note) => selectedIds.has(note.id))
    if (deleted.length === 0) return
    const after = before.filter((note) => !selectedIds.has(note.id))
    setNotes(after)
    for (const note of deleted) persistence.saveSoon({ kind: 'delete', id: note.id })
    props.onNotesEdited?.(props.clipId, before, after)
  }
  const duplicateSelectedNotes = () => {
    const selectedIds = new Set(selectedNoteIds())
    const selected = notes().filter((note) => selectedIds.has(note.id))
    if (selected.length === 0 || !persistence.canPersist()) return
    const start = Math.min(...selected.map((note) => note.beat))
    const end = Math.max(...selected.map((note) => note.beat + note.length))
    const offset = end - start
    const copies = selected
      .map((note) => ({ ...note, id: crypto.randomUUID(), beat: note.beat + offset }))
      .filter((note) => note.beat < grid().clipBeats)
    if (copies.length === 0) return
    const before = notes()
    const after = [...before, ...copies]
    setNotes(after)
    for (const note of copies) persistence.saveSoon({ kind: 'insert', note })
    props.onNotesEdited?.(props.clipId, before, after)
    setSelectedNoteIds(copies.map((note) => note.id))
  }
  const onLocalDuplicateRequest = () => duplicateSelectedNotes()
  createEffect(() => {
    const currentRoot = root
    if (!currentRoot) return
    currentRoot.addEventListener('timeline-local-duplicate', onLocalDuplicateRequest)
    onCleanup(() => currentRoot.removeEventListener('timeline-local-duplicate', onLocalDuplicateRequest))
  })
  createEffect(() => {
    selectedNoteIds()
    window.dispatchEvent(new Event('timeline-local-duplicate-state-change'))
  })

  const onEditorKeyDown = (event: KeyboardEvent) => {
    if (
      (event.metaKey || event.ctrlKey)
      && !event.altKey
      && !event.shiftKey
      && event.key.toLowerCase() === 'd'
      && !(event.metaKey && window.dawDesktop && /Macintosh/.test(navigator.userAgent))
    ) {
      event.preventDefault()
      event.stopPropagation()
      duplicateSelectedNotes()
      return
    }
    if (event.key === 'Escape' && !dragNote && selectedNoteIds().length > 0) {
      event.preventDefault()
      event.stopPropagation()
      setSelectedNoteIds([])
      return
    }
    if (event.key !== 'Delete' && event.key !== 'Backspace') return
    if (isEditableKeyboardTarget(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    if (persistence.canPersist()) deleteSelectedNotes()
    else if (selectedNoteIds().length > 0) warnMissingUser()
  }

  const selectNote = (noteId: string, event: PointerEvent) => {
    const selected = selectedNoteIds()
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      setSelectedNoteIds(selected.includes(noteId)
        ? selected.filter((id) => id !== noteId)
        : [...selected, noteId])
    } else if (!selected.includes(noteId) || selected.length !== 1) {
      setSelectedNoteIds([noteId])
    }
  }

  const onGridPointerDown = (e: PointerEvent) => {
    if (dragNote) { e.preventDefault(); return }
    if (e.button !== 0) return
    const target = e.target
    if (target instanceof HTMLElement && target.closest('[data-midi-note="1"]')) return
    setSelectedNoteIds([])
    if (!persistence.canPersist()) { warnMissingUser(); return }
    const el = gridRef; if (!el) return
    const cell = pointToCell(el, e)
    const existing = grid().findNoteAtCell(notes(), cell)
    if (existing) {
      deleteNote(existing.id)
    } else {
      const channel = projectedMidi()?.inputChannel ?? 1
      const note = grid().noteFromCell(cell, crypto.randomUUID(), channel)
      const length = lastCreatedNoteLength() || note.length
      const nextNote = { ...note, length }
      const before = notes()
      const after = [...before, nextNote]
      setNotes(after)
      if (props.trackId) props.onAuditionNote?.(props.trackId, nextNote.pitch, nextNote.velocity, grid().noteDurationSeconds(nextNote.length, 0.5))
      persistence.saveSoon({ kind: 'insert', note: nextNote })
      props.onNotesEdited?.(props.clipId, before, after)
    }
  }

  // Drag to move/resize notes
  const noteDragListenerOptions: AddEventListenerOptions = { capture: true }
  const cleanupNoteDragListeners = () => {
    props.onNoteDragStateChange?.(false)
    window.removeEventListener('pointermove', onNotePointerMove, noteDragListenerOptions)
    window.removeEventListener('pointerup', onNotePointerUp, noteDragListenerOptions)
    window.removeEventListener('pointercancel', onNotePointerCancel, noteDragListenerOptions)
    window.removeEventListener('keydown', onNoteDragKeyDown, noteDragListenerOptions)
    window.removeEventListener('blur', cancelNoteDrag)
    gridRef?.removeEventListener('lostpointercapture', onNotePointerCancel)
    const pointerId = dragNote?.pointerId
    if (pointerId !== undefined && gridRef?.hasPointerCapture(pointerId)) gridRef.releasePointerCapture(pointerId)
  }
  const cancelNoteDrag = () => {
    cleanupNoteDragListeners()
    dragNote = null
    setNotes(projectedNotes)
  }
  const isForeignNotePointer = (e: PointerEvent) => dragNote !== null && e.pointerId !== dragNote.pointerId
  const onNoteDragKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.preventDefault(); e.stopPropagation()
    cancelNoteDrag()
  }
  const onNotePointerDown = (noteId: string, target: HTMLElement, e: PointerEvent) => {
    if (e.button !== 0) return
    focusEditorOnPointerDown(e)
    e.preventDefault()
    selectNote(noteId, e)
    if (e.shiftKey || e.metaKey || e.ctrlKey) return
    if (!persistence.canPersist()) { warnMissingUser(); return }
    // If this is a double-click, don't start dragging; deletion is handled by onDblClick
    if (e.detail >= 2) {
      return
    }
    if (dragNote) return
    const n = grid().findNoteById(notes(), noteId); if (!n) return
    const el = gridRef; if (!el) return
    const rect = target.getBoundingClientRect()
    const nearRight = (e.clientX - rect.left) > rect.width * 0.7
    const cell = pointToCell(el, e)
    dragNote = {
      pointerId: e.pointerId,
      noteId,
      drag: grid().createNoteDrag({
        note: n,
        mode: nearRight ? 'resize' : 'move',
        cell,
        pointerStep: grid().pointerStep(el, e),
      }),
      draft: n,
      started: false,
      changed: false,
    }
    props.onNoteDragStateChange?.(true)
    window.addEventListener('pointermove', onNotePointerMove, noteDragListenerOptions)
    window.addEventListener('pointerup', onNotePointerUp, noteDragListenerOptions)
    window.addEventListener('pointercancel', onNotePointerCancel, noteDragListenerOptions)
    window.addEventListener('keydown', onNoteDragKeyDown, noteDragListenerOptions)
    window.addEventListener('blur', cancelNoteDrag)
    // The note element is re-rendered for every draft, so the stable grid owns the pointer.
    try { el.setPointerCapture(e.pointerId) } catch {}
    el.addEventListener('lostpointercapture', onNotePointerCancel)
    // Audition on drag start
    const dur = Math.max(0.05, grid().noteDurationSeconds(n.length, 0.6))
    if (props.trackId) props.onAuditionNote?.(props.trackId, n.pitch, midiNoteVelocity(n), dur)
  }
  const onNotePointerMove = (e: PointerEvent) => {
    const drag = dragNote
    if (!drag || isForeignNotePointer(e)) return
    if (!persistence.canPersist()) { return }
    const el = gridRef; if (!el) return
    const cell = pointToCell(el, e)
    const note = grid().findNoteById(notes(), drag.noteId)
    if (!note) {
      cancelNoteDrag()
      return
    }

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
    setSelectedNoteIds((selected) => selected.includes(drag.noteId) ? selected : [...selected, drag.noteId])

    const next = grid().noteFromDrag(drag.drag, cell, pointerStep)
    if (grid().notesEqual(note, next)) return
    drag.changed = true
    drag.draft = next
    setNotes(prev => grid().replaceNoteById(prev, drag.noteId, next))
    if (drag.drag.mode === 'move' && note.pitch !== next.pitch) {
      if (props.trackId) props.onAuditionNote?.(props.trackId, next.pitch, midiNoteVelocity(next), grid().noteDurationSeconds(next.length, 0.25))
    }
  }
  const onNotePointerUp = (e: PointerEvent) => {
    if (isForeignNotePointer(e)) return
    const drag = dragNote
    cleanupNoteDragListeners()
    if (!persistence.canPersist()) {
      cancelNoteDrag()
      return
    }
    if (drag?.changed) {
      // Read before saveSoon: it re-projects synchronously and would replace projectedNotes with the moved list.
      const before = projectedNotes
      const note = grid().findNoteById(notes(), drag.noteId)
      if (note) setLastCreatedNoteLength(note.length)
      const original = grid().findNoteById(before, drag.noteId)
      if (note && original && !grid().notesEqual(original, drag.draft)) {
        const changes = drag.drag.mode === 'resize'
          ? { length: note.length }
          : { beat: note.beat, pitch: note.pitch }
        persistence.saveSoon({ kind: 'update', id: drag.noteId, changes })
        props.onNotesEdited?.(props.clipId, before, grid().replaceNoteById(before, drag.noteId, drag.draft))
      }
    }
    dragNote = null
  }
  const onNotePointerCancel = (e: PointerEvent) => {
    if (!isForeignNotePointer(e)) cancelNoteDrag()
  }
  createEffect(() => {
    if (!persistence.canPersist() && dragNote) cancelNoteDrag()
  })
  onCleanup(cleanupNoteDragListeners)

  // Velocity drag: the live value is an overlay, so notes stay projected until pointerup commits one update.
  type VelocityDrag = { noteId: string; startY: number; startVelocity: number; velocity: number }
  const [velocityDrag, setVelocityDrag] = createSignal<VelocityDrag | null>(null)
  const displayedVelocity = (note: MidiEditorNote) => {
    const drag = velocityDrag()
    return drag?.noteId === note.id ? drag.velocity : midiNoteVelocity(note)
  }
  let velocityLaneRef: HTMLDivElement | undefined
  const endVelocityDrag = () => {
    setVelocityDrag(null)
    props.onNoteDragStateChange?.(false)
  }
  const commitVelocity = (drag: VelocityDrag) => {
    if (!persistence.canPersist()) return
    // Read before saveSoon: it re-projects synchronously and would replace projectedNotes.
    const before = projectedNotes
    const original = grid().findNoteById(before, drag.noteId)
    if (!original || midiVelocityValue(midiNoteVelocity(original)) === midiVelocityValue(drag.velocity)) return
    const after = grid().replaceNoteById(before, drag.noteId, { ...original, velocity: drag.velocity })
    persistence.saveSoon({ kind: 'update', id: drag.noteId, changes: { velocity: drag.velocity } })
    props.onNotesEdited?.(props.clipId, before, after)
  }
  const velocityPointer = useDrag({
    disabled: () => !persistence.canPersist(),
    onDragMove: (pos) => {
      const drag = velocityDrag()
      const lane = velocityLaneRef
      if (!drag || !lane) return
      const velocity = midiVelocityFromDrag({
        startVelocity: drag.startVelocity,
        startY: drag.startY,
        y: pos.y,
        laneHeight: lane.getBoundingClientRect().height,
      })
      if (velocity !== drag.velocity) setVelocityDrag({ ...drag, velocity })
    },
    onDragEnd: () => {
      const drag = velocityDrag()
      if (drag) commitVelocity(drag)
      endVelocityDrag()
    },
    onDragCancel: endVelocityDrag,
  })
  const onVelocityPointerDown = (noteId: string, event: PointerEvent) => {
    if (event.button !== 0) return
    focusEditorOnPointerDown(event)
    if (!persistence.canPersist()) return
    const note = grid().findNoteById(notes(), noteId)
    if (!note) return
    const velocity = midiNoteVelocity(note)
    setVelocityDrag({ noteId, startY: event.clientY, startVelocity: velocity, velocity })
    props.onNoteDragStateChange?.(true)
    velocityPointer.onPointerDown(event)
  }

  const renderHeader = () => (
    <div class="flex items-center px-3 py-1.5 bg-muted border-b border-border select-none">
      <div class="flex items-center gap-3 text-sm font-semibold text-foreground">
        <div class="flex items-center gap-2">
          <span>MIDI Editor</span>
        </div>
        <span class="text-muted-foreground">•</span>
        <span class="text-muted-foreground text-xs truncate max-w-48">Clip: {props.clipName}</span>
        <span class="text-muted-foreground text-xs">BPM: {props.bpm}</span>
        <label class="flex items-center gap-1 text-xs font-normal text-muted-foreground">
          Input
          <select
            class="border border-border bg-app-surface px-1 py-0.5 text-foreground"
            aria-label="MIDI input channel"
            value={projectedMidi()?.inputChannel ?? ''}
            disabled={!persistence.canPersist()}
            onChange={(event) => {
              const value = event.currentTarget.value
              persistence.saveSoon({ kind: 'set-input-channel', ...(value === '' ? { inputChannel: undefined } : { inputChannel: Number(value) }) })
            }}
          >
            <option value="">Omni</option>
            <option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option>
            <option value="5">5</option><option value="6">6</option><option value="7">7</option><option value="8">8</option>
            <option value="9">9</option><option value="10">10</option><option value="11">11</option><option value="12">12</option>
            <option value="13">13</option><option value="14">14</option><option value="15">15</option><option value="16">16</option>
          </select>
        </label>
        {persistence.error() && (
          <button
            class="text-amber-400 hover:text-amber-300 text-xs"
            onClick={() => {
              if (persistence.error()?.retryable) {
                void persistence.flush().catch(() => undefined)
              } else {
                persistence.dismissError()
              }
            }}
            title={persistence.error()?.error.message}
          >
            MIDI save failed — {persistence.error()?.retryable ? 'Retry' : 'Dismiss'}
          </button>
        )}
      </div>
    </div>
  )

  const sourceForKind = (mapping: MidiMapping, kind: MidiMapping['source']['kind']): MidiMapping['source'] => {
    const channel = mapping.source.channel
    if (kind === 'cc') return { kind, controller: mapping.source.kind === 'cc' ? mapping.source.controller : 1, channel }
    if (kind === 'poly-pressure') {
      const pitch = mapping.source.kind === 'poly-pressure' ? mapping.source.pitch : undefined
      return { kind, channel, pitch }
    }
    return { kind, channel }
  }

  const mappingSourceKind = (value: string): MidiMapping['source']['kind'] | undefined => (
    value === 'cc' || value === 'pitch-bend' || value === 'channel-pressure' || value === 'poly-pressure'
      ? value
      : undefined
  )

  const boundedMidiValue = (value: string) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.min(127, Math.max(0, Math.round(parsed))) : 0
  }

  const renderMappings = () => (
    <div class="border-b border-border bg-muted/40 px-3 py-1.5 text-xs">
      <div class="flex items-center gap-2">
        <span class="font-medium text-muted-foreground">Mappings</span>
        <button
          class="border border-border bg-app-surface px-1.5 py-0.5 text-foreground disabled:opacity-50"
          disabled={!persistence.canPersist()}
          aria-label="Add MIDI mapping"
          onClick={() => persistence.saveSoon({
            kind: 'insert-mapping',
            mapping: {
              id: crypto.randomUUID(),
              source: { kind: 'cc', controller: 1 },
              target: { parameterId: 'volume' },
              outputMin: 0,
              outputMax: 1,
            },
          })}
        >
          Add
        </button>
      </div>
      <div class="mt-1 flex max-h-24 flex-wrap content-start gap-x-2 gap-y-1 overflow-y-auto pr-1">
        <For each={mappings()}>
        {(mapping) => {
          const selectedTargetKey = midiMappingTargetKey(mapping.target)
          const available = createMemo(() => mappingTargets().some((option) => midiMappingTargetKey({
            parameterId: option.parameterId,
            effectInstanceId: option.effectInstanceId,
          }) === selectedTargetKey))
          return (
            <div class="flex shrink-0 flex-wrap items-center gap-1 border-l border-border pl-2">
              <select
                class="border border-border bg-app-surface px-1 py-0.5 text-foreground"
                aria-label={`Mapping source kind ${mapping.id}`}
                value={mapping.source.kind}
                disabled={!persistence.canPersist()}
                onChange={(event) => {
                  const kind = mappingSourceKind(event.currentTarget.value)
                  if (!kind) return
                  persistence.saveSoon({
                    kind: 'update-mapping',
                    id: mapping.id,
                    changes: { source: sourceForKind(mapping, kind) },
                  })
                }}
              >
                <option value="cc">CC</option>
                <option value="pitch-bend">Pitch bend</option>
                <option value="channel-pressure">Channel pressure</option>
                <option value="poly-pressure">Poly pressure</option>
              </select>
              {mapping.source.kind === 'cc' && (
                <input
                  class="w-11 border border-border bg-app-surface px-1 py-0.5 text-foreground"
                  aria-label={`Mapping CC controller ${mapping.id}`}
                  type="number"
                  min="0"
                  max="127"
                  value={mapping.source.kind === 'cc' ? mapping.source.controller : 0}
                  disabled={!persistence.canPersist()}
                  onChange={(event) => persistence.saveSoon({
                    kind: 'update-mapping',
                    id: mapping.id,
                    changes: {
                      source: {
                        kind: 'cc',
                        controller: boundedMidiValue(event.currentTarget.value),
                        channel: mapping.source.channel,
                      },
                    },
                  })}
                />
              )}
              <select
                class="border border-border bg-app-surface px-1 py-0.5 text-foreground"
                aria-label={`Mapping source channel ${mapping.id}`}
                value={mapping.source.channel ?? ''}
                disabled={!persistence.canPersist()}
                onChange={(event) => {
                  const channel = event.currentTarget.value === '' ? undefined : Number(event.currentTarget.value)
                  persistence.saveSoon({
                    kind: 'update-mapping',
                    id: mapping.id,
                    changes: { source: { ...mapping.source, ...(channel === undefined ? { channel: undefined } : { channel }) } },
                  })
                }}
              >
                <option value="">Omni</option>
                <For each={Array.from({ length: 16 }, (_, index) => index + 1)}>
                  {(channel) => <option value={channel}>{channel}</option>}
                </For>
              </select>
              {mapping.source.kind === 'poly-pressure' && (
                <input
                  class="w-11 border border-border bg-app-surface px-1 py-0.5 text-foreground"
                  aria-label={`Mapping poly pressure pitch ${mapping.id}`}
                  type="number"
                  min="0"
                  max="127"
                  placeholder="Any"
                  value={mapping.source.kind === 'poly-pressure' ? mapping.source.pitch ?? '' : ''}
                  disabled={!persistence.canPersist()}
                  onChange={(event) => {
                    const pitch = event.currentTarget.value === '' ? undefined : boundedMidiValue(event.currentTarget.value)
                    persistence.saveSoon({
                      kind: 'update-mapping',
                      id: mapping.id,
                      changes: { source: { ...mapping.source, ...(pitch === undefined ? { pitch: undefined } : { pitch }) } },
                    })
                  }}
                />
              )}
              <span class="text-muted-foreground">→</span>
              <select
                class="border border-border bg-app-surface px-1 py-0.5 text-foreground"
                aria-label={`Mapping target ${mapping.id}`}
                value={available() ? selectedTargetKey : ''}
                disabled={!persistence.canPersist()}
                onChange={(event) => {
                  const option = mappingTargets().find((candidate) => midiMappingTargetKey({
                    parameterId: candidate.parameterId,
                    effectInstanceId: candidate.effectInstanceId,
                  }) === event.currentTarget.value)
                  if (!option) return
                  persistence.saveSoon({
                    kind: 'update-mapping',
                    id: mapping.id,
                    changes: {
                      target: {
                        parameterId: option.parameterId,
                        effectInstanceId: option.effectInstanceId,
                      },
                    },
                  })
                }}
              >
                <option value="" disabled>{available() ? 'Select supported target' : 'Unavailable target'}</option>
                <For each={mappingTargets()}>
                  {(option) => (
                    <option value={midiMappingTargetKey({
                      parameterId: option.parameterId,
                      effectInstanceId: option.effectInstanceId,
                    })}>
                      {option.device}: {option.label}
                    </option>
                  )}
                </For>
              </select>
              <input
                class="w-12 border border-border bg-app-surface px-1 py-0.5 text-foreground"
                aria-label={`Mapping minimum ${mapping.id}`}
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={mapping.outputMin}
                disabled={!persistence.canPersist() || !available()}
                onChange={(event) => persistence.saveSoon({ kind: 'update-mapping', id: mapping.id, changes: { outputMin: Number(event.currentTarget.value) } })}
              />
              <input
                class="w-12 border border-border bg-app-surface px-1 py-0.5 text-foreground"
                aria-label={`Mapping maximum ${mapping.id}`}
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={mapping.outputMax}
                disabled={!persistence.canPersist() || !available()}
                onChange={(event) => persistence.saveSoon({ kind: 'update-mapping', id: mapping.id, changes: { outputMax: Number(event.currentTarget.value) } })}
              />
              <button
                class="text-muted-foreground hover:text-foreground"
                aria-label={`Remove MIDI mapping ${mapping.id}`}
                disabled={!persistence.canPersist()}
                onClick={() => persistence.saveSoon({ kind: 'delete-mapping', id: mapping.id })}
              >
                ×
              </button>
            </div>
          )
        }}
        </For>
      </div>
    </div>
  )

  const renderPianoGutter = () => (
    <div class="bg-app-surface border-r border-border select-none">
      <div class="grid w-full" style={{ 'grid-template-rows': grid().rowTemplate }}>
        <For each={grid().rows}>
          {(row) => {
            const pitch = grid().pitchForRow(row)
            const isBlackKey = grid().isBlackKey(pitch)
            return (
              <button
                type="button"
                class={cn(
                  'relative flex w-full cursor-pointer items-center justify-center border-b border-border font-mono text-2xs',
                  props.midiKeyboard.isActive(pitch)
                    ? 'border-green-400 bg-green-600/50 text-white'
                    : isBlackKey
                      ? 'bg-secondary/70 text-foreground'
                      : 'bg-muted/70 text-foreground',
                )}
                onPointerDown={() => {
                  if (props.trackId) props.onAuditionNote?.(props.trackId, pitch, DEFAULT_NOTE_VELOCITY, grid().noteDurationSeconds(1, 0.6))
                }}
                aria-label={`Audition ${grid().noteName(pitch)}`}
              >
                <span class="opacity-80">{grid().noteName(pitch)}</span>
              </button>
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
          <div class={cn('border', major ? 'border-border' : 'border-border')} />
        )}
      </For>
    </div>
  )

  const renderNotes = () => (
    <div class="absolute left-0 right-0 pointer-events-none" style={{ top: '0px', height: `${grid().contentHeight}px` }}>
      <For each={notes()}>
        {(note) => (
          <div
            class={cn(
              'absolute bg-green-500/70 border pointer-events-auto',
              selectedNoteIds().includes(note.id)
                ? 'border-foreground ring-1 ring-foreground'
                : 'border-green-400/80',
            )}
            aria-selected={selectedNoteIds().includes(note.id)}
            data-midi-note-id={note.id}
            style={{
              left: `${grid().noteLeftPercent(note)}%`,
              top: `${grid().noteTop(note)}px`,
              width: `${grid().noteWidthPercent(note)}%`,
              height: `${grid().noteHeight}px`,
              opacity: 0.35 + 0.65 * displayedVelocity(note),
              cursor: 'grab',
            }}
            onPointerDown={(event) => onNotePointerDown(note.id, event.currentTarget, event)}
            onClick={stopAndPreventEditorEvent}
            onDblClick={(event) => {
              stopAndPreventEditorEvent(event)
              if (!persistence.canPersist()) { warnMissingUser(); return }
              deleteNote(note.id)
            }}
            data-midi-note="1"
          />
        )}
      </For>
    </div>
  )

  const renderBody = () => (
    <div class="relative w-full flex-1 min-h-0">
      <div class="absolute inset-0 grid overflow-y-auto" style={{ 'grid-template-columns': '44px 1fr' }}>
        {renderPianoGutter()}
        <div class="relative bg-app-surface" ref={(el) => (gridRef = el)} onPointerDown={onGridPointerDown}>
          {renderGridCells()}
          {renderNotes()}
        </div>
      </div>
    </div>
  )

  // Focusing the root on pointerdown routes Delete/Backspace and Space by the keydown target.
  // Text fields and buttons keep their own focus, which is still inside the root.
  const focusEditorOnPointerDown = (event: PointerEvent) => {
    stopEditorEvent(event)
    if (isEditableKeyboardTarget(event.target) || isButtonKeyboardTarget(event.target)) return
    root?.focus({ preventScroll: true })
  }

  // Fixed-height lane outside the scrolling body, so vertical grid scroll does not move it.
  // Markers sit on the same column template as the grid, so they line up with note starts.
  // The marker area starts 6px down, so a 127 head sits fully inside the lane.
  // Only heads take pointer events; a lower value stacks above a higher one where heads overlap.
  const renderVelocityLane = () => (
    <div class="grid h-16 shrink-0 border-t border-border bg-muted/40 select-none" style={{ 'grid-template-columns': '44px 1fr' }}>
      <div class="relative border-r border-border bg-app-surface font-mono text-2xs text-muted-foreground">
        <span class="absolute right-1 top-0.5">127</span>
        <span class="absolute right-1 top-1/2 -translate-y-1/2">64</span>
        <span class="absolute bottom-0.5 right-1">1</span>
      </div>
      <div class="relative">
        <Show when={velocityDrag()}>
          {(drag) => (
            <span class="pointer-events-none absolute left-1.5 top-0.5 font-mono text-2xs text-foreground">
              Velocity {midiVelocityValue(drag().velocity)}
            </span>
          )}
        </Show>
        <div ref={(el) => (velocityLaneRef = el)} class="absolute inset-x-0 bottom-0 top-1.5">
          <For each={notes()}>
            {(note) => (
              <div
                class="pointer-events-none absolute bottom-0 w-3 -translate-x-1/2"
                style={{
                  left: `${grid().noteLeftPercent(note)}%`,
                  height: `${displayedVelocity(note) * 100}%`,
                  'z-index': 128 - midiVelocityValue(displayedVelocity(note)),
                }}
                data-midi-velocity="1"
              >
                <div class="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-green-400/80" />
                <div
                  class={cn(
                    'pointer-events-auto absolute left-1/2 top-0 flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center',
                    persistence.canPersist() ? 'cursor-ns-resize' : 'cursor-default',
                  )}
                  onPointerDown={(event) => onVelocityPointerDown(note.id, event)}
                >
                  <div
                    class={cn(
                      'size-2.5 rounded-full border border-green-400/80',
                      velocityDrag()?.noteId === note.id ? 'bg-green-300' : 'bg-green-500/70',
                    )}
                  />
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  )

  return (
    <div
      ref={(el) => (root = el)}
      tabIndex={-1}
      class="flex flex-col h-full min-h-0 bg-app-surface outline-none"
      data-timeline-keyboard-local="true"
      data-timeline-keyboard-duplicate-enabled={persistence.canPersist() && selectedNoteIds().length > 0 ? 'true' : 'false'}
      onPointerDown={focusEditorOnPointerDown}
      onKeyDown={onEditorKeyDown}
      onClick={stopEditorEvent}
      onWheel={stopEditorEvent}
      onContextMenu={stopAndPreventEditorEvent}
    >
      {renderHeader()}
      {renderMappings()}
      {renderBody()}
      {renderVelocityLane()}
    </div>
  )
}

export default MidiClipEditor
