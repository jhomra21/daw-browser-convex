import path from "node:path"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { z } from "zod"
import type { ProjectSnapshotV2 } from "@daw-browser/control"
import { createDefaultSpectralParams, getSpectralLatencyFrames } from "@daw-browser/shared"
import { command } from "../performance/30-track/v3-import-workload"
import { deleteTrackThroughUi, pressHistoryKey, selectFftSize, setupPhase5Fixture, waitForUi, waitImportedClip,
  waitNativeFrame, type Phase5Context } from "./ae-08-phase-5-fixture"
import { burstSchedule, judgeStored, MIN_WINDOW_MS, phase9Matrix, parseHostLines, repetitionsFor, runBurst, type Perform, type Row, type Timings } from "./ae-08-phase-9-matrix"

// One packaged launch of phase 9: the row's phase 5 start state, then either a burst of its edits (settled on host evidence) or the
// same timeline with no edits (a reference, or the calibration duplicate of one). Edits go through the public control actions or the
// UI steps phase 5 already uses; there is no second protocol.
const sampleRate = 48000
const warmupFrames = sampleRate * 2
const ref = (id: string) => ({ source: "persisted", id })
const move = (fromLatencyFrames: number, toLatencyFrames: number) => ({ fromLatencyFrames, toLatencyFrames })
const unmoved = move(0, 0)
const spectralFrames = (fftSize: 512 | 4096) => getSpectralLatencyFrames(fftSize, createDefaultSpectralParams().overlap)
const silentTrack = "Silent publication target"
// Native progress frames are lower bounds on what has been heard, so a window is closed this long after its second.
const windowMarginMs = 250

export type Phase9Launch =
  | { role: "burst"; rows: Row[]; repetitions: number; vstRepetitions: number; directory: string; contentSeconds: number }
  | { role: "reference" | "calibration"; rows: Row[]; frames: number; contentSeconds: number }

// The ids a performer needs from the project; `observe` reads them from a fresh snapshot, so a performer never holds a stale one.
export type Observed = { spectralEffectId: string | undefined; trackId: (name: string) => string | undefined; clipId: (name: string) => string | undefined }
export const observeSnapshot = (state: ProjectSnapshotV2, changedTrackId: string): Observed => ({
  spectralEffectId: state.processors.find((entry) => "trackId" in entry.target && entry.target.trackId === changedTrackId && entry.processor.kind === "spectral")?.id,
  trackId: (name) => state.tracks.find((track) => track.name === name)?.id,
  clipId: (name) => state.clips.find((clip) => clip.name.includes(name))?.id,
})

type Performers = {
  context: Pick<Phase5Context, "mutate" | "evaluate" | "interact">
  runtime: (args: string[]) => Promise<void>
  observe: () => Promise<Observed>
  setup: { changedTrackId: string; changedFile: string }
}
const required = (id: string | undefined, what: string) => {
  if (id === undefined) throw new Error(`${what} missing`)
  return id
}

// The edit names of the built rows (ae-08-phase-9-matrix.ts) and what each does. Each returns the latency move it declares.
export const createPerformer = ({ context, runtime, observe, setup }: Performers): Perform => {
  const { mutate } = context
  const target = { kind: "track", track: ref(setup.changedTrackId) }
  const changedClip = (present: boolean) => waitForUi(context, `Changed clip ${present ? "not restored" : "not removed"} in the UI`,
    `${present ? "" : "!"}[...document.querySelectorAll('[data-timeline-clip]')].some(e=>e.getAttribute('title')?.includes('changed'))`)
  const settings = (tempoBpm: number) => async () => { await mutate([{ kind: "project.settings.set", tempoBpm }]); return unmoved }
  const fft = (from: 512 | 4096, to: 512 | 4096) => async () => { await selectFftSize(context, to); return move(spectralFrames(from), spectralFrames(to)) }
  const history = (redo: boolean, clipPresent: boolean) => async () => { await pressHistoryKey(context, redo); await changedClip(clipPresent); return unmoved }
  const deleteImportedClip = async () => {
    await mutate([{ kind: "clip.delete", clip: ref(required((await observe()).clipId("changed"), "Imported changed clip")) }])
    await changedClip(false)
    return unmoved
  }
  const performers = new Map([
    ["fft-4096", fft(512, 4096)],
    ["fft-512", fft(4096, 512)],
    ["spectral-remove", async () => {
      await mutate([{ kind: "effect.remove", target, effectKind: "spectral", effect: ref(required((await observe()).spectralEffectId, "Spectral device")) }])
      return move(spectralFrames(512), 0)
    }],
    ["spectral-attach", async () => {
      await mutate([{ kind: "effect.upsert", target, effectKind: "spectral",
        params: { version: 1, state: { ...createDefaultSpectralParams(), fftSize: 512, mix: 1 } } }])
      return move(0, spectralFrames(512))
    }],
    ["track-delete", async () => { await deleteTrackThroughUi(context, "Changed right"); await changedClip(false); return unmoved }],
    ["undo", history(false, true)],
    ["redo", history(true, false)],
    ["asset-import", async () => { await runtime(["import", "--path", setup.changedFile]); await waitImportedClip(context, "changed"); return unmoved }],
    ["asset-clip-delete", deleteImportedClip],
    ["silent-track-create", async () => { await mutate([{ kind: "track.create", name: silentTrack, trackKind: "audio" }]); return unmoved }],
    ["silent-track-delete", async () => {
      await mutate([{ kind: "track.delete", track: ref(required((await observe()).trackId(silentTrack), silentTrack)) }])
      return unmoved
    }],
    ["tempo-137", settings(137)],
    ["tempo-120", settings(120)],
  ])
  return async (edit) => {
    const perform = performers.get(edit)
    if (!perform) throw new Error(`No phase 9 performer for ${edit}`)
    return perform()
  }
}

