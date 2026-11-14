#!/usr/bin/env bun
import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { z } from "zod"
import { readWav, type Pcm } from "./ae08-wav"
import { phase8Rows } from "./ae-08-phase-8-fixture"
import { rawCaptureOffsetsValid } from "./analyze-ae-08-continuity"

// Phase 8 (C2): a structural edit is adopted by the live host, playing or paused. The verdict comes from host.jsonl:
// one spawn and one exit at quit, one device identity before and after the edit, no stop/start/configure/rebuild event
// from the edit through capture-end, and rising published revisions. A stable PID alone cannot pass; the capture must
// also be audible after the edit (and gap-free when the edit lands mid-playback).
type Entry = Record<string, z.infer<ReturnType<typeof z.json>>>
const jsonl = async (file: string): Promise<Entry[]> => (await readFile(file, "utf8")).trim().split("\n")
  .filter(Boolean).map((line) => z.record(z.string(), z.json()).parse(JSON.parse(line)))

const planSchema = z.object({ phase: z.literal(8), row: z.string(), editStart: z.number(), editEnd: z.number(),
  pausedFrame: z.number().int().nullable(), committedRevision: z.number() })
type Plan = z.infer<typeof planSchema>
type Evidence = { plan: Plan; host: Entry[]; actions: Entry[]; wav: (name: string) => Promise<Pcm> }

const lifecyclePattern = /stop|teardown|start|rebuild|host-exit|host-spawn|device-configure/i
const rms = (pcm: Pcm, from: number, to: number) => {
  let square = 0
  for (let frame = from; frame < to; frame++) square += (pcm.samples[frame * pcm.channels] ?? NaN) ** 2
  return Math.sqrt(square / Math.max(1, to - from))
}

export const checkPhase8 = async ({ plan, host, actions, wav }: Evidence) => {
  const wall = (event: string) => Number(actions.find((entry) => entry.event === event)?.wallMs)
  const end = wall("capture-end"), quit = wall("quit-request")
  const spawns = host.filter((entry) => entry.event === "host-spawn")
  const window = host.filter((entry) => Number(entry.wallMs) >= plan.editStart && Number(entry.wallMs) <= end)
  const sessions = host.filter((entry) => entry.event === "device-session" && Number(entry.wallMs) < plan.editStart)
  const current = sessions.at(-1)
  const publications = window.filter((entry) => entry.event === "graph-publish")
  const lifecycle = window.filter((entry) => lifecyclePattern.test(String(entry.event)))
  const blocks = host.filter((entry) => entry.event === "capture-block" && Number(entry.wallMs) <= end)
  const owner = blocks.at(-1)
  if (!owner) throw new Error("No native capture blocks")
  const pcm = await wav(`output-${owner.pid}-${owner.captureId}.wav`)
  // Every block of the capture, including those after capture-end: the WAV and completion count them all.
  const ownerBlocks = host.filter((entry) => entry.event === "capture-block" && entry.pid === owner.pid && entry.captureId === owner.captureId)
  const complete = host.find((entry) => entry.event === "capture-complete" && entry.pid === owner.pid && entry.captureId === owner.captureId)
  const frames = pcm.samples.length / pcm.channels, second = pcm.sampleRate
  const windowFrames = Math.round(pcm.sampleRate * 0.01)
  const levels: number[] = []
  for (let from = second / 2; from + windowFrames <= frames - second / 2; from += windowFrames) levels.push(rms(pcm, from, from + windowFrames))
  const median = levels.toSorted((a, b) => a - b)[Math.floor(levels.length / 2)] ?? 0
  const blockFrames = Math.max(...ownerBlocks.map((entry) => Number(entry.frames)))
  const resumeWall = wall("phase8-resume")
  // The first block that moves off the held pause frame must continue from it, not restart or skip.
  const resumed = blocks.find((entry) => Number(entry.wallMs) >= resumeWall && Number(entry.transportFrame) !== plan.pausedFrame)
  const checks = {
    singleHost: spawns.length === 1 && spawns[0]?.cause === "supervisor-start"
      && !host.some((entry) => entry.event === "host-exit" && Number(entry.wallMs) < quit),
    // Startup may open and replace a device before the measured Play; the session live at the edit is the one to keep.
    deviceIdentityUnchanged: current !== undefined && !window.some((entry) => entry.event === "device-session"),
    noLifecycleEvent: lifecycle.length === 0,
    publishedInPlace: publications.length >= 1 && publications.length <= 2
      && publications.every((entry, index) => entry.pid === spawns[0]?.pid
        && (index === 0 || Number(entry.revision) > Number(publications[index - 1]?.revision))
        && window.some((request) => request.event === "graph-publish-request" && request.requestedRevision === entry.revision)),
    captureIntegrity: rawCaptureOffsetsValid(ownerBlocks, frames, complete) && complete?.failed === false && complete.overflowFrames === 0,
    audibleAfterEdit: rms(pcm, frames - second, frames) > 0.02,
    gapFree: plan.pausedFrame !== null || (median > 0.02 && levels.every((level) => level >= median * 0.5)),
    resumesAtPause: plan.pausedFrame === null
      || (resumed !== undefined && Number(resumed.transportFrame) > plan.pausedFrame
        && Number(resumed.transportFrame) - plan.pausedFrame <= 8 * blockFrames),
  }
  const passed = Object.values(checks).every(Boolean)
  return { phase: 8, row: plan.row, passed, verdict: `PHASE 8 ${passed ? "PASS" : "FAIL"}: ${plan.row}`, checks,
    spawns: spawns.length, deviceSession: current?.deviceSession ?? null,
    publications: publications.map((entry) => ({ revision: entry.revision, cause: entry.cause, publicationFrame: entry.publicationFrame })),
    lifecycle, owner: { pid: owner.pid, captureId: owner.captureId } }
}

