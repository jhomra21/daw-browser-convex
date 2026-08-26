import {
  controlCommitResultSchemaV1,
  projectSnapshotSchemaV2,
  type ControlActionV1,
  type ProjectSnapshotV2,
} from '@daw-browser/control'
import { isLocalId, normalizeLegacyMidiClip, type MidiMapping, type NormalizedLegacyMidiClip } from '@daw-browser/shared'
import { convexApi, convexClient } from '~/lib/convex'
import { createLocalControlService } from '~/lib/local-control/local-control-service'
import { registerPendingLocalProjectWriteFlusher } from '~/lib/local-project-pending-writes'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import { serializeJsonValue } from '~/lib/json'
import { z } from 'zod'

export type MidiEditorNote = NormalizedLegacyMidiClip['notes'][number] & { id: string; channel: number }

export type MidiEditorOperation =
  | { kind: 'insert'; note: MidiEditorNote }
  | { kind: 'update'; id: string; changes: Partial<Pick<MidiEditorNote, 'beat' | 'length' | 'pitch' | 'velocity' | 'channel'>> }
  | { kind: 'delete'; id: string }
  | { kind: 'set-input-channel'; inputChannel: number | undefined }
  | { kind: 'insert-mapping'; mapping: MidiMapping }
  | { kind: 'update-mapping'; id: string; changes: Partial<Omit<MidiMapping, 'id'>> }
  | { kind: 'delete-mapping'; id: string }

export class MidiEditorConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MidiEditorConflictError'
  }
}

class MidiEditorClipConflictError extends MidiEditorConflictError {}

export type MidiEditorPersistenceError = {
  error: Error
  retryable: boolean
  operationIds?: string[]
}

const localActor = { subject: 'timeline-midi-editor' }
type MidiAdapter = {
  clipId: string
  flush: () => Promise<void>
  discard: () => void
  project: (midi: NormalizedLegacyMidiClip) => NormalizedLegacyMidiClip
}

const midiAdapters = new Map<string, Set<MidiAdapter>>()
const midiCommitChains = new Map<string, Promise<void>>()
const projectionListeners = new Map<string, Set<() => void>>()

const adapterKey = (projectId: string) => projectId

const notifyMidiProjectProjection = (projectId: string) => {
  for (const listener of projectionListeners.get(adapterKey(projectId)) ?? []) listener()
}

export const subscribeMidiProjectProjection = (projectId: string, listener: () => void) => {
  const key = adapterKey(projectId)
  const listeners = projectionListeners.get(key) ?? new Set<() => void>()
  listeners.add(listener)
  projectionListeners.set(key, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) projectionListeners.delete(key)
  }
}

const registerAdapter = (projectId: string, adapter: MidiAdapter) => {
  const key = adapterKey(projectId)
  const entries = midiAdapters.get(key) ?? new Set<MidiAdapter>()
  entries.add(adapter)
  midiAdapters.set(key, entries)
  return () => {
    entries.delete(adapter)
    if (entries.size === 0) midiAdapters.delete(key)
  }
}

const serializeProjectMidiCommit = async <Value>(
  projectId: string,
  callback: () => Promise<Value>,
): Promise<Value> => {
  const previous = midiCommitChains.get(projectId) ?? Promise.resolve()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const chain = previous.then(() => gate, () => gate)
  midiCommitChains.set(projectId, chain)
  await previous
  try {
    return await callback()
  } finally {
    release?.()
    if (midiCommitChains.get(projectId) === chain) midiCommitChains.delete(projectId)
  }
}

export const flushMidiProjectWrites = async (projectId: string): Promise<void> => {
  await Promise.all(Array.from(midiAdapters.get(adapterKey(projectId)) ?? [], (adapter) => adapter.flush()))
}

export const flushAllMidiProjectWrites = async (): Promise<void> => {
  await Promise.all(Array.from(midiAdapters.values()).flatMap((entries) => (
    Array.from(entries, (adapter) => adapter.flush())
  )))
}

