import { type Component, createMemo, createSignal, onCleanup, createEffect, For } from 'solid-js'
import { cn } from '~/lib/utils'
import { useDrag } from '~/hooks/useDrag'
import { useMidiEditorPersistence } from '~/hooks/useMidiEditorPersistence'
import {
  createTimelineMidiBoundsDrag,
  type TimelineMidiBounds,
} from '~/lib/timeline-midi-bounds'
import { createMidiEditorGrid, type MidiEditorNote, type MidiNoteDrag } from '~/lib/midi-editor-grid'
import {
  getAutomationParameterOptionsForTarget,
  isMidiMappingTargetSupported,
  midiMappingTargetKey,
  normalizeLegacyMidiClip,
  type AutomationTargetDeviceInstance,
  type MidiMapping,
} from '@daw-browser/shared'
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
  canWrite: boolean
  // Optional: preview note when adding/dragging
  onAuditionNote?: (pitch: number, velocity?: number, durSec?: number) => void
  // Local-only: current room id for per-room persistence
  projectId?: string
  midiKeyboard: {
    isActive: (pitch: number) => boolean
  }
  onLocalMidiSaved?: (clipId: string, midi: Clip['midi']) => void
  trackId?: string
  effectInstances?: readonly AutomationTargetDeviceInstance[]
}

