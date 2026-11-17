// Where the span from a revision's graph-prepare to its first graph-publish-request goes. Host evidence (run with DAW_AE08_EVIDENCE_DIR):
//   host prepare   = vst-control + host-pre + core + host-post of the revision's `prepare-profile` line
//   reply write    = the `prepare-step` line `graph-prepare-reply`, logged after the status reply is written
//   host to renderer = graph-prepare to the renderer's `prepare-reply-received` mark, less the two above (the IPC hops and the
//                    host's own wait before the reply, to wall-clock millisecond precision)
//   renderer work  = `prepare-reply-received` to the first `bind-request-sent` mark (an asset publication hydrates in it)
//   renderer to host = `bind-request-sent` to the host's graph-publish-request
//   bind to armed  = the bind request to the next publish request of the revision, split at the last host `asset-page-write` between them
//                    (page time, then post-page time), with the renderer's armed-* staging marks in ms after the bind
// The renderer marks carry the key of the adoption whose `prepare-sent` is the last before graph-prepare.
//
//   bun tools/acceptance/ae-08-prepare-split.ts --run <phaseDir>   (every row directory with a host.jsonl, split in the lo and hi modes)
//   bun tools/acceptance/ae-08-prepare-split.ts --self-test
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

export type SplitEvent = { event: string; pid: number; wallMs: number; requestedRevision: number; key: string; stepsUs: string; step: string; durationMs: number
  queueDepth: number; queuedMs: number }
// `rendererSteps` splits `rendererMs` at the two host round trips on the path: the reply to the instrument states reply, that to the
// bind's progress read, and what is left up to the bind request. It is absent from evidence taken before those marks existed.
// `progress` splits the progress read at the host's `inspect-step` line (its wall time less its duration is the receipt) and the renderer's
// `bind-progress-reply` mark: the request's trip to the host, the host's own handling, the reply's trip back, and the wait to take the
// publication lane again. It is absent when the evidence lacks either.
// `main` splits the request into the IPC to main (`bind-states-configured` to main's `inspect-handler-entry`), main's handling and queue wait
// (to `inspect-dispatch`, the write to the host), and the pipe to the host; and the reply into the pipe back (the host line to main's
// `inspect-reply-received`) and the IPC to the renderer. `queueDepth` and `queuedMs` are main's own account at the write. It is absent
// when main logged no such lines.
export type ProgressMain = { toMainMs: number; queueMs: number; toHostMs: number; fromHostMs: number; toRendererMs: number; queueDepth: number; queuedMs: number }
export type ProgressSplit = { requestMs: number; hostMs: number; replyMs: number; laneMs: number; main?: ProgressMain }
export type RendererSteps = { statesMs: number; progressReadMs: number; restMs: number; progress?: ProgressSplit }
// The span from the bind request to the armed Publish, where the staging spends the seam's lead. Page time runs from the bind to the last
// host `asset-page-write` in it (0 with none), post-page time from there to the armed request. `marks` are the renderer's staging marks
// after the bind, in ms from it. It is absent when the revision sent no second publish request (no late bind).
export type ArmedSplit = { totalMs: number; pageMs: number; postPageMs: number; pages: number; marks: { name: string; ms: number }[] }
export type PrepareSplit = { hostPrepareMs: number; replyWriteMs: number; hostToRendererMs: number; rendererMs: number; rendererToHostMs: number; spectralWarmMs: number
  rendererSteps?: RendererSteps; armed?: ArmedSplit }

const hostSteps = ["vst-control", "host-pre", "core", "host-post"]
const armedMarks = ["armed-cover-end", "armed-stage-returned", "armed-prime-start", "armed-prime-end"]
const stepMicroseconds = (stepsUs: string) => new Map(stepsUs.split(";").filter(Boolean).map((pair): [string, number] => {
  const [name = "", value = ""] = pair.split("=")
  return [name, Number(value)]
}))

