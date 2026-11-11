import { z } from "zod"

type DiagnosticEvent =
  | { readonly kind: "backend"; readonly backend: "native" | "portable" | "unknown" }
  | { readonly kind: "configure-request" }
  | { readonly kind: "configure-result"; readonly outcome: "ready" | "rejected"; readonly category: "success" | "command-rejected" | "admission-failed" | "native-configure-failed" | "readiness-validation-failed" | "binding-changed" | "threw"; readonly sampleRateHz: number | null; readonly channelCount: number | null; readonly phase?: "request" | "readiness"; readonly elapsedMs?: number }
  | { readonly kind: "readiness"; readonly configured: boolean; readonly active: boolean; readonly sampleRateHz: number | null; readonly channelCount: number | null; readonly spoolState: number | null; readonly spoolError: number | null; readonly spoolSystemError: number | null }
  | { readonly kind: "native-start-blocked" }
  | { readonly kind: "native-start-result"; readonly outcome: "succeeded" | "rejected" }

export type RecordingStartDiagnosticEvent = DiagnosticEvent
export const recordingStartDiagnosticEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("backend"), backend: z.enum(["native", "portable", "unknown"]) }).strict(),
  z.object({ kind: z.literal("configure-request") }).strict(),
  z.object({ kind: z.literal("configure-result"), outcome: z.enum(["ready", "rejected"]),
    category: z.enum(["success", "command-rejected", "admission-failed", "native-configure-failed",
      "readiness-validation-failed", "binding-changed", "threw"]),
    sampleRateHz: z.number().int().positive().nullable(),
    channelCount: z.number().int().min(1).max(2).nullable(),
    phase: z.enum(["request", "readiness"]).optional(),
    elapsedMs: z.number().int().nonnegative().max(60_000).optional() }).strict(),
  z.object({ kind: z.literal("readiness"), configured: z.boolean(), active: z.boolean(),
    sampleRateHz: z.number().int().positive().nullable(), channelCount: z.number().int().min(1).max(2).nullable(),
    spoolState: z.number().int().min(0).max(16).nullable(), spoolError: z.number().int().nonnegative().nullable(),
    spoolSystemError: z.number().int().nonnegative().nullable() }).strict(),
  z.object({ kind: z.literal("native-start-blocked") }).strict(),
  z.object({ kind: z.literal("native-start-result"), outcome: z.enum(["succeeded", "rejected"]) }).strict(),
])

const maximumEvents = 64
const inputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("backend"), backend: z.string() }).passthrough(),
  z.object({ kind: z.literal("configure-request") }).passthrough(),
  z.object({ kind: z.literal("configure-result"), outcome: z.string(), category: z.string(),
    sampleRateHz: z.number().optional(), channelCount: z.number().optional(),
    phase: z.string().optional(), elapsedMs: z.number().optional() }).passthrough(),
  z.object({ kind: z.literal("readiness"), configured: z.boolean(), active: z.boolean(),
    sampleRateHz: z.number().optional(), channelCount: z.number().optional(),
    spool: z.object({ state: z.number(), error: z.number(), systemError: z.number() }).passthrough().optional() }).passthrough(),
])
const safeInteger = (value: number | undefined, minimum = 0, maximum = 1_000_000) => {
  const parsed = z.number().int().safe().min(minimum).max(maximum).safeParse(value)
  return parsed.success ? parsed.data : null
}

export const createRecordingStartDiagnostic = (
  enabled: boolean,
  write: (event: RecordingStartDiagnosticEvent) => void,
  inhibitCapture = enabled,
) => {
  let count = 0
  const emit = (event: DiagnosticEvent) => {
    if (!enabled || count >= maximumEvents
      || (event.kind !== "native-start-blocked" && count >= maximumEvents - 1)) return
    count += 1
    // Diagnostic output must never veto configure or bypass the no-start guard.
    try { write(event) } catch { /* Output is best-effort; capture inhibition is not. */ }
  }

  return {
    observe(input: z.input<typeof inputSchema>) {
      if (!enabled || count >= maximumEvents) return
      const parsed = inputSchema.safeParse(input)
      if (!parsed.success) return
      const value = parsed.data
      if (value.kind === "backend") {
        const backend = value.backend === "native" || value.backend === "portable" ? value.backend : "unknown"
        emit({ kind: "backend", backend })
      } else if (value.kind === "configure-request") {
        emit({ kind: "configure-request" })
      } else if (value.kind === "configure-result") {
        const outcome = value.outcome === "ready" ? "ready" : "rejected"
        const elapsedMs = safeInteger(value.elapsedMs, 0, 60_000)
        const phase = value.phase === "request" || value.phase === "readiness" ? value.phase : undefined
        const category = value.category === "success" || value.category === "command-rejected"
          || value.category === "admission-failed" || value.category === "native-configure-failed"
          || value.category === "readiness-validation-failed" || value.category === "binding-changed"
          ? value.category : "threw"
        emit({
          kind: "configure-result", outcome, category,
          sampleRateHz: safeInteger(value.sampleRateHz, 1, 768_000),
          channelCount: safeInteger(value.channelCount, 1, 2),
          phase,
          elapsedMs: elapsedMs ?? undefined,
        })
      } else if (value.kind === "readiness") {
        emit({
          kind: "readiness",
          configured: value.configured === true,
          active: value.active === true,
          sampleRateHz: safeInteger(value.sampleRateHz, 1, 768_000),
          channelCount: safeInteger(value.channelCount, 1, 2),
          spoolState: safeInteger(value.spool?.state, 0, 16),
          spoolError: safeInteger(value.spool?.error, 0, 1_000_000),
          spoolSystemError: safeInteger(value.spool?.systemError, 0, 1_000_000),
        })
      }
    },
    async start<T>(nativeStart: () => Promise<T>): Promise<T | { readonly ok: false; readonly error: "diagnostic-capture-blocked" }> {
      if (inhibitCapture) {
        emit({ kind: "native-start-blocked" })
        return Promise.resolve({ ok: false, error: "diagnostic-capture-blocked" })
      }
      try {
        const result = await nativeStart()
        emit({ kind: "native-start-result", outcome: "succeeded" })
        return result
      } catch (error) {
        emit({ kind: "native-start-result", outcome: "rejected" })
        throw error
      }
    },
  }
}
