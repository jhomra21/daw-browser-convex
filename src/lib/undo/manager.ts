import type { HistoryEntry, MergeKey, PersistedHistory } from './types'

export type UndoManager = ReturnType<typeof createUndoManager>

function mergeEntry(prev: HistoryEntry, entry: HistoryEntry): HistoryEntry {
  if (prev.type === 'clip-timing' && entry.type === 'clip-timing') {
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
    switch (entry.data.effect) {
      case 'eq':
        if (prev.data.effect !== 'eq') return entry
        return { ...entry, data: { ...entry.data, from: prev.data.from } }
      case 'compressor':
        if (prev.data.effect !== 'compressor') return entry
        return { ...entry, data: { ...entry.data, from: prev.data.from } }
      case 'saturator':
        if (prev.data.effect !== 'saturator') return entry
        return { ...entry, data: { ...entry.data, from: prev.data.from } }
      case 'delay':
        if (prev.data.effect !== 'delay') return entry
        return { ...entry, data: { ...entry.data, from: prev.data.from } }
      case 'reverb':
        if (prev.data.effect !== 'reverb') return entry
        return { ...entry, data: { ...entry.data, from: prev.data.from } }
      case 'synth':
        if (prev.data.effect !== 'synth') return entry
        return { ...entry, data: { ...entry.data, from: prev.data.from } }
      case 'arp':
        if (prev.data.effect !== 'arp') return entry
        return { ...entry, data: { ...entry.data, from: prev.data.from } }
      case 'master-eq':
        if (prev.data.effect !== 'master-eq') return entry
        return { ...entry, data: { ...entry.data, from: prev.data.from } }
      case 'master-compressor':
        if (prev.data.effect !== 'master-compressor') return entry
        return { ...entry, data: { ...entry.data, from: prev.data.from } }
      case 'master-saturator':
        if (prev.data.effect !== 'master-saturator') return entry
        return { ...entry, data: { ...entry.data, from: prev.data.from } }
      case 'master-delay':
        if (prev.data.effect !== 'master-delay') return entry
        return { ...entry, data: { ...entry.data, from: prev.data.from } }
      case 'master-reverb':
        if (prev.data.effect !== 'master-reverb') return entry
        return { ...entry, data: { ...entry.data, from: prev.data.from } }
    }
  }
  return entry
}

export function createUndoManager(options: { max?: number; onChange?: (state: PersistedHistory) => void }) {
  const max = options.max ?? 50
  let undo: HistoryEntry[] = []
  let redo: HistoryEntry[] = []
  let lastMerged: { key: MergeKey; ts: number } | null = null
  const notify = () => options.onChange?.({ undo: [...undo], redo: [...redo] })

  const push = (entry: HistoryEntry, mergeKey?: MergeKey, mergeWindowMs = 500) => {
    if (mergeKey && undo.length > 0) {
      const now = Date.now()
      const prev = undo[undo.length - 1]
      if (lastMerged && lastMerged.key === mergeKey && (now - lastMerged.ts) <= mergeWindowMs && prev.type === entry.type) {
        undo[undo.length - 1] = mergeEntry(prev, entry)
        lastMerged.ts = now
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
    notify()
  }

  const canUndo = () => undo.length > 0
  const canRedo = () => redo.length > 0
  const pushUndoEntry = (entry: HistoryEntry) => {
    undo.push(entry)
    if (undo.length > max) undo.shift()
    lastMerged = null
    notify()
  }
  const popUndo = () => {
    const e = undo.pop()
    if (e) notify()
    return e
  }
  const pushRedo = (e: HistoryEntry) => {
    redo.push(e)
    if (redo.length > max) redo.shift()
    notify()
  }
  const popRedo = () => {
    const e = redo.pop()
    if (e) notify()
    return e
  }
  const clear = () => { undo = []; redo = []; lastMerged = null; notify() }
  const snapshot = (): PersistedHistory => ({ undo: [...undo], redo: [...redo] })
  const hydrate = (state?: PersistedHistory) => {
    if (!state) return
    undo = Array.isArray(state.undo) ? state.undo as HistoryEntry[] : []
    redo = Array.isArray(state.redo) ? state.redo as HistoryEntry[] : []
    lastMerged = null
    notify()
  }

  return { push, pushUndoEntry, canUndo, canRedo, popUndo, pushRedo, popRedo, clear, snapshot, hydrate }
}
