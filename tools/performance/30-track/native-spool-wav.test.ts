import { expect, test } from "bun:test"
import { z } from "zod"
import { encodePlanarFloat32Wav } from "../../../packages/audio-engine/src/recording/encode-wav"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { writeWav } from "../../acceptance/ae08-wav"
import { tapMetrics } from "../../acceptance/packaged-r27-regressions"
import { analyzePhase5, analyzePhase5EffectState, checkPhase5EffectState, comparePhase5, phase5EffectStateEvidence,
  phase5EffectStateSyntheticProof } from "../../acceptance/analyze-ae-08-continuity"
import { phase5Rows } from "../../acceptance/ae-08-phase-5-fixture"

// Failure inventory before implementation: averaging masks isolated zeros;
// silence-only probes miss doubling; seam exclusion masks missing fades and
// block offsets; checking only the seam misses early stops; PCM alone misses
// rebuilds. Every injected copy must fail the same gate used by real captures.
test("phase 5 checks every sample, every seam, and native lifecycle proof", () => {
  for (const sampleRate of [44100, 48000, 96000]) {
    for (const block of [64, 512]) {
      const seam = block * 8
      const frames = seam + sampleRate
      const reference = { sampleRate, channels: 2, samples: Float32Array.from(
        { length: frames * 2 }, (_, index) => 0.15 + 0.03 * Math.sin(index * 0.017)) }
      const options = { seams: [seam], blockFrames: block, lifecycleHealthy: true }
      expect(comparePhase5(reference, reference, options).passed).toBe(true)
      const defect = (change: (samples: Float32Array) => void) => {
        const samples = reference.samples.slice()
        change(samples)
        expect(comparePhase5({ ...reference, samples }, reference, options).passed).toBe(false)
      }
      defect((samples) => { samples[seam * 2 + 2] = 0 }) // one sample
      defect((samples) => samples.fill(0, seam * 2, (seam + 64) * 2))
      defect((samples) => { for (let i = seam * 2; i < samples.length; i++) samples[i] = (samples[i] ?? 0) * 2 })
      defect((samples) => { samples[seam * 2] = (samples[seam * 2] ?? 0) + 0.08 }) // missing fade step
      defect((samples) => samples.fill(0, (frames - 1000) * 2))
      defect((samples) => samples.copyWithin(seam * 2, (seam + block) * 2))
      expect(comparePhase5(reference, reference, { ...options, lifecycleHealthy: false }).passed).toBe(false)
      expect(comparePhase5(reference, reference, { ...options, seams: [] }).passed).toBe(false)
    }
  }
})

