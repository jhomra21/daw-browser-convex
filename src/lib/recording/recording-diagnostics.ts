export type RecordingTerminationCause = "native-fatal" | "writer-failure" | "lifecycle-cancellation" | "controller-cleanup" | "explicit-stop" | "start-failure" | "capture-failure"
import type { WriterTiming } from "../../../packages/audio-engine/src/recording/recording-protocol"

type RecordingDiagnostics = {
  requestedFormat: "pcm" | "compressed"
  activeFormat: "pcm" | "compressed"
  requestedLayout: "mono" | "stereo"
  activeChannels: number | null
  requestedSampleRate: number | null
  activeSampleRate: number | null
  transport: "sab" | "transferable" | null
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
const listeners = new Set<() => void>()

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
  if (snapshot.termination) return
  updateRecordingDiagnostics({ termination: { cause, error: sanitizeError(error) } })
}

export const recordRecordingLifecycle = (state: string) => {
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
  snapshot = initialDiagnostics()
  lastNativeBlockAt = null
  for (const listener of listeners) listener()
}

export const subscribeRecordingDiagnostics = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
