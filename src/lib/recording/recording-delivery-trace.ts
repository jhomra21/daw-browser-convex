export type RecordingTerminationCause = "native-fatal" | "writer-failure" | "lifecycle-cancellation" | "controller-cleanup" | "explicit-stop" | "start-failure" | "capture-failure"

type DeliveryEventKind = "block" | "enqueue" | "status" | "writer" | RecordingTerminationCause | "cleanup"
  | "lifecycle-ready" | "lifecycle-recovering" | "lifecycle-suspended" | "lifecycle-failed"

export const createRecordingDeliveryTrace = (enabled: boolean, generation: number, sessionId: bigint, startedAtEpochMs: number) => {
  const capacity = 512
  const emptyEntry = (kind: DeliveryEventKind) => ({
    kind, atEpochMs: 0, sequence: -1, frameCount: 0, nativeQueuedBlocks: -1,
    outstanding: 0, sendEndEpochMs: 0, latencyMs: 0, deliveryMs: 0,
    returnedAtEpochMs: 0, returned: 0, active: 0, fatal: 0,
    mainArrivalEpochMs: 0, oldestAgeMs: 0, capturedFrames: 0,
  })
  const entries = enabled ? Array.from({ length: capacity }, () => emptyEntry("block")) : []
  let count = 0
  let dumped = false
  let observedFrames = 0
  let queuedBlocks = -1
  let outstanding = 0
  let firstTermination: { cause: RecordingTerminationCause; atEpochMs: number } | null = null
  let firstFatalStatus: { atEpochMs: number; queuedBlocks: number; capturedFrames: number } | null = null
  const clockOffsetAtStartMs = enabled ? Date.now() - (performance.timeOrigin + performance.now()) : null
  const append = (kind: DeliveryEventKind, atEpochMs: number) => {
    if (!enabled || dumped) return undefined
    const entry = entries[count % capacity]!
    entry.kind = kind
    entry.atEpochMs = atEpochMs
    entry.sequence = -1
    entry.frameCount = 0
    entry.nativeQueuedBlocks = queuedBlocks
    entry.outstanding = outstanding
    entry.sendEndEpochMs = 0
    entry.latencyMs = 0
    entry.deliveryMs = 0
    entry.returnedAtEpochMs = 0
    entry.returned = 0
    entry.active = 0
    entry.fatal = 0
    entry.mainArrivalEpochMs = 0
    entry.oldestAgeMs = 0
    entry.capturedFrames = 0
    count += 1
    return entry
  }
  return {
    block(sequence: number, frameCount: number, arrivalEpochMs: number, sendMs = 0, mainArrivalEpochMs = 0) {
      const entry = append("block", arrivalEpochMs)
      if (!entry) return
      observedFrames += frameCount
      entry.sequence = sequence
      entry.frameCount = frameCount
      entry.sendEndEpochMs = arrivalEpochMs + sendMs
      entry.mainArrivalEpochMs = mainArrivalEpochMs
    },
    enqueue(sequence: number, frameCount: number, atEpochMs: number, writerOutstanding: number) {
      outstanding = writerOutstanding
      const entry = append("enqueue", atEpochMs)
      if (!entry) return
      entry.sequence = sequence
      entry.frameCount = frameCount
    },
    status(atEpochMs: number, nativeQueuedBlocks: number, active: boolean, fatal: boolean, capturedFrames: number) {
      if (!enabled || dumped) return
      queuedBlocks = nativeQueuedBlocks
      if (fatal && !firstFatalStatus) firstFatalStatus = { atEpochMs, queuedBlocks, capturedFrames }
      const entry = append("status", atEpochMs)!
      entry.capturedFrames = capturedFrames
      entry.active = Number(active)
      entry.fatal = Number(fatal)
    },
    writer(atEpochMs: number, writerOutstanding: number, returned: number, latencyMs: number,
      deliveryMs: number, returnedAtEpochMs: number, oldestAgeMs: number) {
      outstanding = writerOutstanding
      const entry = append("writer", atEpochMs)
      if (!entry) return
      entry.latencyMs = latencyMs
      entry.deliveryMs = deliveryMs
      entry.returnedAtEpochMs = returnedAtEpochMs
      entry.returned = returned
      entry.oldestAgeMs = oldestAgeMs
    },
    lifecycle(state: string, atEpochMs: number) {
      if (state === "ready") append("lifecycle-ready", atEpochMs)
      else if (state === "recovering") append("lifecycle-recovering", atEpochMs)
      else if (state === "suspended") append("lifecycle-suspended", atEpochMs)
      else if (state === "failed") append("lifecycle-failed", atEpochMs)
    },
    transition(cause: RecordingTerminationCause | "cleanup", atEpochMs: number) {
      if (!enabled || dumped) return
      if (cause !== "cleanup" && !firstTermination) firstTermination = { cause, atEpochMs }
      append(cause, atEpochMs)
    },
    dump(endedAtEpochMs: number) {
      if (!enabled || dumped) return null
      dumped = true
      const events = Array.from({ length: Math.min(count, capacity) }, (_, offset) => ({
        ...entries[(Math.max(0, count - capacity) + offset) % capacity]!,
      }))
      return {
        version: 1, capacity, generation, sessionId: sessionId.toString(),
        clock: "performance.timeOrigin+performance.now",
        clockOffsetAtStartMs,
        clockOffsetAtEndMs: Date.now() - (performance.timeOrigin + performance.now()),
        startedAtEpochMs, endedAtEpochMs, observedFrames,
        totalEvents: count, overwritten: Math.max(0, count - capacity),
        firstTermination, firstFatalStatus, events,
        nativeProductionTimestampsAvailable: false,
      }
    },
  }
}

export type RecordingDeliveryDump = ReturnType<ReturnType<typeof createRecordingDeliveryTrace>["dump"]>
