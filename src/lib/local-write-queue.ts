type QueuedWrite = {
  key: string
  write: () => Promise<void>
}

type TimerHandle = number | ReturnType<typeof globalThis.setTimeout>

type LocalWriteQueueOptions = {
  schedule?: (callback: () => void) => TimerHandle
  cancel?: (handle: TimerHandle) => void
}

const defaultSchedule = (callback: () => void) => {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    return window.requestIdleCallback(callback)
  }
  return globalThis.setTimeout(callback, 0)
}

const defaultCancel = (handle: TimerHandle) => {
  if (typeof handle === 'number' && typeof window !== 'undefined' && 'cancelIdleCallback' in window) {
    window.cancelIdleCallback(handle)
    return
  }
  globalThis.clearTimeout(handle)
}

export const createLocalWriteQueue = (options: LocalWriteQueueOptions = {}) => {
  const schedule = options.schedule ?? defaultSchedule
  const cancel = options.cancel ?? defaultCancel
  const writes = new Map<string, QueuedWrite>()
  let scheduledHandle: TimerHandle | null = null
  let flushPromise: Promise<void> | null = null

  const clearScheduledFlush = () => {
    if (scheduledHandle === null) return
    cancel(scheduledHandle)
    scheduledHandle = null
  }

  const flush = async () => {
    clearScheduledFlush()
    if (flushPromise) return flushPromise

    flushPromise = (async () => {
      while (writes.size > 0) {
        const batch = Array.from(writes.values())
        writes.clear()
        await Promise.all(batch.map((item) => item.write()))
      }
    })()

    try {
      await flushPromise
    } finally {
      flushPromise = null
    }
  }

  const scheduleFlush = () => {
    if (scheduledHandle !== null) return
    scheduledHandle = schedule(() => {
      scheduledHandle = null
      void flush()
    })
  }

  const enqueue = (key: string, write: () => Promise<void>) => {
    writes.set(key, { key, write })
    scheduleFlush()
  }

  const writeImmediately = async (write: () => Promise<void>) => {
    await flush()
    await write()
  }

  return {
    enqueue,
    flush,
    writeImmediately,
    clear: () => {
      clearScheduledFlush()
      writes.clear()
    },
    size: () => writes.size,
  }
}
