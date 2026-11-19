import { expect, test } from "bun:test"
import { assessRecordedAudioContent, collectLongTaskRecords, correlateRecordingStall, parseLongTaskEvidence, summarizeRecordingWindowState, TierThreeRecordingFailure, selectTierThreeParameter, selectTierThreeSecondaryParameter, validateTierThreeRecording, validateTierThreeAudioRecording, matchingWorkerAutomation, tierThreeAutomationObservationMs, startTraceBeforeRecordingDiagnostics, reEnableAutomationBeforePlayback, retainTierThreeRecordingFailure, diagnosticStageFailure } from "./tier-three"

test("persisted spool audio must match the asset row and exact proven frames", () => {
  const asset = { sizeBytes: 1_152_044, contentSha256: "a".repeat(64), sampleRate: 48_000, channelCount: 2, durationSec: 3 }
  const content = { sizeBytes: 1_152_044, sha256: "a".repeat(64), formatTag: 3, channels: 2, sampleRate: 48_000, bitsPerSample: 32, frames: 144_000, nonzeroSamples: 10, nonFiniteSamples: 0, peakAbs: 0.2 }
  expect(assessRecordedAudioContent(asset, content, 144_000, 48_000)).toEqual([])
  expect(assessRecordedAudioContent(asset, content, 140_000, 48_000)).toContain("frames")
  expect(assessRecordedAudioContent(asset, { ...content, sizeBytes: 44 }, 140_000, 48_000)).toContain("size")
  expect(assessRecordedAudioContent(asset, { ...content, sha256: "b".repeat(64) }, 140_000, 48_000)).toContain("sha256")
  expect(assessRecordedAudioContent(asset, { ...content, formatTag: 1, bitsPerSample: 16 }, 140_000, 48_000)).toContain("format")
  expect(assessRecordedAudioContent(asset, { ...content, channels: 1 }, 140_000, 48_000)).toContain("channels")
  expect(assessRecordedAudioContent(asset, content, 140_000, 44_100)).toContain("sample-rate")
  expect(assessRecordedAudioContent(asset, content, 150_000, 48_000)).toContain("frames")
  expect(assessRecordedAudioContent({ ...asset, durationSec: 2 }, content, 140_000, 48_000)).toContain("duration")
  expect(assessRecordedAudioContent(asset, { ...content, nonFiniteSamples: 1 }, 140_000, 48_000)).toContain("non-finite")
  expect(assessRecordedAudioContent(asset, { ...content, nonzeroSamples: 0, peakAbs: 0 }, 144_000, 48_000)).toEqual([])
})

test("window-state report attributes the writer worst only when it occurred inside the state", () => {
  const before = { capturedFrames: 100, droppedFrames: 0, overrunFrames: 0, writerReturnMaxMs: 7, writerReturnDeliveryMaxMs: 6, writerReturnDeliveryWorst: { returnedAtEpochMs: 10, receivedAtEpochMs: 16 }, nativeArrivalGapMaxMs: 12, writerOldestOutstandingMs: 9, peakQueuedFrames: 512, termination: null, writerTiming: null }
  const inside = { ...before, capturedFrames: 1_200_100, writerReturnDeliveryMaxMs: 40, writerReturnDeliveryWorst: { returnedAtEpochMs: 1_500, receivedAtEpochMs: 1_540 }, writerTiming: { storage: { channelWriteMs: { max: 30 } } } }
  const observation = { raf: { minimized: 0 }, visibility: [{ label: "minimized", state: "hidden", epochMs: 1_001 }], losses: [{ label: "minimized", error: "Native VST3 worker missed its deadline.", epochMs: 1_200 }] }
  const report = summarizeRecordingWindowState("minimized", 1_000, 26_000, "hidden", before, before, inside, observation)
  expect(report).toMatchObject({ state: "minimized", durationMs: 25_000, sampledVisibility: "hidden", rafCallbacks: 0, capturedFrames: 1_200_000, droppedFrames: 0, overrunFrames: 0, writerReturnDeliveryWorstInStateMs: 40, storageChannelWriteMaxMsCumulative: 30, terminationAfterTransition: null, terminationAtEnd: null })
  expect(report.visibilityTransitions).toEqual(["hidden"])
  expect(report.hostLosses).toEqual([{ error: "Native VST3 worker missed its deadline.", afterStateStartMs: 200 }])
  const ended = { ...inside, capturedFrames: 0, droppedFrames: 3, termination: { cause: "writer-failure" } }
  const unchanged = summarizeRecordingWindowState("occluded", 30_000, 55_000, "visible", inside, ended, ended, { raf: {}, visibility: [], losses: [] })
  expect(unchanged.hostLosses).toEqual([])
  expect(unchanged).toMatchObject({ writerReturnDeliveryWorstInStateMs: null, writerReturnDeliveryMaxMsUpperBound: 40, droppedFrames: 3, rafCallbacks: 0, terminationAfterTransition: "writer-failure", terminationAtEnd: "writer-failure" })
})