export const projectMidiProjectTracks = (
  projectId: string,
  tracks: RuntimeTrack[],
): RuntimeTrack[] => {
  const adapters = new Map(
    Array.from(midiAdapters.get(adapterKey(projectId)) ?? [], (adapter) => [adapter.clipId, adapter]),
  )
  if (adapters.size === 0) return tracks
  return tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      if (!clip.midi) return clip
      const adapter = adapters.get(clip.id)
      return adapter ? { ...clip, midi: adapter.project(normalizeLegacyMidiClip(clip.midi)) } : clip
    }),
  }))
}

export const discardMidiProjectWrites = (projectId: string): void => {
  for (const adapter of midiAdapters.get(adapterKey(projectId)) ?? []) adapter.discard()
}

const sameNote = (left: MidiEditorNote, right: MidiEditorNote) => (
  left.id === right.id
  && left.beat === right.beat
  && left.length === right.length
  && left.pitch === right.pitch
  && left.velocity === right.velocity
  && left.channel === right.channel
)

const noteWithChannel = (note: NormalizedLegacyMidiClip['notes'][number]): MidiEditorNote => ({
  ...note,
  id: note.id ?? '',
  channel: note.channel ?? 1,
})

const isOperationReflected = (
  midi: NormalizedLegacyMidiClip,
  operation: MidiEditorOperation,
) => {
  if (operation.kind === 'set-input-channel') return midi.inputChannel === operation.inputChannel
  if (operation.kind === 'insert-mapping') {
    return JSON.stringify(midi.mappings.find((mapping) => mapping.id === operation.mapping.id)) === JSON.stringify(operation.mapping)
  }
  if (operation.kind === 'delete-mapping') return !midi.mappings.some((mapping) => mapping.id === operation.id)
  if (operation.kind === 'update-mapping') {
    const mapping = midi.mappings.find((candidate) => candidate.id === operation.id)
    return mapping !== undefined
      && (operation.changes.source === undefined || JSON.stringify(mapping.source) === JSON.stringify(operation.changes.source))
      && (operation.changes.target === undefined || JSON.stringify(mapping.target) === JSON.stringify(operation.changes.target))
      && (operation.changes.outputMin === undefined || mapping.outputMin === operation.changes.outputMin)
      && (operation.changes.outputMax === undefined || mapping.outputMax === operation.changes.outputMax)
  }
  const note = midi.notes.find((candidate) => candidate.id === (
    operation.kind === 'insert' ? operation.note.id : operation.id
  ))
  if (operation.kind === 'insert') return note !== undefined && sameNote(noteWithChannel(note), operation.note)
  if (operation.kind === 'delete') return note === undefined
  return note !== undefined
    && (operation.changes.beat === undefined || note.beat === operation.changes.beat)
    && (operation.changes.length === undefined || note.length === operation.changes.length)
    && (operation.changes.pitch === undefined || note.pitch === operation.changes.pitch)
    && (operation.changes.velocity === undefined || note.velocity === operation.changes.velocity)
    && (operation.changes.channel === undefined || (note.channel ?? 1) === operation.changes.channel)
}

const midiFingerprint = (midi: NormalizedLegacyMidiClip) => JSON.stringify(midi)

type AwaitingMidiReconciliation = {
  commitRevision: number
  operations: MidiEditorOperation[]
}

export const createAwaitingMidiReconciliation = (
  operations: readonly MidiEditorOperation[],
  commitRevision = 0,
): AwaitingMidiReconciliation => ({
  commitRevision,
  operations: [...operations],
})

export const reconcileAwaitingMidiReconciliation = (
  overlay: AwaitingMidiReconciliation,
  midi: NormalizedLegacyMidiClip,
): AwaitingMidiReconciliation | undefined => {
  const operations = reconcileMidiEditorOperations(midi, overlay.operations)
  return operations.length > 0 ? { ...overlay, operations } : undefined
}