// The playing content must outlast the longest merged burst, with the assumed edit time doubled for slack and a tail for the last window.
export const contentSecondsFor = (rows: readonly Row[], repetitions: number, vstRepetitions: number, timings: Timings) =>
  Math.max(24, Math.ceil(rows.reduce((total, row) => total + burstSchedule(row, repetitionsFor(row, repetitions, vstRepetitions)).length
    * 2 * (row.repeat === "vst-burst" ? timings.vstStepSeconds : timings.stepSeconds), 0)) + 30)

// Phase 5 fixtures name a row ("phase5:effect-state"); a launch's merged rows share one.
const fixtureRow = (rows: readonly Row[]) => {
  const names = new Set(rows.map((row) => row.fixture))
  const [only] = names
  if (names.size !== 1 || !only?.startsWith("phase5:")) throw new Error(`A phase 9 launch needs one phase 5 fixture, got ${[...names].join(", ")}`)
  return only.slice("phase5:".length)
}

export const runPhase9Launch = async (context: Phase5Context, launch: Phase9Launch) => {
  const { out, profile, mark } = context
  const runtime = (args: string[]) => command(profile, ["host", ...args])
  const setup = await setupPhase5Fixture({ ...context, row: fixtureRow(launch.rows), contentSeconds: launch.contentSeconds })
  await runtime(["seek", "0"])
  await mark("capture-start")
  const playWallMs = Date.now()
  await runtime(["play"])
  await waitNativeFrame(context, warmupFrames)
  if (launch.role === "burst") {
    const perform = createPerformer({ context, runtime: async (args) => { await runtime(args) }, setup: { changedTrackId: setup.changedTrack.id, changedFile: setup.changedFile },
      observe: async () => observeSnapshot(await context.snapshot(), setup.changedTrack.id) })
    for (const row of launch.rows) {
      const logged = await runBurst({ out, directory: path.join(launch.directory, row.name), row, perform, mark,
        repetitions: repetitionsFor(row, launch.repetitions, launch.vstRepetitions) })
      // The last edit's window needs its second (and the next row's first window starts after it), so hold until the transport
      // has rendered that far. The transport started at frame 0 at playWallMs.
      const lastSettled = logged.at(-1)?.settledWallMs
      if (lastSettled !== undefined) await waitNativeFrame(context, Math.ceil((lastSettled + MIN_WINDOW_MS + windowMarginMs - playWallMs) * sampleRate / 1000))
    }
  } else await waitNativeFrame(context, launch.frames)
  await mark("capture-end")
  await writeFile(path.join(out, "diagnostics-active.json"), JSON.stringify(await runtime(["diagnostics-v2"]), null, 2))
  await runtime(["stop"])
}

// ---- Per-row evidence in the shape ae-08-latency-gates.ts reads: <run>/phase9/<row>/{host,actions,phase9-edits,latency-class} ----
const edits = z.object({ edits: z.array(z.object({ wallMs: z.number() })) })
const lines = async (file: string) => (await readFile(file, "utf8")).split("\n").filter(Boolean)

