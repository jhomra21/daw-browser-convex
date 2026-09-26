type Boundary = "browser" | "control-cli"
type Entry = {
  readonly boundary: Boundary
  readonly kind: string
  readonly startedAt: string
  readonly durationMs: number
  readonly exitCode: number | null
}

const browserKinds = new Set(["connect", "tab", "set", "open", "wait", "eval", "get", "upload", "find", "console", "errors", "close", "screenshot"])
const controlKinds = new Set(["host", "snapshot-v2"])

export const createCommandTimings = (enabled: boolean) => {
  const entries: Entry[] = []
  return {
    record(boundary: Boundary, kind: string, startedAt: number, durationMs: number, exitCode: number | null) {
      if (!enabled) return
      entries.push({
        boundary,
        kind: (boundary === "browser" ? browserKinds : controlKinds).has(kind) ? kind : "unknown",
        startedAt: new Date(startedAt).toISOString(),
        durationMs,
        exitCode,
      })
      if (entries.length > 64) entries.shift()
    },
    snapshot: (): readonly Entry[] => [...entries],
  }
}

export type CommandTimings = ReturnType<typeof createCommandTimings>