test("labels a failed host diagnostic with its Tier 3 stage", () => {
  expect(diagnosticStageFailure('after-manual-override', new Error('deadline-exceeded')).message)
    .toBe('Tier 3 after-manual-override diagnostics failed: deadline-exceeded')
})

test("uses only the visible re-enable control and confirms it clears", async () => {
  const expressions: string[] = []
  const run = async (expression: string) => {
    expressions.push(expression)
    return expressions.length === 1 ? "true" : expressions.length === 2 ? "true" : "false"
  }
  expect(await reEnableAutomationBeforePlayback(run)).toBe("ui-re-enabled")
  expect(expressions).toHaveLength(3)
  expect(await reEnableAutomationBeforePlayback(async () => "false")).toBe("control-absent")
})
test("starts the diagnostic trace before reading the five-second host snapshot", async () => {
  const stages: string[] = []
  const read = async () => { stages.push("host-diagnostics") }
  const trace = async () => { stages.push("trace-start") }
  await startTraceBeforeRecordingDiagnostics(read, trace)
  expect(stages).toEqual(["trace-start", "host-diagnostics"])
})
test("samples after the eight-second real VST automation point", () => {
  expect(tierThreeAutomationObservationMs).toBe(9_000)
})

test("drains pending observer records before disconnect and bounds evidence", () => {
  const evidence = { supported: true, truncated: false, intervals: [{ startEpochMs: 1, endEpochMs: 2 }] }
  collectLongTaskRecords(evidence, [{ startTime: 100, duration: 70 }], 1000)
  expect(evidence.intervals).toEqual([{ startEpochMs: 1, endEpochMs: 2 }, { startEpochMs: 1100, endEpochMs: 1170 }])
})

test("worker observation requires exact instance, parameter, epoch and increasing sequence", () => {
  const observation = { instanceId: "real", lastParameterId: 4, transportEpoch: 7, sequence: "9007199254740993", acceptedPoints: 2 }
  expect(matchingWorkerAutomation(observation, "real", 4, 7, "9007199254740992")).toBe(true)
  expect(matchingWorkerAutomation(observation, "other", 4, 7, "1")).toBe(false)
  expect(matchingWorkerAutomation(observation, "real", 5, 7, "1")).toBe(false)
  expect(matchingWorkerAutomation(observation, "real", 4, 8, "1")).toBe(false)
  expect(matchingWorkerAutomation(observation, "real", 4, 7, observation.sequence)).toBe(false)
  expect(matchingWorkerAutomation(null, "real", 4, 7, "1")).toBe(false)
})

test("parses the browser driver's nested JSON encoding of longtask evidence", () => {
  const evidence = { supported: true, truncated: false, intervals: [{ startEpochMs: 100, endEpochMs: 120 }] }
  expect(parseLongTaskEvidence(JSON.stringify(JSON.stringify(evidence)))).toEqual(evidence)
  expect(() => parseLongTaskEvidence(JSON.stringify(JSON.stringify({ ...evidence, secret: "not allowed" })))).toThrow()
})

test("classifies return delay only when task evidence is complete", () => {
  const worst = { returnedAtEpochMs: 100, receivedAtEpochMs: 1200 }
  expect(correlateRecordingStall(worst, { supported: true, truncated: false, intervals: [{ startEpochMs: 200, endEpochMs: 700 }] })).toBe("renderer-longtask-overlap")
  expect(correlateRecordingStall(worst, { supported: true, truncated: false, intervals: [] })).toBe("no-observed-longtask-overlap")
  expect(correlateRecordingStall(worst, { supported: false, truncated: false, intervals: [] })).toBe("unknown")
})

