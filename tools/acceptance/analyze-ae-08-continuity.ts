#!/usr/bin/env bun
import path from "node:path"
import { appendFile, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { z } from "zod"
import { readWav, type Pcm } from "./ae08-wav"
import { phase5Rows } from "./ae-08-phase-5-fixture"

const jsonl = async (file: string) => (await readFile(file, "utf8")).trim().split("\n")
  .filter(Boolean).map((line) => z.record(z.string(), z.json()).parse(JSON.parse(line)))

// One fixed alignment per capture. Never warp individual edit windows or hide
// missing device time. Random VST material is judged separately by energy.
const compare = (output: Pcm, reference: Pcm) => {
  if (output.sampleRate !== reference.sampleRate || output.channels !== reference.channels)
    throw new Error("Capture/reference formats differ")
  const channels = output.channels
  const frames = output.samples.length / channels
  const window = Math.round(output.sampleRate * 0.01)
  const defects: { kind: string; frame: number; durationFrames: number; residual: number }[] = []
  let nonFinite = 0, clipped = 0, square = 0, difference = 0, compared = 0, maxAbsDifference = 0
  for (let start = 0; start < frames; start += window) {
    const count = Math.min(window, frames - start)
    let energy = 0, expectedEnergy = 0, error = 0, dot = 0
    for (let frame = start; frame < start + count; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        const actual = output.samples[frame * channels + channel] ?? 0
        const expected = reference.samples[frame * channels + channel] ?? 0
        if (!Number.isFinite(actual)) { nonFinite++; continue }
        if (Math.abs(actual) >= 1) clipped++
        maxAbsDifference = Math.max(maxAbsDifference, Math.abs(actual - expected))
        energy += actual * actual; expectedEnergy += expected * expected
        error += (actual - expected) ** 2; dot += actual * expected
      }
    }
    square += energy; difference += error; compared += count * channels
    if (expectedEnergy < 1e-9) continue
    const residual = Math.sqrt(error / expectedEnergy)
    if (energy < expectedEnergy * 0.0001) defects.push({ kind: "gap", frame: start, durationFrames: count, residual })
    else if (residual > 0.05) {
      const ratio = Math.sqrt(energy / expectedEnergy)
      const correlation = dot / Math.sqrt(energy * expectedEnergy)
      defects.push({ kind: correlation > 0.98 && Math.abs(ratio - 1) > 0.1 ? "tail-reset" : "phase-or-delay",
        frame: start, durationFrames: count, residual })
    }
  }
  return { frames, referenceFrames: reference.samples.length / channels, nonFinite, clipped, maxAbsDifference,
    rms: Math.sqrt(square / Math.max(1, compared)), residualRms: Math.sqrt(difference / Math.max(1, compared)), defects }
}

// A measured capture is one that produced blocks inside the marked interval. It
// must have completed, and none may have failed or dropped frames.
type Entry = Awaited<ReturnType<typeof jsonl>>[number]
export const rawCaptureOffsetsValid = (blocks: Entry[], wavFrames: number, complete?: Entry) => {
  if (!complete || !Number.isSafeInteger(wavFrames) || Number(complete.frames) !== wavFrames || !blocks.length) return false
  let accountedFrames = 0
  for (const block of blocks.toSorted((left, right) => Number(left.offset) - Number(right.offset))) {
    const offset = Number(block.offset), frames = Number(block.frames)
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(frames) || frames <= 0 || offset !== accountedFrames)
      return false
    accountedFrames += frames
  }
  return accountedFrames === wavFrames
}
const captureCoverage = (host: Entry[], actions: Entry[]) => {
  const failures = host.filter((entry) => entry.event === "capture-complete"
    && (entry.failed === true || entry.overflowFrames !== 0))
  const measuredStart = actions.find((entry) => entry.event === "capture-start")
  const measuredEnd = actions.find((entry) => entry.event === "capture-end")
  let measured = 0
  for (const capture of host.filter((entry) => entry.event === "capture-first-drain")) {
    const measuredBlocks = host.some((entry) => entry.event === "capture-block" && entry.pid === capture.pid && entry.captureId === capture.captureId
      && Number(entry.wallMs) >= Number(measuredStart?.wallMs ?? 0)
      && Number(entry.wallMs) <= Number(measuredEnd?.wallMs ?? Infinity))
    if (!measuredBlocks) continue
    measured++
    if (!host.some((entry) => entry.event === "capture-complete" && entry.pid === capture.pid && entry.captureId === capture.captureId))
      failures.push({ event: "capture-incomplete", pid: capture.pid ?? null, captureId: capture.captureId ?? null })
  }
  return { failures, measured }
}

const firstSignalFrame = (pcm: Pcm) => {
  for (let index = 0; index < pcm.samples.length; index++)
    if (Math.abs(pcm.samples[index] ?? 0) > 0.00001) return Math.floor(index / pcm.channels)
  throw new Error("Capture contains no audible fixture")
}

const bands = (pcm: Pcm) => {
  const result: { frame: number; tone431: number; tone997: number; held440: number; heldPhase: number; highBandRms: number; peakStep: number }[] = []
  const size = 8192, frames = pcm.samples.length / pcm.channels
  let previous = 0, low = 0
  const smoothing = 1 - Math.exp(-2 * Math.PI * 2000 / pcm.sampleRate)
  for (let start = 0; start + size <= frames; start += size) {
    const real = [0, 0, 0], imaginary = [0, 0, 0], frequencies = [431, 997, 440]
    let highEnergy = 0, peakStep = 0
    for (let frame = 0; frame < size; frame++) {
      const sample = pcm.samples[(start + frame) * pcm.channels] ?? 0
      peakStep = Math.max(peakStep, Math.abs(sample - previous)); previous = sample
      low += smoothing * (sample - low); highEnergy += (sample - low) ** 2
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * frame / (size - 1))
      for (let index = 0; index < frequencies.length; index++) {
        const phase = 2 * Math.PI * (frequencies[index] ?? 0) * frame / pcm.sampleRate
        real[index] = (real[index] ?? 0) + sample * window * Math.cos(phase)
        imaginary[index] = (imaginary[index] ?? 0) + sample * window * Math.sin(phase)
      }
    }
    const amplitude = (index: number) => 4 * Math.hypot(real[index] ?? 0, imaginary[index] ?? 0) / size
    result.push({ frame: start, tone431: amplitude(0), tone997: amplitude(1), held440: amplitude(2),
      heldPhase: Math.atan2(imaginary[2] ?? 0, real[2] ?? 0),
      highBandRms: Math.sqrt(highEnergy / size), peakStep })
  }
  return result
}

// Executable analyzer acceptance, not a TS unit-test suite. Each independently
// injected defect must fail the oracle; pristine input must pass.
const syntheticProof = () => {
  const sampleRate = 48000, frames = sampleRate * 2
  const samples = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame++)
    samples[frame] = 0.3 * Math.exp(-frame / sampleRate) * (Math.sin(frame * 0.057) + 0.37 * Math.sin(frame * 0.131))
  const reference = { sampleRate, channels: 1, samples }
  const length = 12000
  const defects = ["gap", "retrigger", "tail-reset", "wrong-delay", "unexpected-gap"].map((kind) => {
    const at = kind === "unexpected-gap" ? 12000 : 48000
    const silence = kind === "gap" || kind === "unexpected-gap"
    const mutated = samples.slice()
    for (let frame = at; frame < at + length; frame++) {
      mutated[frame] = silence ? 0 : kind === "retrigger" ? samples[frame - at] ?? 0
        : kind === "tail-reset" ? (samples[frame] ?? 0) * 0.25 : samples[frame - 47] ?? 0
    }
    const result = compare({ ...reference, samples: mutated }, reference)
    const detected = silence ? result.defects.some((entry) => entry.kind === "gap")
      : kind === "tail-reset" ? result.defects.some((entry) => entry.kind === "tail-reset")
      : result.defects.some((entry) => entry.kind === "phase-or-delay")
    return { kind, injectedFrame: at, frames: length, detected, flaggedWindows: result.defects.length }
  })
  if (compare(reference, reference).defects.length || defects.some((entry) => !entry.detected))
    throw new Error("Analyzer synthetic-defect gate failed")
  return { pristinePassed: true, defects }
}