const earliestFrom = (events: readonly SplitEvent[], from: number, match: (event: SplitEvent) => boolean) =>
  events.filter((event) => event.wallMs >= from && match(event)).reduce<SplitEvent | undefined>((first, event) => first && first.wallMs <= event.wallMs ? first : event, undefined)

const armedSplit = (events: readonly SplitEvent[], prepare: SplitEvent, request: SplitEvent, key: string): ArmedSplit | undefined => {
  const armed = earliestFrom(events, request.wallMs + 1, (event) => event.event === "graph-publish-request" && event.pid === prepare.pid && event.requestedRevision === prepare.requestedRevision)
  if (!armed) return undefined
  const pages = events.filter((event) => event.event === "asset-page-write" && event.pid === prepare.pid && event.wallMs >= request.wallMs && event.wallMs <= armed.wallMs)
  const lastPageMs = Math.max(request.wallMs, ...pages.map((event) => event.wallMs))
  return { totalMs: armed.wallMs - request.wallMs, pageMs: lastPageMs - request.wallMs, postPageMs: armed.wallMs - lastPageMs, pages: pages.length,
    marks: armedMarks.flatMap((name) => {
      const mark = earliestFrom(events, request.wallMs, (event) => event.event === name && event.key === key && event.wallMs <= armed.wallMs)
      return mark ? [{ name, ms: mark.wallMs - request.wallMs }] : []
    }) }
}

export const prepareSplit = (events: readonly SplitEvent[], prepare: SplitEvent, request: SplitEvent): PrepareSplit | undefined => {
  const earliestAfter = (match: (event: SplitEvent) => boolean, from = prepare.wallMs) => earliestFrom(events, from, match)
  const profile = earliestAfter((event) => event.event === "prepare-profile" && event.pid === prepare.pid && event.requestedRevision === prepare.requestedRevision)
  const reply = earliestAfter((event) => event.event === "prepare-step" && event.pid === prepare.pid && event.step === "graph-prepare-reply")
  const sent = events.findLast((event) => event.event === "prepare-sent" && event.wallMs <= prepare.wallMs)
  const received = sent && earliestAfter((event) => event.event === "prepare-reply-received" && event.key === sent.key)
  const bound = sent && received && earliestAfter((event) => event.event === "bind-request-sent" && event.key === sent.key && event.wallMs <= request.wallMs, received.wallMs)
  if (!profile || !reply || !received || !bound) return undefined
  const configured = earliestAfter((event) => event.event === "bind-states-configured" && event.key === sent.key, received.wallMs)
  const progressRead = configured && earliestAfter((event) => event.event === "bind-progress-read" && event.key === sent.key, configured.wallMs)
  const hostInspect = configured && progressRead && earliestAfter((event) => event.event === "inspect-step" && event.pid === prepare.pid && event.step === "graph-inspect-reply"
    && event.wallMs <= progressRead.wallMs, configured.wallMs)
  const replied = configured && progressRead && earliestAfter((event) => event.event === "bind-progress-reply" && event.key === sent.key && event.wallMs <= progressRead.wallMs, configured.wallMs)
  const mainEvent = (name: string) => configured && progressRead && earliestAfter((event) => event.event === name && event.pid === prepare.pid && event.wallMs <= progressRead.wallMs, configured.wallMs)
  const entry = mainEvent("inspect-handler-entry"), dispatch = mainEvent("inspect-dispatch"), mainReply = mainEvent("inspect-reply-received")
  const main = configured && hostInspect && replied && entry && dispatch && mainReply ? { toMainMs: entry.wallMs - configured.wallMs, queueMs: dispatch.wallMs - entry.wallMs,
    toHostMs: hostInspect.wallMs - hostInspect.durationMs - dispatch.wallMs, fromHostMs: mainReply.wallMs - hostInspect.wallMs, toRendererMs: replied.wallMs - mainReply.wallMs,
    queueDepth: dispatch.queueDepth, queuedMs: dispatch.queuedMs } : undefined
  const progress = configured && progressRead && hostInspect && replied ? { requestMs: hostInspect.wallMs - hostInspect.durationMs - configured.wallMs,
    hostMs: hostInspect.durationMs, replyMs: replied.wallMs - hostInspect.wallMs, laneMs: progressRead.wallMs - replied.wallMs, main } : undefined
  const steps = stepMicroseconds(profile.stepsUs)
  const hostPrepareMs = hostSteps.reduce((total, name) => total + (steps.get(name) ?? 0), 0) / 1000
  return { hostPrepareMs, replyWriteMs: reply.durationMs, hostToRendererMs: received.wallMs - prepare.wallMs - hostPrepareMs - reply.durationMs,
    rendererMs: bound.wallMs - received.wallMs, rendererToHostMs: request.wallMs - bound.wallMs, spectralWarmMs: (steps.get("spectral-warm") ?? 0) / 1000,
    rendererSteps: configured && progressRead ? { statesMs: configured.wallMs - received.wallMs, progressReadMs: progressRead.wallMs - configured.wallMs,
      restMs: bound.wallMs - progressRead.wallMs, progress } : undefined, armed: armedSplit(events, prepare, request, sent.key) }
}

