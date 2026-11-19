import type { EffectParamsHistoryEntry, HistoryEntry, MergeKey, PersistedHistory } from './types'

import { isJsonObject, type JsonValue } from '@daw-browser/shared'
import { serializeJsonValue } from '~/lib/json'

export type UndoManager = ReturnType<typeof createUndoManager>

const sameHistoryEntry = (left: JsonValue, right: JsonValue): boolean => {
  if (Object.is(left, right)) return true
  if (!isJsonObject(left) || !isJsonObject(right)) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameHistoryEntry(value, right[index]))
  }
  const leftEntries = Object.entries(left)
  const rightEntries = new Map(Object.entries(right))
  return leftEntries.length === rightEntries.size
    && leftEntries.every(([key, value]) => {
      const rightValue = rightEntries.get(key)
      return rightValue !== undefined && sameHistoryEntry(value, rightValue)
    })
}

const occurrenceFromEnd = (entries: HistoryEntry[], entry: HistoryEntry, index: number) => (
  entries.slice(index + 1).filter((candidate) => (
    sameHistoryEntry(serializeJsonValue(candidate), serializeJsonValue(entry))
  )).length
)

const occurrenceIndexFromEnd = (entries: HistoryEntry[], entry: HistoryEntry, occurrence: number) => {
  let remaining = occurrence
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (!sameHistoryEntry(serializeJsonValue(entries[index]), serializeJsonValue(entry))) continue
    if (remaining === 0) return index
    remaining -= 1
  }
  return undefined
}

function mergeEffectParamsEntry<Effect extends EffectParamsHistoryEntry['data']['effect']>(
  prev: EffectParamsHistoryEntry<Effect>,
  entry: EffectParamsHistoryEntry<Effect>,
): EffectParamsHistoryEntry<Effect> {
  return { ...entry, data: { ...entry.data, from: prev.data.from } }
}

function mergeEntry(prev: HistoryEntry, entry: HistoryEntry): HistoryEntry | undefined {
  if (prev.type === 'clip-timing' && entry.type === 'clip-timing') {
    return { ...entry, data: { ...entry.data, from: prev.data.from } }
  }
  if (prev.type === 'clip-fades' && entry.type === 'clip-fades') {
    return { ...entry, data: { ...entry.data, from: prev.data.from } }
  }
  if (prev.type === 'track-volume' && entry.type === 'track-volume') {
    return { ...entry, data: { ...entry.data, from: prev.data.from } }
  }
  if (prev.type === 'track-mute' && entry.type === 'track-mute') {
    return { ...entry, data: { ...entry.data, from: prev.data.from } }
  }
  if (prev.type === 'track-solo' && entry.type === 'track-solo') {
    return { ...entry, data: { ...entry.data, from: prev.data.from } }
  }
  if (prev.type === 'track-routing' && entry.type === 'track-routing') {
    return { ...entry, data: { ...entry.data, from: prev.data.from } }
  }
  if (prev.type === 'effect-params' && entry.type === 'effect-params') {
    if (
      prev.data.effect !== entry.data.effect
      || prev.data.trackRef !== entry.data.trackRef
      || prev.data.instanceId !== entry.data.instanceId
    ) return undefined
    return mergeEffectParamsEntry(prev, entry)
  }
  return undefined
}