export const analyzeRun = async (directory: string) => {
  const synthetic = syntheticProof()
  const output = await readWav(path.join(directory, "output.wav"))
  const reference = await readWav(path.join(directory, "reference.wav"))
  const outputOrigin = firstSignalFrame(output), referenceOrigin = firstSignalFrame(reference)
  const alignedOutput = { ...output, samples: output.samples.subarray(outputOrigin * output.channels) }
  const alignedReference = { ...reference, samples: reference.samples.subarray(referenceOrigin * reference.channels) }
  const result = compare(alignedOutput, alignedReference)
  const host = await jsonl(path.join(directory, "host.jsonl"))
  host.sort((left, right) => Number(left.wallMs) - Number(right.wallMs))
  const spawnedHosts = new Map(host.filter((entry) => entry.event === "host-spawn").map((entry) => [entry.pid, entry]))
  const workerParents = new Map(host.filter((entry) => entry.event === "worker-spawn").map((entry) => [entry.workerPid, entry.pid]))
  for (const entry of host) {
    const owner = spawnedHosts.get(entry.pid) ?? spawnedHosts.get(workerParents.get(entry.pid) ?? null)
    if (!owner) continue
    entry.hostPid = owner.pid ?? null
    entry.lifecycleGeneration = owner.lifecycleGeneration ?? null
  }
  await writeFile(path.join(directory, "host.jsonl"), host.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
  const actions = await jsonl(path.join(directory, "actions.jsonl"))
  const fixtureKind = actions.find((entry) => entry.event === "launch")?.fixtureKind ?? "combined"
  const revisions = host.filter((entry) => String(entry.event).startsWith("graph-"))
  await writeFile(path.join(directory, "revisions.jsonl"), revisions.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
  const captureFailures = captureCoverage(host, actions).failures
  const edits = actions.filter((entry) => entry.event === "edit-start").map((action) => {
    const finish = actions.find((entry) => entry.event === "edit-end" && entry.id === action.id)
    const start = Number(action.wallMs), end = Number(finish?.wallMs ?? start)
    const spawns = host.filter((entry) => entry.event === "host-spawn" && Number(entry.wallMs) >= start && Number(entry.wallMs) <= end)
    const timings = spawns.map((spawn) => {
      const hello = host.find((entry) => entry.event === "hostHello" && entry.pid === spawn.pid)
      const device = host.find((entry) => entry.event === "device-session" && entry.pid === spawn.pid && Number(entry.wallMs) >= Number(spawn.wallMs))
      const teardown = host.filter((entry) => entry.event === "host-teardown-request" && Number(entry.wallMs) <= Number(spawn.wallMs)
        && Number(entry.wallMs) >= start).at(-1)
      return { pid: spawn.pid, spawnToHelloMs: hello ? Number(hello.wallMs) - Number(spawn.wallMs) : null,
        spawnToDeviceMs: device ? Number(device.wallMs) - Number(spawn.wallMs) : null,
        teardownToDeviceMs: device && teardown ? Number(device.wallMs) - Number(teardown.wallMs) : null }
    })
    const captureStart = actions.find((entry) => entry.event === "capture-start")
    const beginFrame = Math.round((start - Number(captureStart?.wallMs ?? start)) / 1000 * output.sampleRate) - outputOrigin
    const endFrame = Math.round((end - Number(captureStart?.wallMs ?? start)) / 1000 * output.sampleRate) - outputOrigin
    return { id: action.id, operation: action.operation, playing: action.playing, restartCount: spawns.length, timings,
      analysisWindow: action.playing ? { beginFrame, endFrame,
        gapWindows: result.defects.filter((defect) => defect.kind === "gap" && defect.frame >= beginFrame && defect.frame <= endFrame).length } : null,
      publications: revisions.filter((entry) => entry.event === "graph-publish" && Number(entry.wallMs) >= start && Number(entry.wallMs) <= end) }
  })
  const startup = host.filter((entry) => entry.event === "vst-startup-step" || entry.event === "vst-preflight-complete"
    || entry.event === "worker-spawn" || entry.event === "worker-ready")
  const gapIntervals: { startFrame: number; endFrame: number; durationMs: number }[] = []
  for (const defect of result.defects.filter((entry) => entry.kind === "gap")) {
    const previous = gapIntervals.at(-1)
    if (previous?.endFrame === defect.frame) {
      previous.endFrame += defect.durationFrames
      previous.durationMs = (previous.endFrame - previous.startFrame) / output.sampleRate * 1000
    } else gapIntervals.push({ startFrame: defect.frame, endFrame: defect.frame + defect.durationFrames,
      durationMs: defect.durationFrames / output.sampleRate * 1000 })
  }
  let referenceSilentFrames = 0, longestReferenceSilence = 0, consecutive = 0
  const referenceCheckEnd = fixtureKind === "reverb-tail"
    ? Math.min(alignedReference.samples.length / reference.channels - reference.sampleRate * 0.1, reference.sampleRate * 4)
    : alignedReference.samples.length / reference.channels - reference.sampleRate * 0.1
  for (let frame = Math.round(reference.sampleRate * 0.5);
    frame < referenceCheckEnd; frame++) {
    const silent = Math.abs(alignedReference.samples[frame * reference.channels] ?? 0) < 1e-8
    consecutive = silent ? consecutive + 1 : 0
    if (silent) referenceSilentFrames++
    longestReferenceSilence = Math.max(longestReferenceSilence, consecutive)
  }
  const editFreeCapture = { referenceSilentFrames, longestReferenceSilence,
    passed: longestReferenceSilence < 512, toleranceFrames: 512,
    checkedThroughFrame: referenceCheckEnd, expectedLateTailSilence: fixtureKind === "reverb-tail" }
  const segmentProof = z.object({ frames: z.number(), capturedFrames: z.number(),
    segments: z.array(z.object({ pid: z.number(), captureId: z.number(), outputFrame: z.number(), frames: z.number() }).passthrough()) })
    .parse(JSON.parse(await readFile(path.join(directory, "reference", "capture-segments.json"), "utf8")))
  let coveredThrough = 0, maximumCaptureHole = 0
  for (const segment of segmentProof.segments.toSorted((left, right) => left.outputFrame - right.outputFrame)) {
    if (coveredThrough > 0) maximumCaptureHole = Math.max(maximumCaptureHole, segment.outputFrame - coveredThrough)
    coveredThrough = Math.max(coveredThrough, segment.outputFrame + segment.frames)
  }
  maximumCaptureHole = Math.max(maximumCaptureHole, segmentProof.frames - coveredThrough)
  const referenceHost = await jsonl(path.join(directory, "reference", "host.jsonl"))
  const referenceCaptureFailed = referenceHost.some((entry) => entry.event === "capture-complete"
    && (entry.failed === true || entry.overflowFrames !== 0))
    || segmentProof.segments.some((segment) => !referenceHost.some((entry) => entry.event === "capture-complete"
      && entry.pid === segment.pid && entry.captureId === segment.captureId))
  // An impulse response is naturally sparse. Sample-wise zeros are not a loss
  // oracle for reverb; uninterrupted callback coverage is the independent gate.
  if (fixtureKind === "reverb-tail") editFreeCapture.passed = maximumCaptureHole < 512 && !referenceCaptureFailed
  else editFreeCapture.passed &&= maximumCaptureHole < 512 && !referenceCaptureFailed
  const outputBands = bands(alignedOutput), referenceBands = bands(alignedReference)
  const workerReady = host.filter((entry) => entry.event === "worker-spawn").map((entry) => {
    const ready = host.find((record) => record.event === "worker-ready" && record.pid === entry.workerPid)
    return { workerPid: entry.workerPid, spawnMs: entry.durationMs,
      spawnToReadyMs: ready ? Number(ready.wallMs) - Number(entry.wallMs) : null }
  })
  const publicationWindows = revisions.filter((entry) => entry.event === "graph-publish").map((entry) => {
    const captureStart = actions.find((record) => record.event === "capture-start")
    const observedRunFrame = Math.round((Number(entry.wallMs) - Number(captureStart?.wallMs ?? entry.wallMs)) / 1000 * output.sampleRate) - outputOrigin
    const index = Math.floor(observedRunFrame / 8192)
    const observed = outputBands[index], expected = referenceBands[index]
    const phaseDifference = observed && expected ? observed.heldPhase - expected.heldPhase : null
    return { pid: entry.pid, revision: entry.revision, publicationFrame: entry.publicationFrame,
      publicationEpoch: entry.publicationEpoch, cause: entry.cause,
      observedRunFrame, runFrameBasis: "telemetry wall clock; native publication frame remains separately reported",
      masterBandObservation: observed && expected ? {
        output: observed, reference: expected,
        heldEnvelopeResidual: observed.held440 - expected.held440,
        heldPhaseResidualRadians: phaseDifference === null ? null : Math.atan2(Math.sin(phaseDifference), Math.cos(phaseDifference)),
        reverbBandEnvelopeResidual: observed.highBandRms - expected.highBandRms,
        isolatedSourceProof: false,
      } : null,
      nearbyDefects: result.defects.filter((defect) => Math.abs(defect.frame - observedRunFrame) < output.sampleRate * 0.1).length }
  })
  const baselineFailed = result.defects.length > 0 || edits.some((entry) => entry.restartCount > 0)
  const lifecycle = {
    hostSpawns: host.filter((entry) => entry.event === "host-spawn").length,
    pluginRestartRequests: host.filter((entry) => entry.event === "host-restart-request"),
    latencyStops: host.filter((entry) => entry.event === "host-stop-request" && entry.cause === "latency-notification"),
    crashStops: host.filter((entry) => entry.event === "host-stop-request" && entry.cause === "plugin-crash"),
    unexpectedHostExits: host.filter((entry) => entry.event === "host-exit" && entry.cause === "crash"),
  }
  const verdict = captureFailures.length || !editFreeCapture.passed ? "HARNESS FAILED: capture overflow, writer failure, or edit-free loss."
    : baselineFailed ? "EXPECTED BASELINE CONTINUITY FAILURE. Infrastructure phases do not enable live edits."
      : "No defect detected in this baseline. This is not AE-08 feature certification."
  const analysis = { schemaVersion: 1, fixtureKind, verdict, numericalTolerance: 0.05,
    alignment: { strategy: "one first-signal origin per run, no per-edit warping", outputOrigin, referenceOrigin },
    synthetic, ...result, gapIntervals, editFreeCapture,
    referenceCaptureProof: { maximumCaptureHole, coveredThrough, referenceCaptureFailed },
    analyzerSha256: createHash("sha256").update(await readFile(import.meta.filename)).digest("hex"),
    bands: { output: outputBands, reference: referenceBands },
    captureFailures, lifecycle, edits, vstStartup: startup, workerReady, publications: revisions, publicationWindows,
    limitations: [fixtureKind === "combined" ? "Summed stereo master cannot uniquely attribute a residual to the held synth versus reverb."
      : "Only the selected source is audible; unrelated and deleted contributions are muted in this oracle.",
      "Random VST sample nulling is not used; worker identity/startup and diagnostic faults are separate evidence.",
      "Deletion affects its own wet contribution. Total-mix residuals during deletion are not claimed to be unaffected-track nulls."] }
  await writeFile(path.join(directory, "analysis.json"), JSON.stringify(analysis, null, 2))
  await writeFile(path.join(directory, "verdict.md"),
    `# AE-08 infrastructure continuity baseline\n\n${verdict}\n\n` +
    `Live output: ${result.frames} frames; reference: ${result.referenceFrames}; ` +
    `${result.defects.filter((entry) => entry.kind === "gap").length} near-zero 10 ms windows; ` +
    `${result.nonFinite} non-finite and ${result.clipped} clipped samples.\n\n` +
    `Synthetic gap, retrigger, tail-reset, wrong-delay and off-edit unexpected-gap injections: all detected; pristine passes.\n\n` +
    edits.map((entry) => `- ${entry.operation} (${entry.playing ? "playing" : "paused"}): ${entry.restartCount} host spawns; spawn→hello ${entry.timings.map((timing) => timing.spawnToHelloMs).join(", ") || "n/a"} ms; spawn→device ${entry.timings.map((timing) => timing.spawnToDeviceMs).join(", ") || "n/a"} ms.`).join("\n") +
    `\n\nSee provenance.json, actions.jsonl, host.jsonl, revisions.jsonl and analysis.json. ` +
    `Baseline restarts publish while configured, before the next device session starts. ` +
    `Capture blocks have callback timestamps and sample offsets; wall-clock assembly preserves device downtime, with millisecond wall-clock anchoring uncertainty. ` +
    `No sample-exact hardware clock or summed-master per-track null claim is made.\n`)
  const isolated = z.array(z.object({ fixture: z.string(), verdict: z.string(), directory: z.string() }))
    .parse(await readFile(path.join(directory, "isolated-fixtures.json"), "utf8").then(JSON.parse).catch(() => []))
  if (isolated.length) await appendFile(path.join(directory, "verdict.md"), "\n## Isolated source oracles\n\n" +
    isolated.map((entry) => `- ${entry.fixture}: ${entry.verdict} See ${entry.fixture}/analysis.json.`).join("\n") + "\n")
  return analysis
}

const revisionReply = z.object({ hostPid: z.number(), hostGeneration: z.number(),
  revision: z.object({ status: z.string(), continuity: z.string().optional(),
    publicationFrame: z.union([z.string(), z.number()]).optional() }).passthrough() }).passthrough()
const phase3Plan = z.object({ noteOnWallMs: z.number(), edits: z.array(z.object({
  name: z.string(), publishWallMs: z.number(), prepared: revisionReply, published: revisionReply, retired: revisionReply })) })

const deletedFundamentalHz = 659.2551
// Before the deletion publishes the two runs are sample-identical, so the first
// divergence near the wall-clock estimate is the exact first faded frame.
const firstDivergence = (output: Pcm, reference: Pcm, estimate: number, radius: number) => {
  for (let frame = Math.max(0, estimate - radius); frame < estimate + radius; frame++)
    if (Math.abs((reference.samples[frame * reference.channels] ?? 0) - (output.samples[frame * output.channels] ?? 0)) > 1e-6) return frame
  return null
}

// Energy envelope of ref-out (the deleted contribution), 2 ms window, 0.5 ms hop.
const differenceEnvelope = (output: Pcm, reference: Pcm, fromFrame: number, toFrame: number) => {
  const window = Math.round(output.sampleRate * 0.002), hop = Math.round(output.sampleRate * 0.0005)
  const points: { frame: number; energy: number }[] = []
  for (let start = fromFrame; start + window <= toFrame; start += hop) {
    let energy = 0
    for (let frame = start; frame < start + window; frame++) {
      const difference = (reference.samples[frame * reference.channels] ?? 0) - (output.samples[frame * output.channels] ?? 0)
      energy += difference * difference
    }
    points.push({ frame: start, energy: energy / window })
  }
  return points
}

const toneAmplitude = (pcm: Pcm, startFrame: number, frames: number, hz: number) => {
  let real = 0, imaginary = 0
  for (let frame = 0; frame < frames; frame++) {
    const sample = pcm.samples[(startFrame + frame) * pcm.channels] ?? 0
    const angle = 2 * Math.PI * hz * frame / pcm.sampleRate
    real += sample * Math.cos(angle); imaginary += sample * Math.sin(angle)
  }
  return 2 * Math.hypot(real, imaginary) / frames
}

// Phase 3 packaged oracle: connected add/remove must not disturb the retained
// held note or the long reverb tail (same host, same generation, accepted
// continuity), and deleting a sounding source must ramp only its own
// contribution to zero over about five milliseconds.
export const analyzePhase3 = async (directory: string) => {
  const synthetic = syntheticProof()
  const output = await readWav(path.join(directory, "output.wav"))
  const reference = await readWav(path.join(directory, "reference.wav"))
  const outputOrigin = firstSignalFrame(output), referenceOrigin = firstSignalFrame(reference)
  const aligned = { ...output, samples: output.samples.subarray(outputOrigin * output.channels) }
  const alignedReference = { ...reference, samples: reference.samples.subarray(referenceOrigin * reference.channels) }
  const plan = phase3Plan.parse(JSON.parse(await readFile(path.join(directory, "phase3-edits.json"), "utf8")))
  const host = await jsonl(path.join(directory, "host.jsonl"))
  // Wall clock only places the windows (tens of milliseconds of IPC uncertainty);
  // the fade itself is measured from the PCM, not from this estimate.
  const edits = plan.edits.map((edit) => ({ ...edit,
    publishFrame: Math.round((edit.publishWallMs - plan.noteOnWallMs) / 1000 * output.sampleRate) }))
  const sampleRate = output.sampleRate
  const frames = Math.min(aligned.samples.length, alignedReference.samples.length) / output.channels
  const slice = (pcm: Pcm, from: number, to: number) => ({ ...pcm,
    samples: pcm.samples.subarray(Math.max(0, from) * pcm.channels, Math.min(frames, to) * pcm.channels) })
  const protectedEdits = edits.filter((edit) => edit.name !== "delete-sounding-source").map((edit) => {
    const window = compare(slice(aligned, edit.publishFrame - sampleRate * 0.1, edit.publishFrame + sampleRate * 1.0),
      slice(alignedReference, edit.publishFrame - sampleRate * 0.1, edit.publishFrame + sampleRate * 1.0))
    return { name: edit.name, publishFrame: edit.publishFrame, defects: window.defects, residualRms: window.residualRms,
      maxAbsDifference: window.maxAbsDifference, nonFinite: window.nonFinite, clipped: window.clipped,
      covered: edit.publishFrame >= sampleRate * 0.1 && edit.publishFrame + sampleRate * 1.0 <= frames,
      accepted: edit.prepared.revision.continuity === "accepted" && edit.published.revision.status === "published" }
  })
  // The fixture is deterministic, so a connected edit that keeps every retained
  // processor and voice leaves the capture bit-identical to the unedited run.
  // The whole capture, fades included, must also be finite and unclipped.
  let nonFinite = 0, clipped = 0
  for (const sample of aligned.samples) {
    if (!Number.isFinite(sample)) nonFinite++
    else if (Math.abs(sample) >= 1) clipped++
  }
  const estimated = edits.find((edit) => edit.name === "delete-sounding-source")
  const divergence = estimated ? firstDivergence(aligned, alignedReference, estimated.publishFrame, Math.round(sampleRate * 0.3)) : null
  const deletion = estimated && divergence !== null ? { ...estimated, publishFrame: divergence } : undefined
  let fade: { riseMs: number | null; settledRatio: number; priorRatio: number; maxStepRatio: number } | null = null
  if (deletion) {
    const span = Math.round(sampleRate * 0.25)
    const envelope = differenceEnvelope(aligned, alignedReference, deletion.publishFrame, deletion.publishFrame + span)
    // The source is slowly modulated, so the full-level reference is the settled
    // difference just after the ramp, not the maximum over the whole window.
    const ms = (value: number) => Math.round(sampleRate * value / 1000)
    const peak = Math.max(...envelope.filter((point) => point.frame >= deletion.publishFrame + ms(6) && point.frame <= deletion.publishFrame + ms(16))
      .map((point) => point.energy), 0)
    const first10 = envelope.find((point) => point.energy >= peak * 0.01)
    const first90 = envelope.find((point) => point.energy >= peak * 0.81)
    const amplitude = (pcm: Pcm, start: number) => toneAmplitude(pcm, start, 4800, deletedFundamentalHz)
    const settledStart = deletion.publishFrame + span, priorStart = deletion.publishFrame - span - 4800
    const stepOf = (pcm: Pcm) => {
      let step = 0
      for (let frame = Math.max(1, deletion.publishFrame - span); frame < deletion.publishFrame + span && frame < frames; frame++)
        step = Math.max(step, Math.abs((pcm.samples[frame * pcm.channels] ?? 0) - (pcm.samples[(frame - 1) * pcm.channels] ?? 0)))
      return step
    }
    fade = {
      riseMs: first10 && first90 ? (first90.frame - first10.frame) / sampleRate * 1000 : null,
      settledRatio: amplitude(aligned, settledStart) / Math.max(1e-9, amplitude(alignedReference, settledStart)),
      priorRatio: amplitude(aligned, priorStart) / Math.max(1e-9, amplitude(alignedReference, priorStart)),
      maxStepRatio: stepOf(aligned) / Math.max(1e-9, stepOf(alignedReference)),
    }
  }
  // Application start supervises several hosts before the session; no host may
  // spawn once the fixture's note has started.
  const hostSpawns = host.filter((entry) => entry.event === "host-spawn" && Number(entry.wallMs) >= plan.noteOnWallMs).length
  const sameHost = edits.every((edit) => edit.prepared.hostPid === edits[0]?.prepared.hostPid
    && edit.published.hostPid === edit.prepared.hostPid && edit.published.hostGeneration === edit.prepared.hostGeneration
    && edit.prepared.hostGeneration === edits[0]?.prepared.hostGeneration)
  const actions = await jsonl(path.join(directory, "actions.jsonl"))
  const referenceCoverage = captureCoverage(await jsonl(path.join(directory, "reference", "host.jsonl")),
    await jsonl(path.join(directory, "reference", "actions.jsonl")))
  const coverage = captureCoverage(host, actions)
  const captureFailures = [...coverage.failures, ...referenceCoverage.failures]
  const checks = {
    editsPresent: edits.length === 3,
    sameHostAndGeneration: sameHost && hostSpawns === 0,
    connectedEditsAcceptedAndNull: protectedEdits.length === 2 && protectedEdits.every((edit) =>
      edit.accepted && edit.covered && edit.defects.length === 0 && edit.maxAbsDifference === 0),
    finiteAndUnclipped: nonFinite === 0 && clipped === 0
      && protectedEdits.every((edit) => edit.nonFinite === 0 && edit.clipped === 0),
    deletionAccepted: estimated?.published.revision.status === "published",
    // A linear 5 ms ramp reads as roughly 4 to 6 ms between 1% and 81% of the
    // 2 ms-smoothed difference energy; a hard cut reads as the 2 ms window.
    deletionFadeFiveMs: fade !== null && fade.riseMs !== null && fade.riseMs >= 3 && fade.riseMs <= 9
      && fade.settledRatio < 0.05 && fade.priorRatio > 0.8 && fade.priorRatio < 1.2 && fade.maxStepRatio < 1.5,
    // A run with no completed measured capture proves nothing; the null needs both sides.
    captureIntegrity: coverage.measured > 0 && referenceCoverage.measured > 0 && captureFailures.length === 0,
  }
  const passed = Object.values(checks).every(Boolean)
  const verdict = passed ? "PHASE 3 PACKAGED PASS: retained held/wet state survived connected add/remove; deletion faded over ~5 ms."
    : `PHASE 3 PACKAGED FAIL: ${Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name).join(", ")}`
  const analysis = { schemaVersion: 1, verdict, passed, checks, synthetic, hostSpawns, edits, protectedEdits, fade,
    signal: { nonFinite, clipped }, alignment: { outputOrigin, referenceOrigin }, captureFailures,
    measuredCaptures: { output: coverage.measured, reference: referenceCoverage.measured },
    analyzerSha256: createHash("sha256").update(await readFile(import.meta.filename)).digest("hex") }
  await writeFile(path.join(directory, "analysis.json"), JSON.stringify(analysis, null, 2))
  await writeFile(path.join(directory, "verdict.md"), `# AE-08 phase 3 packaged oracle\n\n${verdict}\n\n` +
    Object.entries(checks).map(([name, ok]) => `- ${name}: ${ok ? "pass" : "FAIL"}`).join("\n") +
    `\n\nSee analysis.json, phase3-edits.json, host.jsonl and the reference/baseline run directories.\n`)
  return analysis
}

type LatencyMove = { publicationFrame: number; raiseFrames: number }
type Phase4Edit = { name: string; fromLatencyFrames: number; toLatencyFrames: number; wallMs: number }

// Moves come from the published revisions, never from plan positions. Each publication carries a contiguous run of
// plan edits in plan order: either every edit has its own publication, or every renderer turn (the edits the runner
// recorded at one wallMs) has exactly one. Any other count loses or duplicates an edit, and no publication may
// precede an edit it carries. A publication's move is the sum of its raises, so the total is the plan's.
const attributePublications = <Publication extends { wallMs: number; publicationFrame: number }>(
  edits: readonly Phase4Edit[], publications: readonly Publication[]) => {
  const turns: Phase4Edit[][] = []
  for (const edit of edits) {
    const turn = turns.at(-1)
    if (turn && turn[0]?.wallMs === edit.wallMs) turn.push(edit)
    else turns.push([edit])
  }
  const groups = publications.length === edits.length ? edits.map((edit) => [edit])
    : publications.length === turns.length ? turns : undefined
  if (!groups) return undefined
  const attributed = publications.map((publication, index) => {
    const group = groups[index] ?? []
    return { publication, edits: group, raiseFrames: group.reduce((sum, edit) =>
      sum + Math.max(0, edit.toLatencyFrames - edit.fromLatencyFrames), 0) }
  })
  return attributed.every(({ publication, edits: group }) => group.length > 0
    && group.every((edit) => edit.wallMs <= publication.wallMs)) ? attributed : undefined
}
const publishedMoves = (attributed: NonNullable<ReturnType<typeof attributePublications>>): LatencyMove[] =>
  attributed.filter((entry) => entry.raiseFrames > 0)
    .map((entry) => ({ publicationFrame: entry.publication.publicationFrame, raiseFrames: entry.raiseFrames }))

// An exact oracle, not a seam exclusion. Both the fade and the declared R-frame
// history move are checked sample by sample. A lower never removes that shift.
const latencySample = (reference: Pcm, frame: number, channel: number, move: LatencyMove) => {
  const fade = Math.round(reference.sampleRate * 0.005)
  const seam = move.publicationFrame + fade
  const shift = frame < seam ? 0 : move.raiseFrames
  const gain = frame < move.publicationFrame || frame >= seam + fade ? 1
    : frame < seam ? (seam - frame) / fade : (frame - seam) / fade
  return Math.fround((reference.samples[(frame - shift) * reference.channels + channel] ?? 0) * Math.fround(gain))
}

const compareLatency = (output: Pcm, reference: Pcm, move: LatencyMove | LatencyMove[], tolerance: number, endFrame: number) => {
  const moves = Array.isArray(move) ? move : [move]
  let mismatches = 0, nonFinite = 0, clipped = 0, maxAbsDifference = 0, firstMismatch: number | null = null
  const regions = { before: 0, fade: 0, shifted: 0 }
  const firstPublication = moves[0]?.publicationFrame ?? Infinity
  const fadeEnd = (moves.at(-1)?.publicationFrame ?? Infinity) + Math.round(output.sampleRate * 0.01)
  for (let frame = 0; frame < endFrame; frame++) {
    for (let channel = 0; channel < output.channels; channel++) {
      const actual = output.samples[frame * output.channels + channel] ?? NaN
      const fade = Math.round(output.sampleRate * 0.005)
      let shift = 0, gain = 1
      for (const candidate of moves) {
        const seam = candidate.publicationFrame + fade
        if (frame >= seam) shift += candidate.raiseFrames
        if (frame >= candidate.publicationFrame && frame < seam + fade)
          gain *= frame < seam ? (seam - frame) / fade : (frame - seam) / fade
      }
      const expected = Math.fround((reference.samples[(frame - shift) * reference.channels + channel] ?? 0) * Math.fround(gain))
      if (!Number.isFinite(actual)) nonFinite++
      if (Math.abs(actual) >= 1) clipped++
      const difference = Math.abs(actual - expected)
      maxAbsDifference = Math.max(maxAbsDifference, difference)
      if (!Number.isFinite(actual) || difference > tolerance) {
        mismatches++
        firstMismatch ??= frame
        if (frame < firstPublication) regions.before++
        else if (frame < fadeEnd) regions.fade++
        else regions.shifted++
      }
    }
  }
  return { passed: mismatches === 0 && nonFinite === 0 && clipped === 0,
    mismatches, nonFinite, clipped, maxAbsDifference, firstMismatch, regions, comparedFrames: endFrame }
}

// Compare the monitored right output with its identical source on the retained
// left channel. Search content delay, not onset/energy, without realigning PCM.
const monitoredContentDelay = (output: Pcm, source: Pcm, from: number, intrinsicFrames: number) => {
  const start = Math.max(Math.ceil(from), 65_536)
  const count = Math.min(4096, output.samples.length / output.channels - start)
  let bestCorrelation = -Infinity, measuredFrames = -1
  for (let delay = 0; delay <= 65_536; delay++) {
    let dot = 0, actualEnergy = 0, sourceEnergy = 0
    for (let frame = start; frame < start + count; frame += 8) {
      const actual = output.samples[frame * output.channels + 1] ?? NaN
      const expected = source.samples[(frame - delay) * source.channels] ?? NaN
      dot += actual * expected
      actualEnergy += actual * actual
      sourceEnergy += expected * expected
    }
    const correlation = dot / Math.sqrt(actualEnergy * sourceEnergy)
    if (correlation > bestCorrelation) { bestCorrelation = correlation; measuredFrames = delay }
  }
  return { intrinsicFrames, measuredFrames, correlation: bestCorrelation,
    passed: count >= 2048 && bestCorrelation > 0.98 && Math.abs(measuredFrames - intrinsicFrames) <= 1 }
}

export const phase4SyntheticProof = () => {
  const sampleRate = 48000, frames = sampleRate * 2, channels = 2
  const reference: Pcm = { sampleRate, channels, samples: new Float32Array(frames * channels) }
  for (let frame = 0; frame < frames; frame++) {
    // Non-periodic stereo content exposes even a one-frame wrong delay.
    reference.samples[frame * 2] = 0.12 * Math.sin(frame * 0.071 + frame * frame * 0.0000001)
    reference.samples[frame * 2 + 1] = 0.1 * Math.cos(frame * 0.113) * Math.exp(-frame / frames)
  }
  const move = { publicationFrame: 24000, raiseFrames: 3584 }
  const render = (candidate: LatencyMove) => {
    const samples = new Float32Array(frames * channels)
    for (let frame = 0; frame < frames; frame++)
      for (let channel = 0; channel < channels; channel++)
        samples[frame * channels + channel] = latencySample(reference, frame, channel, candidate)
    return { ...reference, samples }
  }
  const pristine = render(move)
  const wrongR = render({ ...move, raiseFrames: move.raiseFrames + 1 })
  const earlySeam = render({ ...move, publicationFrame: move.publicationFrame - 1 })
  const missingFade = render(move)
  for (let frame = move.publicationFrame; frame < move.publicationFrame + 480; frame++)
    for (let channel = 0; channel < channels; channel++)
      missingFade.samples[frame * channels + channel] = reference.samples[(frame - (frame >= move.publicationFrame + 240 ? move.raiseFrames : 0)) * channels + channel] ?? 0
  const gap = render(move), retrigger = render(move), tailReset = render(move)
  gap.samples.fill(0, 60000 * channels, 60512 * channels)
  retrigger.samples.set(pristine.samples.subarray(0, 512 * channels), 65000 * channels)
  for (let frame = 70000; frame < frames; frame++)
    for (let channel = 0; channel < channels; channel++) tailReset.samples[frame * channels + channel] *= 0.1
  const detects = (defect: Pcm) => !compareLatency(defect, reference, move, 0, frames).passed
  const results = { pristine: compareLatency(pristine, reference, move, 0, frames).passed,
    wrongR: detects(wrongR), missingFade: detects(missingFade), earlySeam: detects(earlySeam),
    gap: detects(gap), retrigger: detects(retrigger), tailReset: detects(tailReset) }
  const renderMoves = (moves: LatencyMove[]): Pcm => {
    const samples = new Float32Array(frames * channels)
    for (let frame = 0; frame < frames; frame++) {
      let shift = 0, gain = 1
      for (const candidate of moves) {
        const fade = 240, seam = candidate.publicationFrame + fade
        if (frame >= seam) shift += candidate.raiseFrames
        if (frame >= candidate.publicationFrame && frame < seam + fade)
          gain *= frame < seam ? (seam - frame) / fade : (frame - seam) / fade
      }
      for (let channel = 0; channel < channels; channel++)
        samples[frame * channels + channel] = Math.fround(
          (reference.samples[(frame - shift) * channels + channel] ?? 0) * Math.fround(gain))
    }
    return { ...reference, samples }
  }
  const moves = [move, { publicationFrame: 48000, raiseFrames: 512 }]
  const multipleMoves = compareLatency(renderMoves(moves), reference, moves, 0, frames).passed
    && !compareLatency(renderMoves(moves), reference, [move], 0, frames).passed
  // The overlapping-moves plan: two raises in one renderer turn, then two lowers in later turns.
  const plan: Phase4Edit[] = [
    { name: "latency-raise", fromLatencyFrames: 1024, toLatencyFrames: 2560, wallMs: 0 },
    { name: "latency-raise-overlap", fromLatencyFrames: 2560, toLatencyFrames: 6144, wallMs: 0 },
    { name: "latency-lower", fromLatencyFrames: 6144, toLatencyFrames: 2560, wallMs: 1000 },
    { name: "latency-lower", fromLatencyFrames: 2560, toLatencyFrames: 1024, wallMs: 2000 }]
  const raised = { wallMs: 100, publicationFrame: 20000 }, overlap = { wallMs: 150, publicationFrame: 30000 }
  const lowered = { wallMs: 1100, publicationFrame: 50000 }, lowest = { wallMs: 2100, publicationFrame: 70000 }
  // Whether the audio that actually moved by `actual` passes against the moves taken from `published`.
  const accepted = (published: { wallMs: number; publicationFrame: number }[], actual: LatencyMove[]) => {
    const attributed = attributePublications(plan, published)
    return !!attributed && compareLatency(renderMoves(actual), reference, publishedMoves(attributed), 0, frames).passed
  }
  const attribution = {
    mergedTurn: accepted([raised, lowered, lowest], [{ publicationFrame: 20000, raiseFrames: 5120 }]),
    splitTurn: accepted([raised, overlap, lowered, lowest],
      [{ publicationFrame: 20000, raiseFrames: 1536 }, { publicationFrame: 30000, raiseFrames: 3584 }]),
    lostEdit: !accepted([raised, lowered, lowest], [{ publicationFrame: 20000, raiseFrames: 1536 }])
      && !accepted([raised, lowest], [{ publicationFrame: 20000, raiseFrames: 5120 }]),
    duplicatedMove: !accepted([raised, lowered, lowest],
      [{ publicationFrame: 20000, raiseFrames: 5120 }, { publicationFrame: 50000, raiseFrames: 3584 }])
      && !accepted([raised, overlap, { wallMs: 200, publicationFrame: 40000 }, lowered, lowest], [
        { publicationFrame: 20000, raiseFrames: 1536 }, { publicationFrame: 30000, raiseFrames: 3584 },
        { publicationFrame: 40000, raiseFrames: 3584 }]),
    wrongMergedTotal: !accepted([raised, lowered, lowest], [{ publicationFrame: 20000, raiseFrames: 5632 }]),
    swappedOrder: !accepted([raised, overlap, lowered, lowest],
      [{ publicationFrame: 20000, raiseFrames: 3584 }, { publicationFrame: 30000, raiseFrames: 1536 }])
      && !accepted([raised, { wallMs: 900, publicationFrame: 45000 }, lowest], [{ publicationFrame: 20000, raiseFrames: 5120 }]),
  }
  const keepLatency = compareLatency(reference, reference, [], 0, frames).passed
    && !compareLatency(pristine, reference, [], 0, frames).passed
  const monitored = (extra: number): Pcm => {
    const samples = reference.samples.slice()
    for (let frame = 0; frame < frames; frame++)
      samples[frame * 2 + 1] = reference.samples[(frame - 4096 - extra) * 2] ?? 0
    return { ...reference, samples }
  }
  const monitoredIntrinsicOnly = monitoredContentDelay(monitored(0), reference, 48000, 4096).passed
  const monitoredCompensationRejected = [2, 512, 3584, 48000].every((extra) =>
    !monitoredContentDelay(monitored(extra), reference, 70000, 4096).passed)
  if (!monitoredIntrinsicOnly || !monitoredCompensationRejected) throw new Error("Monitored content-delay oracle failed")
  if (!multipleMoves || !keepLatency) throw new Error("Phase 4 multiple-move/Keep Latency oracle failed")
  if (!Object.values(attribution).every(Boolean)) throw new Error(`Phase 4 publication attribution oracle failed: ${JSON.stringify(attribution)}`)
  if (!Object.values(results).every(Boolean)) throw new Error(`Phase 4 synthetic oracle failed: ${JSON.stringify(results)}`)
  return { ...results, multipleMoves, keepLatency, monitoredIntrinsicOnly, monitoredCompensationRejected, ...attribution }
}

const phase4Plan = z.object({ phase: z.literal(4), fixtureKind: z.string(), edits: z.array(z.object({
  name: z.string(), fromLatencyFrames: z.number().int().nonnegative(), toLatencyFrames: z.number().int().nonnegative(), wallMs: z.number(),
})) })
const captureSegments = z.object({ segments: z.array(z.object({
  pid: z.number(), captureId: z.number(), sourceFrame: z.number(), outputFrame: z.number(), frames: z.number(),
})) })

export const analyzePhase4 = async (directory: string) => {
  const synthetic = phase4SyntheticProof()
  const plan = phase4Plan.parse(JSON.parse(await readFile(path.join(directory, "phase4-edits.json"), "utf8")))
  const output = await readWav(path.join(directory, "output.wav"))
  const reference = await readWav(path.join(directory, "reference.wav"))
  const calibration = await readWav(path.join(directory, "calibration.wav"))
  if ([reference, calibration].some((pcm) => pcm.sampleRate !== output.sampleRate || pcm.channels !== output.channels))
    throw new Error("Phase 4 capture formats differ")
  const origins = { output: firstSignalFrame(output), reference: firstSignalFrame(reference), calibration: firstSignalFrame(calibration) }
  const align = (pcm: Pcm, origin: number): Pcm => ({ ...pcm, samples: pcm.samples.subarray(origin * pcm.channels) })
  const aligned = align(output, origins.output), expected = align(reference, origins.reference)
  const calibrated = align(calibration, origins.calibration)
  const host = await jsonl(path.join(directory, "host.jsonl"))
  const actions = await jsonl(path.join(directory, "actions.jsonl"))
  const start = Number(actions.find((entry) => entry.event === "capture-start")?.wallMs)
  const end = Number(actions.find((entry) => entry.event === "capture-end")?.wallMs)
  const measured = host.filter((entry) => Number(entry.wallMs) >= start && Number(entry.wallMs) <= end)
  const publications = measured.filter((entry) => entry.event === "graph-publish"
    && Number(entry.wallMs) >= (plan.edits[0]?.wallMs ?? Infinity))
    .sort((a, b) => Number(a.publicationFrame) - Number(b.publicationFrame))
  const segments = captureSegments.parse(JSON.parse(await readFile(path.join(directory, "baseline", "capture-segments.json"), "utf8"))).segments
  const located = publications.map((entry) => {
    const publicationFrame = Number(entry.publicationFrame)
    const block = host.find((candidate) => candidate.event === "capture-block" && candidate.pid === entry.pid
      && candidate.revision === entry.revision && candidate.transportEpoch === entry.transportEpoch
      && Number(candidate.transportFrame) <= publicationFrame
      && publicationFrame < Number(candidate.transportFrame) + Number(candidate.frames))
    if (!block) throw new Error("Publication has no matching captured native frame")
    const sourceFrame = Number(block.offset) + publicationFrame - Number(block.transportFrame)
    const segment = segments.find((candidate) => candidate.pid === entry.pid && candidate.captureId === block.captureId
      && sourceFrame >= candidate.sourceFrame && sourceFrame < candidate.sourceFrame + candidate.frames)
    if (!segment) throw new Error("Publication is outside the assembled capture")
    return { nativePublicationFrame: publicationFrame, revision: Number(entry.revision),
      pid: Number(entry.pid), transportEpoch: Number(entry.transportEpoch), wallMs: Number(entry.wallMs),
      publicationFrame: segment.outputFrame + sourceFrame - segment.sourceFrame - origins.output }
  })
  const attribution = attributePublications(plan.edits, located)
  const edits = (attribution ?? []).map(({ publication: { wallMs: publishedWallMs, ...publication }, edits: group, raiseFrames }) => ({
    name: group.map((edit) => edit.name).join("+"), fromLatencyFrames: group[0]?.fromLatencyFrames,
    toLatencyFrames: group.at(-1)?.toLatencyFrames, wallMs: group[0]?.wallMs,
    planEdits: group.map((edit) => plan.edits.indexOf(edit)), raiseFrames, publishedWallMs, ...publication }))
  const raise = edits[0], lower = edits.at(-1), rate = output.sampleRate
  const protectedChannel = (pcm: Pcm): Pcm => ({ ...pcm, channels: 1,
    samples: Float32Array.from({ length: pcm.samples.length / pcm.channels }, (_, frame) => pcm.samples[frame * pcm.channels] ?? 0) })
  const protectedOutput = protectedChannel(aligned), protectedReference = protectedChannel(expected)
  const protectedCalibration = protectedChannel(calibrated)
  const endFrame = Math.min(aligned.samples.length, expected.samples.length, calibrated.samples.length) / output.channels
  const noEdit = compareLatency(protectedCalibration, protectedReference, [], 0, endFrame)
  // No tolerance is inferred from an edited run. Duplicate no-edit captures
  // alone calibrate numerical noise; an unhealthy baseline cannot authorize it.
  const tolerance = noEdit.maxAbsDifference
  const keepLatency = plan.fixtureKind === "keep-latency-direct" || plan.fixtureKind === "keep-latency-group"
  const moves = keepLatency || !attribution ? [] : publishedMoves(attribution)
  const R = moves.reduce((sum, move) => sum + move.raiseFrames, 0)
  const pcm = compareLatency(protectedOutput, protectedReference, moves, tolerance, endFrame)
  const sources = await Promise.all(["reference", "calibration", "baseline"].map(async (name) => {
    const sourceHost = await jsonl(path.join(directory, name, "host.jsonl"))
    const sourceActions = await jsonl(path.join(directory, name, "actions.jsonl"))
    return captureCoverage(sourceHost, sourceActions)
  }))
  const pid = located[0]?.pid
  const owners = host.filter((entry) => entry.event === "host-spawn" && entry.pid === pid)
  const sourceEnergy = (from: number, to: number) => {
    let square = 0
    for (let frame = from; frame < to; frame++)
      square += (expected.samples[frame * expected.channels] ?? 0) ** 2
    return square / Math.max(1, to - from)
  }
  const rightEnergy = (from: number, to: number) => {
    let square = 0, nonFinite = 0, clipped = 0
    for (let frame = Math.max(0, Math.floor(from)); frame < Math.min(endFrame, to); frame++) {
      const sample = aligned.samples[frame * aligned.channels + 1] ?? NaN
      if (!Number.isFinite(sample)) nonFinite++
      if (Math.abs(sample) >= 1) clipped++
      square += sample * sample
    }
    return { meanSquare: square / Math.max(1, to - from), nonFinite, clipped }
  }
  const audibleEditedPath = located.map((edit) => ({
    before: rightEnergy(edit.publicationFrame - rate / 4, edit.publicationFrame),
    after: rightEnergy(edit.publicationFrame + rate / 4, edit.publicationFrame + rate / 2),
  }))
  const monitoredDelay = keepLatency ? edits.map((edit) => ({
    before: monitoredContentDelay(aligned, expected, edit.publicationFrame - rate / 4, edit.fromLatencyFrames ?? 0),
    after: monitoredContentDelay(aligned, expected, edit.publicationFrame + rate / 4, edit.toLatencyFrames ?? 0),
  })) : []
  let restart: { passed: boolean; actualOnset: number; referenceOnset: number } | undefined
  if (plan.fixtureKind === "stop-restart") {
    const restarted = protectedChannel(await readWav(path.join(directory, "restart.wav")))
    const restartedReference = protectedChannel(await readWav(path.join(directory, "restart-reference.wav")))
    const nativeOnset = async (pcm: Pcm, source: string) => {
      const frame = firstSignalFrame(pcm)
      const map = captureSegments.parse(JSON.parse(await readFile(path.join(directory, source, "restart-capture-segments.json"), "utf8"))).segments
      const segment = map.find((candidate) => frame >= candidate.outputFrame && frame < candidate.outputFrame + candidate.frames)
      if (!segment) throw new Error("Restart onset outside capture")
      const offset = segment.sourceFrame + frame - segment.outputFrame
      const records = await jsonl(path.join(directory, source, "host.jsonl"))
      const block = records.find((entry) => entry.event === "capture-block" && entry.pid === segment.pid
        && entry.captureId === segment.captureId && offset >= Number(entry.offset) && offset < Number(entry.offset) + Number(entry.frames))
      if (!block) throw new Error("Restart onset has no transport-frame proof")
      return Number(block.transportFrame) + offset - Number(block.offset)
    }
    const actualOnset = await nativeOnset(restarted, "baseline")
    const referenceOnset = await nativeOnset(restartedReference, "reference")
    const actualSignal = firstSignalFrame(restarted), referenceSignal = firstSignalFrame(restartedReference)
    const actualPcm = align(restarted, actualSignal), referencePcm = align(restartedReference, referenceSignal)
    const comparedFrames = Math.min(actualPcm.samples.length, referencePcm.samples.length)
    const continuity = compareLatency(actualPcm, referencePcm, [], tolerance, comparedFrames)
    restart = { actualOnset, referenceOnset, passed: Math.abs(actualOnset - referenceOnset) <= 1
      && comparedFrames > rate && continuity.passed }
  }
  const completion = measured.filter((entry) => entry.event === "latency-move-complete"
    && Number(entry.wallMs) >= (plan.edits[0]?.wallMs ?? Infinity))
  const overlapRequested = plan.edits[1]?.wallMs ?? Infinity
  const checks = {
    genuinePhase4Routes: plan.edits.length === (plan.fixtureKind === "overlapping-moves" ? 4 : 2)
      && plan.edits[0]?.name === "latency-raise" && lower?.name === "latency-lower"
      && lower?.toLatencyFrames === raise?.fromLatencyFrames,
    everyEditPublished: attribution !== undefined,
    monotonicRevisions: located.every((edit, index) => index === 0 || edit.revision > (located[index - 1]?.revision ?? Infinity)),
    oneHostAndGeneration: owners.length === 1 && Number.isInteger(owners[0]?.lifecycleGeneration)
      && located.every((edit) => edit.pid === pid && edit.transportEpoch === located[0]?.transportEpoch)
      && !measured.some((entry) => Number(entry.wallMs) >= (plan.edits[0]?.wallMs ?? Infinity)
        && ["host-spawn", "host-exit", "device-stop", "device-configure"].includes(String(entry.event))),
    calibratedNoEditHealthy: noEdit.passed,
    windowsCoveredAndAudible: !!raise && !!lower && raise.publicationFrame > rate
      && lower.publicationFrame > raise.publicationFrame + rate
      && endFrame > lower.publicationFrame + rate
      && sourceEnergy(raise.publicationFrame - rate / 2, raise.publicationFrame) > 1e-10
      && sourceEnergy(lower.publicationFrame, lower.publicationFrame + rate / 2) > 1e-10,
    exactRaiseFadeAndDeclaredMove: pcm.passed,
    pinnedLowerNoGapRetriggerOrTailReset: pcm.regions.shifted === 0 && pcm.passed,
    editedFftPathAudibleAndFinite: attribution !== undefined && audibleEditedPath.every((entry) =>
      [entry.before, entry.after].every((energy) => energy.meanSquare > 1e-10 && energy.nonFinite === 0 && energy.clipped === 0)),
    monitoredPathHasNoCompensation: !keepLatency || (attribution !== undefined
      && monitoredDelay.every((entry) => entry.before.passed && entry.after.passed)),
    stopRestartShrinks: plan.fixtureKind !== "stop-restart" || restart?.passed === true,
    overlappingMoveWaitsForCompletion: plan.fixtureKind !== "overlapping-moves"
      || (completion.length >= 2 && overlapRequested < Number(completion[0]?.wallMs)
        && Number(publications[1]?.wallMs) >= Number(completion[0]?.wallMs)),
    productMaximumReached: plan.fixtureKind !== "product-maximum" || raise?.toLatencyFrames === 65_536,
    captureIntegrity: sources.every((source) => source.measured === 1 && source.failures.length === 0),
  }
  const passed = Object.values(checks).every(Boolean)
  const verdict = passed ? `PHASE 4 PACKAGED PASS: ${plan.fixtureKind}; R=${R} frames; ${
    keepLatency ? "Keep Latency, no compensated move." : "5 ms out/in, lower pinned."}`
    : `PHASE 4 PACKAGED FAIL: ${Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name).join(", ")}`
  const analysis = { phase: 4, passed, verdict, checks, synthetic, edits, publications: located, restart, audibleEditedPath, monitoredDelay,
    oracle: "Moves from the published revisions; exact retained left channel; monitored right content delay equals intrinsic FFT latency only; edited right energy/finite checks.",
    declaredMoveFrames: R,
    declaredMoveMs: R / rate * 1000, allowedMoveWindowFrames: R + Math.round(rate * 0.01),
    tolerance, noEdit, pcm, origins, capture: sources,
    analyzerSha256: createHash("sha256").update(await readFile(import.meta.filename)).digest("hex") }
  await writeFile(path.join(directory, "analysis.json"), JSON.stringify(analysis, null, 2))
  await writeFile(path.join(directory, "verdict.md"), `# AE-08 phase 4\n\n${verdict}\n\n` +
    Object.entries(checks).map(([name, ok]) => `- ${name}: ${ok ? "pass" : "FAIL"}`).join("\n") + "\n")
  return analysis
}

export const analyzePhase4Campaign = async (directory: string) => {
  const required = ["two-tone", "held-note", "reverb-tail", "combined", "stop-restart", "overlapping-moves", "keep-latency-direct", "keep-latency-group", "product-maximum"]
  const campaign = z.object({ phase: z.literal(4), directories: z.array(z.string()).length(required.length) })
    .parse(JSON.parse(await readFile(path.join(directory, "phase4-campaign.json"), "utf8")))
  if (new Set(campaign.directories).size !== required.length || required.some((name) => !campaign.directories.includes(name)))
    throw new Error("Phase 4 requires all nine audible latency-transition rows")
  const fixtures = []
  for (const name of campaign.directories) fixtures.push(await analyzePhase4(path.join(directory, name)))
  const passed = fixtures.every((fixture) => fixture.passed)
  const verdict = passed ? "PHASE 4 PACKAGED PASS: all nine audible latency-transition rows."
    : "PHASE 4 PACKAGED FAIL: see isolated fixture verdicts."
  const analysis = { phase: 4, passed, verdict, fixtures }
  await writeFile(path.join(directory, "analysis.json"), JSON.stringify(analysis, null, 2))
  await writeFile(path.join(directory, "verdict.md"), `# AE-08 phase 4\n\n${verdict}\n`)
  return analysis
}

// Float32 native multiply/add versus a Float64 offline-oracle composition can
// differ by a few ULPs. 2e-7 absolute is < -133 dBFS and >100,000x below this
// fixture's smallest audible sample. Retained channel must still null exactly.
// No RMS averaging, seam exclusion, local alignment, or data-fitted tolerance.
export const comparePhase5 = (output: Pcm, reference: Pcm, options: {
  seams: number[]; blockFrames: number; lifecycleHealthy: boolean; startFrame?: number
}) => {
  const frames = output.samples.length / output.channels
  const startFrame = options.startFrame ?? 0
  const format = output.sampleRate === reference.sampleRate && output.channels === reference.channels
    && output.samples.length === reference.samples.length
  let mismatches = 0, retainedMismatches = 0, nonFinite = 0, maxAbsDifference = 0, firstMismatch = -1
  const windows = options.seams.map((frame) => ({ seamFrame: frame,
    startFrame: frame - options.blockFrames * 2,
    endFrame: frame + Math.ceil(output.sampleRate * 0.006) + options.blockFrames * 2,
    checkedSamples: 0, mismatches: 0, maxAbsDifference: 0, peakStep: 0, referencePeakStep: 0 }))
  for (let frame = startFrame; frame < frames; frame++) {
    for (let channel = 0; channel < output.channels; channel++) {
      const actual = output.samples[frame * output.channels + channel]
      const expected = reference.samples[frame * reference.channels + channel]
      const error = Math.abs((actual ?? NaN) - (expected ?? NaN))
      const invalid = !Number.isFinite(error)
      if (invalid) nonFinite++
      const mismatch = invalid || error > (channel === 0 ? 0 : 2e-7)
      maxAbsDifference = Math.max(maxAbsDifference, invalid ? Infinity : error)
      if (mismatch) {
        mismatches++
        if (channel === 0) retainedMismatches++
        if (firstMismatch < 0) firstMismatch = frame
      }
      for (const window of windows) {
        if (frame < window.startFrame || frame >= window.endFrame) continue
        window.checkedSamples++
        if (mismatch) window.mismatches++
        window.maxAbsDifference = Math.max(window.maxAbsDifference, invalid ? Infinity : error)
        if (frame > window.startFrame) {
          window.peakStep = Math.max(window.peakStep, Math.abs((actual ?? NaN)
            - (output.samples[(frame - 1) * output.channels + channel] ?? NaN)))
          window.referencePeakStep = Math.max(window.referencePeakStep, Math.abs((expected ?? NaN)
            - (reference.samples[(frame - 1) * reference.channels + channel] ?? NaN)))
        }
      }
    }
  }
  const covered = windows.length > 0 && windows.every((window) =>
    Number.isSafeInteger(window.seamFrame) && window.startFrame >= startFrame && window.endFrame <= frames
    && window.checkedSamples === (window.endFrame - window.startFrame) * output.channels)
  const boundedSteps = windows.every((window) => window.peakStep <= window.referencePeakStep + 4e-7)
  return { passed: format && options.lifecycleHealthy && covered && boundedSteps && mismatches === 0,
    frames, format, covered, lifecycleHealthy: options.lifecycleHealthy, mismatches, retainedMismatches,
    nonFinite, firstMismatch, maxAbsDifference, boundedSteps, windows, tolerance: { retained: 0, edited: 2e-7 } }
}

// Bit-exact on the retained left channel and within 2e-7 on the edited right, as comparePhase5.
const spanDifference = (output: Pcm, reference: Pcm, startFrame: number, endFrame: number) => {
  let mismatches = 0, maxAbsDifference = 0
  for (let frame = startFrame; frame < endFrame; frame++) {
    for (let channel = 0; channel < output.channels; channel++) {
      const error = Math.abs((output.samples[frame * output.channels + channel] ?? NaN)
        - (reference.samples[frame * output.channels + channel] ?? NaN))
      if (!Number.isFinite(error) || error > (channel === 0 ? 0 : 2e-7)) mismatches++
      maxAbsDifference = Math.max(maxAbsDifference, error)
    }
  }
  return { mismatches, maxAbsDifference }
}

const phase5PlanSchema = z.object({ phase: z.literal(5), row: z.string(), editStart: z.number(),
  commits: z.array(z.object({ wallMs: z.number(), revision: z.number() })), endFrame: z.number().int().positive(),
  sameTrackId: z.boolean().optional() })
type Phase5Evidence = { plan: z.infer<typeof phase5PlanSchema>; host: Entry[]; actions: Entry[]; wav: (name: string) => Promise<Pcm> }

export const checkPhase5 = async ({ plan, host, actions, wav }: Phase5Evidence) => {
  const end = Number(actions.find((entry) => entry.event === "capture-end")?.wallMs)
  const measured = host.filter((entry) => Number(entry.wallMs) >= plan.editStart && Number(entry.wallMs) <= end)
  const publications = measured.filter((entry) => entry.event === "graph-publish")
    .sort((a, b) => Number(a.publicationFrame) - Number(b.publicationFrame))
  const blocks = host.filter((entry) => entry.event === "capture-block"
    && Number(entry.transportFrame) > 0 && Number(entry.wallMs) <= end)
  const owner = blocks.find((entry) => Number(entry.wallMs) >= plan.editStart)
  if (!owner) throw new Error("No measured native capture blocks")
  const pcm = await wav(`output-${owner.pid}-${owner.captureId}.wav`)
  const rawBlocks = host.filter((entry) => entry.event === "capture-block"
    && entry.pid === owner.pid && entry.captureId === owner.captureId)
  const captureComplete = host.find((entry) => entry.event === "capture-complete"
    && entry.pid === owner.pid && entry.captureId === owner.captureId)
  const rawOffsetIntegrity = rawCaptureOffsetsValid(rawBlocks, pcm.samples.length / pcm.channels, captureComplete)
  const initial = await wav("initial-reference.wav")
  const final = await wav("final-reference.wav")
  if ([initial, final].some((item) => item.sampleRate !== pcm.sampleRate || item.channels !== pcm.channels
    || item.samples.length / item.channels < plan.endFrame)) throw new Error("Incomplete/mismatched offline references")
  const output: Pcm = { ...pcm, samples: new Float32Array(plan.endFrame * pcm.channels) }
  const covered = new Uint8Array(plan.endFrame)
  let duplicateFrames = 0, blockFrames = 0
  for (const block of blocks) {
    if (block.pid !== owner.pid || block.captureId !== owner.captureId) continue
    const start = Number(block.transportFrame), count = Number(block.frames), offset = Number(block.offset)
    blockFrames = Math.max(blockFrames, count)
    for (let i = 0; i < count && start + i < plan.endFrame; i++) {
      if (covered[start + i]) duplicateFrames++
      covered[start + i] = 1
      for (let channel = 0; channel < pcm.channels; channel++)
        output.samples[(start + i) * pcm.channels + channel] = pcm.samples[(offset + i) * pcm.channels + channel] ?? NaN
    }
  }
  const seams = publications.map((entry) => Number(entry.publicationFrame))
  const epoch = owner.transportEpoch
  const lifecycle = measured.filter((entry) => /stop|teardown|start|rebuild|host-exit|host-spawn|device-configure/i.test(String(entry.event)))
  const energy = (source: Pcm, start: number, stop: number, channel: number) => {
    let square = 0
    for (let frame = start; frame < stop; frame++) square += (source.samples[frame * source.channels + channel] ?? NaN) ** 2
    return square / (stop - start)
  }
  // An import during playback may publish its new, still empty track before the decoded clip: the clip appears at once
  // and its audio follows. One such publication is admitted, before the asset's, only if nothing heard changes until
  // the asset's publication (both channels equal the pre-import reference) and the asset's audio is there from it on.
  const assetSeam = seams.at(-1) ?? Infinity
  const extraSeam = plan.row === "add-paged-asset" && publications.length === 2 ? seams[0] : undefined
  const trackOnlyPublication = extraSeam === undefined ? undefined : {
    startFrame: extraSeam, endFrame: assetSeam,
    preImport: spanDifference(output, initial, extraSeam, assetSeam),
    assetAudible: energy(final, assetSeam, assetSeam + blockFrames, 1) > 1e-5,
  }
  const checks = {
    audibleReference: energy(initial, pcm.sampleRate, pcm.sampleRate * 2, 0) > 1e-5
      && (plan.row === "add-paged-asset" || energy(initial, pcm.sampleRate, pcm.sampleRate * 2, 1) > 1e-5),
    supportedPublicationCount: plan.row === "remove-readd-track" ? [2, 3].includes(publications.length)
      : plan.row === "rapid-burst" ? publications.length >= 1 && publications.length <= plan.commits.length
      : plan.row === "add-paged-asset" ? publications.length === 1 || (!!trackOnlyPublication
        && trackOnlyPublication.startFrame < trackOnlyPublication.endFrame
        && trackOnlyPublication.preImport.mismatches === 0 && trackOnlyPublication.assetAudible)
      : publications.length === 1,
    stagedPublication: publications.length >= (plan.row === "remove-readd-track" ? 2 : 1)
      && publications.every((entry, index) => entry.cause === "block-boundary"
        && Number(entry.publicationEpoch) > 0 && entry.pid === owner.pid && entry.transportEpoch === epoch
        && (index === 0 || Number(entry.revision) > Number(publications[index - 1]?.revision))
        && measured.some((request) => request.event === "graph-publish-request"
          && request.requestedRevision === entry.revision)
        && blocks.some((block) => block.pid === entry.pid && block.captureId === owner.captureId
          && block.revision === entry.revision && block.transportEpoch === epoch
          && Number(block.transportFrame) <= Number(entry.publicationFrame)
          && Number(entry.publicationFrame) < Number(block.transportFrame) + Number(block.frames))),
    noColdRebuild: lifecycle.length === 0
      && measured.filter((entry) => entry.transportEpoch !== undefined).every((entry) => entry.transportEpoch === epoch),
    captureIntegrity: rawOffsetIntegrity && captureComplete?.failed === false && captureComplete.overflowFrames === 0
      && covered.subarray(pcm.sampleRate).every((value) => value === 1) && duplicateFrames === 0,
    burstCommitted: plan.row !== "rapid-burst" || (plan.commits.length >= 5
      && plan.commits.every((entry, index) => index === 0 || entry.revision > (plan.commits[index - 1]?.revision ?? Infinity))),
    sameTrackId: plan.row !== "remove-readd-track" || plan.sameTrackId === true,
    completeInterval: Number.isFinite(end) && seams.length > 0 && (seams.at(-1) ?? Infinity) < plan.endFrame - pcm.sampleRate,
  }
  const expected: Pcm = { ...output, samples: initial.samples.slice(0, output.samples.length) }
  const fadeFrames = Math.trunc(pcm.sampleRate * 0.006)
  const first = seams[0] ?? Infinity, last = seams.at(-1) ?? Infinity
  // The publication that restores a removed track, and the one that delivers an asset: the LAT1 judge requires exactly it to carry asset-install.
  const restored = seams.length === 3 ? seams[1] ?? last : last
  const assetPublicationFrame = plan.row === "add-paged-asset" ? assetSeam : plan.row === "remove-readd-track" ? restored : Infinity
  // The left-only 180s retained source is independent of every edit. Right
  // references are whole-project offline exports made outside live playback.
  // Raw tempo, empty-track edits and held synth must null to the initial state.
  for (let frame = first; frame < plan.endFrame; frame++) {
    const index = frame * pcm.channels + 1
    const old = initial.samples[index] ?? NaN, next = final.samples[index] ?? NaN
    if (plan.row === "delete-clip" || plan.row === "move-trim" || plan.row === "rapid-burst") {
      const seam = plan.row === "rapid-burst" ? last : first
      const gain = frame < seam ? 1 : Math.max(0, Math.fround(1 - Math.fround((frame - seam) / fadeFrames)))
      const entry = plan.row === "move-trim" ? Math.min(1, Math.fround((frame - first) / fadeFrames)) : 1
      expected.samples[index] = Math.fround(old * gain + next * entry)
    } else if (plan.row === "add-paged-asset") expected.samples[index] = frame < last ? old : next
    else if (plan.row === "remove-readd-track") {
      // Deleted nodes have the existing 5ms graph-ghost fade (phase 3);
      // the source itself has the independent 6ms termination envelope.
      const ghost = Math.max(0, Math.fround(1 - Math.fround((frame - first) / Math.round(pcm.sampleRate * 0.005))))
      const source = Math.max(0, Math.fround(1 - Math.fround((frame - first) / fadeFrames)))
      if (frame < restored) expected.samples[index] = Math.fround(old * ghost * source)
      else if (frame < last) expected.samples[index] = old
      else if (restored < last) {
        const fade = Math.max(0, Math.fround(1 - Math.fround((frame - last) / fadeFrames)))
        expected.samples[index] = Math.fround(old * fade + next * (1 - fade))
      } else expected.samples[index] = next
    } else expected.samples[index] = next
  }
  const comparison = comparePhase5(output, expected, { seams, blockFrames,
    lifecycleHealthy: Object.values(checks).every(Boolean), startFrame: pcm.sampleRate })
  // Even a missing publication cannot exempt the final state from comparison.
  // This detects saved edits that never reach playback, independently of the
  // required staged-publication proof (which already fails without a seam).
  const finalStart = plan.endFrame - Math.round(pcm.sampleRate * 0.5)
  const finalDifference = spanDifference(output, final, finalStart, plan.endFrame)
  const finalState = { passed: finalDifference.mismatches === 0, startFrame: finalStart, endFrame: plan.endFrame,
    mismatches: finalDifference.mismatches, maxAbsDifference: finalDifference.maxAbsDifference }
  const peakReference = Math.max(energy(initial, pcm.sampleRate, pcm.sampleRate * 2, 1),
    energy(final, finalStart, plan.endFrame, 1))
  const seamSignals = seams.map((frame) => ({ frame, beforeMeanSquare: energy(output, frame - blockFrames, frame, 0),
    afterMeanSquare: energy(output, frame, frame + blockFrames, 0) }))
  // A silent oracle must never certify a lost imported source or muted synth.
  const audible = peakReference > 1e-5 && seamSignals.every((entry) =>
    entry.beforeMeanSquare > 1e-5 && entry.afterMeanSquare > 1e-5)
  const passed = comparison.passed && finalState.passed && audible
  return { phase: 5, row: plan.row, passed, verdict: `PHASE 5 ${passed ? "PASS" : "FAIL"}: ${plan.row}`,
    checks, ...(trackOnlyPublication && { trackOnlyPublication }), ...(Number.isFinite(assetPublicationFrame) && { assetPublicationFrame }),
    comparison, finalState, audible, seamSignals,
    publications, lifecycle, owner: { pid: owner.pid, captureId: owner.captureId, epoch } }
}

export const analyzePhase5 = async (directory: string) => {
  const plan = phase5PlanSchema.parse(JSON.parse(await readFile(path.join(directory, "phase5-edits.json"), "utf8")))
  const analysis = { ...await checkPhase5({ plan, host: await jsonl(path.join(directory, "host.jsonl")),
    actions: await jsonl(path.join(directory, "actions.jsonl")), wav: (name) => readWav(path.join(directory, name)) }),
    analyzerSha256: createHash("sha256").update(await readFile(import.meta.filename)).digest("hex") }
  await writeFile(path.join(directory, "analysis.json"), JSON.stringify(analysis, null, 2))
  return analysis
}

// Phase 5 effect-state row. The left 180 s source has no effect, and live
// playback keeps the monitored Spectral track's latency out of compensation
// (phase 4 Keep Latency), so it must null bit-exactly inside every playing span
// against each offline reference at that reference's compensation. The right
// path, Spectral then Utility, is judged by its content delay against the
// fixture's own source, which is the FFT's intrinsic latency, and by its
// least-squares gain relative to the unchanged-gain span after the FFT edit.
// Spans come from native transport proof alone: a span is a run of capture
// blocks whose transport frame and raw offset both advance in one epoch. A
// deliberate pause holds one frame in a later epoch; a stall or skip inside a
// running epoch splits a span and fails. Resume may ramp back in, never click.
const effectStatePlanSchema = z.object({ phase: z.literal(5), row: z.literal("effect-state"), editStart: z.number(),
  endFrame: z.number().int().positive(), effectState: z.object({ trackId: z.string(),
    fromLatencyFrames: z.number().int().positive(), toLatencyFrames: z.number().int().positive(),
    fftAfterFrame: z.number().int(), dragAfterFrame: z.number().int(), previewFromFrame: z.number().int(),
    releaseAfterFrame: z.number().int(), pausedFrame: z.number().int(),
    knob: z.object({ before: z.number(), paused: z.number(), resumed: z.number(), end: z.number() }) }) })
const effectStateProgressSchema = z.object({
  progress: z.array(z.object({ wallMs: z.number(), revision: z.number(), epoch: z.number(), running: z.boolean(),
    renderedThroughFrame: z.string().regex(/^\d+$/), appliedProcessorSequence: z.string().regex(/^\d+$/) })),
  release: z.object({ wallMs: z.number(), dragEnded: z.boolean(), knobDb: z.number() }),
  pause: z.object({ wallMs: z.number() }),
})
type EffectStateEvidence = {
  plan: z.infer<typeof effectStatePlanSchema>; host: Entry[]; actions: Entry[]
  capture: Pcm; leftReference: Pcm; rightSource: Pcm; finalReference: Pcm
  progress: z.infer<typeof effectStateProgressSchema>; persistedGainDb: number | undefined
}
type CaptureSpan = { epoch: number; transportFrame: number; offset: number; frames: number; blocks: number }

const effectStateOwner = (host: Entry[], editStart: number) =>
  host.find((entry) => entry.event === "capture-block" && Number(entry.wallMs) >= editStart)

const captureSpans = (blocks: Entry[]) => {
  const spans: CaptureSpan[] = []
  for (const block of blocks) {
    const epoch = Number(block.transportEpoch), transportFrame = Number(block.transportFrame)
    const offset = Number(block.offset), frames = Number(block.frames)
    const last = spans.at(-1)
    if (last && last.epoch === epoch && last.transportFrame + last.frames === transportFrame && last.offset + last.frames === offset) {
      last.frames += frames
      last.blocks++
    } else spans.push({ epoch, transportFrame, offset, frames, blocks: 1 })
  }
  return spans
}

export const checkPhase5EffectState = (evidence: EffectStateEvidence) => {
  const { plan, host, actions, capture, leftReference, rightSource, finalReference, progress, persistedGainDb } = evidence
  const state = plan.effectState, rate = capture.sampleRate, channels = capture.channels
  const markWall = (event: string) => Number(actions.find((entry) => entry.event === event)?.wallMs)
  const start = markWall("capture-start"), end = markWall("capture-end"), resumeMark = markWall("effect-resume")
  const fftMark = markWall("effect-fft-edit"), dragMark = markWall("effect-gain-drag")
  const owner = effectStateOwner(host, plan.editStart)
  const measured = host.filter((entry) => Number(entry.wallMs) >= start && Number(entry.wallMs) <= end)
  const ownerBlocks = host.filter((entry) => entry.event === "capture-block" && !!owner
    && entry.pid === owner.pid && entry.captureId === owner.captureId)
  const complete = host.find((entry) => entry.event === "capture-complete" && !!owner
    && entry.pid === owner.pid && entry.captureId === owner.captureId)
  const blocks = ownerBlocks.filter((entry) => Number(entry.wallMs) >= start && Number(entry.wallMs) <= end)
    .toSorted((left, right) => Number(left.offset) - Number(right.offset))
  const playing = captureSpans(blocks).filter((span) => span.blocks > 1)
  const [spanA, spanB] = playing
  const spanEnd = (span: CaptureSpan) => span.transportFrame + span.frames
  const pauseBlocks = spanA && spanB ? blocks.filter((block) => Number(block.offset) >= spanA.offset + spanA.frames
    && Number(block.offset) < spanB.offset) : []
  const sample = (span: CaptureSpan, frame: number, channel: number) =>
    capture.samples[(span.offset + frame - span.transportFrame) * channels + channel] ?? NaN
  const source = (frame: number) => rightSource.samples[frame * rightSource.channels + 1] ?? NaN
  const blockFrames = blocks.reduce((maximum, block) => Math.max(maximum, Number(block.frames)), 0)
  const resumeGuard = blockFrames * 4 + Math.ceil(rate * 0.006)

  // The retained left channel is compared sample by sample, without tolerance,
  // against each offline reference shifted by its own compensation delay. An
  // export compensates fully, so it delays the effect-free left track by the
  // Spectral latency it rendered with. The exports record no latency; Spectral's
  // latency is its FFT size (getSpectralLatencyFrames, uncentred), which this
  // oracle asserts as the right path's content delay: fromLatencyFrames for the
  // initial reference, rendered before the FFT edit, and toLatencyFrames for the
  // final one, rendered after it. The shifts are derived, never searched.
  const leftReferences = [{ pcm: leftReference, shift: state.fromLatencyFrames },
    { pcm: finalReference, shift: state.toLatencyFrames }]
  const leftWindows = spanA && spanB ? [{ span: spanA, from: Math.max(rate, spanA.transportFrame), to: spanEnd(spanA) },
    { span: spanB, from: spanB.transportFrame + resumeGuard, to: Math.min(spanEnd(spanB), plan.endFrame) }] : []
  let leftCompared = 0, leftMismatches = 0, firstLeftMismatch: number | null = null
  for (const { span, from, to } of leftWindows) {
    for (let frame = from; frame < to; frame++) {
      leftCompared++
      const actual = sample(span, frame, 0)
      if (leftReferences.some(({ pcm, shift }) => actual !== (pcm.samples[(frame + shift) * pcm.channels] ?? NaN))) {
        leftMismatches++
        firstLeftMismatch ??= frame
      }
    }
  }
  const peakStep = (read: (frame: number) => number, from: number, to: number) => {
    let peak = 0
    for (let frame = from + 1; frame < to; frame++) peak = Math.max(peak, Math.abs(read(frame) - read(frame - 1)))
    return peak
  }
  // A resume is warm when the paused graph plays on in the same host and capture:
  // from span A's last block to span B's first, every host event comes from the
  // owner process, every capture block from the owner capture, and no event
  // stops, starts, configures or rebuilds the device, capture or host.
  const pausedFromWall = Number((spanA && blocks.findLast((block) => Number(block.offset) < spanA.offset + spanA.frames))?.wallMs)
  const resumedWall = Number((spanB && blocks.find((block) => Number(block.offset) === spanB.offset))?.wallMs)
  const warmResume = !!owner && pauseBlocks.length > 0 && measured.every((entry) =>
    !(Number(entry.wallMs) >= pausedFromWall && Number(entry.wallMs) <= resumedWall)
    || (entry.pid === owner.pid && (entry.event !== "capture-block" || entry.captureId === owner.captureId)
      && !/stop|start|configure|rebuild|teardown|host-exit|host-spawn/i.test(String(entry.event))))
  const resumeSteps = spanB ? {
    actual: peakStep((frame) => sample(spanB, frame, 0), spanB.transportFrame, spanB.transportFrame + resumeGuard),
    reference: peakStep((frame) => leftReference.samples[frame * leftReference.channels] ?? NaN,
      spanB.transportFrame, spanB.transportFrame + resumeGuard),
  } : undefined

  const correlate = (read: (frame: number) => number, from: number, to: number, delay: number) => {
    let sumActual = 0, sumSource = 0, actualSquares = 0, sourceSquares = 0, products = 0
    for (let frame = from; frame < to; frame++) {
      const actual = read(frame), expected = source(frame - delay)
      sumActual += actual; sumSource += expected
      actualSquares += actual * actual; sourceSquares += expected * expected; products += actual * expected
    }
    const count = to - from
    const covariance = products - sumActual * sumSource / count
    const sourceVariance = sourceSquares - sumSource * sumSource / count
    return { delay, pearson: covariance / Math.sqrt((actualSquares - sumActual * sumActual / count) * sourceVariance),
      gain: covariance / sourceVariance }
  }
  // A steady delay-plus-gain path holds every window at exactly fit.gain² times
  // the energy of the same delayed source window, whatever the window size, so
  // every sliding 1 ms window must stay within ±1 dB of it. A 10 ms floor let a
  // 2 ms dropout through. -Infinity (null in JSON) is a fully silent window.
  const fitPath = (read: (frame: number) => number, from: number, to: number, delay: number, competing: number) => {
    const fit = [delay - 1, delay, delay + 1].map((candidate) => correlate(read, from, to, candidate))
      .reduce((best, next) => next.pearson > best.pearson ? next : best)
    const window = Math.round(rate * 0.001), frames = to - from
    const actualEnergy = new Float64Array(frames + 1), sourceEnergy = new Float64Array(frames + 1)
    let nonFinite = 0, clipped = 0
    for (let index = 0; index < frames; index++) {
      const actual = read(from + index)
      if (!Number.isFinite(actual)) nonFinite++
      else if (Math.abs(actual) >= 1) clipped++
      actualEnergy[index + 1] = (actualEnergy[index] ?? NaN) + actual * actual
      sourceEnergy[index + 1] = (sourceEnergy[index] ?? NaN) + source(from + index - fit.delay) ** 2
    }
    let offLevelWindows = 0, worstWindowDb = 0, worstWindowFrame = from
    for (let index = 0; index + window <= frames; index++) {
      const actual = Math.max(0, (actualEnergy[index + window] ?? NaN) - (actualEnergy[index] ?? NaN))
      const db = 10 * Math.log10(actual / (fit.gain ** 2 * ((sourceEnergy[index + window] ?? NaN) - (sourceEnergy[index] ?? NaN))))
      if (!(Math.abs(db) <= 1)) offLevelWindows++
      if (Math.abs(db) > Math.abs(worstWindowDb)) { worstWindowDb = db; worstWindowFrame = from + index }
    }
    return { from, to, delay, fittedDelay: fit.delay, pearson: fit.pearson, gain: fit.gain,
      competingDelay: competing, competingPearson: correlate(read, from, to, competing).pearson,
      windowFrames: window, toleranceDb: 1, offLevelWindows, worstWindowDb, worstWindowFrame, nonFinite, clipped }
  }
  const region = (span: CaptureSpan | undefined, from: number, to: number, delay: number, competing: number) =>
    span && from >= span.transportFrame && to <= spanEnd(span) && to - from >= rate / 4
      ? fitPath((frame) => sample(span, frame, 1), from, to, delay, competing) : null

  const publications = measured.filter((entry) => entry.event === "graph-publish")
  const fftPublications = publications.filter((entry) => Number(entry.wallMs) >= fftMark && Number(entry.wallMs) < dragMark)
  const fft = fftPublications.length === 1 ? fftPublications[0] : undefined
  const fftFrame = Number(fft?.publicationFrame)
  const { fromLatencyFrames: from, toLatencyFrames: to } = state
  const regions = {
    beforeFft: region(spanA, rate, state.fftAfterFrame, from, to),
    afterFft: region(spanA, fftFrame + rate / 2, state.dragAfterFrame, to, from),
    preview: region(spanA, state.previewFromFrame + rate / 4, state.releaseAfterFrame, to, from),
    resumed: spanB ? region(spanB, spanB.transportFrame + rate / 2, Math.min(spanEnd(spanB), plan.endFrame), to, from) : null,
  }
  const target = progress.release.knobDb
  const levelDb = (next: typeof regions.afterFft) => next && regions.afterFft
    ? 20 * Math.log10(next.gain / regions.afterFft.gain) : NaN
  const previewDb = levelDb(regions.preview), resumedDb = levelDb(regions.resumed)
  // Promoted after the C0i packaged run held them steady: the resumed span inside
  // the gain region's half-second guard, from the first frame the FFT refills
  // after the resume ramp; and the right path of the post-reload export.
  const resumedEarly = spanB
    ? region(spanB, spanB.transportFrame + resumeGuard + to, spanB.transportFrame + rate / 2, to, from) : null
  const durability = fitPath((frame) => finalReference.samples[frame * finalReference.channels + 1] ?? NaN,
    rate, plan.endFrame, to, from)
  const earlyDb = levelDb(resumedEarly), durabilityDb = levelDb(durability)
  const wouldPass = (entry: typeof resumedEarly, db: number) => !!entry && entry.offLevelWindows === 0
    && entry.nonFinite === 0 && entry.clipped === 0 && entry.pearson > 0.98 && entry.competingPearson < 0.9
    && Math.abs(db - target) <= 0.1
  const sequence = (entries: typeof progress.progress) =>
    entries.reduce((maximum, entry) => BigInt(entry.appliedProcessorSequence) > maximum ? BigInt(entry.appliedProcessorSequence) : maximum, -1n)
  const beforeDragSequence = sequence(progress.progress.filter((entry) => entry.wallMs <= dragMark).slice(-1))
  const previewSequence = sequence(progress.progress.filter((entry) => entry.wallMs > dragMark && entry.wallMs < progress.release.wallMs))

  const checks = {
    captureIntegrity: !!owner && rawCaptureOffsetsValid(ownerBlocks, capture.samples.length / channels, complete)
      && complete?.failed === false && complete.overflowFrames === 0,
    sameHostNoColdRebuild: !!owner
      && !measured.some((entry) => /stop|teardown|start|rebuild|host-exit|host-spawn|device-configure/i.test(String(entry.event)))
      && measured.every((entry) => entry.event !== "capture-block" || (entry.pid === owner.pid && entry.captureId === owner.captureId))
      && publications.every((entry) => entry.cause === "block-boundary" && entry.pid === owner.pid),
    playingSpansContinuous: playing.length === 2 && !!spanA && !!spanB && spanA.transportFrame <= rate
      && spanEnd(spanA) >= state.releaseAfterFrame && spanEnd(spanB) >= plan.endFrame,
    // Resume plays the live paused graph: it is warm, keeps the paused epoch and starts at exactly the paused
    // frame. A resume that is not warm fails here even when no lifecycle event marks it cold.
    pauseBoundary: !!spanA && !!spanB && pauseBlocks.length > 0 && warmResume && spanB.epoch > spanA.epoch
      && spanB.transportFrame === state.pausedFrame
      && pauseBlocks.every((block) => Number(block.transportFrame) === spanB.transportFrame
        && Number(block.transportEpoch) === spanB.epoch)
      && progress.progress.some((entry) => !entry.running && entry.wallMs >= progress.release.wallMs && entry.wallMs <= resumeMark),
    pauseDuringFlush: progress.release.dragEnded && progress.release.wallMs > dragMark
      && progress.pause.wallMs >= progress.release.wallMs && progress.pause.wallMs < resumeMark,
    retainedLeftExact: leftWindows.length === 2 && leftWindows.every((window) => window.to - window.from >= rate)
      && leftMismatches === 0,
    resumeBoundaryBounded: !!resumeSteps && resumeSteps.actual <= resumeSteps.reference * 2 + 4e-7,
    rightPathCoveredAndGapFree: Object.values(regions).every((entry) => entry !== null
      && entry.offLevelWindows === 0 && entry.nonFinite === 0 && entry.clipped === 0),
    fftPublished: !!fft && !!spanA && !!owner && fft.cause === "block-boundary" && fft.pid === owner.pid
      && Number(fft.transportEpoch) === spanA.epoch && Number(fft.publicationEpoch) > 0
      && fftFrame >= state.fftAfterFrame && fftFrame < state.dragAfterFrame
      && measured.some((request) => request.event === "graph-publish-request" && request.requestedRevision === fft.revision
        && Number(request.wallMs) <= Number(fft.wallMs))
      && blocks.some((block) => block.revision === fft.revision && Number(block.transportEpoch) === spanA.epoch
        && Number(block.transportFrame) <= fftFrame && fftFrame < Number(block.transportFrame) + Number(block.frames)),
    fftChangedAudibly: Object.values(regions).every((entry) => entry !== null && entry.pearson > 0.98 && entry.competingPearson < 0.9),
    previewApplied: previewSequence > beforeDragSequence && Math.abs(previewDb - target) <= 0.1,
    gainChanged: Math.abs(target - state.knob.before) >= 1 && Math.abs(resumedDb - target) <= 0.1,
    draftRetained: [state.knob.paused, state.knob.resumed, state.knob.end].every((value) => value === target),
    persistedWithoutRestore: persistedGainDb === target,
    resumedEarlyGain: wouldPass(resumedEarly, earlyDb),
    exportDurable: wouldPass(durability, durabilityDb),
  }
  return { passed: Object.values(checks).every(Boolean), checks, owner: owner ? { pid: owner.pid, captureId: owner.captureId } : null,
    spans: playing, pauseBlocks: pauseBlocks.length, warmResume, resumeGuardFrames: resumeGuard, resumeSteps,
    left: { compared: leftCompared, mismatches: leftMismatches, firstMismatch: firstLeftMismatch, tolerance: 0,
      shifts: leftReferences.map(({ shift }) => shift) },
    regions, gain: { targetDb: target, previewDb, resumedDb, toleranceDb: 0.1, persistedGainDb: persistedGainDb ?? null },
    processorSequence: { beforeDrag: beforeDragSequence.toString(), preview: previewSequence.toString() },
    diagnostics: {
      rightPathWorstWindowDb: Math.max(...Object.values(regions).map((entry) => entry ? Math.abs(entry.worstWindowDb) : NaN)),
      resumedEarly: resumedEarly && { ...resumedEarly, levelDb: earlyDb, targetDb: target, wouldPass: wouldPass(resumedEarly, earlyDb) },
      durability: { ...durability, levelDb: durabilityDb, absoluteDb: 20 * Math.log10(durability.gain), targetDb: target,
        wouldPass: wouldPass(durability, durabilityDb) },
    },
    fftPublication: fft ?? null, publications }
}

export const phase5EffectStateDefects = ["playing-gap", "pcm-discontinuity", "transport-skip", "stall-without-pause",
  "gain-unchanged", "fft-unchanged", "no-preview", "restored-draft", "restored-persisted", "cold-rebuild",
  "resume-other-frame", "resume-click", "publish-missing", "publish-configured-boundary", "stamps-misordered",
  "capture-overflow", "drag-missed", "cold-resume-new-epoch", "warm-resume-wrong-frame", "warm-resume-across-stop",
  "warm-resume-across-configure", "resume-across-capture-configure", "left-wrong-shift", "left-one-sample", "early-restore",
  "export-gain-lost"] as const
type EffectStateDefect = (typeof phase5EffectStateDefects)[number]
const effectStateIntendedCheck = {
  "playing-gap": "retainedLeftExact", "pcm-discontinuity": "retainedLeftExact",
  "transport-skip": "playingSpansContinuous", "stall-without-pause": "playingSpansContinuous",
  "gain-unchanged": "gainChanged", "fft-unchanged": "fftChangedAudibly", "no-preview": "previewApplied",
  "restored-draft": "draftRetained", "restored-persisted": "persistedWithoutRestore", "cold-rebuild": "sameHostNoColdRebuild",
  "resume-other-frame": "pauseBoundary", "resume-click": "resumeBoundaryBounded", "publish-missing": "fftPublished",
  "publish-configured-boundary": "fftPublished", "stamps-misordered": "pauseDuringFlush", "capture-overflow": "captureIntegrity",
  // The C0d repeat's shape: the press never moved the knob, so the release reads the unchanged gain as its target.
  "drag-missed": "gainChanged",
  "cold-resume-new-epoch": "sameHostNoColdRebuild", "warm-resume-wrong-frame": "pauseBoundary",
  "warm-resume-across-stop": "pauseBoundary", "warm-resume-across-configure": "pauseBoundary",
  // A lone capture reconfigure marks no lifecycle event sameHostNoColdRebuild rejects, so only the warm requirement catches it.
  "resume-across-capture-configure": "pauseBoundary",
  "left-wrong-shift": "retainedLeftExact", "left-one-sample": "retainedLeftExact",
  "early-restore": "resumedEarlyGain", "export-gain-lost": "exportDurable",
} satisfies Record<EffectStateDefect, keyof ReturnType<typeof checkPhase5EffectState>["checks"]>

// One deterministic packaged-shaped capture: pre-roll, a playing span with an
// FFT publication and a gain preview, a pause holding one frame one block
// behind, then the warm resume in the same epoch from that frame with a 6 ms
// entry ramp. Spectral is a pure delay here, and each offline reference delays
// the left source by the Spectral latency it rendered with.
export const phase5EffectStateEvidence = (defect?: EffectStateDefect): EffectStateEvidence => {
  const sampleRate = 48000, block = 512, channels = 2, targetDb = defect === "drag-missed" ? 0 : -14
  const signature = (frame: number, right: boolean) => 0.08 + 0.025 * Math.sin(frame * (right ? 0.039 : 0.027))
    + 0.015 * Math.sin(frame * frame * (right ? 1.7e-8 : 1e-8))
  const reference = (seconds: number, right: boolean, delay = 0): Pcm => {
    const samples = new Float32Array(seconds * sampleRate * channels)
    for (let frame = delay; frame < seconds * sampleRate; frame++)
      samples[frame * channels + (right ? 1 : 0)] = signature(frame - delay, right)
    return { sampleRate, channels, samples }
  }
  const leftSource = reference(18, false), leftReference = reference(18, false, 512), rightSource = reference(30, true)
  const fftFrame = 212 * block, dragFrame = 240_000, previewFrom = 264_192, releaseFrame = 312_320
  const pauseFrame = 613 * block, resumeFrame = pauseFrame - block, endFrame = 17 * sampleRate
  const holdFrame = defect === "resume-other-frame" ? resumeFrame + block : resumeFrame
  const resumedBlocks = Math.ceil((18 * sampleRate - resumeFrame) / block)
  const split = defect === "transport-skip" || defect === "stall-without-pause" ? 600 : resumedBlocks
  // The pause opens epoch 5, so lookups of the resumed epoch (native-spool-wav.test.ts) still find the resume.
  const pausedEpoch = 5, resumedEpoch = defect === "cold-resume-new-epoch" ? 6 : pausedEpoch
  const segments = [
    { epoch: 2, transportFrame: 0, blocks: 8, advancing: false, resumed: false },
    { epoch: 3, transportFrame: 0, blocks: pauseFrame / block, advancing: true, resumed: false },
    { epoch: pausedEpoch, transportFrame: holdFrame, blocks: 16, advancing: false, resumed: false },
    { epoch: resumedEpoch, transportFrame: resumeFrame, blocks: split, advancing: true, resumed: true },
    ...(defect === "stall-without-pause" ? [{ epoch: resumedEpoch, transportFrame: resumeFrame + split * block, blocks: 16,
      advancing: false, resumed: true }] : []),
    ...(split < resumedBlocks ? [{ epoch: resumedEpoch, transportFrame: resumeFrame + split * block
      + (defect === "transport-skip" ? block : 0), blocks: resumedBlocks - split, advancing: true, resumed: true }] : []),
  ]
  const totalBlocks = segments.reduce((sum, segment) => sum + segment.blocks, 0)
  const samples = new Float32Array(totalBlocks * block * channels)
  const host: Entry[] = [], playingBlocks: Entry[] = []
  const leftDelay = defect === "left-wrong-shift" ? 1 : 0
  const progress: EffectStateEvidence["progress"]["progress"] = []
  const wallAt = (index: number) => 1000 + index * block / 48
  let offset = 0, sequence = 0
  for (const segment of segments) {
    for (let index = 0; index < segment.blocks; index++) {
      const transportFrame = segment.transportFrame + (segment.advancing ? index * block : 0)
      const { resumed } = segment
      const delay = transportFrame >= fftFrame && defect !== "fft-unchanged" ? 4096 : 512
      for (let frame = transportFrame; segment.advancing && frame < transportFrame + block; frame++) {
        const at = offset + frame - transportFrame
        const ramp = resumed ? Math.min(1, (frame - resumeFrame) / Math.ceil(sampleRate * 0.006)) : 1
        const preview = frame < dragFrame ? 0 : Math.min(1, (frame - dragFrame) / (previewFrom - dragFrame))
        const gainDb = resumed ? (defect === "gain-unchanged" || defect === "restored-persisted"
          || (defect === "early-restore" && frame < resumeFrame + sampleRate * 0.4) ? 0 : targetDb)
          : defect === "gain-unchanged" || defect === "no-preview" ? 0 : targetDb * preview
        samples[at * channels] = (leftSource.samples[(frame - leftDelay) * channels] ?? 0) * ramp
        samples[at * channels + 1] = (rightSource.samples[(frame - delay) * channels + 1] ?? 0) * 10 ** (gainDb / 20)
      }
      const wallMs = wallAt(offset / block)
      const captureBlock = { event: "capture-block", pid: 1, captureId: 2, offset, frames: block, transportFrame,
        transportEpoch: segment.epoch, revision: segment.epoch > 3 || transportFrame >= fftFrame ? 2 : 1, wallMs }
      host.push(captureBlock)
      if (segment.advancing) playingBlocks.push(captureBlock)
      progress.push({ wallMs, revision: segment.epoch > 3 || transportFrame >= fftFrame ? 2 : 1, epoch: segment.epoch,
        running: segment.epoch === 3 || resumed,
        renderedThroughFrame: String(transportFrame + (segment.advancing ? block : 0)), appliedProcessorSequence: String(sequence) })
      if (segment.epoch === 3 && transportFrame >= dragFrame && transportFrame < previewFrom && defect !== "no-preview"
        && defect !== "drag-missed") sequence++
      offset += block
    }
  }
  const playingBlock = (epoch: number, frame: number) => playingBlocks.find((entry) => entry.transportEpoch === epoch
    && Number(entry.transportFrame) <= frame && frame < Number(entry.transportFrame) + block)
  const blockWall = (epoch: number, frame: number) => Number(playingBlock(epoch, frame)?.wallMs)
  const rawFrame = (epoch: number, frame: number) => {
    const entry = playingBlock(epoch, frame)
    return Number(entry?.offset) + frame - Number(entry?.transportFrame)
  }
  if (defect === "playing-gap") samples.fill(0, rawFrame(resumedEpoch, 600_000) * channels, (rawFrame(resumedEpoch, 600_000) + 64) * channels)
  if (defect === "pcm-discontinuity") {
    const at = rawFrame(3, 200_000)
    samples.copyWithin(at * channels, (at + block) * channels, (at + block * 2) * channels)
  }
  if (defect === "resume-click") for (let frame = 0; frame < 50; frame++) samples[(rawFrame(resumedEpoch, resumeFrame) + frame) * channels] = 0
  if (defect === "left-one-sample") {
    const at = rawFrame(resumedEpoch, 600_000) * channels
    samples[at] = (samples[at] ?? 0) + 2 ** -20
  }
  const publishWall = blockWall(3, fftFrame), releaseWall = blockWall(3, releaseFrame)
  const resumeWall = wallAt(segments.slice(0, 3).reduce((sum, segment) => sum + segment.blocks, 0)) - 1
  const endWall = wallAt(totalBlocks) + 1
  const holdWall = wallAt(segments.slice(0, 2).reduce((sum, segment) => sum + segment.blocks, 0) + 8)
  const pauseEvents = defect === "cold-resume-new-epoch" ? ["device-stop", "device-start-request"]
    : defect === "warm-resume-across-stop" ? ["device-stop"] : defect === "warm-resume-across-configure" ? ["device-configure"]
    : defect === "resume-across-capture-configure" ? ["capture-configure"] : []
  host.push({ event: "graph-publish-request", requestedRevision: 2, wallMs: publishWall - 1 },
    ...(defect === "publish-missing" ? [] : [{ event: "graph-publish", pid: 1, revision: 2, transportEpoch: 3,
      publicationFrame: fftFrame, publicationEpoch: 190,
      cause: defect === "publish-configured-boundary" ? "configured-boundary" : "block-boundary", wallMs: publishWall }]),
    { event: "capture-complete", pid: 1, captureId: 2, frames: offset, failed: false,
      overflowFrames: defect === "capture-overflow" ? block : 0, wallMs: endWall + 1 },
    ...(defect === "cold-rebuild" ? [{ event: "structural-rebuild", pid: 1, cause: "device-configure", wallMs: blockWall(3, 150_000) }] : []),
    ...pauseEvents.map((event) => ({ event, pid: 1, wallMs: holdWall })))
  const editStart = blockWall(3, 96_000) - 1
  const restored = defect === "restored-draft" ? 0 : targetDb
  const persistedGainDb = defect === "restored-persisted" ? 0 : targetDb
  // The post-reload offline export carries the persisted gain behind the 4096 FFT, and compensates the left by it.
  const finalReference = reference(18, false, 4096)
  for (let frame = 4096; frame < 18 * sampleRate; frame++) finalReference.samples[frame * channels + 1] =
    (rightSource.samples[(frame - 4096) * channels + 1] ?? 0) * 10 ** ((defect === "export-gain-lost" ? 0 : persistedGainDb) / 20)
  return {
    plan: { phase: 5, row: "effect-state", editStart, endFrame, effectState: { trackId: "track:effect-state",
      fromLatencyFrames: 512, toLatencyFrames: 4096, fftAfterFrame: 96_000, dragAfterFrame: dragFrame,
      previewFromFrame: previewFrom, releaseAfterFrame: releaseFrame,
      pausedFrame: defect === "warm-resume-wrong-frame" ? holdFrame - block / 4 : holdFrame,
      knob: { before: 0, paused: restored, resumed: restored, end: restored } } },
    host,
    actions: [{ event: "capture-start", wallMs: 999 }, { event: "phase5-edit-start", wallMs: editStart },
      { event: "effect-fft-edit", wallMs: editStart }, { event: "effect-gain-drag", wallMs: blockWall(3, dragFrame) },
      { event: "effect-resume", wallMs: resumeWall }, { event: "capture-end", wallMs: endWall }],
    capture: { sampleRate, channels, samples }, leftReference, rightSource, finalReference,
    progress: { progress, release: { wallMs: releaseWall, dragEnded: true, knobDb: targetDb },
      pause: { wallMs: defect === "stamps-misordered" ? releaseWall - 1 : releaseWall } },
    persistedGainDb,
  }
}

export const phase5EffectStateSyntheticProof = () => {
  const clean = checkPhase5EffectState(phase5EffectStateEvidence())
  const defects = Object.fromEntries(phase5EffectStateDefects.map((defect) => {
    const { checks } = checkPhase5EffectState(phase5EffectStateEvidence(defect))
    const intended = effectStateIntendedCheck[defect]
    return [defect, { rejected: !checks[intended], intended,
      failed: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name) }]
  }))
  if (!clean.passed || Object.values(defects).some((entry) => !entry.rejected))
    throw new Error(`Phase 5 effect-state synthetic oracle failed: ${JSON.stringify({ clean: clean.checks, defects })}`)
  return { clean: clean.passed, checks: Object.keys(clean.checks).length, defects }
}

// add-paged-asset admits one silent track-only publication before the asset's. Each defect below must still fail the
// row on its publication count, and both clean shapes must pass.
export const phase5AddPagedAssetDefects = ["audible-early-publication", "two-extra-publications",
  "extra-after-asset-publication", "early-publication-installs-asset"] as const
type AddPagedAssetCase = (typeof phase5AddPagedAssetDefects)[number] | "single-publication" | "track-only-publication"

// One small packaged-shaped capture: the retained source on the left, and the imported asset entering the right
// channel at the asset publication, which is the last one.
const phase5AddPagedAssetEvidence = (variant: AddPagedAssetCase): Phase5Evidence => {
  const sampleRate = 8000, block = 64, channels = 2, endFrame = 6 * sampleRate, pid = 1, captureId = 1, epoch = 3
  const wall = (frame: number) => 1_000_000 + frame / sampleRate * 1000
  const retained = (frame: number) => 0.08 + 0.025 * Math.sin(frame * 0.027)
  const asset = (frame: number) => 0.07 * Math.sin(frame * 0.039)
  const seams = variant === "single-publication" ? [28_032] : variant === "two-extra-publications"
    ? [16_000, 20_032, 28_032] : [20_032, 28_032]
  const first = seams[0] ?? 0, last = seams.at(-1) ?? 0
  const assetFrom = variant === "extra-after-asset-publication" ? first : last
  const pcm = (sample: (frame: number, channel: number) => number): Pcm => {
    const samples = new Float32Array(endFrame * channels)
    for (let frame = 0; frame < endFrame; frame++)
      for (let channel = 0; channel < channels; channel++) samples[frame * channels + channel] = sample(frame, channel)
    return { sampleRate, channels, samples }
  }
  const early = (frame: number) => frame >= first && frame < last
  const files = new Map([
    ["initial-reference.wav", pcm((frame, channel) => channel === 0 ? retained(frame) : 0)],
    ["final-reference.wav", pcm((frame, channel) => channel === 0 ? retained(frame) : asset(frame))],
    [`output-${pid}-${captureId}.wav`, pcm((frame, channel) => channel === 0
      // An audible track or mixer change: the new track's publication moves the retained source's level.
      ? retained(frame) * (variant === "audible-early-publication" && early(frame) ? 0.5 : 1)
      : frame >= assetFrom ? asset(frame)
      // The early publication carries the asset, so its audio starts from that publication's frame.
      : variant === "early-publication-installs-asset" && early(frame) ? asset(frame - first) : 0)],
  ])
  const revisionAt = (frame: number) => 1 + seams.filter((seam) => seam <= frame).length
  return {
    plan: { phase: 5, row: "add-paged-asset", editStart: wall(12_000), commits: [{ wallMs: wall(24_000), revision: 2 }],
      endFrame, sameTrackId: true },
    actions: [{ event: "capture-end", wallMs: wall(endFrame) }],
    host: [
      ...Array.from({ length: endFrame / block }, (_, index): Entry => ({ event: "capture-block", pid, captureId,
        transportEpoch: epoch, transportFrame: index * block, offset: index * block, frames: block,
        revision: revisionAt(index * block), wallMs: wall(index * block) })),
      ...seams.flatMap((seam, index): Entry[] => [
        { event: "graph-publish-request", pid, transportEpoch: epoch, requestedRevision: index + 2, wallMs: wall(seam) - 1 },
        { event: "graph-publish", pid, cause: "block-boundary", revision: index + 2, transportEpoch: epoch,
          publicationFrame: seam, publicationEpoch: String(100 + index), wallMs: wall(seam) },
      ]),
      { event: "capture-complete", pid, captureId, frames: endFrame, overflowFrames: 0, failed: false, wallMs: wall(endFrame) + 1 },
    ],
    wav: async (name) => {
      const file = files.get(name)
      if (!file) throw new Error(`Missing synthetic ${name}`)
      return file
    },
  }
}

export const phase5AddPagedAssetSyntheticProof = async () => {
  const single = await checkPhase5(phase5AddPagedAssetEvidence("single-publication"))
  const trackOnly = await checkPhase5(phase5AddPagedAssetEvidence("track-only-publication"))
  const defects: Record<string, { rejected: boolean; intended: "supportedPublicationCount"; failed: string[] }> = {}
  for (const defect of phase5AddPagedAssetDefects) {
    const result = await checkPhase5(phase5AddPagedAssetEvidence(defect))
    defects[defect] = { rejected: !result.passed && !result.checks.supportedPublicationCount, intended: "supportedPublicationCount",
      failed: Object.entries(result.checks).filter(([, ok]) => !ok).map(([name]) => name) }
  }
  if (!single.passed || !trackOnly.passed || Object.values(defects).some((entry) => !entry.rejected))
    throw new Error(`Phase 5 add-paged-asset synthetic oracle failed: ${JSON.stringify({ single: single.checks,
      trackOnly: trackOnly.checks, defects })}`)
  return { singlePublication: single.passed, trackOnlyPublication: trackOnly.passed, defects }
}

export const analyzePhase5EffectState = async (directory: string) => {
  const synthetic = phase5EffectStateSyntheticProof()
  const plan = effectStatePlanSchema.parse(JSON.parse(await readFile(path.join(directory, "phase5-edits.json"), "utf8")))
  const host = await jsonl(path.join(directory, "host.jsonl"))
  const owner = effectStateOwner(host, plan.editStart)
  if (!owner) throw new Error("No measured native capture blocks")
  const snapshot = z.object({ processors: z.array(z.object({ target: z.object({ trackId: z.string().optional() }),
    processor: z.object({ kind: z.string(), params: z.json() }) })) })
    .parse(JSON.parse(await readFile(path.join(directory, "final-snapshot.json"), "utf8")))
  const utility = snapshot.processors.find((entry) => entry.target.trackId === plan.effectState.trackId && entry.processor.kind === "utility")
  const result = checkPhase5EffectState({ plan, host,
    actions: await jsonl(path.join(directory, "actions.jsonl")),
    capture: await readWav(path.join(directory, `output-${owner.pid}-${owner.captureId}.wav`)),
    leftReference: await readWav(path.join(directory, "initial-reference.wav")),
    rightSource: await readWav(path.join(directory, "changed.wav")),
    finalReference: await readWav(path.join(directory, "final-reference.wav")),
    progress: effectStateProgressSchema.parse(JSON.parse(await readFile(path.join(directory, "effect-state-progress.json"), "utf8"))),
    persistedGainDb: z.object({ state: z.object({ gainDb: z.number() }) }).safeParse(utility?.processor.params).data?.state.gainDb })
  const analysis = { phase: 5, row: plan.row, ...result, verdict: `PHASE 5 ${result.passed ? "PASS" : "FAIL"}: ${plan.row}`,
    synthetic, analyzerSha256: createHash("sha256").update(await readFile(import.meta.filename)).digest("hex") }
  await writeFile(path.join(directory, "analysis.json"), JSON.stringify(analysis, null, 2))
  return analysis
}
export const analyzePhase5Campaign = async (directory: string, selected: readonly string[] = phase5Rows) => {
  const campaign = z.object({ phase: z.literal(5), rows: z.array(z.object({ row: z.string(), failure: z.string().optional() })) })
    .parse(JSON.parse(await readFile(path.join(directory, "phase5-campaign.json"), "utf8")))
  const rows = []
  for (const row of selected) {
    const declared = campaign.rows.find((entry) => entry.row === row)
    try {
      if (!declared || declared.failure) throw new Error(declared?.failure ?? "Missing required row")
      rows.push(await (row === "effect-state" ? analyzePhase5EffectState : analyzePhase5)(path.join(directory, row)))
    } catch (error) {
      rows.push({ row, passed: false, failure: error instanceof Error ? error.message : String(error) })
    }
  }
  const passed = rows.every((row) => row.passed)
  const analysis = { phase: 5, passed, verdict: `PHASE 5 PACKAGED ${passed ? "PASS" : "FAIL"}: ${rows.filter((row) => row.passed).length}/${selected.length} rows`, rows }
  await writeFile(path.join(directory, "analysis.json"), JSON.stringify(analysis, null, 2))
  await writeFile(path.join(directory, "verdict.md"), `# AE-08 phase 5\n\n${analysis.verdict}\n`)
  return analysis
}

if (import.meta.main && Bun.argv[2] === "--self-test") {
  console.log(JSON.stringify({ phase4: phase4SyntheticProof(), legacy: syntheticProof(),
    phase5EffectState: phase5EffectStateSyntheticProof(), phase5AddPagedAsset: await phase5AddPagedAssetSyntheticProof() }, null, 2))
} else if (import.meta.main) {
  if (Bun.argv[2] === "--run" && Bun.argv[3] && await Bun.file(path.join(Bun.argv[3], "phase5-campaign.json")).exists()) {
    const result = await analyzePhase5Campaign(Bun.argv[3])
    console.log(result.verdict)
    if (!result.passed) process.exitCode = 1
    process.exit()
  }
  if (Bun.argv[2] === "--run" && Bun.argv[3] && await Bun.file(path.join(Bun.argv[3], "phase4-campaign.json")).exists()) {
    const result = await analyzePhase4Campaign(Bun.argv[3])
    console.log(result.verdict)
    if (!result.passed) process.exitCode = 1
    process.exit()
  }
  const phase3 = Bun.argv[2] === "--phase-3-run"
  if ((Bun.argv[2] !== "--run" && !phase3) || !Bun.argv[3] || !path.isAbsolute(Bun.argv[3]) || Bun.argv.length !== 4)
    throw new Error("Usage: analyze-ae-08-continuity.ts --run|--phase-3-run /absolute/run")
  if (phase3) {
    const accepted = await analyzePhase3(Bun.argv[3])
    console.log(accepted.verdict)
    if (!accepted.passed) process.exitCode = 1
    process.exit()
  }
  const result = await analyzeRun(Bun.argv[3])
  console.log(result.verdict)
  if (result.captureFailures.length || !result.editFreeCapture.passed) process.exitCode = 1
}
