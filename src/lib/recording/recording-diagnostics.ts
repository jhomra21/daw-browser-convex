export type RecordingTerminationCause = "native-fatal" | "writer-failure" | "lifecycle-cancellation" | "controller-cleanup" | "explicit-stop" | "start-failure" | "capture-failure"
import type { WriterTiming } from "../../../packages/audio-engine/src/recording/recording-protocol"

type DeliveryEventKind = "block" | "enqueue" | "status" | "writer" | RecordingTerminationCause | "cleanup"
  | "lifecycle-ready" | "lifecycle-recovering" | "lifecycle-suspended" | "lifecycle-failed"

// Shared by the existing main benchmark telemetry and renderer recording
// diagnostics. Only the opt-in path allocates; hot-path writes retain scalars
// in fixed storage, never messages/PCM. Epoch-aligned monotonic clocks permit
// correlation, subject to the start/end wall-clock offsets and heartbeat bounds.
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
      // Do not copy arbitrary strings into the public evidence.
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
      // Allocate the public scalar-only snapshot once, outside block delivery.
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

declare global {
  // Benchmark-only state: one current session and one completed scalar dump.
  // Collected by Tier 3 before renderer reload; reset only at the next take.
  var __dawRecordingDeliveryTraceEnabled: boolean | undefined
  var __dawRecordingDeliveryEvidence: ReturnType<ReturnType<typeof createRecordingDeliveryTrace>["dump"]> | undefined
  var __dawRecordingMainDeliveryEvidence: ReturnType<ReturnType<typeof createRecordingDeliveryTrace>["dump"]> | undefined
}

type RecordingDiagnostics = {
  requestedFormat: "pcm" | "compressed"
  activeFormat: "pcm" | "compressed"
  requestedLayout: "mono" | "stereo"
  activeChannels: number | null
  requestedSampleRate: number | null
  activeSampleRate: number | null
  transport: "sab" | "transferable" | "native-spool" | null
  capturedFrames: number | null
  overrunFrames: number | null
  droppedFrames: number | null
  queuedFrames: number | null
  peakQueuedFrames: number
  writerReturnedBuffers: number
  writerOutstandingBuffers: number
  peakWriterOutstandingBuffers: number
  sabWriterOccupancy: number
  peakSabWriterOccupancy: number
  writerReturnMaxMs: number
  writerReturnDeliveryMaxMs: number
  writerReturnDeliveryWorst: { returnedAtEpochMs: number; receivedAtEpochMs: number } | null
  writerOldestOutstandingMs: number
  writerTiming: WriterTiming | null
  nativeReceivedBlocks: number
  nativeArrivalGapMaxMs: number
  nativeHandlerMaxMs: number
  muted: boolean
  deviceLost: boolean
  lastFailure: string | null
  termination: { cause: RecordingTerminationCause; error: string | null } | null
  lifecycleTransitions: readonly string[]
  lastNativeStatus: {
    active: boolean
    fatal: boolean
    capturedFrames: number
    droppedFrames: number
    queuedBlocks: number
  } | null
}

const initialDiagnostics = (): RecordingDiagnostics => ({
  requestedFormat: "pcm",
  activeFormat: "pcm",
  requestedLayout: "mono",
  activeChannels: null,
  requestedSampleRate: null,
  activeSampleRate: null,
  transport: null,
  capturedFrames: null,
  overrunFrames: null,
  droppedFrames: null,
  queuedFrames: null,
  peakQueuedFrames: 0,
  writerReturnedBuffers: 0,
  writerOutstandingBuffers: 0,
  peakWriterOutstandingBuffers: 0,
  sabWriterOccupancy: 0,
  peakSabWriterOccupancy: 0,
  writerReturnMaxMs: 0,
  writerReturnDeliveryMaxMs: 0,
  writerReturnDeliveryWorst: null,
  writerOldestOutstandingMs: 0,
  writerTiming: null,
  nativeReceivedBlocks: 0,
  nativeArrivalGapMaxMs: 0,
  nativeHandlerMaxMs: 0,
  muted: false,
  deviceLost: false,
  lastFailure: null,
  termination: null,
  lifecycleTransitions: [],
  lastNativeStatus: null,
})

let snapshot = initialDiagnostics()
let lastNativeBlockAt: number | null = null
// This module already owns the single live recording diagnostic session.
// Keep trace ownership here so hook termination/lifecycle events share it.
let deliveryTrace: ReturnType<typeof createRecordingDeliveryTrace> | null = null
export const beginRecordingDeliveryTrace = (generation: number, sessionId: bigint) => {
  if (globalThis.__dawRecordingDeliveryTraceEnabled !== true) return null
  globalThis.__dawRecordingDeliveryEvidence = null
  globalThis.__dawRecordingMainDeliveryEvidence = null
  deliveryTrace = createRecordingDeliveryTrace(true, generation, sessionId, performance.timeOrigin + performance.now())
  return deliveryTrace
}
export const finishRecordingDeliveryTrace = () => {
  if (!deliveryTrace) return
  const now = performance.timeOrigin + performance.now()
  deliveryTrace.transition("cleanup", now)
  const dump = deliveryTrace.dump(now)
  if (dump) globalThis.__dawRecordingDeliveryEvidence = dump
  deliveryTrace = null
}
const listeners = new Set<() => void>()
export const recordingDiagnosticsSubscriberCount = () => listeners.size

