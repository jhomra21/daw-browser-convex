import { expect, test } from "bun:test"
import { browserProbeResultSchema } from "./probe"
import { deriveProbeErrors, deriveUnavailable } from "./run-result"

const probe = {
  version: "30-track-probe-v2",
  phases: [{
    name: "warmup",
    parameters: { sampleCount: 1 },
    durationMs: 1,
    raf: {
      supported: false,
      unavailableReason: "raf-not-delivered",
      sampleCount: 0,
      intervalsMs: { p50: null, p95: null, p99: null, max: null },
      thresholds: { over8_33Ms: 0, over16_67Ms: 0, over33_3Ms: 0, over50Ms: 0 },
    },
    longTasks: { supported: true, count: 0, totalDurationMs: 0, maxDurationMs: null },
    heap: { supported: false, source: "performance.memory", beforeBytes: null, afterBytes: null, totalBytes: null, limitBytes: null },
    errors: [{ kind: "unhandledrejection", message: "Failed to fetch Convex auth token" }],
    unavailable: ["raf-not-delivered"],
  }],
  startupErrors: [],
  display: {
    viewportSupported: false,
    viewportUnavailableReason: "viewport-not-reported",
    viewportWidth: null,
    viewportHeight: null,
    devicePixelRatio: 1,
    intervalEstimateMs: null,
  },
  canvasAttribution: { supported: false, reason: "not-instrumented" },
  integrity: {
    fixtureHashVerified: false,
    semanticManifestVerified: false,
    starterProjectId: null,
    importedProjectId: null,
    importedProjectDifferent: false,
    trackCount: 0,
    clipCount: 0,
    expectedTrackLabels: 0,
    expectedClipTitles: 0,
    serviceWorkerControllerAbsent: true,
    transportPlaybackUiVerified: false,
    transportStopUiVerified: false,
    audioEvidence: "not-observed",
  },
} satisfies Parameters<typeof deriveProbeErrors>[0]

test("derives unavailable fields from probe capability results", () => {
  expect(deriveUnavailable("browser", probe)).toEqual([
    "raf-not-delivered",
    "viewport-not-reported",
    "canvas-attribution-not-instrumented",
  ])
  expect(deriveUnavailable("electron", null)).toEqual([
    "electron-surface-not-run",
    "raf-not-delivered",
    "viewport-not-reported",
    "long-task-observer-unavailable",
    "canvas-attribution-not-instrumented",
  ])
})

test("promotes probe errors into top-level result messages", () => {
  expect(deriveProbeErrors(probe)).toEqual([
    "unhandledrejection: Failed to fetch Convex auth token",
  ])
})

test("accepts exact transport and heap evidence fields", () => {
  const parsed = browserProbeResultSchema.parse(probe)
  expect(parsed.integrity.transportPlaybackUiVerified).toBe(false)
  expect(parsed.integrity.transportStopUiVerified).toBe(false)
  expect(parsed.integrity.audioEvidence).toBe("not-observed")
  expect(parsed.phases[0]?.heap.source).toBe("performance.memory")
})
