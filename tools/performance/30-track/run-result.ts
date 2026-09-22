import type { BrowserProbeResult } from "./probe"

export type SourceIdentity = {
  readonly commit: string
  readonly dirty: boolean
}

export const deriveUnavailable = (surface: "browser" | "electron", probe: BrowserProbeResult | null): string[] => {
  const unavailable = new Set<string>()
  if (surface === "electron") unavailable.add("electron-surface-not-run")
  if (probe === null || probe.phases.every((phase) => !phase.raf.supported)) unavailable.add("raf-not-delivered")
  if (probe === null || !probe.display.viewportSupported) unavailable.add("viewport-not-reported")
  if (probe === null || probe.phases.every((phase) => !phase.longTasks.supported)) unavailable.add("long-task-observer-unavailable")
  unavailable.add("canvas-attribution-not-instrumented")
  return [...unavailable]
}

export const deriveProbeErrors = (probe: BrowserProbeResult): string[] => (
  [
    ...probe.startupErrors,
    ...probe.phases.flatMap((phase) => phase.errors),
  ].map((error) => `${error.kind}: ${error.message}`)
)