const MidiEditorCard: Component<MidiEditorCardProps> = (props) => {
  const [notes, setNotes] = createSignal<MidiEditorNote[]>([])
  const [mappings, setMappings] = createSignal<MidiMapping[]>([])
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
  const mappingTargets = createMemo(() => getAutomationParameterOptionsForTarget(
    props.effectInstances ?? [],
    props.trackId,
  ).filter((option) => isMidiMappingTargetSupported({
    parameterId: option.parameterId,
    ...(option.effectInstanceId === undefined ? {} : { effectInstanceId: option.effectInstanceId }),
  })))

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
  type DragState = {
    noteId: string
    drag: MidiNoteDrag
    draft: MidiEditorNote
    started: boolean
    changed: boolean
  }
  let dragNote: DragState | null = null
  let projectedNotes: MidiEditorNote[] = []

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
    const existing = grid().findNoteAtCell(notes(), cell)
    if (existing) {
      setNotes(prev => grid().removeNoteById(prev, existing.id))
      persistence.saveSoon({ kind: 'delete', id: existing.id })
    } else {
      const channel = projectedMidi()?.inputChannel ?? 1
      const note = grid().noteFromCell(cell, crypto.randomUUID(), channel)
      const length = lastCreatedNoteLength() || note.length
      const nextNote = { ...note, length }
      setNotes(prev => [...prev, nextNote])
      props.onAuditionNote?.(nextNote.pitch, nextNote.velocity, grid().noteDurationSeconds(nextNote.length, 0.5))
      persistence.saveSoon({ kind: 'insert', note: nextNote })
    }
  }

  // Drag to move/resize notes
  const noteDragListenerOptions: AddEventListenerOptions = { capture: true }
  const cleanupNoteDragListeners = () => {
    window.removeEventListener('pointermove', onNotePointerMove, noteDragListenerOptions)
    window.removeEventListener('pointerup', onNotePointerUp, noteDragListenerOptions)
    window.removeEventListener('pointercancel', onNotePointerCancel, noteDragListenerOptions)
  }
  const cancelNoteDrag = () => {
    cleanupNoteDragListeners()
    dragNote = null
    setNotes(projectedNotes)
  }
  const onNotePointerDown = (noteId: string, target: HTMLElement, e: PointerEvent) => {
    if (!persistence.canPersist()) { warnMissingUser(); return }
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    // If this is a double-click, don't start dragging; deletion is handled by onDblClick
    if (e.detail >= 2) {
      return
    }
    const n = grid().findNoteById(notes(), noteId); if (!n) return
    const el = gridRef; if (!el) return
    const rect = target.getBoundingClientRect()
    const nearRight = (e.clientX - rect.left) > rect.width * 0.7
    const cell = pointToCell(el, e)
    dragNote = {
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
    window.addEventListener('pointermove', onNotePointerMove, noteDragListenerOptions)
    window.addEventListener('pointerup', onNotePointerUp, noteDragListenerOptions)
    window.addEventListener('pointercancel', onNotePointerCancel, noteDragListenerOptions)
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

    const next = grid().noteFromDrag(drag.drag, cell, pointerStep)
    if (grid().notesEqual(note, next)) return
    drag.changed = true
    drag.draft = next
    setNotes(prev => grid().replaceNoteById(prev, drag.noteId, next))
    if (drag.drag.mode === 'move' && note.pitch !== next.pitch) {
      props.onAuditionNote?.(next.pitch, next.velocity ?? 0.9, grid().noteDurationSeconds(next.length, 0.25))
    }
  }
  const onNotePointerUp = (_e: PointerEvent) => {
    const drag = dragNote
    cleanupNoteDragListeners()
    if (!persistence.canPersist()) {
      cancelNoteDrag()
      return
    }
    if (drag?.changed) {
      const note = grid().findNoteById(notes(), drag.noteId)
      if (note) setLastCreatedNoteLength(note.length)
      if (note) {
        const changes = drag.drag.mode === 'resize'
          ? { length: note.length }
          : { beat: note.beat, pitch: note.pitch }
        persistence.saveSoon({ kind: 'update', id: drag.noteId, changes })
      }
    }
    dragNote = null
  }
  const onNotePointerCancel = () => {
    cancelNoteDrag()
  }
  createEffect(() => {
    if (!persistence.canPersist() && dragNote) cancelNoteDrag()
  })
  onCleanup(cleanupNoteDragListeners)

  const renderHeader = () => (
    <div
      class="flex items-center justify-between px-3 py-2 bg-muted border-b border-border cursor-move select-none"
      onPointerDown={onHeaderPointerDown}
    >
      <div class="flex items-center gap-3 text-sm font-semibold text-foreground">
        <div class="flex items-center gap-2">
          <span>MIDI Editor</span>
        </div>
        <span class="text-muted-foreground">•</span>
        <span class="text-muted-foreground text-xs">Clip: {props.clipId.slice(0, 8)}</span>
        <span class="text-muted-foreground text-xs">BPM: {props.bpm}</span>
        <label class="flex items-center gap-1 text-xs font-normal text-muted-foreground" onPointerDown={stopEditorEvent}>
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
            onPointerDown={stopEditorEvent}
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
      <button
        class="text-muted-foreground hover:text-foreground px-2 py-0.5 text-sm"
        onPointerDown={stopEditorEvent}
        onClick={props.onClose}
        aria-label="Close MIDI editor"
      >
        ✕
      </button>
    </div>
  )

  const sourceForKind = (mapping: MidiMapping, kind: MidiMapping['source']['kind']): MidiMapping['source'] => {
    const channel = mapping.source.channel
    if (kind === 'cc') return { kind, controller: mapping.source.kind === 'cc' ? mapping.source.controller : 1, ...(channel === undefined ? {} : { channel }) }
    if (kind === 'poly-pressure') {
      const pitch = mapping.source.kind === 'poly-pressure' ? mapping.source.pitch : undefined
      return { kind, ...(channel === undefined ? {} : { channel }), ...(pitch === undefined ? {} : { pitch }) }
    }
    return { kind, ...(channel === undefined ? {} : { channel }) }
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
    <div class="border-b border-border bg-muted/40 px-3 py-1.5 text-xs" onPointerDown={stopEditorEvent}>
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
            ...(option.effectInstanceId === undefined ? {} : { effectInstanceId: option.effectInstanceId }),
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
                        ...(mapping.source.channel === undefined ? {} : { channel: mapping.source.channel }),
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
                    ...(candidate.effectInstanceId === undefined ? {} : { effectInstanceId: candidate.effectInstanceId }),
                  }) === event.currentTarget.value)
                  if (!option) return
                  persistence.saveSoon({
                    kind: 'update-mapping',
                    id: mapping.id,
                    changes: {
                      target: {
                        parameterId: option.parameterId,
                        ...(option.effectInstanceId === undefined ? {} : { effectInstanceId: option.effectInstanceId }),
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
                      ...(option.effectInstanceId === undefined ? {} : { effectInstanceId: option.effectInstanceId }),
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
                onPointerDown={(event) => {
                  stopEditorEvent(event)
                  props.onAuditionNote?.(pitch, 0.9, grid().noteDurationSeconds(1, 0.6))
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
            class="absolute bg-green-500/70 border border-green-400/80 pointer-events-auto"
            style={{
              left: `${grid().noteLeftPercent(note)}%`,
              top: `${grid().noteTop(note)}px`,
              width: `${grid().noteWidthPercent(note)}%`,
              height: `${grid().noteHeight}px`,
              cursor: 'grab',
            }}
            onPointerDown={(event) => onNotePointerDown(note.id, event.currentTarget, event)}
            onClick={stopAndPreventEditorEvent}
            onDblClick={(event) => {
              stopAndPreventEditorEvent(event)
              if (!persistence.canPersist()) { warnMissingUser(); return }
              setNotes(prev => grid().removeNoteById(prev, note.id))
              persistence.saveSoon({ kind: 'delete', id: note.id })
            }}
            data-midi-note="1"
          />
        )}
      </For>
    </div>
  )

  const renderBody = () => (
    <div class="relative w-full" style={{ height: 'calc(100% - 66px)' }}>
      <div class="absolute inset-0 grid overflow-y-auto" style={{ 'grid-template-columns': '44px 1fr' }}>
        {renderPianoGutter()}
        <div class="relative bg-app-surface" ref={(el) => (gridRef = el)} onPointerDown={onGridClick}>
          {renderGridCells()}
          {renderNotes()}
        </div>
      </div>
      <div
        class="absolute right-1 bottom-1 w-4 h-4 cursor-se-resize bg-secondary/60 hover:bg-secondary/70"
        onPointerDown={onResizerPointerDown}
        title="Resize"
      />
    </div>
  )

  return (
    <div
      class="absolute z-50 border border-border bg-app-surface shadow-xl overflow-hidden"
      style={{ left: `${props.bounds.x}px`, top: `${props.bounds.y}px`, width: `${props.bounds.w}px`, height: `${props.bounds.h}px` }}
      onPointerDown={stopEditorEvent}
      onClick={stopEditorEvent}
      onWheel={stopEditorEvent}
      onContextMenu={stopAndPreventEditorEvent}
    >
      {renderHeader()}
      {renderMappings()}
      {renderBody()}
    </div>
  )
}

export default MidiEditorCard