export const reconcileMidiEditorOperations = (
  midi: NormalizedLegacyMidiClip,
  operations: readonly MidiEditorOperation[],
) => operations.filter((operation) => !isOperationReflected(midi, operation))

export const applyMidiEditorOperations = (
  midi: NormalizedLegacyMidiClip,
  operations: readonly MidiEditorOperation[],
): NormalizedLegacyMidiClip => {
  let notes = [...midi.notes].map((note) => ({ ...note, channel: note.channel ?? 1 }))
  let mappings = [...midi.mappings]
  for (const operation of operations) {
    if (operation.kind === 'set-input-channel') {
      midi = { ...midi, ...(operation.inputChannel === undefined ? { inputChannel: undefined } : { inputChannel: operation.inputChannel }) }
      continue
    }
    if (operation.kind === 'insert-mapping') {
      const existing = mappings.find((mapping) => mapping.id === operation.mapping.id)
      if (!existing) mappings = [...mappings, operation.mapping]
      else if (JSON.stringify(existing) !== JSON.stringify(operation.mapping)) {
        throw new MidiEditorConflictError(`MIDI mapping "${operation.mapping.id}" already exists with different values.`)
      }
      continue
    }
    if (operation.kind === 'delete-mapping') {
      mappings = mappings.filter((mapping) => mapping.id !== operation.id)
      continue
    }
    if (operation.kind === 'update-mapping') {
      if (!mappings.some((mapping) => mapping.id === operation.id)) {
        throw new MidiEditorConflictError(`MIDI mapping "${operation.id}" was removed remotely.`)
      }
      mappings = mappings.map((mapping) => mapping.id === operation.id ? { ...mapping, ...operation.changes } : mapping)
      continue
    }
    if (operation.kind === 'insert') {
      const index = notes.findIndex((note) => note.id === operation.note.id)
      if (index < 0) {
        notes = [...notes, operation.note]
      } else if (!sameNote({ ...notes[index]!, id: notes[index]!.id ?? operation.note.id }, operation.note)) {
        throw new MidiEditorConflictError(`MIDI note "${operation.note.id}" already exists with different values.`)
      }
      continue
    }
    const index = notes.findIndex((note) => note.id === operation.id)
    if (operation.kind === 'delete') {
      if (index >= 0) notes = notes.filter((note) => note.id !== operation.id)
      continue
    }
    if (index < 0) {
      throw new MidiEditorConflictError(`MIDI note "${operation.id}" was removed remotely.`)
    }
    notes = notes.map((note) => note.id === operation.id ? { ...note, ...operation.changes } : note)
  }
  return { ...midi, notes, mappings }
}

export const projectMidiEditorOperations = (
  midi: NormalizedLegacyMidiClip,
  operations: readonly MidiEditorOperation[],
): NormalizedLegacyMidiClip => reconcileMidiEditorOperationBatch(midi, operations).midi

export const reconcileMidiEditorOperationBatch = (
  midi: NormalizedLegacyMidiClip,
  operations: readonly MidiEditorOperation[],
): MidiEditorOperationBatch => {
  let projected = midi
  const conflicts: MidiEditorOperation[] = []
  for (const operation of operations) {
    try {
      projected = applyMidiEditorOperations(projected, [operation])
    } catch (error) {
      if (!(error instanceof MidiEditorConflictError)) throw error
      conflicts.push(operation)
    }
  }
  return { midi: projected, conflicts }
}

type MidiEditorOperationBatch = {
  midi: NormalizedLegacyMidiClip
  conflicts: MidiEditorOperation[]
}