export const analyzePhase8 = async (directory: string) => {
  const plan = planSchema.parse(JSON.parse(await readFile(path.join(directory, "phase8-edits.json"), "utf8")))
  const analysis = { ...await checkPhase8({ plan, host: await jsonl(path.join(directory, "host.jsonl")),
    actions: await jsonl(path.join(directory, "actions.jsonl")), wav: (name) => readWav(path.join(directory, name)) }),
    analyzerSha256: createHash("sha256").update(await readFile(import.meta.filename)).digest("hex") }
  await writeFile(path.join(directory, "analysis.json"), JSON.stringify(analysis, null, 2))
  return analysis
}

// A subset analyses the rows it ran and is never a campaign verdict; only every row, once, can pass the campaign.
export const analyzePhase8Campaign = async (directory: string, rows: readonly string[] = phase8Rows) => {
  const campaign = z.object({ phase: z.literal(8), rows: z.array(z.object({ row: z.string(), failure: z.string().optional() })) })
    .parse(JSON.parse(await readFile(path.join(directory, "phase8-campaign.json"), "utf8")))
  const results = []
  for (const row of rows) {
    const declared = campaign.rows.find((entry) => entry.row === row)
    try {
      if (!declared || declared.failure) throw new Error(declared?.failure ?? "Missing required row")
      results.push(await analyzePhase8(path.join(directory, row)))
    } catch (error) {
      results.push({ row, passed: false, failure: error instanceof Error ? error.message : String(error) })
    }
  }
  const passed = results.every((row) => row.passed)
  const complete = phase8Rows.every((row) => rows.includes(row))
  const analysis = { phase: 8, passed, certifying: complete,
    verdict: `PHASE 8 PACKAGED ${passed ? "PASS" : "FAIL"}${complete ? "" : " (NON-CERTIFYING subset)"}: ${results.filter((row) => row.passed).length}/${rows.length} rows`,
    rows: results }
  await writeFile(path.join(directory, "analysis.json"), JSON.stringify(analysis, null, 2))
  await writeFile(path.join(directory, "verdict.md"), `# AE-08 phase 8\n\n${analysis.verdict}\n`)
  return analysis
}

export const phase8Defects = ["second-spawn", "second-device-session", "lifecycle-in-window", "no-publication",
  "revision-regress", "publication-not-requested", "silent-after-edit", "playing-gap", "resume-elsewhere"] as const
type Phase8Defect = (typeof phase8Defects)[number]
const phase8Intended = {
  "second-spawn": "singleHost", "second-device-session": "deviceIdentityUnchanged", "lifecycle-in-window": "noLifecycleEvent",
  "no-publication": "publishedInPlace", "revision-regress": "publishedInPlace", "publication-not-requested": "publishedInPlace",
  "silent-after-edit": "audibleAfterEdit", "playing-gap": "gapFree", "resume-elsewhere": "resumesAtPause",
} satisfies Record<Phase8Defect, keyof Awaited<ReturnType<typeof checkPhase8>>["checks"]>

