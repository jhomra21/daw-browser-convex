import type { HistoryEntry, MergeKey, PersistedHistory } from './types'

export type UndoManager = ReturnType<typeof createUndoManager>

export function createUndoManager(options: { max?: number; roomId: string; onChange?: (state: PersistedHistory) => void }) {
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
        undo[undo.length - 1] = entry
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

  return { roomId: options.roomId, push, canUndo, canRedo, popUndo, pushRedo, popRedo, clear, snapshot, hydrate }
}
