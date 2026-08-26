export type AuditionReleaseTimerScheduler = {
  schedule: (callback: () => void, delayMs: number) => number
  clear: (timer: number) => void
}

export function createAuditionReleaseTimerOwnership(scheduler: AuditionReleaseTimerScheduler) {
  const timers = new Map<number, number>()
  const schedule = (pitch: number, delayMs: number, release: () => void) => {
    const previous = timers.get(pitch)
    if (previous !== undefined) scheduler.clear(previous)
    const timer = scheduler.schedule(() => {
      if (timers.get(pitch) !== timer) return
      timers.delete(pitch)
      release()
    }, delayMs)
    timers.set(pitch, timer)
  }
  return {
    cancel: (pitch: number) => {
      const timer = timers.get(pitch)
      if (timer === undefined) return
      scheduler.clear(timer)
      timers.delete(pitch)
    },
    clear: () => {
      for (const timer of timers.values()) scheduler.clear(timer)
      timers.clear()
    },
    has: (pitch: number) => timers.has(pitch),
    schedule,
    size: () => timers.size,
  }
}