// A small packaged-shaped run: 6 s of a steady source in one capture, the edit at 3 s (paused rows pause at 2 s and
// resume after the edit), and one published revision.
export const phase8Evidence = (row: string, defect?: Phase8Defect): Evidence => {
  const sampleRate = 8000, block = 64, endFrame = 6 * sampleRate, pid = 1, captureId = 1
  const paused = row === "paused-structural", pausedFrame = 2 * sampleRate
  const wall = (frame: number) => 1_000_000 + frame / sampleRate * 1000
  const editStart = wall(3 * sampleRate), editEnd = wall(3 * sampleRate + 400)
  const gapFrom = 4 * sampleRate, gapTo = gapFrom + 200
  const samples = new Float32Array(endFrame * 2)
  for (let frame = 0; frame < endFrame; frame++) {
    const silent = (defect === "playing-gap" && frame >= gapFrom && frame < gapTo) || (defect === "silent-after-edit" && frame > 3 * sampleRate)
    samples[frame * 2] = silent ? 0 : 0.08 + 0.025 * Math.sin(frame * 0.027)
  }
  const revisions = defect === "revision-regress" ? [3, 2] : defect === "no-publication" ? [] : [2]
  const resumeWall = editEnd + 100
  const resumeFrame = defect === "resume-elsewhere" ? pausedFrame + 40 * block : pausedFrame
  // Paused rows hold the pause frame from 2 s to the resume, then advance from it.
  const transportFrame = (index: number) => !paused || index * block < pausedFrame ? index * block
    : wall(index * block) < resumeWall ? pausedFrame
      : resumeFrame + Math.round((wall(index * block) - resumeWall) * sampleRate / 1000) + block
  return {
    plan: { phase: 8, row, editStart, editEnd, pausedFrame: paused ? pausedFrame : null, committedRevision: 3 },
    actions: [{ event: "capture-start", wallMs: wall(0) }, { event: "phase8-resume", wallMs: resumeWall }, { event: "capture-end", wallMs: wall(endFrame) },
      { event: "quit-request", wallMs: wall(endFrame) + 100 }],
    host: [
      { event: "host-spawn", pid, cause: "supervisor-start", wallMs: wall(0) - 10 },
      ...(defect === "second-spawn" ? [{ event: "host-spawn", pid: 2, cause: "supervisor-start", wallMs: wall(3 * sampleRate + 50) }] : []),
      { event: "device-session", pid, deviceSession: "device-1", sampleRate: 48000, blockSize: 512, wallMs: wall(0) },
      ...(defect === "second-device-session" ? [{ event: "device-session", pid, deviceSession: "device-1", sampleRate: 48000, blockSize: 512, wallMs: wall(3 * sampleRate + 50) }] : []),
      ...(defect === "lifecycle-in-window" ? [{ event: "device-stop", pid, wallMs: wall(3 * sampleRate + 50) }] : []),
      ...Array.from({ length: endFrame / block }, (_, index) => ({ event: "capture-block", pid, captureId,
        transportEpoch: 1, transportFrame: transportFrame(index),
        offset: index * block, frames: block, revision: 1, wallMs: wall(index * block) })),
      ...revisions.flatMap((revision, index): Entry[] => [
        ...(defect === "publication-not-requested" ? [] : [{ event: "graph-publish-request", pid, requestedRevision: revision, wallMs: wall(3 * sampleRate + 100 + index) }]),
        { event: "graph-publish", pid, cause: "block-boundary", revision, publicationFrame: 3 * sampleRate + 128, wallMs: wall(3 * sampleRate + 120 + index) },
      ]),
      { event: "capture-complete", pid, captureId, frames: endFrame, overflowFrames: 0, failed: false, wallMs: wall(endFrame) + 1 },
      { event: "host-exit", pid, wallMs: wall(endFrame) + 200 },
    ],
    wav: async () => ({ sampleRate, channels: 2, samples }),
  }
}

export const phase8SyntheticProof = async () => {
  const clean: Record<string, boolean> = {}
  const defects: Record<string, { rejected: boolean; intended: string; failed: string[] }> = {}
  for (const row of phase8Rows) {
    clean[row] = (await checkPhase8(phase8Evidence(row))).passed
    for (const defect of phase8Defects) {
      if (defect === "playing-gap" && row !== "playing-structural" || defect === "resume-elsewhere" && row !== "paused-structural") continue
      const result = await checkPhase8(phase8Evidence(row, defect))
      const intended = phase8Intended[defect]
      defects[`${row}:${defect}`] = { rejected: !result.passed && !result.checks[intended], intended,
        failed: Object.entries(result.checks).filter(([, ok]) => !ok).map(([name]) => name) }
    }
  }
  if (Object.values(clean).some((ok) => !ok) || Object.values(defects).some((entry) => !entry.rejected))
    throw new Error(`Phase 8 synthetic oracle failed: ${JSON.stringify({ clean, defects })}`)
  return { clean, defects }
}

if (import.meta.main) {
  if (Bun.argv[2] === "--self-test") console.log(JSON.stringify(await phase8SyntheticProof(), null, 2))
  else if (Bun.argv[2] === "--run" && Bun.argv[3] && path.isAbsolute(Bun.argv[3]) && Bun.argv.length === 4) {
    const result = await analyzePhase8Campaign(Bun.argv[3])
    console.log(result.verdict)
    if (!result.passed) process.exitCode = 1
  } else throw new Error("Usage: analyze-ae-08-phase-8.ts --self-test | --run /absolute/phase8/out")
}
