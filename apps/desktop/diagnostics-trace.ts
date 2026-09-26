import type { ZodError } from "zod"

export const diagnosticValidationPaths = (error: ZodError): string => (
  error.issues.slice(0, 8).map((issue) => issue.path.slice(0, 3).map((part) => (
    /^(result|audio|recording|native|scheduler|counts|workerAutomation|sequence|transportEpoch|renderEpoch|lastRejectedCallback|lastRejectedRenderEpoch|tracks)$/.test(String(part))
      ? part
      : "other"
  )).join(".")).join(",")
)

export const createDiagnosticsTrace = (
  enabled: boolean,
  emit: (line: string) => void,
  now: () => number = Date.now,
) => ({
  start: () => now(),
  mark: (start: number, stage: string) => {
    if (!enabled) return
    emit(`[diagnostics-v2-boundary] operation=diagnostics.snapshot.v2 stage=${stage} elapsedMs=${Math.max(0, Math.round(now() - start))}`)
  },
})
