type Timer = number | ReturnType<typeof setTimeout>

type MidiRecordingCheckpointSnapshot<T> = {
  checkpoint: T
  eventCount: number
  version: number
}

type MidiRecordingCheckpointState = {
  eventCount: number
  version: number
}

type MidiRecordingCheckpointOptions<T> = {
  snapshot: () => MidiRecordingCheckpointSnapshot<T>
  state: () => MidiRecordingCheckpointState
  persist: (checkpoint: T, final: boolean) => Promise<void>
  isActive: () => boolean
  delayMs?: number
  eventThreshold?: number
  maxRetryAttempts?: number
  setTimer?: (callback: () => void, delay: number) => Timer
  clearTimer?: (timer: Timer) => void
}

export type MidiRecordingCheckpointController<T> = {
  request: (final?: boolean) => Promise<void>
  schedule: () => void
  clear: () => void
  last: () => T | null
  pendingEventCount: () => number
  shouldRequest: () => boolean
}

export const createMidiRecordingCheckpointController = <T>(
  options: MidiRecordingCheckpointOptions<T>,
): MidiRecordingCheckpointController<T> => {
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  let timer: Timer | null = null
  let write: Promise<void> | null = null
  let pending = false
  let finalPending = false
  let lastEventCount = 0
  let lastVersion = 0
  let lastCheckpoint: T | null = null
  let retryAttempts = 0

  const clear = () => {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  const schedule = () => {
    if (
      timer !== null
      || options.state().version <= lastVersion
      || retryAttempts >= (options.maxRetryAttempts ?? 3)
    ) return
    timer = setTimer(() => {
      timer = null
      if (options.isActive()) void request().catch(() => undefined)
    }, options.delayMs ?? 1_000)
  }

  const request = (final = false): Promise<void> => {
    clear()
    if (!final && retryAttempts >= (options.maxRetryAttempts ?? 3)) return Promise.resolve()
    if (write) {
      pending = true
      if (final) finalPending = true
      if (!final) return write
      return write.catch(async () => {
        // A final request cannot be satisfied by a failed periodic write.
        // Retry from the latest snapshot after the in-flight write releases.
        await Promise.resolve()
        return request(true)
      })
    }
    const run = async () => {
      do {
        pending = false
        const snapshot = options.snapshot()
        const isFinal = final || finalPending
        finalPending = false
        try {
          await options.persist(snapshot.checkpoint, isFinal)
        } catch (error) {
          retryAttempts += 1
          throw error
        }
        lastEventCount = snapshot.eventCount
        lastVersion = snapshot.version
        lastCheckpoint = snapshot.checkpoint
        retryAttempts = 0
      } while (pending || options.state().version > lastVersion)
    }
    write = run().finally(() => {
      write = null
      if (options.isActive()) schedule()
    })
    return write
  }

  return {
    request,
    schedule,
    clear,
    last: () => lastCheckpoint,
    pendingEventCount: () => options.state().eventCount - lastEventCount,
    shouldRequest: () => (
      retryAttempts < (options.maxRetryAttempts ?? 3)
      && options.state().eventCount - lastEventCount >= (options.eventThreshold ?? 64)
    ),
  }
}