const round = (value: number) => Math.round(value * 100) / 100
const progressLine = ({ requestMs, hostMs, replyMs, laneMs, main }: ProgressSplit) =>
  ` = request ${round(requestMs)}${main ? ` (to main ${round(main.toMainMs)} + main ${round(main.queueMs)} + to host ${round(main.toHostMs)}; queue depth ${round(main.queueDepth)}, queued ${round(main.queuedMs)} ms)` : ""}`
  + ` + host ${round(hostMs)} + reply ${round(replyMs)}${main ? ` (from host ${round(main.fromHostMs)} + to renderer ${round(main.toRendererMs)})` : ""} + lane ${round(laneMs)}`
const armedLine = (armed: ArmedSplit) => `; bind to armed ${armed.totalMs} ms = page time ${armed.pageMs} ms (${armed.pages} pages) + post-page ${armed.postPageMs} ms`
  + (armed.marks.length ? ` [after bind: ${armed.marks.map((mark) => `${mark.name} ${mark.ms}`).join(", ")}]` : "")
export const splitLine = (split: PrepareSplit) => `host prepare ${round(split.hostPrepareMs)} ms, reply write ${round(split.replyWriteMs)} ms, host to renderer ${round(split.hostToRendererMs)} ms, `
  + `renderer work ${round(split.rendererMs)} ms${split.rendererSteps ? ` (states reply ${round(split.rendererSteps.statesMs)} ms, progress read ${round(split.rendererSteps.progressReadMs)} ms${split.rendererSteps.progress ? progressLine(split.rendererSteps.progress) : ""}, rest ${round(split.rendererSteps.restMs)} ms)` : ""}, `
  + `renderer to host bind ${round(split.rendererToHostMs)} ms${split.armed ? armedLine(split.armed) : ""}`

const hostSchema = z.object({ event: z.string(), cause: z.string().default(""), pid: z.number().default(0), wallMs: z.number().default(0), revision: z.number().default(0),
  requestedRevision: z.number().default(0), publicationFrame: z.number().default(0), key: z.string().default(""), stepsUs: z.string().default(""),
  step: z.string().default(""), durationMs: z.number().default(0), queueDepth: z.number().default(0), queuedMs: z.number().default(0) })
const editsSchema = z.object({ edits: z.array(z.object({ wallMs: z.number(), fromLatencyFrames: z.number(), toLatencyFrames: z.number() })).default([]) })
const LO_HI_CUT_MS = 8.5

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = (sorted.length - 1) / 2
  return ((sorted[Math.floor(middle)] ?? 0) + (sorted[Math.ceil(middle)] ?? 0)) / 2
}

