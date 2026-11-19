import { expect, test } from "bun:test"
import { assessSpoolCompletion, spoolObservationLimit, assessSpoolCapture, assessNativeSpoolAsset, assessSpoolProductDialog } from "./native-spool-evidence"

// Failure-first: legacy zero counters, missing native proof, format/totals
// mismatch, dropped data, pool overflow, premature/missing release, missing
// durable clip observation, padded/truncated decoded audio and unbounded waits.
const status = {
  capturedFrames: 2880000, droppedFrames: 0, droppedBlocks: 0, availableBlocks: 32, queuedBlocks: 0,
  fatal: false, active: false, configured: true,
  spool: { state: 2, error: 0, systemError: 0, writtenFrames: 2880000,
    writtenBytes: 11525628, writtenBlocks: 1407, published: true, partialRetained: false,
    sampleRateHz: 48000, channelCount: 1 },
}
const proof = { frames: 2880000, bytes: 11525628, blocks: 1407, sampleRateHz: 48000, channelCount: 1 }
const release = {
  calls: 1, succeeded: true, savedClipObserved: true, assetObserved: true, sourcePresentBefore: true,
  sourceAbsentAfter: true, receiptPresent: true, receiptBeforeSourceUnlinkObserved: true,
  proofVerified: true, acknowledgmentFinalized: true, acknowledgmentMatchesProof: true,
  receiptMatchesAcknowledgment: true, listEmptyAfter: true,
}
test("requires full native Complete and independent proof, never legacy zero counters", () => {
  expect(assessSpoolCompletion(status, proof, release)).toEqual([])
  expect(assessSpoolCompletion(null, proof, release)).toContain("complete-status")
  expect(assessSpoolCompletion(status, null, release)).toContain("complete-proof")
  expect(assessSpoolCompletion({ ...status, capturedFrames: 1 }, proof, release)).toContain("captured-written")
  expect(assessSpoolCompletion({ ...status, droppedBlocks: 1 }, proof, release)).toContain("native-drop-or-fatal")
  expect(assessSpoolCompletion({ ...status, availableBlocks: 33 }, proof, release)).toContain("native-pool")
  expect(assessSpoolCompletion({ ...status, spool: { ...status.spool, published: false } }, proof, release)).toContain("complete-status")
  expect(assessSpoolCompletion(status, { ...proof, bytes: 1 }, release)).toContain("proof-totals")
  for (const key of ["savedClipObserved", "assetObserved", "sourceAbsentAfter", "receiptPresent",
    "receiptBeforeSourceUnlinkObserved", "acknowledgmentMatchesProof", "listEmptyAfter"]) {
    expect(assessSpoolCompletion(status, proof, { ...release, [key]: false })).not.toEqual([])
  }
  expect(assessSpoolCompletion(status, proof, { ...release, calls: 2 })).toContain("release-count")
})
test("Complete retires ready configuration; configured false is not failed completion", () => {
  expect(assessSpoolCompletion({ ...status, configured: false }, proof, release)).toEqual([])
})
test("capture requires explicit native-spool and actual healthy native progress", () => {
  const capture = { ...status, active: true, spool: { ...status.spool, state: 1, published: false } }
  expect(assessSpoolCapture("native-spool", capture)).toEqual([])
  expect(assessSpoolCapture(null, capture)).toContain("native-spool-transport")
  expect(assessSpoolCapture("sab", capture)).toContain("native-spool-transport")
  expect(assessSpoolCapture("native-spool", null)).toContain("native-status")
  expect(assessSpoolCapture("native-spool", { ...capture, fatal: true })).toContain("native-drop-or-fatal")
})
test("asset decoded frames are exact, with negotiated format and matching hash", () => {
  const asset = { sizeBytes: 11520044, contentSha256: "a".repeat(64), sampleRate: 48000, channelCount: 1, durationSec: 60 }
  const content = { sizeBytes: 11520044, sha256: "a".repeat(64), frames: 2880000, sampleRate: 48000,
    channels: 1, formatTag: 3, bitsPerSample: 32, nonFiniteSamples: 0, nonzeroSamples: 1, peakAbs: 0.1 }
  expect(assessNativeSpoolAsset(asset, content, proof)).toEqual([])
  expect(assessNativeSpoolAsset(asset, { ...content, frames: 2880001 }, proof)).toContain("frames")
  expect(assessNativeSpoolAsset(asset, { ...content, channels: 2 }, proof)).toContain("channels")
  expect(assessNativeSpoolAsset(asset, { ...content, sha256: "b".repeat(64) }, proof)).toContain("sha256")
})
test("size-aware observation has explicit capped finite budget and workload reason", () => {
  const normal = spoolObservationLimit(11525628)
  const large = spoolObservationLimit(100 * 1024 * 1024)
  expect(normal.timeoutMs).toBeGreaterThanOrEqual(30000)
  expect(large.timeoutMs).toBeGreaterThan(normal.timeoutMs)
  expect(spoolObservationLimit(1024 ** 4).timeoutMs).toBeLessThanOrEqual(180000)
  expect(normal.reason).toContain("MiB")
  expect(() => spoolObservationLimit(-1)).toThrow()
})
test("a playback-fault dialog blocks take acceptance even after valid content and release", () => {
  expect(assessSpoolProductDialog("")).toEqual([])
  expect(assessSpoolProductDialog("Native playback stoppedNative audio playback stopped because the native graph is no longer active.OKClose")).toEqual(["product-failure-dialog"])
})
