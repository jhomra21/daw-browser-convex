import type { NativeHostDiagnostics } from "@daw-browser/audio-engine/native-host-wire"

export const serializeNativeDiagnostics = <T extends Pick<NativeHostDiagnostics,
  "workerAutomation" | "watchedMixProcessed" | "watchedMixHost" | "renderEpoch" | "lastRejectedCallback" | "lastRejectedRenderEpoch"
  | "transportFrame" | "realtimePerformance" | "vstWorkerPerformance">>(diagnostics: T) => {
  const { workerAutomation, watchedMixProcessed, renderEpoch, lastRejectedCallback, lastRejectedRenderEpoch,
    transportFrame, realtimePerformance, vstWorkerPerformance, ...rest } = diagnostics
  return {
    ...rest,
    workerAutomation: workerAutomation === null ? null : {
      ...workerAutomation,
      sequence: workerAutomation.sequence.toString(),
    },
    watchedMixProcessed: watchedMixProcessed === null ? null : {
      ...watchedMixProcessed,
      sequence: watchedMixProcessed.sequence.toString(),
    },
    renderEpoch: renderEpoch.toString(),
    transportFrame: transportFrame.toString(),
    realtimePerformance: {
      ...realtimePerformance,
      observationCount: realtimePerformance.observationCount.toString(),
      processingP50Nanoseconds: realtimePerformance.processingP50Nanoseconds.toString(),
      processingP95Nanoseconds: realtimePerformance.processingP95Nanoseconds.toString(),
      processingP99Nanoseconds: realtimePerformance.processingP99Nanoseconds.toString(),
      processingMaximumNanoseconds: realtimePerformance.processingMaximumNanoseconds.toString(),
      deadlineMisses: realtimePerformance.deadlineMisses.toString(),
    },
    vstWorkerPerformance: {
      ...vstWorkerPerformance,
      observationCount: vstWorkerPerformance.observationCount.toString(),
      processingP50Nanoseconds: vstWorkerPerformance.processingP50Nanoseconds.toString(),
      processingP95Nanoseconds: vstWorkerPerformance.processingP95Nanoseconds.toString(),
      processingP99Nanoseconds: vstWorkerPerformance.processingP99Nanoseconds.toString(),
      processingMaximumNanoseconds: vstWorkerPerformance.processingMaximumNanoseconds.toString(),
      deadlineMisses: vstWorkerPerformance.deadlineMisses.toString(),
      watchdogMisses: vstWorkerPerformance.watchdogMisses.toString(),
      faults: vstWorkerPerformance.faults.toString(),
      restarts: vstWorkerPerformance.restarts.toString(),
    },
    lastRejectedCallback: lastRejectedCallback.toString(),
    lastRejectedRenderEpoch: lastRejectedRenderEpoch.toString(),
  }
}
