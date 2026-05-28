export type ScheduledTrackWrite<TTrackId extends string> = {
  timer: number
  write: () => Promise<unknown>
  afterWrite?: () => void
}

export const createTimelineMixerWriteQueue = <TTrackId extends string>(
  onWriteFailure: (error: unknown) => void,
) => {
  const runningWrites = new Set<Promise<void>>()

  const runScheduledWrite = (
    timers: Map<TTrackId, ScheduledTrackWrite<TTrackId>>,
    trackId: TTrackId,
    scheduled: ScheduledTrackWrite<TTrackId>,
  ) => (
    scheduled.write()
      .then(() => {
        scheduled.afterWrite?.()
      })
      .catch((error) => {
        onWriteFailure(error)
        throw error
      })
      .finally(() => {
        const current = timers.get(trackId)
        if (current === scheduled) timers.delete(trackId)
      })
  )

  const trackScheduledWrite = (
    timers: Map<TTrackId, ScheduledTrackWrite<TTrackId>>,
    trackId: TTrackId,
    scheduled: ScheduledTrackWrite<TTrackId>,
  ) => {
    const promise = runScheduledWrite(timers, trackId, scheduled)
      .finally(() => {
        runningWrites.delete(promise)
      })
    runningWrites.add(promise)
    return promise
  }

  const scheduleTrackWrite = (
    timers: Map<TTrackId, ScheduledTrackWrite<TTrackId>>,
    trackId: TTrackId,
    write: () => Promise<unknown>,
    afterWrite?: () => void,
  ) => {
    const previous = timers.get(trackId)
    if (previous) clearTimeout(previous.timer)
    const timer = window.setTimeout(() => {
      const scheduled = timers.get(trackId)
      if (!scheduled) return
      timers.delete(trackId)
      void trackScheduledWrite(timers, trackId, scheduled).catch(() => undefined)
    }, 150)
    timers.set(trackId, { timer, write, afterWrite })
  }

  const clearScheduledWrite = (
    timers: Map<TTrackId, ScheduledTrackWrite<TTrackId>>,
    trackId: TTrackId,
  ) => {
    const timer = timers.get(trackId)
    if (!timer) return
    clearTimeout(timer.timer)
    timers.delete(trackId)
  }

  const flushTimers = async (timers: Map<TTrackId, ScheduledTrackWrite<TTrackId>>) => {
    const writes: Promise<void>[] = Array.from(runningWrites)
    for (const [trackId, scheduled] of timers) {
      clearTimeout(scheduled.timer)
      timers.delete(trackId)
      writes.push(trackScheduledWrite(timers, trackId, scheduled))
    }
    await Promise.all(writes)
  }

  return {
    clearScheduledWrite,
    flushTimers,
    scheduleTrackWrite,
  }
}