const coalesceOperations = (operations: readonly MidiEditorOperation[]) => {
  const result: MidiEditorOperation[] = []
  for (const operation of operations) {
    const entryKey = (entry: MidiEditorOperation) => entry.kind === 'insert'
      ? entry.note.id
      : entry.kind === 'insert-mapping' ? `mapping:${entry.mapping.id}`
        : entry.kind === 'set-input-channel' ? 'input-channel' : entry.kind === 'update-mapping' || entry.kind === 'delete-mapping' ? `mapping:${entry.id}` : entry.id
    const index = result.findIndex((entry) => entryKey(entry) === entryKey(operation))
    const previous = index < 0 ? undefined : result[index]
    if (previous?.kind === 'insert' && operation.kind === 'update') {
      result[index] = { kind: 'insert', note: { ...previous.note, ...operation.changes } }
    } else if (previous?.kind === 'insert' && operation.kind === 'delete') {
      result.splice(index, 1)
    } else if (previous?.kind === 'update' && operation.kind === 'update') {
      result[index] = { kind: 'update', id: operation.id, changes: { ...previous.changes, ...operation.changes } }
    } else if (previous?.kind === 'update' && operation.kind === 'delete') {
      result[index] = operation
    } else if (previous?.kind === 'delete' && operation.kind === 'update') {
      continue
    } else if (operation.kind === 'set-input-channel') {
      if (index >= 0) result[index] = operation
      else result.push(operation)
    } else if (previous?.kind === 'insert-mapping' && operation.kind === 'update-mapping') {
      result[index] = { kind: 'insert-mapping', mapping: { ...previous.mapping, ...operation.changes } }
    } else if (previous?.kind === 'insert-mapping' && operation.kind === 'delete-mapping') {
      result.splice(index, 1)
    } else if (previous?.kind === 'update-mapping' && operation.kind === 'update-mapping') {
      result[index] = { kind: 'update-mapping', id: operation.id, changes: { ...previous.changes, ...operation.changes } }
    } else if (previous?.kind === 'update-mapping' && operation.kind === 'delete-mapping') {
      result[index] = operation
    } else {
      result.push(operation)
    }
  }
  return result
}

const commitAction = (clipId: string, midi: NormalizedLegacyMidiClip): ControlActionV1 => ({
  kind: 'clip.midi.set',
  clip: { source: 'persisted', id: clipId },
  wave: midi.wave,
  gain: midi.gain,
  notes: midi.notes,
  inputChannel: midi.inputChannel ?? null,
  cc: midi.cc.length === 0 ? undefined : midi.cc,
  pitchBends: midi.pitchBends.length === 0 ? undefined : midi.pitchBends,
  channelPressure: midi.channelPressure.length === 0 ? undefined : midi.channelPressure,
  polyPressure: midi.polyPressure.length === 0 ? undefined : midi.polyPressure,
  mappings: midi.mappings,
})

const codedErrorSchema = z.object({ code: z.string() })
const nestedCodedErrorSchema = z.object({ data: codedErrorSchema })

const errorCode = (cause: unknown) => {
  const direct = codedErrorSchema.safeParse(cause)
  if (direct.success) return direct.data.code
  const nested = nestedCodedErrorSchema.safeParse(cause)
  return nested.success ? nested.data.data.code : undefined
}

const terminalError = (cause: unknown) => (
  cause instanceof MidiEditorConflictError
  || errorCode(cause) === 'not-found'
  || errorCode(cause) === 'validation'
  || errorCode(cause) === 'limit-exceeded'
  || errorCode(cause) === 'forbidden'
  || errorCode(cause) === 'authorization'
)

const asError = (cause: unknown) => (
  cause instanceof Error ? cause : new Error('Unable to save MIDI changes.')
)

const operationId = (operation: MidiEditorOperation) => (
  operation.kind === 'insert' ? operation.note.id
    : operation.kind === 'insert-mapping' ? operation.mapping.id
      : operation.kind === 'set-input-channel' ? 'input-channel' : operation.id
)