// A merged launch's host.jsonl holds every row's publications, so each row keeps the events from its first step to the next row's
// first step (and every device-session line, which the gates need), and its capture ends where the next row's first step begins.
export const exportRowEvidence = async (launchOut: string, directory: string, rows: readonly Row[]) => {
  const starts = await Promise.all(rows.map(async (row) => edits.parse(JSON.parse(await readFile(path.join(directory, row.name, "phase9-edits.json"), "utf8")))
    .edits.reduce((first, edit) => Math.min(first, edit.wallMs), Number.POSITIVE_INFINITY)))
  const host = await lines(path.join(launchOut, "host.jsonl"))
  const events = parseHostLines(host.join("\n") + "\n")
  const actions = await lines(path.join(launchOut, "actions.jsonl"))
  for (const [position, row] of rows.entries()) {
    const from = starts[position] ?? Number.POSITIVE_INFINITY, to = starts[position + 1] ?? Number.POSITIVE_INFINITY
    const inRow = (wallMs: number) => wallMs >= from && wallMs < to
    await writeFile(path.join(directory, row.name, "host.jsonl"), host.filter((_, index) => {
      const event = events[index]
      return event !== undefined && (event.event === "device-session" || inRow(event.wallMs))
    }).join("\n") + "\n")
    await writeFile(path.join(directory, row.name, "actions.jsonl"), actions.map((line) => {
      const action = z.object({ event: z.string() }).passthrough().parse(JSON.parse(line))
      return action.event === "capture-end" && to !== Number.POSITIVE_INFINITY ? JSON.stringify({ ...action, wallMs: to }) : line
    }).join("\n") + "\n")
  }
}

// ---- Self-test: each performer's request against a recorded fake context ----
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(`phase 9 launch self-test: ${message}`) }

