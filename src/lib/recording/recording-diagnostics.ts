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
  muted: boolean
  deviceLost: boolean
  lastFailure: string | null
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
  muted: false,
  deviceLost: false,
  lastFailure: null,
})

let snapshot = initialDiagnostics()
const listeners = new Set<() => void>()

const boundedFrames = (value: number | null): number | null =>
  value === null ? null : Number.isSafeInteger(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value)) : null

export const getRecordingDiagnostics = (): RecordingDiagnostics => snapshot

export const updateRecordingDiagnostics = (update: Partial<RecordingDiagnostics>) => {
  snapshot = {
    ...snapshot,
    ...update,
    capturedFrames: boundedFrames(update.capturedFrames === undefined ? snapshot.capturedFrames : update.capturedFrames),
    overrunFrames: boundedFrames(update.overrunFrames === undefined ? snapshot.overrunFrames : update.overrunFrames),
    droppedFrames: boundedFrames(update.droppedFrames === undefined ? snapshot.droppedFrames : update.droppedFrames),
    queuedFrames: boundedFrames(update.queuedFrames === undefined ? snapshot.queuedFrames : update.queuedFrames),
  }
  for (const listener of listeners) listener()
}

export const resetRecordingDiagnostics = () => {
  snapshot = initialDiagnostics()
  for (const listener of listeners) listener()
}

export const subscribeRecordingDiagnostics = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
