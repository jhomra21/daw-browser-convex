import type { NativeHostDiagnostics } from "@daw-browser/audio-engine/native-host-wire"

export const serializeNativeDiagnostics = <T extends Pick<NativeHostDiagnostics,
  "workerAutomation" | "watchedMixProcessed" | "renderEpoch" | "lastRejectedCallback" | "lastRejectedRenderEpoch">>(diagnostics: T) => {
  const { workerAutomation, watchedMixProcessed, renderEpoch, lastRejectedCallback, lastRejectedRenderEpoch, ...rest } = diagnostics
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
    lastRejectedCallback: lastRejectedCallback.toString(),
    lastRejectedRenderEpoch: lastRejectedRenderEpoch.toString(),
  }
}