export function createUndoManager(options: { max?: number; onChange?: (state: PersistedHistory) => void }) {
  const max = options.max ?? 50
  let undo: HistoryEntry[] = []
  let redo: HistoryEntry[] = []
  let reservedUndo: { entry: HistoryEntry; index: number; occurrence: number; generation: number } | undefined
  let redoGeneration = 0
  let undoGeneration = 0
  let reservedRedo: { entry: HistoryEntry; index: number; occurrence: number; undoIndex: number; generation: number } | undefined
  let lastMerged: { key: MergeKey; ts: number } | null = null
  const withReservation = (
    entries: HistoryEntry[],
    reservation: { entry: HistoryEntry; index: number } | undefined,
  ) => {
    if (!reservation) return [...entries]
    const result = [...entries]
    result.splice(Math.min(reservation.index, result.length), 0, reservation.entry)
    return result
  }
  const snapshot = (): PersistedHistory => ({
    undo: withReservation(undo, reservedUndo),
    redo: withReservation(redo, reservedRedo),
  })
  const notify = () => options.onChange?.(snapshot())

  const push = (entry: HistoryEntry, mergeKey?: MergeKey, mergeWindowMs = 500) => {
    if (mergeKey) {
      const now = Date.now()
      const prev = undo.at(-1)
      if (prev && lastMerged && lastMerged.key === mergeKey && (now - lastMerged.ts) <= mergeWindowMs && prev.type === entry.type) {
        const merged = mergeEntry(prev, entry)
        if (merged) {
          undo[undo.length - 1] = merged
          lastMerged.ts = now
        } else {
          undo.push(entry)
          lastMerged = { key: mergeKey, ts: now }
        }
      } else {
        undo.push(entry)
        lastMerged = { key: mergeKey, ts: now }
      }
    } else {
      undo.push(entry)
      lastMerged = null
    }
    if (undo.length > max) undo.shift()
    redo = []
    redoGeneration += 1
    undoGeneration += 1
    notify()
  }

  const canUndo = () => undo.length > 0
  const canRedo = () => redo.length > 0
  const reserveUndo = () => {
    if (reservedUndo || undo.length === 0) return undefined
    const index = undo.length - 1
    const [entry] = undo.splice(index, 1)
    if (!entry) return undefined
    reservedUndo = { entry, index, occurrence: occurrenceFromEnd(undo, entry, index), generation: undoGeneration }
    lastMerged = null
    notify()
    return entry
  }
  const reserveRedo = () => {
    if (reservedRedo || redo.length === 0) return undefined
    const index = redo.length - 1
    const [entry] = redo.splice(index, 1)
    if (!entry) return undefined
    reservedRedo = {
      entry,
      index,
      occurrence: occurrenceFromEnd(redo, entry, index),
      undoIndex: undo.length,
      generation: redoGeneration,
    }
    lastMerged = null
    notify()
    return entry
  }
  const completeUndo = (entry: HistoryEntry) => {
    if (!reservedUndo || reservedUndo.entry !== entry) return false
    const reservation = reservedUndo
    reservedUndo = undefined
    if (reservation.generation === undoGeneration) {
      redo.push(entry)
      if (redo.length > max) redo.shift()
    }
    lastMerged = null
    notify()
    return true
  }
  const completeRedo = (entry: HistoryEntry) => {
    if (!reservedRedo || reservedRedo.entry !== entry) return false
    const index = Math.min(reservedRedo.undoIndex, undo.length)
    reservedRedo = undefined
    undo.splice(index, 0, entry)
    if (undo.length > max) undo.shift()
    lastMerged = null
    notify()
    return true
  }
  const restoreUndo = (entry: HistoryEntry) => {
    if (!reservedUndo || reservedUndo.entry !== entry) return false
    undo.splice(Math.min(reservedUndo.index, undo.length), 0, entry)
    reservedUndo = undefined
    lastMerged = null
    notify()
    return true
  }
  const restoreRedo = (entry: HistoryEntry) => {
    if (!reservedRedo || reservedRedo.entry !== entry) return false
    if (reservedRedo.generation === redoGeneration) {
      redo.splice(Math.min(reservedRedo.index, redo.length), 0, entry)
    }
    reservedRedo = undefined
    lastMerged = null
    notify()
    return true
  }
  const mutate = (mutator: (state: PersistedHistory) => boolean) => {
    if (!mutator(snapshot())) return false
    notify()
    return true
  }
  const clear = () => {
    undo = []
    redo = []
    redoGeneration += 1
    undoGeneration += 1
    reservedUndo = undefined
    reservedRedo = undefined
    lastMerged = null
    notify()
  }
  const hydrate = (state?: PersistedHistory) => {
    if (!state) return
    undo = state.undo
    redo = state.redo
    if (reservedUndo) {
      const reserved = reservedUndo
      const index = occurrenceIndexFromEnd(undo, reserved.entry, reserved.occurrence)
      if (index !== undefined) {
        undo.splice(index, 1)
        reservedUndo = { ...reserved, index }
      }
    }
    if (reservedRedo) {
      const reserved = reservedRedo
      const index = occurrenceIndexFromEnd(redo, reserved.entry, reserved.occurrence)
      if (index !== undefined) {
        redo.splice(index, 1)
        reservedRedo = { ...reserved, index }
      }
    }
    lastMerged = null
    notify()
  }

  return {
    push,
    canUndo,
    canRedo,
    reserveUndo,
    reserveRedo,
    completeUndo,
    completeRedo,
    restoreUndo,
    restoreRedo,
    mutate,
    clear,
    snapshot,
    hydrate,
  }
}