const boundedFrames = (value: number | null): number | null =>
  value === null ? null : Number.isSafeInteger(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value)) : null

export const getRecordingDiagnostics = (): RecordingDiagnostics => snapshot

export const recordNativeBlockTiming = (arrivalMs: number, handlerMs: number) => {
  updateRecordingDiagnostics({
    nativeReceivedBlocks: snapshot.nativeReceivedBlocks + 1,
    nativeArrivalGapMaxMs: Math.max(snapshot.nativeArrivalGapMaxMs, lastNativeBlockAt === null ? 0 : Math.max(0, arrivalMs - lastNativeBlockAt)),
    nativeHandlerMaxMs: Math.max(snapshot.nativeHandlerMaxMs, handlerMs),
  })
  lastNativeBlockAt = arrivalMs
}

const sanitizeError = (error: Error | string | undefined) =>
  error === undefined ? null : (error instanceof Error ? error.message : error)
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s]*/g, "<path>").slice(0, 256)

export const recordRecordingTermination = (cause: RecordingTerminationCause, error?: Error | string) => {
  deliveryTrace?.transition(cause, performance.timeOrigin + performance.now())
  if (snapshot.termination) return
  updateRecordingDiagnostics({ termination: { cause, error: sanitizeError(error) } })
}

export const recordRecordingLifecycle = (state: string) => {
  deliveryTrace?.lifecycle(state, performance.timeOrigin + performance.now())
  updateRecordingDiagnostics({ lifecycleTransitions: [...snapshot.lifecycleTransitions.slice(-7), state.slice(0, 64)] })
}

export const recordNativeRecordingStatus = (status: NonNullable<RecordingDiagnostics["lastNativeStatus"]>) => {
  updateRecordingDiagnostics({ lastNativeStatus: {
    active: status.active,
    fatal: status.fatal,
    capturedFrames: boundedFrames(status.capturedFrames) ?? 0,
    droppedFrames: boundedFrames(status.droppedFrames) ?? 0,
    queuedBlocks: boundedFrames(status.queuedBlocks) ?? 0,
  } })
}

export const updateRecordingDiagnostics = (update: Partial<RecordingDiagnostics>) => {
  if (deliveryTrace && update.writerOutstandingBuffers !== undefined) {
    deliveryTrace.writer(performance.timeOrigin + performance.now(), update.writerOutstandingBuffers,
      update.writerReturnedBuffers ?? snapshot.writerReturnedBuffers, update.writerReturnMaxMs ?? 0,
      update.writerReturnDeliveryMaxMs ?? 0, update.writerReturnDeliveryWorst?.returnedAtEpochMs ?? 0,
      update.writerOldestOutstandingMs ?? 0)
  }
  const deliveryMax = Math.max(snapshot.writerReturnDeliveryMaxMs, update.writerReturnDeliveryMaxMs ?? 0)
  snapshot = {
    ...snapshot,
    ...update,
    capturedFrames: boundedFrames(update.capturedFrames === undefined ? snapshot.capturedFrames : update.capturedFrames),
    overrunFrames: boundedFrames(update.overrunFrames === undefined ? snapshot.overrunFrames : update.overrunFrames),
    droppedFrames: boundedFrames(update.droppedFrames === undefined ? snapshot.droppedFrames : update.droppedFrames),
    queuedFrames: boundedFrames(update.queuedFrames === undefined ? snapshot.queuedFrames : update.queuedFrames),
    peakQueuedFrames: Math.max(snapshot.peakQueuedFrames, boundedFrames(update.queuedFrames ?? null) ?? 0),
    peakWriterOutstandingBuffers: Math.max(snapshot.peakWriterOutstandingBuffers, update.writerOutstandingBuffers ?? 0),
    peakSabWriterOccupancy: Math.max(snapshot.peakSabWriterOccupancy, update.sabWriterOccupancy ?? 0),
    writerReturnMaxMs: Math.max(snapshot.writerReturnMaxMs, update.writerReturnMaxMs ?? 0),
    writerReturnDeliveryMaxMs: deliveryMax,
    writerReturnDeliveryWorst: update.writerReturnDeliveryMaxMs !== undefined
      && update.writerReturnDeliveryMaxMs > snapshot.writerReturnDeliveryMaxMs
      ? update.writerReturnDeliveryWorst ?? null : snapshot.writerReturnDeliveryWorst,
    writerOldestOutstandingMs: Math.max(snapshot.writerOldestOutstandingMs, update.writerOldestOutstandingMs ?? 0),
  }
  for (const listener of listeners) listener()
}

export const resetRecordingDiagnostics = () => {
  finishRecordingDeliveryTrace()
  snapshot = initialDiagnostics()
  lastNativeBlockAt = null
  for (const listener of listeners) listener()
}

export const subscribeRecordingDiagnostics = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