export const selfTest = async () => {
  const calls: string[] = []
  const observed: Observed = { spectralEffectId: "spectral-1", trackId: (name) => name === silentTrack ? "silent-1" : undefined, clipId: (name) => name === "changed" ? "clip-1" : undefined }
  const perform = createPerformer({
    context: {
      mutate: async (actions) => { calls.push(`mutate ${JSON.stringify(actions)}`) },
      evaluate: async (script) => { calls.push(`evaluate ${script}`) },
      interact: async (args) => { calls.push(`interact ${args.join(" ")}`) },
    },
    runtime: async (args) => { calls.push(`runtime ${args.join(" ")}`) },
    observe: async () => observed,
    setup: { changedTrackId: "track-1", changedFile: "/tmp/changed.wav" },
  })
  const run = async (edit: string) => {
    calls.length = 0
    const moved = await perform(edit)
    return { moved, calls: [...calls] }
  }
  const spectral512 = spectralFrames(512), spectral4096 = spectralFrames(4096)
  check(spectral512 > 0 && spectral4096 > spectral512, "the Spectral latency grows with the FFT size")

  const tempo = await run("tempo-137")
  check(tempo.calls[0] === `mutate ${JSON.stringify([{ kind: "project.settings.set", tempoBpm: 137 }])}` && tempo.moved.toLatencyFrames === 0, `tempo-137: ${tempo.calls}`)
  check((await run("tempo-120")).calls[0] === `mutate ${JSON.stringify([{ kind: "project.settings.set", tempoBpm: 120 }])}`, "tempo-120")

  const raise = await run("fft-4096")
  check(raise.calls[0]?.includes("'4096'") === true || raise.calls[0]?.includes('"4096"') === true, `fft-4096 clicks the 4096 button: ${raise.calls[0]}`)
  check(raise.moved.fromLatencyFrames === spectral512 && raise.moved.toLatencyFrames === spectral4096, "fft-4096 declares 512 to 4096")
  const lower = await run("fft-512")
  check(lower.moved.fromLatencyFrames === spectral4096 && lower.moved.toLatencyFrames === spectral512, "fft-512 declares 4096 to 512")

  const remove = await run("spectral-remove")
  check(remove.calls[0] === `mutate ${JSON.stringify([{ kind: "effect.remove", target: { kind: "track", track: ref("track-1") }, effectKind: "spectral", effect: ref("spectral-1") }])}`,
    `spectral-remove names the observed Spectral: ${remove.calls[0]}`)
  check(remove.moved.fromLatencyFrames === spectral512 && remove.moved.toLatencyFrames === 0, "spectral-remove declares a lower to zero")
  const attach = await run("spectral-attach")
  check(attach.calls[0]?.includes('"kind":"effect.upsert"') === true && attach.calls[0]?.includes('"effectKind":"spectral"') === true && attach.calls[0]?.includes('"fftSize":512') === true,
    `spectral-attach upserts a 512 Spectral: ${attach.calls[0]}`)
  check(attach.moved.fromLatencyFrames === 0 && attach.moved.toLatencyFrames === spectral512, "spectral-attach declares a raise from zero")

  const create = await run("silent-track-create")
  check(create.calls[0] === `mutate ${JSON.stringify([{ kind: "track.create", name: silentTrack, trackKind: "audio" }])}`, "silent-track-create")
  const drop = await run("silent-track-delete")
  check(drop.calls[0] === `mutate ${JSON.stringify([{ kind: "track.delete", track: ref("silent-1") }])}`, "silent-track-delete names the observed track")

  const imported = await run("asset-import")
  check(imported.calls[0] === "runtime import --path /tmp/changed.wav", "asset-import imports the changed file")
  const deleted = await run("asset-clip-delete")
  check(deleted.calls[0] === `mutate ${JSON.stringify([{ kind: "clip.delete", clip: ref("clip-1") }])}`, "asset-clip-delete names the observed clip")

  const trackDelete = await run("track-delete")
  check(trackDelete.calls.some((call) => call.startsWith("interact find text Delete track click")), "track-delete opens the Delete track menu item")
  const undo = await run("undo"), redo = await run("redo")
  check(undo.calls[0]?.includes("shiftKey:false") === true && redo.calls[0]?.includes("shiftKey:true") === true, "undo and redo differ by shift")

  const rejected = await perform("no-such-edit").then(() => "performed", (error) => error instanceof Error ? error.message : "other")
  check(rejected === "No phase 9 performer for no-such-edit", `an unknown edit is refused, got ${rejected}`)

  // One merged launch's host.jsonl is split per row at each row's first step, and each row is judged from its own part.
  const [first, second] = [phase9Matrix.find((row) => row.name === "fft-transition"), phase9Matrix.find((row) => row.name === "raise-lower-burst")]
  if (!first || !second) throw new Error("phase 9 launch self-test: rows missing")
  const directory = await mkdtemp(path.join(tmpdir(), "ae08-phase9-export-"))
  try {
    const publication = (wallMs: number, publicationFrame: number) => ({ event: "graph-publish", cause: "block-boundary", wallMs, publicationFrame, revision: 1, transportEpoch: 1 })
    const host = [{ event: "device-session", wallMs: 1, sampleRate: 48000, blockSize: 512 }, publication(2_000, 96_000), publication(5_000, 240_000), publication(12_000, 576_000)]
    const launchOut = path.join(directory, "launch")
    await mkdir(launchOut)
    await writeFile(path.join(launchOut, "host.jsonl"), host.map((line) => JSON.stringify(line)).join("\n") + "\n")
    await writeFile(path.join(launchOut, "actions.jsonl"), [{ event: "capture-start", wallMs: 0 }, { event: "capture-end", wallMs: 20_000 }].map((line) => JSON.stringify(line)).join("\n") + "\n")
    const stored = [{ row: first, edits: [{ index: 1, wallMs: 1_500 }, { index: 2, wallMs: 4_500 }] }, { row: second, edits: [{ index: 1, wallMs: 10_000 }] }]
    for (const { row, edits } of stored) {
      await mkdir(path.join(directory, row.name))
      await writeFile(path.join(directory, row.name, "phase9-edits.json"), JSON.stringify({ phase: 9, row: row.name,
        edits: edits.map((edit) => ({ ...edit, fromLatencyFrames: 0, toLatencyFrames: 0 })) }))
    }
    await exportRowEvidence(launchOut, directory, [first, second])
    const firstHost = (await lines(path.join(directory, first.name, "host.jsonl"))).map((line) => JSON.parse(line).wallMs)
    const secondHost = (await lines(path.join(directory, second.name, "host.jsonl"))).map((line) => JSON.parse(line).wallMs)
    check(firstHost.join() === "1,2000,5000" && secondHost.join() === "1,12000", `rows keep their own publications and the device session: ${firstHost} | ${secondHost}`)
    const ends = await Promise.all([first, second].map(async (row) => (await lines(path.join(directory, row.name, "actions.jsonl"))).map((line) => JSON.parse(line)).find((action) => action.event === "capture-end").wallMs))
    check(ends.join() === "10000,20000", `the first row's capture ends where the next row begins: ${ends}`)
    const judged = await judgeStored(directory)
    check(judged.length === 2 && judged.every((entry) => entry.phase === 9) && judged.find((entry) => entry.row === first.name)?.edits === 2, `stored phase 9 rows are judged by step: ${JSON.stringify(judged)}`)
    check(judged.every((entry) => entry.verdict.outcome === "pass"), `settled windows over 1 s pass: ${JSON.stringify(judged.map((entry) => entry.verdict))}`)
  } finally { await rm(directory, { recursive: true }) }
  console.log("ae-08 phase 9 launch self-test: pass")
}

if (import.meta.main) {
  if (Bun.argv[2] === "--self-test") await selfTest()
  else throw new Error("Usage: ae-08-phase-9-launch.ts --self-test")
}
