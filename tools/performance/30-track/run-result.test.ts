import { expect, test } from "bun:test"
import { browserProbeResultSchema } from "./probe"
import { deriveProbeErrors, deriveRequiredTier2Failures, deriveUnavailable, deriveTierThreeFailures } from "./run-result"

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
    tier2SemanticSnapshotVerified: false,
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
    tier2VisibleWorkload: {
      trackSelected: false,
      effectsPanelOpened: false,
      synthVisible: false,
      saturatorVisible: false,
      utilityVisible: false,
    },
    meterEvidence: {
      status: "unavailable",
      activityDetected: null,
      maxHeightPercent: null,
      unavailableReason: "stable-rendered-meter-signal-unavailable",
    },
    audioEvidence: {
      kind: "not-observed",
      audibleOutputVerified: false,
    },
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
  expect(parsed.integrity.tier2SemanticSnapshotVerified).toBe(false)
  expect(parsed.integrity.audioEvidence).toEqual({
    kind: "not-observed",
    audibleOutputVerified: false,
  })
  expect(parsed.phases[0]?.heap.source).toBe("performance.memory")
})

test("rejects probe results that omit explicit Tier 2 runtime evidence", () => {
  const { tier2VisibleWorkload: _tier2VisibleWorkload, ...integrity } = probe.integrity
  expect(() => browserProbeResultSchema.parse({ ...probe, integrity })).toThrow()
})

test("fails required Tier 2 device gates and browser meter activity", () => {
  expect(deriveRequiredTier2Failures("browser", probe)).toEqual([
    "Tier 2 Synth track was not selected through the rendered UI.",
    "Effects panel was not opened through the rendered UI.",
    "Tier 2 Synth device was not visibly rendered.",
    "Tier 2 Saturator device was not visibly rendered.",
    "Tier 2 Utility device was not visibly rendered.",
    "Tier 2 selected-track meter activity was unavailable.",
  ])
})

test("reports a failed or missing requested Tier 3 workload as a failed run", () => {
  expect(deriveTierThreeFailures(true, undefined)).toEqual(["Tier 3 workload did not produce a result."])
  expect(deriveTierThreeFailures(true, {
    status: "failed",
    stage: "recording",
    reason: "MIDI access denied",
    failureEvidencePath: "/tmp/private/failure.json",
    issue48LiveReEnableCertification: "not-attempted",
  })).toEqual(["Tier 3 failed at recording: MIDI access denied"])
  expect(deriveTierThreeFailures(false, undefined)).toEqual([])
})