const clipMidi = (snapshot: ProjectSnapshotV2, clipId: string) => {
  const clip = snapshot.clips.find((entry) => entry.id === clipId)
  if (!clip) throw new MidiEditorClipConflictError('The MIDI clip was removed remotely.')
  if (!('midi' in clip) || clip.midi === undefined) throw new MidiEditorClipConflictError('The MIDI clip is no longer editable.')
  return normalizeLegacyMidiClip(clip.midi)
}

export const createMidiEditorPersistence = (input: {
  projectId: string
  clipId: string
  onCommitted?: (midi: NormalizedLegacyMidiClip) => void
  onError?: (error: MidiEditorPersistenceError) => void
  onSettled?: () => void
}) => {
  const local = isLocalId('project', input.projectId)
  const service = local
    ? createLocalControlService({
      actor: localActor,
      projectId: input.projectId,
      excludePendingWriteKinds: ['midi'],
    })
    : undefined
  let revision: number | undefined
  let pending: MidiEditorOperation[] = []
  let inFlightOperations: MidiEditorOperation[] = []
  let awaitingReconciliation: AwaitingMidiReconciliation | undefined
  let authoritativeMidi: NormalizedLegacyMidiClip | undefined
  let reconciliationQuery: Promise<void> | undefined
  let reconciledInputFingerprint: string | undefined
  let inFlight: Promise<void> | undefined
  let disposed = false
  let discarded = false
  let lastError: MidiEditorPersistenceError | undefined

  const reconcile = (midi: NormalizedLegacyMidiClip) => {
    const overlay = awaitingReconciliation
    if (authoritativeMidi && midiFingerprint(authoritativeMidi) === midiFingerprint(midi)) {
      authoritativeMidi = undefined
    }
    if (!overlay) return
    awaitingReconciliation = reconcileAwaitingMidiReconciliation(overlay, midi)
    notifyMidiProjectProjection(input.projectId)
    if (!awaitingReconciliation || local || reconciledInputFingerprint === midiFingerprint(midi) || reconciliationQuery) return
    reconciledInputFingerprint = midiFingerprint(midi)
    const commitRevision = awaitingReconciliation.commitRevision
    reconciliationQuery = snapshot().then((canonical) => {
      const canonicalMidi = clipMidi(canonical, input.clipId)
      const current = awaitingReconciliation
      if (!current || current.commitRevision !== commitRevision) return
      const remaining = reconcileAwaitingMidiReconciliation(current, canonicalMidi)
      if (remaining && canonical.project.revision >= commitRevision) {
        authoritativeMidi = canonicalMidi
        awaitingReconciliation = undefined
        notifyMidiProjectProjection(input.projectId)
      }
    }).catch((error) => {
      input.onError?.({ error: asError(error), retryable: true })
    }).finally(() => {
      reconciliationQuery = undefined
      input.onSettled?.()
    })
  }

  const snapshot = async () => {
    const value = local
      ? await service!.snapshotV2({ projectId: input.projectId })
      : await convexClient.query(convexApi.control.snapshotV2, { projectId: input.projectId })
    const parsed = projectSnapshotSchemaV2.parse(value)
    revision = parsed.project.revision
    return parsed
  }

  const attemptOperations = async (operations: readonly MidiEditorOperation[], retryAfterConflict: boolean): Promise<void> => {
    const base = await snapshot()
    const baseMidi = clipMidi(base, input.clipId)
    // Committed operations remain a visual overlay while subscriptions catch up.
    // Reapplying them to this fresh write snapshot would overwrite collaborators.
    const midi = applyMidiEditorOperations(baseMidi, operations)
    const key = `midi-editor-${crypto.randomUUID()}`
    const request = {
      version: 'v1' as const,
      projectId: input.projectId,
      expectedRevision: revision,
      idempotencyKey: key,
      actions: [commitAction(input.clipId, midi)],
    }
    const commit = async () => {
      const value = local
        ? await service!.commit(serializeJsonValue(request))
        : await convexClient.mutation(convexApi.control.commitV1, { request: serializeJsonValue(request) })
      return controlCommitResultSchemaV1.parse(value)
    }
    try {
      const result = await commit().catch(async (error) => {
        if (errorCode(error) !== undefined) throw error
        return commit()
      })
      revision = result.revision
      if (!local) {
        awaitingReconciliation = awaitingReconciliation
          ? {
              commitRevision: result.revision,
              operations: [...awaitingReconciliation.operations, ...operations],
            }
          : createAwaitingMidiReconciliation(operations, result.revision)
        authoritativeMidi = undefined
        reconciledInputFingerprint = undefined
      }
      input.onCommitted?.(midi)
      notifyMidiProjectProjection(input.projectId)
    } catch (error) {
      if (errorCode(error) === 'revision-conflict' && !retryAfterConflict) {
        await attemptOperations(operations, true)
        return
      }
      throw error
    }
  }

  const attempt = async (operations: readonly MidiEditorOperation[]) => {
    try {
      await serializeProjectMidiCommit(input.projectId, () => attemptOperations(operations, false))
    } catch (error) {
      if (!(error instanceof MidiEditorClipConflictError) && terminalError(error)) {
        lastError = { error: asError(error), retryable: false, operationIds: operations.map(operationId) }
        input.onError?.(lastError)
        return
      }
      throw error
    }
  }

  const flush = async (): Promise<void> => {
    if (inFlight) {
      await inFlight
      return flush()
    }
    if (pending.length === 0) return
    const operations = pending
    pending = []
    inFlightOperations = operations
    inFlight = attempt(operations).catch((error) => {
      if (terminalError(error)) {
        lastError = { error: asError(error), retryable: false }
        input.onError?.(lastError)
        return
      }
      if (!discarded) pending = [...operations, ...pending]
      notifyMidiProjectProjection(input.projectId)
      lastError = { error: asError(error), retryable: true }
      input.onError?.(lastError)
      throw error
    }).finally(() => {
      inFlightOperations = []
      notifyMidiProjectProjection(input.projectId)
      input.onSettled?.()
      inFlight = undefined
      if (disposed && pending.length === 0) unregister()
    })
    await inFlight
    if (pending.length > 0) await flush()
  }

  const discard = () => {
    discarded = true
    pending = []
    inFlightOperations = []
    notifyMidiProjectProjection(input.projectId)
  }
  const unregisterAdapter = registerAdapter(input.projectId, {
    clipId: input.clipId,
    flush,
    discard,
    project: (midi) => authoritativeMidi ?? projectMidiEditorOperations(midi, [
      ...(awaitingReconciliation?.operations ?? []),
      ...inFlightOperations,
      ...pending,
    ]),
  })
  const unregisterLocal = local
    ? registerPendingLocalProjectWriteFlusher('midi', input.projectId, flush)
    : undefined
  const unregister = () => {
    unregisterAdapter()
    unregisterLocal?.()
  }

  return {
    enqueue: (operation: MidiEditorOperation) => {
      discarded = false
      lastError = undefined
      pending = coalesceOperations([...pending, operation])
      notifyMidiProjectProjection(input.projectId)
    },
    reconcile: (midi: NormalizedLegacyMidiClip) => {
      reconcile(midi)
    },
    project: (midi: NormalizedLegacyMidiClip) => (
      authoritativeMidi ?? projectMidiEditorOperations(midi, [
        ...(awaitingReconciliation?.operations ?? []),
        ...inFlightOperations,
        ...pending,
      ])
    ),
    pendingOperations: () => [
      ...(awaitingReconciliation?.operations ?? []),
      ...inFlightOperations,
      ...pending,
    ],
    error: () => lastError,
    dismissError: () => { lastError = undefined },
    flush,
    settle: flush,
    discard,
    dispose: () => {
      disposed = true
      void flush().catch(input.onError)
      if (!inFlight && pending.length === 0) unregister()
    },
  }
}