test("phase 5 file analyzer rejects injected PCM and an actual rebuild event", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ae08-phase5-"))
  const sampleRate = 48000, frames = sampleRate * 4, seam = 512 * 192
  const samples = Float32Array.from({ length: frames * 2 },
    (_, index) => 0.08 + 0.025 * Math.sin(index * 0.027) + 0.015 * Math.sin(index * index * 1e-8))
  const pcm = { samples, sampleRate, channels: 2 }
  const finalSamples = samples.slice()
  const cleanSamples = samples.slice()
  const fade = Math.trunc(sampleRate * 0.006)
  for (let frame = 0; frame < frames; frame++) {
    finalSamples[frame * 2 + 1] = 0
    if (frame >= seam) cleanSamples[frame * 2 + 1] = Math.fround((samples[frame * 2 + 1] ?? 0)
      * Math.max(0, Math.fround(1 - Math.fround((frame - seam) / fade))))
  }
  const captureBlocks = Array.from({ length: frames / 512 }, (_, index) => ({ event: "capture-block", pid: 1, captureId: 2,
    offset: index * 512, frames: 512, transportFrame: index * 512, transportEpoch: 3, revision: index * 512 < seam ? 1 : 2,
    wallMs: index * 512 / 48 + 1000 }))
  const native = [
    { event: "graph-publish-request", wallMs: 2999, requestedRevision: 2, transportEpoch: 3 },
    { event: "graph-publish", wallMs: 3000, pid: 1, revision: 2, transportEpoch: 3,
      publicationFrame: seam, publicationEpoch: 190, cause: "block-boundary" },
    { event: "capture-complete", pid: 1, captureId: 2, frames, failed: false, overflowFrames: 0, wallMs: 5100 },
  ]
  const writeNative = (rebuild: boolean, blocks = captureBlocks, completedFrames = frames) =>
    writeFile(path.join(directory, "host.jsonl"),
    [...blocks, ...native,
      ...(rebuild ? [{ event: "structural-rebuild", wallMs: 3100, transportEpoch: 3 }] : [])]
      .map((entry) => JSON.stringify(entry.event === "capture-complete"
        ? { ...entry, frames: completedFrames } : entry)).join("\n") + "\n")
  try {
    await writeFile(path.join(directory, "phase5-edits.json"), JSON.stringify({
      phase: 5, row: "delete-clip", editStart: 2990, commits: [{ wallMs: 3010, revision: 2 }], endFrame: frames,
    }))
    await writeFile(path.join(directory, "actions.jsonl"), JSON.stringify({ event: "capture-end", wallMs: 5000 }) + "\n")
    await writeWav(path.join(directory, "initial-reference.wav"), pcm)
    await writeWav(path.join(directory, "final-reference.wav"), { ...pcm, samples: finalSamples })
    await writeNative(false)
    await writeWav(path.join(directory, "output-1-2.wav"), { ...pcm, samples: cleanSamples })
    expect((await analyzePhase5(directory)).passed).toBe(true)
    const repeatedOffset = captureBlocks.map((entry) => ({ ...entry }))
    if (repeatedOffset[1]) repeatedOffset[1].offset = 0
    await writeNative(false, repeatedOffset)
    expect((await analyzePhase5(directory)).checks.captureIntegrity).toBe(false)
    const rawGap = captureBlocks.map((entry) => ({ ...entry }))
    if (rawGap[1]) rawGap[1].offset = 513
    await writeNative(false, rawGap)
    expect((await analyzePhase5(directory)).checks.captureIntegrity).toBe(false)
    await writeNative(false, captureBlocks.slice(0, -1))
    expect((await analyzePhase5(directory)).checks.captureIntegrity).toBe(false)
    await writeNative(false, captureBlocks, frames - 512)
    expect((await analyzePhase5(directory)).checks.captureIntegrity).toBe(false)
    await writeNative(false)
    const defects: [string, (samples: Float32Array) => void][] = [
      ["one-sample-dropout", (copy) => { copy[seam * 2 + 1] = 0 }],
      ["64-frame-gap", (copy) => copy.fill(0, seam * 2, (seam + 64) * 2)],
      ["doubled-source", (copy) => { for (let i = seam * 2 + 1; i < copy.length; i += 2) copy[i] = (copy[i] ?? 0) + (samples[i] ?? 0) }],
      ["missing-fade-step", (copy) => { for (let i = seam * 2 + 1; i < (seam + fade) * 2; i += 2) copy[i] = 0 }],
      ["early-stop", (copy) => copy.fill(0, (frames - 2048) * 2)],
      ["one-block-offset", (copy) => copy.copyWithin(seam * 2, (seam + 512) * 2)],
    ]
    for (const [name, inject] of defects) {
      const copy = cleanSamples.slice()
      inject(copy)
      await writeWav(path.join(directory, "output-1-2.wav"), { ...pcm, samples: copy })
      const analysis = await analyzePhase5(directory)
      expect(analysis.passed, name).toBe(false)
      expect(analysis.comparison.mismatches, name).toBeGreaterThan(0)
      console.log(JSON.stringify({ phase: 5, defect: name, verdict: "rejected",
        mismatches: analysis.comparison.mismatches, firstMismatch: analysis.comparison.firstMismatch }))
    }
    await writeWav(path.join(directory, "output-1-2.wav"), { ...pcm, samples: cleanSamples })
    await writeNative(true)
    expect((await analyzePhase5(directory)).checks.noColdRebuild).toBe(false)
    expect((await analyzePhase5(directory)).passed).toBe(false)
    console.log(JSON.stringify({ phase: 5, defect: "rebuild-marker", verdict: "rejected" }))
    await writeNative(false)
    expect((await analyzePhase5(directory)).passed).toBe(true)
    console.log(JSON.stringify({ phase: 5, defect: "clean", verdict: "pass" }))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

// Effect-state failure inventory, recorded before the row existed: a gap or a
// one-block shift inside a playing span; a transport skip or stall inside a
// running epoch passed off as a pause; a gain or FFT size that never changed in
// the audio; a preview that never reached native before release; and a draft or
// persisted value restored after the pause. Each must fail its own check. The
// clean capture pauses, re-renders one block on resume and ramps back in, so a
// deliberate pause boundary must not read as a gap.
test("phase 5 effect-state analyzer rejects span gaps, unchanged gain/FFT, unannounced stalls and restored values", async () => {
  expect(phase5Rows).toContain("effect-state")
  const proof = phase5EffectStateSyntheticProof()
  expect(proof.clean).toBe(true)
  expect(Object.keys(proof.defects)).toEqual(expect.arrayContaining(["playing-gap", "pcm-discontinuity",
    "transport-skip", "stall-without-pause", "gain-unchanged", "fft-unchanged", "restored-draft", "restored-persisted"]))
  for (const [defect, result] of Object.entries(proof.defects)) {
    expect(result.rejected, defect).toBe(true)
    console.log(JSON.stringify({ phase: 5, row: "effect-state", defect, verdict: "rejected", intended: result.intended, failed: result.failed }))
  }
  const directory = await mkdtemp(path.join(tmpdir(), "ae08-effect-state-"))
  const write = async (evidence: ReturnType<typeof phase5EffectStateEvidence>) => {
    const lines = (entries: object[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
    await writeFile(path.join(directory, "phase5-edits.json"), JSON.stringify(evidence.plan))
    await writeFile(path.join(directory, "host.jsonl"), lines(evidence.host))
    await writeFile(path.join(directory, "actions.jsonl"), lines(evidence.actions))
    await writeFile(path.join(directory, "effect-state-progress.json"), JSON.stringify(evidence.progress))
    await writeFile(path.join(directory, "final-snapshot.json"), JSON.stringify({ processors: evidence.persistedGainDb === undefined ? []
      : [{ target: { trackId: evidence.plan.effectState.trackId }, processor: { kind: "utility", params: { version: 1, state: { gainDb: evidence.persistedGainDb } } } }] }))
    await writeWav(path.join(directory, "output-1-2.wav"), evidence.capture)
    await writeWav(path.join(directory, "initial-reference.wav"), evidence.leftReference)
    await writeWav(path.join(directory, "changed.wav"), evidence.rightSource)
    await writeWav(path.join(directory, "final-reference.wav"), evidence.finalReference)
  }
  try {
    await write(phase5EffectStateEvidence())
    expect((await analyzePhase5EffectState(directory)).passed).toBe(true)
    for (const defect of ["playing-gap", "stall-without-pause", "fft-unchanged", "restored-persisted"] as const) {
      await write(phase5EffectStateEvidence(defect))
      const analysis = await analyzePhase5EffectState(directory)
      expect(analysis.passed, defect).toBe(false)
      console.log(JSON.stringify({ phase: 5, row: "effect-state", file: true, defect, verdict: "rejected",
        failed: Object.entries(analysis.checks).filter(([, ok]) => !ok).map(([name]) => name) }))
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

// C0b failure inventory, recorded before the fix, using the C0 reviewer's
// probe mutations: a 2 ms right-channel dropout that a 10 ms energy floor
// averages away; a resume frame two blocks from the renderer's paused frame;
// and the checks that had no synthetic defect of their own.
const resumedStart = (evidence: ReturnType<typeof phase5EffectStateEvidence>) => {
  const first = evidence.host.find((entry) => entry.event === "capture-block" && entry.transportEpoch === 5)
  return { offset: Number(first?.offset), transportFrame: Number(first?.transportFrame) }
}
test("phase 5 effect-state C0b witnesses: short dropout, resume away from the paused frame, uncovered checks", () => {
  const dropout = phase5EffectStateEvidence()
  const dropoutAt = resumedStart(dropout).offset + 48000
  for (let frame = dropoutAt; frame < dropoutAt + 96; frame++) dropout.capture.samples[frame * 2 + 1] = 0
  const far = phase5EffectStateEvidence()
  far.plan.effectState.pausedFrame = resumedStart(far).transportFrame + 1024
  const proof = phase5EffectStateSyntheticProof()
  const defects = ["resume-other-frame", "resume-click", "publish-missing", "publish-configured-boundary",
    "stamps-misordered", "capture-overflow"]
  expect({
    shortDropoutRejected: checkPhase5EffectState(dropout).checks.rightPathCoveredAndGapFree === false,
    resumeAwayFromPausedFrameRejected: checkPhase5EffectState(far).checks.pauseBoundary === false,
    ...Object.fromEntries(defects.map((defect) => [defect, proof.defects[defect]?.rejected === true])),
  }).toEqual({ shortDropoutRejected: true, resumeAwayFromPausedFrameRejected: true,
    ...Object.fromEntries(defects.map((defect) => [defect, true])) })
})

// Diagnostics recorded before promotion: a 0 dB restore that ends inside the
// resumed region's half-second guard, and a post-reload export that lost the
// gain. Both must be flagged while clean evidence is not.
test("phase 5 effect-state C0b diagnostics flag an early restore and a lost export gain", () => {
  const clean = phase5EffectStateEvidence()
  const restore = phase5EffectStateEvidence()
  const restoreAt = resumedStart(restore).offset
  for (let frame = restoreAt; frame < restoreAt + 19200; frame++)
    restore.capture.samples[frame * 2 + 1] = (restore.capture.samples[frame * 2 + 1] ?? 0) * 10 ** (14 / 20)
  const lost = new Float32Array(clean.finalReference.samples.length)
  for (let frame = 4096; frame * 2 < lost.length; frame++) lost[frame * 2 + 1] = clean.rightSource.samples[(frame - 4096) * 2 + 1] ?? 0
  const cleanDiagnostics = checkPhase5EffectState(clean).diagnostics
  expect({
    cleanResumedEarly: cleanDiagnostics.resumedEarly?.wouldPass,
    cleanDurability: cleanDiagnostics.durability.wouldPass,
    earlyRestoreFlagged: checkPhase5EffectState(restore).diagnostics.resumedEarly?.wouldPass === false,
    lostExportGainFlagged: checkPhase5EffectState({ ...clean,
      finalReference: { ...clean.finalReference, samples: lost } }).diagnostics.durability.wouldPass === false,
  }).toEqual({ cleanResumedEarly: true, cleanDurability: true, earlyRestoreFlagged: true, lostExportGainFlagged: true })
})
test("Granular marker uses transport frames despite a paused native capture pre-roll", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "r27-marker-"))
  const sampleRate = 48_000
  const preRoll = 29_696
  const target = sampleRate / 2
  const samples = new Float32Array((preRoll + sampleRate) * 2)
  for (let frame = 0; frame < sampleRate; frame++) {
    samples[(preRoll + frame) * 2] = 0.15 * Math.sin(2 * Math.PI * 880 * frame / sampleRate)
    samples[(preRoll + frame) * 2 + 1] = 0.1 * Math.sin(2 * Math.PI * 1320 * frame / sampleRate)
  }
  try {
    await writeWav(path.join(directory, "output-1-2.wav"), { samples, sampleRate, channels: 2 })
    await writeFile(path.join(directory, "host.jsonl"), JSON.stringify({ event: "host-spawn", pid: 1 }) + "\n")
    await writeFile(path.join(directory, "native-1.jsonl"), [
      ...Array.from({ length: preRoll / 512 }, (_, index) => ({
        event: "capture-block", pid: 1, captureId: 2, offset: index * 512, frames: 512, transportFrame: 0,
      })),
      { event: "capture-block", pid: 1, captureId: 2, offset: preRoll, frames: sampleRate, transportFrame: 0 },
      { event: "capture-complete", pid: 1, captureId: 2, frames: samples.length / 2, failed: false, overflowFrames: 0 },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n")
    const metrics = z.object({ markerTargetFrame: z.number(), markerProbeStartFrame: z.number(),
      leftMarkerAmplitude: z.number(), rightMarkerAmplitude: z.number() }).parse(await tapMetrics(directory, "granular"))
    expect(metrics.markerTargetFrame).toBe(target)
    expect(metrics.markerProbeStartFrame).toBe(preRoll + target)
    expect(metrics.leftMarkerAmplitude).toBeCloseTo(0.15, 3)
    expect(metrics.rightMarkerAmplitude).toBeCloseTo(0.1, 3)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// Blocks before `playFrom` are paused at transport epoch 11, frame 0; later
// blocks play in epoch 12 and advance their transport frame.
const playbackCaptureRows = (captureId: number, startMs: number, blocks: number, playFrom: number) => [
  { event: "capture-first-drain", pid: 1, captureId, wallMs: startMs, bufferedFrames: 512 },
  ...Array.from({ length: blocks }, (_, index) => ({
    event: "capture-block", pid: 1, captureId, offset: index * 512, frames: 512, wallMs: startMs + index * 10,
    transportEpoch: index < playFrom ? 11 : 12, transportFrame: index < playFrom ? 0 : (index - playFrom) * 512,
  })),
  { event: "capture-complete", pid: 1, captureId, wallMs: startMs + blocks * 10, frames: blocks * 512, failed: false, overflowFrames: 0 },
]
const writeHostCapture = (directory: string, rows: object[]) => Promise.all([
  writeFile(path.join(directory, "host.jsonl"), JSON.stringify({ event: "host-spawn", pid: 1 }) + "\n"),
  writeFile(path.join(directory, "native-1.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n"),
])
// Failure inventory before the fix: a capture that started before the Play request
// and plays after it was dropped by its start time, so the largest remaining
// capture was a silent paused preview. Selection must follow playback.
test("playback capture selection follows the Play request, not capture start", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "r27-playback-select-"))
  const start = 1_000_000
  try {
    await writeHostCapture(directory, [...playbackCaptureRows(10, start, 40, 6), ...playbackCaptureRows(11, start + 1_900, 60, 60)])
    await writeWav(path.join(directory, "output-1-10.wav"), { samples: Float32Array.from({ length: 40 * 512 * 2 },
      (_, index) => 0.5 * Math.sin(index * 0.05)), sampleRate: 48_000, channels: 2 })
    await writeWav(path.join(directory, "output-1-11.wav"), { samples: new Float32Array(60 * 512 * 2), sampleRate: 48_000, channels: 2 })
    // Play is requested after capture 10 started (start) and before its transport advances (start + 70).
    const metrics = await tapMetrics(directory, undefined, true, start + 50)
    expect(metrics.frames).toBe(40 * 512)
    expect(metrics.nonzero).toBe(true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test("playback capture selection still rejects silence during playback", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "r27-playback-silent-"))
  const start = 1_000_000
  try {
    await writeHostCapture(directory, playbackCaptureRows(10, start + 100, 40, 2))
    await writeWav(path.join(directory, "output-1-10.wav"), { samples: new Float32Array(40 * 512 * 2), sampleRate: 48_000, channels: 2 })
    await expect(tapMetrics(directory, undefined, true, start + 50)).rejects.toThrow("Post-master playback/late-stereo marker assertion failed")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

// Real encoder, exact native trial totals; no microphone or app rerun.
// A bounded in-memory diagnostic sink owns only the ~11 MiB synthetic output.
test("actual recording encoder preserves the exact sixty-second native trial frame count", async () => {
  const capturedFrames = 2885120
  let bytes = new Uint8Array(4 * capturedFrames + 8192)
  let size = 0
  await encodePlanarFloat32Wav({
    sampleRate: 48000, channelCount: 1, capturedFrames,
    blocks: (async function* () {
      for (let position = 0; position < capturedFrames; position += 2048) {
        const frameCount = Math.min(2048, capturedFrames - position)
        yield { frameCount, channels: [new Float32Array(frameCount)] }
      }
    })(),
    sink: {
      write: async (chunk) => {
        const required = chunk.position + chunk.data.byteLength
        if (required > bytes.byteLength) {
          const expanded = new Uint8Array(required); expanded.set(bytes); bytes = expanded
        }
        bytes.set(chunk.data, chunk.position); size = Math.max(size, required)
      },
      close: async () => undefined, abort: async () => undefined,
    },
  })
  const view = new DataView(bytes.buffer)
  let decodedFrames: number | null = null
  for (let offset = 12; offset + 8 <= size;) {
    const name = new TextDecoder().decode(bytes.subarray(offset, offset + 4))
    const length = view.getUint32(offset + 4, true)
    if (name === "data") { decodedFrames = length / 4; break }
    offset += 8 + length + (length & 1)
  }
  console.log(JSON.stringify({ capturedFrames, decodedFrames, sizeBytes: size, sampleRate: 48000, channels: 1 }))
  expect(decodedFrames).toBe(capturedFrames)
})