const directions = ["raise", "lower", "plain"]
type Row = { publication: number; spanMs: number; direction: string; split: PrepareSplit }
export const splitRow = (events: readonly z.infer<typeof hostSchema>[], edits: z.infer<typeof editsSchema>["edits"]): Row[] => {
  const publications = events.flatMap((publish, index) => {
    if (publish.event !== "graph-publish" || publish.cause !== "block-boundary" || publish.publicationFrame === 0) return []
    const prepare = events.slice(0, index).findLast((event) => event.event === "graph-prepare" && event.pid === publish.pid && event.requestedRevision === publish.revision)
    const request = prepare && events.slice(events.indexOf(prepare) + 1, index).find((event) => event.event === "graph-publish-request" && event.pid === publish.pid && event.requestedRevision === publish.revision)
    const split = prepare && request && prepareSplit(events, prepare, request)
    return prepare && request && split ? [{ publish, spanMs: request.wallMs - prepare.wallMs, split }] : []
  })
  // A publication carries every edit made since the previous one: the first publication at or after the edit's wall time.
  const move = publications.map(() => 0)
  for (const edit of edits) {
    const owner = publications.findIndex(({ publish }) => publish.wallMs >= edit.wallMs)
    if (owner >= 0) move[owner] = (move[owner] ?? 0) + edit.toLatencyFrames - edit.fromLatencyFrames
  }
  return publications.map(({ publish, spanMs, split }, at) => ({ publication: publish.revision, spanMs, split,
    direction: (move[at] ?? 0) > 0 ? "raise" : (move[at] ?? 0) < 0 ? "lower" : "plain" }))
}

const modeLine = (label: string, mode: string, group: readonly Row[]) => {
  if (group.length === 0) return []
  const p50 = (pick: (row: Row) => number) => median(group.map(pick))
  const stepped = group.flatMap((row) => row.split.rendererSteps ?? [])
  const stepP50 = (pick: (steps: RendererSteps) => number) => median(stepped.map(pick))
  const progressed = stepped.flatMap((steps) => steps.progress ?? [])
  const progressP50 = (pick: (progress: ProgressSplit) => number) => median(progressed.map(pick))
  const mains = progressed.flatMap((progress) => progress.main ?? [])
  const mainP50 = mains.length > 0 && mains.length === progressed.length ? { toMainMs: median(mains.map((main) => main.toMainMs)), queueMs: median(mains.map((main) => main.queueMs)),
    toHostMs: median(mains.map((main) => main.toHostMs)), fromHostMs: median(mains.map((main) => main.fromHostMs)), toRendererMs: median(mains.map((main) => main.toRendererMs)),
    queueDepth: median(mains.map((main) => main.queueDepth)), queuedMs: median(mains.map((main) => main.queuedMs)) } : undefined
  return [`${label} ${mode} (${group.length}): graph-prepare to bind p50 ${round(p50((row) => row.spanMs))} ms; medians: ${splitLine({ hostPrepareMs: p50((row) => row.split.hostPrepareMs),
    replyWriteMs: p50((row) => row.split.replyWriteMs), hostToRendererMs: p50((row) => row.split.hostToRendererMs), rendererMs: p50((row) => row.split.rendererMs),
    rendererToHostMs: p50((row) => row.split.rendererToHostMs), spectralWarmMs: 0,
    rendererSteps: stepped.length === group.length ? { statesMs: stepP50((steps) => steps.statesMs), progressReadMs: stepP50((steps) => steps.progressReadMs),
      restMs: stepP50((steps) => steps.restMs), progress: progressed.length === group.length ? { requestMs: progressP50((progress) => progress.requestMs),
        hostMs: progressP50((progress) => progress.hostMs), replyMs: progressP50((progress) => progress.replyMs), laneMs: progressP50((progress) => progress.laneMs),
        main: mainP50 } : undefined } : undefined })}`]
}
export const modeLines = (label: string, rows: readonly Row[]) => [...modeLine(label, "lo", rows.filter((row) => row.spanMs < LO_HI_CUT_MS)),
  ...modeLine(label, "hi", rows.filter((row) => row.spanMs >= LO_HI_CUT_MS))]

