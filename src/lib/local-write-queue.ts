import type { LocalProjectEntityRow } from '~/lib/local-project-db'
import { openLocalProjectDb } from '~/lib/local-project-db'

type QueuedEntityWrite = {
  kind: string
  id: string
  row: LocalProjectEntityRow
}

type QueuedEntityDelete = {
  kind: string
  id: string
}

type ScheduledIdleFlush = {
  cancel: () => void
}

const INITIAL_RETRY_DELAY_MS = 250
const MAX_RETRY_DELAY_MS = 30_000

const entityKey = (kind: string, id: string) => `${kind}:${id}`

// Failed durable writes are retried with a capped timer; successful writes stay idle-scheduled.
const scheduleIdleFlush = (callback: () => void, delayMs: number): ScheduledIdleFlush => {
  if (delayMs > 0) {
    const handle = globalThis.setTimeout(callback, delayMs)
    return { cancel: () => globalThis.clearTimeout(handle) }
  }
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    const handle = window.requestIdleCallback(callback)
    return { cancel: () => window.cancelIdleCallback(handle) }
  }
  const handle = globalThis.setTimeout(callback, 0)
  return { cancel: () => globalThis.clearTimeout(handle) }
}

export class LocalEntityWriteQueue {
  private puts = new Map<string, QueuedEntityWrite>()
  private deletes = new Map<string, QueuedEntityDelete>()
  private scheduledFlush: ScheduledIdleFlush | null = null
  private flushPromise: Promise<void> | null = null
  private retryDelayMs = 0

  public constructor(private projectId: string) {}

  public getPending(kind: string, id: string): LocalProjectEntityRow | null | undefined {
    const key = entityKey(kind, id)
    if (this.deletes.has(key)) return null
    return this.puts.get(key)?.row
  }

  public applyPendingRows(kind: string, rows: LocalProjectEntityRow[]): LocalProjectEntityRow[] {
    const rowById = new Map<string, LocalProjectEntityRow>()
    for (const row of rows) {
      if (row.kind === kind && !this.deletes.has(entityKey(kind, row.id))) rowById.set(row.id, row)
    }
    for (const write of this.puts.values()) {
      if (write.kind === kind) rowById.set(write.id, write.row)
    }
    return Array.from(rowById.values())
  }

  public schedulePut(row: LocalProjectEntityRow): void {
    const key = entityKey(row.kind, row.id)
    this.deletes.delete(key)
    this.puts.set(key, { kind: row.kind, id: row.id, row })
    this.scheduleFlush()
  }

  public scheduleDelete(kind: string, id: string): void {
    const key = entityKey(kind, id)
    this.puts.delete(key)
    this.deletes.set(key, { kind, id })
    this.scheduleFlush()
  }

  public flush(): Promise<void> {
    this.cancelScheduledFlush()
    if (this.flushPromise) {
      return this.flushPromise.then(() => {
        if (this.puts.size === 0 && this.deletes.size === 0) return
        return this.flush()
      })
    }
    this.flushPromise = this.flushBatches().finally(() => {
      this.flushPromise = null
      if (this.puts.size > 0 || this.deletes.size > 0) this.scheduleFlush()
    })
    return this.flushPromise
  }

  private scheduleFlush() {
    if (this.scheduledFlush) return
    this.scheduledFlush = scheduleIdleFlush(() => {
      this.scheduledFlush = null
      void this.flush().catch((error) => {
        console.error('Failed to flush local entity writes', error)
      })
    }, this.retryDelayMs)
  }

  private cancelScheduledFlush() {
    this.scheduledFlush?.cancel()
    this.scheduledFlush = null
  }

  private async flushBatches(): Promise<void> {
    while (this.puts.size > 0 || this.deletes.size > 0) {
      const puts = Array.from(this.puts.values())
      const deletes = Array.from(this.deletes.values())
      this.puts.clear()
      this.deletes.clear()

      try {
        const db = await openLocalProjectDb(this.projectId)
        const tx = db.transaction('entities', 'readwrite')
        await Promise.all([
          ...puts.map((write) => tx.store.put(write.row)),
          ...deletes.map((entry) => tx.store.delete([entry.kind, entry.id])),
        ])
        await tx.done
        this.retryDelayMs = 0
      } catch (error) {
        for (const write of puts) {
          const key = entityKey(write.kind, write.id)
          if (!this.puts.has(key) && !this.deletes.has(key)) this.puts.set(key, write)
        }
        for (const entry of deletes) {
          const key = entityKey(entry.kind, entry.id)
          if (!this.puts.has(key) && !this.deletes.has(key)) this.deletes.set(key, entry)
        }
        this.retryDelayMs = this.retryDelayMs === 0
          ? INITIAL_RETRY_DELAY_MS
          : Math.min(this.retryDelayMs * 2, MAX_RETRY_DELAY_MS)
        throw error
      }
    }
  }
}