test("retains bounded longtask evidence when recording ends early", () => {
  const evidence = { supported: true, truncated: false, intervals: [{ startEpochMs: 200, endEpochMs: 700 }] }
  const failure = new TierThreeRecordingFailure("ended early", evidence, "renderer-longtask-overlap")
  expect(failure.message).toBe("ended early")
  expect(failure.longTasks).toEqual(evidence)
  expect(failure.stallCorrelation).toBe("renderer-longtask-overlap")
})

test("retains pre-recording live VST probe status when capture fails", () => {
  const failure = new TierThreeRecordingFailure("writer overflow", null, "unknown", "No matching worker observation.")
  expect(failure.issue48LiveReEnableReason).toBe("No matching worker observation.")
  expect(failure.workerAutomationAtPlayback).toBeNull()
})

test("retains playback native epoch and scheduled count before recording changes epoch", () => {
  const playback = { transportEpoch: 7, callbacks: 123, submittedVstSegments: 9, state: "running" }
  const failure = new TierThreeRecordingFailure("writer failure", null, "unknown", "No observation", null, null, playback)
  expect(failure.nativeAtPlayback).toEqual(playback)
})
test("preserves initial-playback evidence when recording startup fails before a status sample", () => {
  const playback = { transportEpoch: 7, callbacks: 123, submittedVstSegments: 9, state: "running" }
  const failure = retainTierThreeRecordingFailure(
    new Error("SAB worker unavailable"), "No matching worker observation", null, playback,
  )
  expect(failure.message).toBe("SAB worker unavailable")
  expect(failure.nativeAtPlayback).toEqual(playback)
})

test("selects only the unique writable Mix parameter from the installed Valhalla instance", () => {
  const parameters = [
    { id: 4, title: "Mix", readOnly: false, hidden: false, currentValue: 0.5 },
    { id: 5, title: "Mix", readOnly: true, hidden: false, currentValue: 0.5 },
  ]
  expect(selectTierThreeParameter(parameters)).toEqual(parameters[0])
  expect(() => selectTierThreeParameter([{ ...parameters[0], hidden: true }])).toThrow()
  expect(() => selectTierThreeParameter([parameters[0], { ...parameters[0], id: 6 }])).toThrow()
})

test("selects a distinct visible writable Valhalla parameter for selective automation coverage", () => {
  const parameters = [
    { id: 48, title: "Mix", readOnly: false, hidden: false, currentValue: 0.5 },
    { id: 49, title: "Width", readOnly: false, hidden: false, currentValue: 0.5 },
  ]
  expect(selectTierThreeSecondaryParameter(parameters, 48)).toEqual(parameters[1])
  expect(() => selectTierThreeSecondaryParameter([{ ...parameters[1], readOnly: true }], 48)).toThrow()
})

test("recording must add a real MIDI clip with the requested notes on the armed track", () => {
  const before = [{ id: "existing", trackId: "other", midi: { notes: [] } }]
  const after = [...before, {
    id: "recorded", trackId: "synth-track", midi: { notes: [
      { pitch: 60, velocity: 0.9, length: 0.5 },
      { pitch: 64, velocity: 0.9, length: 0.5 },
    ] },
  }]
  expect(validateTierThreeRecording(before, after, "synth-track", [60, 64])).toBe("recorded")
  expect(() => validateTierThreeRecording(before, before, "synth-track", [60, 64])).toThrow()
  expect(() => validateTierThreeRecording(before, after, "synth-track", [60, 67])).toThrow()
})

test("native recording requires one new persisted audio clip with captured frames", () => {
  const before = [{ id: "existing", trackId: "audio-track", source: { sourceKind: "recording" }, duration: 2 }]
  const after = [...before, { id: "take", trackId: "audio-track", source: { sourceKind: "recording" }, duration: 3 }]
  expect(validateTierThreeAudioRecording(before, after, "audio-track", 144_000, 48_000)).toBe("take")
  expect(() => validateTierThreeAudioRecording(before, after, "audio-track", 0, 48_000)).toThrow()
  expect(() => validateTierThreeAudioRecording(before, before, "audio-track", 144_000, 48_000)).toThrow()
})