const runRows = async (run: string) => Promise.all((await readdir(run, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(async (entry) => {
  const host = await readFile(path.join(run, entry.name, "host.jsonl"), "utf8").catch(() => undefined)
  if (host === undefined) return []
  const edits = await readFile(path.join(run, entry.name, "phase4-edits.json"), "utf8").then((text) => editsSchema.parse(JSON.parse(text)).edits, () => [])
  return [{ name: entry.name, rows: splitRow(host.slice(0, host.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => hostSchema.parse(JSON.parse(line))), edits) }]
}))

const selfTest = () => {
  const line = (event: string, wallMs: number, fields: Partial<SplitEvent> = {}): SplitEvent => ({ event, wallMs, pid: 7, requestedRevision: 0, key: "", stepsUs: "", step: "", durationMs: 0, queueDepth: 0, queuedMs: 0, ...fields })
  const prepare = line("graph-prepare", 1000, { requestedRevision: 5 })
  const request = line("graph-publish-request", 1015, { requestedRevision: 5 })
  const events = [line("prepare-sent", 800, { key: "old" }), line("prepare-reply-received", 810, { key: "old" }), line("prepare-sent", 990, { key: "k" }), prepare,
    line("prepare-profile", 1004, { requestedRevision: 5, stepsUs: "vst-control=100;host-pre=200;core=3000;spectral-warm=500;host-post=700;" }),
    line("prepare-step", 1005, { step: "graph-prepare-reply", durationMs: 0.5 }), line("prepare-reply-received", 1010, { key: "k" }),
    line("bind-states-configured", 1011, { key: "k" }), line("bind-progress-read", 1012, { key: "k" }), line("bind-states-configured", 1011, { key: "other" }),
    line("inspect-step", 1009, { step: "graph-inspect-reply", durationMs: 0.1 }), line("inspect-step", 1012, { step: "graph-inspect-reply", durationMs: 0.5 }),
    line("inspect-step", 1011, { step: "graph-inspect-reply", durationMs: 0.1, pid: 8 }), line("bind-progress-reply", 1012, { key: "k" }),
    line("inspect-handler-entry", 1010), line("inspect-handler-entry", 1011), line("inspect-dispatch", 1011, { queueDepth: 2, queuedMs: 1 }),
    line("inspect-dispatch", 1011, { queueDepth: 9, queuedMs: 9, pid: 8 }), line("inspect-reply-received", 1012),
    line("bind-request-sent", 1013, { key: "k" }), line("bind-request-sent", 1300, { key: "k" }), line("bind-request-sent", 1013, { key: "other" }), request,
    line("asset-page-write", 1010), line("asset-page-write", 1017), line("asset-page-write", 1022), line("asset-page-write", 1022, { pid: 8 }), line("asset-page-write", 1100),
    line("armed-cover-end", 1019, { key: "k" }), line("armed-stage-returned", 1030, { key: "k" }), line("armed-prime-start", 1031, { key: "k" }),
    line("armed-prime-end", 1036, { key: "k" }), line("armed-prime-end", 1020, { key: "other" }), line("graph-publish-request", 1040, { requestedRevision: 5 }),
    line("graph-publish-request", 1090, { requestedRevision: 5 })]
  const expectedArmed = { totalMs: 25, pageMs: 7, postPageMs: 18, pages: 2, marks: [{ name: "armed-cover-end", ms: 4 }, { name: "armed-stage-returned", ms: 15 },
    { name: "armed-prime-start", ms: 16 }, { name: "armed-prime-end", ms: 21 }] }
  const split = prepareSplit(events, prepare, request)
  const expected = { hostPrepareMs: 4, replyWriteMs: 0.5, hostToRendererMs: 5.5, rendererMs: 3, rendererToHostMs: 2, spectralWarmMs: 0.5 }
  const expectedSteps = { statesMs: 1, progressReadMs: 1, restMs: 1, progress: { requestMs: 0.5, hostMs: 0.5, replyMs: 0, laneMs: 0,
    main: { toMainMs: 0, queueMs: 0, toHostMs: 0.5, fromHostMs: 0, toRendererMs: 0, queueDepth: 2, queuedMs: 1 } } }
  const failures = [
    ...(split && Object.entries(expected).every(([name, value]) => Math.abs(Number(Object.entries(split).find(([field]) => field === name)?.[1]) - value) < 1e-9) ? []
      : [`split ${JSON.stringify(split)}, expected ${JSON.stringify(expected)}`]),
    ...(JSON.stringify(split?.rendererSteps) === JSON.stringify(expectedSteps) ? [] : [`renderer steps ${JSON.stringify(split?.rendererSteps)}, expected ${JSON.stringify(expectedSteps)}`]),
    ...(JSON.stringify(split?.armed) === JSON.stringify(expectedArmed) ? [] : [`armed ${JSON.stringify(split?.armed)}, expected ${JSON.stringify(expectedArmed)}`]),
    ...(prepareSplit(events.filter((event) => event.event !== "graph-publish-request" || event === request), prepare, request)?.armed === undefined ? [] : ["a revision with no second publish request must have no armed split"]),
    ...["inspect-step", "bind-progress-reply"].flatMap((name) => {
      const steps = prepareSplit(events.filter((event) => event.event !== name), prepare, request)?.rendererSteps
      return steps && steps.progress === undefined && steps.progressReadMs === 1 ? [] : [`a progress read with no ${name} must keep its renderer steps and have no progress split`]
    }),
    ...["inspect-handler-entry", "inspect-dispatch", "inspect-reply-received"].flatMap((name) => {
      const progress = prepareSplit(events.filter((event) => event.event !== name), prepare, request)?.rendererSteps?.progress
      return progress && progress.main === undefined && progress.hostMs === 0.5 ? [] : [`a progress read with no ${name} must keep the progress split and have no main split`]
    }),
    ...(prepareSplit(events.filter((event) => event.event !== "bind-progress-read"), prepare, request)?.rendererSteps === undefined ? [] : ["a revision with no progress-read mark must have no renderer steps"]),
    ...(prepareSplit(events.filter((event) => event.event !== "prepare-reply-received" || event.key === "old"), prepare, request) === undefined ? [] : ["a revision with no reply mark must have no split"]),
    ...(prepareSplit(events.filter((event) => event.event !== "bind-request-sent"), prepare, request) === undefined ? [] : ["a revision with no bind mark must have no split"]),
    ...(prepareSplit(events.filter((event) => event.event !== "prepare-profile"), prepare, request) === undefined ? [] : ["a revision with no prepare-profile line must have no split"]),
    ...(modeLines("row", [{ publication: 5, spanMs: 15, direction: "plain", split: expected }]).join("").includes("row hi (1)") ? [] : ["a 15 ms span belongs to the hi mode"]),
  ]
  if (failures.length > 0) throw new Error(`prepare split self-test: ${failures.join("; ")}`)
  console.log("ae-08 prepare split self-test: pass")
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.includes("--self-test")) selfTest()
  else {
    const run = args[args.indexOf("--run") + 1]
    if (args.indexOf("--run") < 0 || !run) throw new Error("usage: ae-08-prepare-split.ts --run <phaseDir> | --self-test")
    const found = (await runRows(run)).flat()
    for (const { name, rows } of found) {
      for (const row of rows) console.log(`${name} revision ${row.publication} ${row.direction}: graph-prepare to bind ${row.spanMs} ms = ${splitLine(row.split)}, spectral-warm ${round(row.split.spectralWarmMs)} ms`)
      for (const direction of directions) for (const summary of modeLines(`${name} ${direction}`, rows.filter((row) => row.direction === direction))) console.log(summary)
    }
    for (const direction of ["raise", "lower"]) {
      const warm = found.flatMap(({ rows }) => rows.filter((row) => row.direction === direction).map((row) => row.split.spectralWarmMs))
      console.log(`spectral-warm ${direction} (${warm.length}): p50 ${round(median(warm))} ms, max ${round(Math.max(0, ...warm))} ms`)
    }
  }
}
