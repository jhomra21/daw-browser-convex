import { expect, test } from "bun:test"
import { observeSavedSpoolClip, assessSpoolNativeIntegrity } from "./native-spool-evidence"
import { recordedAudioContentSchema } from "./recorded-audio-content"

const clip = { id: "saved", trackId: "track", duration: 1, source: { sourceKind: "recording", assetId: "asset" } }
const asset = { id: "asset", sourceKind: "recording", sizeBytes: 100, contentSha256: "a".repeat(64) }
const input = { beforeClips: [], clips: [clip], assets: [asset], trackId: "track",
  savedClip: { clipId: "saved", sourceAssetKey: "asset" } }
test("normal spool runner observes exactly one saved clip and matching asset without invoking legacy PCM/SAB workload", () => {
  expect(observeSavedSpoolClip(input)).toEqual({ clip, asset })
  expect(() => observeSavedSpoolClip({ ...input, assets: [] })).toThrow()
  expect(() => observeSavedSpoolClip({ ...input, beforeClips: [clip] })).toThrow()
  expect(() => observeSavedSpoolClip({ ...input, clips: [clip, { ...clip, id: "duplicate" }] })).toThrow()
  expect(() => observeSavedSpoolClip({ ...input, savedClip: { ...input.savedClip, clipId: "other" } })).toThrow()
  expect(() => observeSavedSpoolClip({ ...input, clips: [{ ...clip, source: { ...clip.source, assetId: "wrong" } }] })).toThrow()
  expect(() => observeSavedSpoolClip({ ...input, assets: [{ ...asset, sourceKind: "upload" }] })).toThrow()
})
test("isolated persisted-content helper retains exact bounded content contract", () => {
  expect(recordedAudioContentSchema.safeParse({ frames: 3 }).success).toBe(false)
})
test("native integrity uses measured callbacks and VST counters, not legacy zero writer/SAB fields", () => {
  const native = { status: "available", artifactVerification: { status: "verified" },
    diagnostics: { rejectedBlocks: 0, callbacks: 1,
      vstWorkerPerformance: { faults: "0", watchdogMisses: "0", restarts: "0" } } }
  expect(assessSpoolNativeIntegrity([native, { ...native, diagnostics: { ...native.diagnostics, callbacks: 2 } }], 0)).toEqual([])
  expect(assessSpoolNativeIntegrity([native, native], 0)).toContain("native-callback-progress")
  expect(assessSpoolNativeIntegrity([native, native], 1)).toContain("native-worker-incident")
  for (const key of ["faults", "watchdogMisses", "restarts"]) {
    const bad = { ...native, diagnostics: { ...native.diagnostics,
      vstWorkerPerformance: { ...native.diagnostics.vstWorkerPerformance, [key]: "1" } } }
    expect(assessSpoolNativeIntegrity([native, bad], 0)).toContain("vst-fault-watchdog-restart")
  }
  expect(assessSpoolNativeIntegrity([{ ...native, diagnostics: { ...native.diagnostics, vstWorkerPerformance: null } }], 0)).not.toEqual([])
  expect(assessSpoolNativeIntegrity([{ ...native, artifactVerification: { status: "development" } }], 0)).toContain("native-artifact-integrity")
  expect(assessSpoolNativeIntegrity([{ ...native, diagnostics: { ...native.diagnostics, rejectedBlocks: 1 } }], 0)).toContain("native-artifact-integrity")
  expect(assessSpoolNativeIntegrity([{ ...native, status: "failed" }], 0)).not.toEqual([])
  expect(assessSpoolNativeIntegrity([{ status: "unavailable" }], 0)).toContain("native-artifact-integrity")
})
