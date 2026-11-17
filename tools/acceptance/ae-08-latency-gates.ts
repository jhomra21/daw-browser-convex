// AE-08 frozen LAT1 latency gates. Standalone judge for the publication timing of a packaged run, 48 kHz / 512-frame blocks.
// It reads each row's host.jsonl (and phaseN-edits.json, and an optional latency-class.json) and gives a verdict per row.
//
//   bun tools/acceptance/ae-08-latency-gates.ts --run <phaseDir> [--run <phaseDir>...] [--out <file>]     phaseDir ends in phase<N>
//     (several --run directories pool their publications, so a phase 4 and a phase 9 run judge one spectral pool)
//   bun tools/acceptance/ae-08-latency-gates.ts --self-test --c1 <phaseDir> [--c1 <phaseDir>...]
//
// FROZEN 2026-11-13 by the parent ruling on /tmp/ae08-lat1-gates-proposal.md §2, before any run it judges.
// Evidence the numbers come from (acceptance-reports/ae-08-phase-5-2026-10-18/):
//   C1 pre-LAT1: processor-owner-certification/phase4, /phase5 (negative control, every gate must fail)
//   LAT1 certified: rc-p5c/phase4, /phase5; earlier LAT1 runs rc-p5a, rc-p5b (spread)
// Only the parent changes a constant below, by a new ruling, and never after seeing the data it would judge.
// The verdict is the worst row: FAIL, else INCOMPLETE (a row has no frozen limit yet, or a pooled gate has fewer publications than
// POOLED_MIN_N), else PASS.
// One publication over its limit fails its row and the run continues; only a product error dialog, a host crash
// or a freeze mismatch stops a campaign.
//
// Definitions, all read from host.jsonl (the host logs the native applied frame, not the requested one):
// - bind: the first `graph-publish-request` of a revision. Lead = publication frame - bind frame, in blocks.
//   Only a publication that binds a seam has a lead: a latency publication (a plug-in's own latency report) prepares with no
//   requested frame and native publishes it at the next block boundary, so its lead is 0 by design. A seam-bound publication
//   stages schedule windows against its prepared revision before it publishes (the host's `schedule-window` lines); one with none
//   is a latency publication. Evidence with no `schedule-window` line at all (from before the line existed) judges every lead.
// - rebase: the publication frame moved past the bound seam (lead above LEAD_MAX_BLOCKS). A re-sent Publish at the
//   same seam is not a rebase.
// - prepare to publish: `graph-prepare` to `graph-publish`. Edit to publish: the first edit the publication carries
//   (the first publication at or after the edit's wall time owns it) to `graph-publish`.
// - completion: `latency-move-complete` frame - publication frame. Frames, not time, so no margin is added. Allowed:
//   ceil((move + 2 * fade) / BLOCK) * BLOCK plus the capped blocks before the bind; see headMoveFrames for `move`. Evidence with no
//   pinned/graph latency on its graph-publish lines keeps COMPLETE_BASE_FRAMES for the first term, and so does a
//   publication whose graph-publish line reports spectralPredecessors above 0 (their stages hold completion, audio_core.cpp:9141-9145).
// - uploaded bytes: the `asset-page-write` lines of the publication's pid between prepare and publish, summed (`bytes` is the page's
//   planar PCM). A first swap uploads its sample in that window, so an asset publication's prepare-to-publish limit is
//   max(the asset class's limit, ASSET_UPLOAD.fixedMs + bytes / ASSET_UPLOAD.bytesPerMs). A resident swap writes none and keeps
//   the class limit; evidence with no such line (older runs) does too.
// - class: asset when the host logged an `asset-install` between prepare and publish; raise when the edits' net
//   latency move is positive (merged when 2+ blocks pass between prepare and bind); else plain. A row can declare
//   its class in latency-class.json; an unknown class is an input failure. vst-insert is decided per publication: it owns an edit
//   named vst-insert or one with a ui-device-insert mark in its window, whatever the row declares.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { z } from "zod"

const SAMPLE_RATE = 48000
const BLOCK = 512
const LEAD_MIN_BLOCKS = 2
const LEAD_MAX_BLOCKS = 3
// Allowance for evidence with no pinned/graph latency on its graph-publish lines (runs from before the host logged them).
const COMPLETE_BASE_FRAMES = 2048
const COMPLETE_MAX_BLOCKS_BEFORE_BIND = 3
// native deletion_fade_frames (audio_core.cpp:7775-7777): (sampleRate * 5 + 500) / 1000.
const FADE_FRAMES = Math.round(SAMPLE_RATE * 5 / 1000)
// A class with no frozen prepare-to-publish limit makes its row INCOMPLETE until the parent freezes one here.
const LIMITS = {
  plain: { prepareToPublishMaxMs: 70, editToPublishMaxMs: 150 },
  raise: { prepareToPublishMaxMs: 70, editToPublishMaxMs: 150 },
  "raise-merged": { prepareToPublishMaxMs: 80, editToPublishMaxMs: 150 },
  asset: { prepareToPublishMaxMs: 100, editToPublishMaxMs: undefined },
  // Frozen by the parent ruling (addendum 7) from PHASE8-C2-GAPS-PACKAGED.md: 15 VST inserts measured edit to publish min 174, p50 176,
  // max 203 ms (250 is about 23% over the max); prepare to publish p50 37, max 43 ms (the plain 70).
  "vst-insert": { prepareToPublishMaxMs: 70, editToPublishMaxMs: 250 },
}
// Frozen by parent ruling addendum 23 (PARENT-RULING-C2-FAIL-ITEMS.md) from PHASE8-ASSET-RECALIBRATION-ROUND.md: 60 packaged asset edits
// (27, 100, 300 MiB, 20 each). T = 0.8 x the lowest throughput (409.1 MiB/s) rounded down = 320 MiB/s; F = 1.2 x the 27 MiB fixed
// maximum (58 ms) rounded up = 70 ms. A first swap's prepare-to-publish limit is max(100, F + bytes / T).
const ASSET_UPLOAD = { fixedMs: 70, bytesPerMs: 320 * 1024 * 1024 / 1000 }
// Pooled over the plain and raise publications of the run.
// Prep time is split by population (parent ruling, addendum 14 item 2): publications with spectralPredecessors = 0 hold 8 ms
// (PARENT-RULING-LAT1-PREP-OVERHEAD.md); those with spectral predecessors hold their own frozen 12 ms (measured p50 9 to 10 ms).
// Evidence without the field on its graph-publish lines keeps the old single pool at 8 ms.
const POOLED = { prepareToPublishP99Ms: 60, prepP50Ms: 8, spectralPrepP50Ms: 12, editToPublishP50Ms: 100 }
// The fewest publications a pooled gate is judged on (parent ruling, addendum 36 item 4, from /tmp/ae08-phase9-budget-plan.md section 5):
// a spectral run median exceeded its 12 ms limit 4.4 % of the time at n = 20 and 0.7 % at n = 40 on the stored publications, and a p99
// of fewer than 100 samples is the maximum. A smaller pool gives INCOMPLETE for its gate, never PASS or FAIL.
const POOLED_MIN_N = { spectralPrepP50: 40, prepP50: 100, prepareToPublishP99: 100, editToPublishP50: 100 }
type PooledMinimums = typeof POOLED_MIN_N

type Class = keyof typeof LIMITS
type Gate = "inputs" | "lead" | "rebase" | "prepare-to-publish" | "prep-time" | "edit-to-publish" | "completion"
type Failure = { row: string; gate: Gate; detail: string }
type Status = "PASS" | "INCOMPLETE" | "FAIL"
type Publication = {
  row: string; revision: number; publicationFrame: number; asset: boolean; uploadedBytes: number; class: Class; raise: boolean; leadBlocks: number; seamBound: boolean; prepareToPublishMs: number; prepMs: number
  // The graph-publish line's spectral predecessor count; undefined on evidence from before the field.
  spectralPredecessors: number | undefined
  editToPublishMs: number | undefined; completeFrames: number | undefined; blocksBeforeBind: number
  // Largest read-head delay change of the publication (0 when the pinned budget grows); undefined without host latency evidence.
  headMoveFrames: number | undefined
}
type Analysis = { publications: Publication[]; failures: Failure[]; incomplete: string[]; rows: { row: string; status: Status }[]
  // Diagnostic only: each row's own prep p50 over the publications it adds to the pooled gates.
  rowPrep: { row: string; publications: number; spectral: number; prepP50Ms: number }[]; status: Status }

const inputFailure = (row: string, detail: string): Failure => ({ row, gate: "inputs", detail })

const hostEventSchema = z.object({
  event: z.string(), cause: z.string().default(""), pid: z.number().default(0), wallMs: z.number().default(0),
  frame: z.number().default(0), revision: z.number().default(0), requestedRevision: z.number().default(0),
  publicationFrame: z.number().default(0), transportEpoch: z.number().default(0), sampleRate: z.number().default(0),
  blockSize: z.number().default(0), pinnedLatencyFrames: z.number().optional(), graphLatencyFrames: z.number().optional(),
  spectralPredecessors: z.number().optional(), bytes: z.number().default(0),
})
const editsSchema = z.object({ edits: z.array(z.object({
  name: z.string().optional(), index: z.number().optional(), wallMs: z.number(), fromLatencyFrames: z.number(), toLatencyFrames: z.number() })).default([]) })
const classSchema = z.object({ class: z.enum(["plain", "raise", "asset", "vst-insert"]) })
const continuitySchema = z.object({ assetPublicationFrame: z.number().optional() }).passthrough()
type HostEvent = z.infer<typeof hostEventSchema>

const readText = (file: string) => readFile(file, "utf8").catch(() => undefined)
const parseHost = (text: string): HostEvent[] => text.split("\n").filter((line) => line.trim()).map((line) => hostEventSchema.parse(JSON.parse(line)))

const percentile = (values: readonly number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * fraction
  const low = Math.floor(position), high = Math.ceil(position)
  return (sorted[low] ?? 0) + ((sorted[high] ?? 0) - (sorted[low] ?? 0)) * (position - low)
}

const findLast = (events: readonly HostEvent[], before: number, match: (event: HostEvent) => boolean) => {
  for (let index = before - 1; index >= 0; index--) {
    const event = events[index]
    if (event && match(event)) return { event, index }
  }
  return undefined
}

// The host's graph-publish lines carry the pinned budget and the graph's own latency. A head's delay is their difference, so a
// publication that does not grow the budget moves heads by max(previous delay, delay) when that delay changed (audio_core.cpp:7074-7081).
// One that grows it moves none: its heads wait the 2 fades alone (:7000-7004). A graph with spectral predecessors is not judged by
// this: their stages hold the completion (:9141-9145), so it keeps COMPLETE_BASE_FRAMES.
const headMoveFrames = (previous: HostEvent, current: HostEvent) => {
  if ((current.spectralPredecessors ?? 0) > 0) return undefined
  if (previous.pinnedLatencyFrames === undefined || previous.graphLatencyFrames === undefined
    || current.pinnedLatencyFrames === undefined || current.graphLatencyFrames === undefined) return undefined
  const before = previous.pinnedLatencyFrames - previous.graphLatencyFrames
  const after = current.pinnedLatencyFrames - current.graphLatencyFrames
  return current.pinnedLatencyFrames > previous.pinnedLatencyFrames || before === after ? 0 : Math.max(before, after)
}

// vst-insert is decided per publication (insert), never by a row's declaration: the removes and undos of a VST row stay plain.
const classOf = (declared: Class | undefined, insert: boolean, asset: boolean, raise: boolean, blocksBeforeBind: number): Class => {
  if (insert) return "vst-insert"
  const base = declared === undefined || declared === "vst-insert" ? (asset ? "asset" : raise ? "raise" : "plain") : declared
  return base === "raise" && blocksBeforeBind >= 2 ? "raise-merged" : base
}

// An edit through the control protocol is stamped with the app's control-commit-received line. An edit made in the app window has
// only its step start, so it is timed from the first ui-* mark the app logged (the moment its UI committed the edit) between the step
// start and the publication that owns it. Evidence with no such mark (older runs) keeps the step start.
const editStartMs = (events: readonly HostEvent[], stepWallMs: number, publishWallMs: number) =>
  events.some((event) => event.event === "control-commit-received" && event.wallMs === stepWallMs) ? stepWallMs
    : events.find((event) => event.event.startsWith("ui-") && event.wallMs >= stepWallMs && event.wallMs <= publishWallMs)?.wallMs ?? stepWallMs

const analyzeRow = (row: string, events: readonly HostEvent[], edits: z.infer<typeof editsSchema>["edits"], declared: Class | undefined) => {
  const drafts: (Omit<Publication, "class" | "raise" | "editToPublishMs"> & { wallMs: number })[] = []
  const failures: Failure[] = []
  const windowed = events.some((event) => event.event === "schedule-window")
  events.forEach((publish, index) => {
    if (publish.event !== "graph-publish" || publish.cause !== "block-boundary" || publish.publicationFrame === 0) return
    const revision = publish.revision
    const prepare = findLast(events, index, (event) => event.event === "graph-prepare" && event.pid === publish.pid && event.requestedRevision === revision)
    const requests = prepare ? events.slice(prepare.index + 1, index).filter((event) =>
      event.event === "graph-publish-request" && event.pid === publish.pid && event.requestedRevision === revision) : []
    const bind = requests[0]
    const armed = requests[requests.length - 1]
    if (!prepare || !bind || !armed) return void failures.push(inputFailure(row, `revision ${revision} has no prepare or publish request before its publication`))
    const session = findLast(events, index, (event) => event.event === "device-session")?.event
    if (session?.sampleRate !== SAMPLE_RATE || session.blockSize !== BLOCK)
      return void failures.push(inputFailure(row, `revision ${revision} runs at ${session?.sampleRate}/${session?.blockSize}, not ${SAMPLE_RATE}/${BLOCK}`))
    const complete = events.slice(index + 1).find((event) => event.event === "latency-move-complete" && event.pid === publish.pid
      && event.revision === revision && event.transportEpoch === publish.transportEpoch && event.frame >= publish.publicationFrame)
    const asset = events.some((event) => event.event === "asset-install" && event.pid === publish.pid
      && event.wallMs >= prepare.event.wallMs && event.wallMs <= publish.wallMs)
    const uploadedBytes = events.filter((event) => event.event === "asset-page-write" && event.pid === publish.pid
      && event.wallMs >= prepare.event.wallMs && event.wallMs <= publish.wallMs).reduce((sum, event) => sum + event.bytes, 0)
    const previousPublish = findLast(events, index, (event) => event.event === "graph-publish" && event.pid === publish.pid)?.event
    const blocksBeforeBind = Math.max(1, Math.round((bind.frame - prepare.event.frame) / BLOCK))
    const seamBound = !windowed || events.slice(prepare.index + 1, index).some((event) => event.event === "schedule-window" && event.revision === revision)
    drafts.push({
      row, revision, publicationFrame: publish.publicationFrame, asset, uploadedBytes, blocksBeforeBind, seamBound, wallMs: publish.wallMs,
      spectralPredecessors: publish.spectralPredecessors,
      headMoveFrames: previousPublish && headMoveFrames(previousPublish, publish),
      leadBlocks: (publish.publicationFrame - bind.frame) / BLOCK, prepareToPublishMs: publish.wallMs - prepare.event.wallMs,
      prepMs: armed.wallMs - prepare.event.wallMs, completeFrames: complete ? complete.frame - publish.publicationFrame : undefined,
    })
  })
  const netMove = drafts.map(() => 0)
  const firstEditMs: (number | undefined)[] = drafts.map(() => undefined)
  const insertsVst = drafts.map(() => false)
  // A step settles before the next one starts, so a publication after the next step's start is not this edit's: a step that publishes
  // nothing (the editor opening) owns none instead of being charged the publication of the edit after it.
  const stepStartMs = new Map<number, number>()
  for (const edit of edits) if (edit.index !== undefined) stepStartMs.set(edit.index, Math.min(stepStartMs.get(edit.index) ?? edit.wallMs, edit.wallMs))
  const nextStepMs = (index: number | undefined) => index === undefined ? Infinity : Math.min(...[...stepStartMs].flatMap(([step, wallMs]) => step > index ? wallMs : []))
  for (const edit of edits) {
    const stepEndMs = nextStepMs(edit.index)
    const owner = drafts.findIndex((draft) => draft.wallMs >= edit.wallMs && draft.wallMs < stepEndMs)
    const draft = drafts[owner]
    if (!draft) continue
    const startMs = editStartMs(events, edit.wallMs, draft.wallMs)
    // A VST insert is the row's declared insert step, or an edit the app marked with ui-device-insert before the publication.
    if (edit.name === "vst-insert" || events.some((event) => event.event === "ui-device-insert" && event.wallMs >= edit.wallMs && event.wallMs <= draft.wallMs))
      insertsVst[owner] = true
    netMove[owner] = (netMove[owner] ?? 0) + edit.toLatencyFrames - edit.fromLatencyFrames
    firstEditMs[owner] = Math.min(firstEditMs[owner] ?? startMs, startMs)
  }
  const publications = drafts.map(({ wallMs, ...draft }, index): Publication => {
    const raise = (netMove[index] ?? 0) > 0
    const editMs = firstEditMs[index]
    return { ...draft, raise, editToPublishMs: editMs === undefined ? undefined : wallMs - editMs, class: classOf(declared, insertsVst[index] === true, draft.asset, raise, draft.blocksBeforeBind) }
  })
  return { failures, publications }
}

// The continuity analysis names the one publication that delivers an asset (analysis.json assetPublicationFrame). Exactly
// that publication must carry an asset-install and no other may: a spurious install would lift a publication from the
// plain 70 ms limit to the asset class's 100 ms. A row without an analysis.json is not cross-checked here.
const assetEvidenceFailures = (row: string, assetFrame: number | undefined, publications: readonly Publication[]): Failure[] => [
  ...(assetFrame !== undefined && !publications.some((publication) => publication.publicationFrame === assetFrame)
    ? [inputFailure(row, `the continuity analysis places an asset at frame ${assetFrame}, but no publication has that frame`)] : []),
  ...publications.filter((publication) => (publication.publicationFrame === assetFrame) !== publication.asset)
    .map((publication) => inputFailure(row, publication.asset
      ? `revision ${publication.revision} carries asset-install, but the continuity analysis places no asset there`
      : `revision ${publication.revision} delivers the asset, but carries no asset-install`)),
]

const judgePublication = (publication: Publication): Failure[] => {
  const { row, revision, leadBlocks } = publication
  const classLimits = LIMITS[publication.class]
  const prepareMaxMs = publication.class === "asset" && classLimits.prepareToPublishMaxMs !== undefined
    ? Math.max(classLimits.prepareToPublishMaxMs, ASSET_UPLOAD.fixedMs + publication.uploadedBytes / ASSET_UPLOAD.bytesPerMs)
    : classLimits.prepareToPublishMaxMs
  const limits = { ...classLimits, prepareToPublishMaxMs: prepareMaxMs }
  const moveAllowance = publication.headMoveFrames === undefined ? COMPLETE_BASE_FRAMES
    : Math.ceil((publication.headMoveFrames + 2 * FADE_FRAMES) / BLOCK) * BLOCK
  const allowedComplete = moveAllowance + BLOCK * Math.min(publication.blocksBeforeBind, COMPLETE_MAX_BLOCKS_BEFORE_BIND)
  const fail = (gate: Gate, detail: string): Failure => ({ row, gate, detail: `rev ${revision} ${detail}` })
  return [
    ...(publication.seamBound && (!Number.isInteger(leadBlocks) || leadBlocks < LEAD_MIN_BLOCKS || leadBlocks > LEAD_MAX_BLOCKS)
      ? [fail("lead", `lead ${leadBlocks} blocks, want ${LEAD_MIN_BLOCKS}..${LEAD_MAX_BLOCKS}`)] : []),
    ...(publication.seamBound && leadBlocks > LEAD_MAX_BLOCKS ? [fail("rebase", "publication frame moved past the bound seam")] : []),
    ...(limits.prepareToPublishMaxMs !== undefined && publication.prepareToPublishMs > limits.prepareToPublishMaxMs
      ? [fail("prepare-to-publish", `${publication.prepareToPublishMs} > ${limits.prepareToPublishMaxMs} ms (${publication.class}, ${publication.uploadedBytes} bytes uploaded)`)] : []),
    ...(limits.editToPublishMaxMs !== undefined && (publication.editToPublishMs ?? 0) > limits.editToPublishMaxMs
      ? [fail("edit-to-publish", `${publication.editToPublishMs} > ${limits.editToPublishMaxMs} ms (${publication.class})`)] : []),
    ...((publication.raise && publication.completeFrames === undefined) || (publication.completeFrames ?? 0) > allowedComplete
      ? [fail("completion", `${publication.completeFrames ?? "no completion"} > ${allowedComplete} frames`)] : []),
  ]
}

// The pooled populations: plain and raise publications, with the spectral ones split off for the prep gate.
const poolOf = (publications: readonly Publication[]) => {
  const pooled = publications.filter((publication) => publication.class === "plain" || publication.class === "raise")
  const spectral = pooled.filter((publication) => (publication.spectralPredecessors ?? 0) > 0)
  return { pooled, spectral, rest: pooled.filter((publication) => !spectral.includes(publication)) }
}

type PoolVerdict = { failure?: Failure; incomplete?: string }
const judgePooled = (publications: readonly Publication[], minimums: PooledMinimums) => {
  const { pooled, spectral, rest } = poolOf(publications)
  const judge = (gate: Gate, label: string, values: readonly number[], fraction: number, limitMs: number, minimum: number): PoolVerdict => {
    if (values.length < minimum) return { incomplete: `${label}: ${values.length} publications, needs ${minimum}` }
    const value = values.length ? percentile(values, fraction) : 0
    return value > limitMs ? { failure: { row: "(pooled)", gate, detail: `${label} ${value} > ${limitMs} ms` } } : {}
  }
  const judged = [
    judge("prepare-to-publish", "pooled p99", pooled.map((publication) => publication.prepareToPublishMs), 0.99, POOLED.prepareToPublishP99Ms, minimums.prepareToPublishP99),
    judge("prep-time", "pooled prep p50", rest.map((publication) => publication.prepMs), 0.5, POOLED.prepP50Ms, minimums.prepP50),
    judge("prep-time", "pooled spectral prep p50", spectral.map((publication) => publication.prepMs), 0.5, POOLED.spectralPrepP50Ms, minimums.spectralPrepP50),
    judge("edit-to-publish", "pooled p50", pooled.flatMap((publication) => publication.editToPublishMs ?? []), 0.5, POOLED.editToPublishP50Ms, minimums.editToPublishP50),
  ]
  return { failures: judged.flatMap((entry) => entry.failure ?? []), incomplete: judged.flatMap((entry) => entry.incomplete ?? []) }
}

// One run directory's rows, each judged on its own publications. Several directories pool their publications, so a row name
// carries its directory's parent (r1/two-tone) to keep two runs of the same fixture apart.
const analyzeRows = async (run: string, prefix: string) => {
  const phase = phaseOf(run)
  const names = (await readdir(run, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  const analyses = await Promise.all(names.map(async (directory) => {
    const hostText = await readText(join(run, directory, "host.jsonl"))
    if (hostText === undefined) return undefined
    const row = `${prefix}${directory}`
    const editsText = await readText(join(run, directory, `phase${phase}-edits.json`))
    const classText = await readText(join(run, directory, "latency-class.json"))
    const declared = classText === undefined ? undefined : classSchema.safeParse(JSON.parse(classText))
    if (declared && !declared.success) return { row, publications: [], failures: [inputFailure(row, "latency-class.json names an unknown class")] }
    const edits = editsText === undefined ? [] : editsSchema.parse(JSON.parse(editsText)).edits
    const continuityText = await readText(join(run, directory, "analysis.json"))
    const analysis = analyzeRow(row, parseHost(hostText), edits, declared?.data.class)
    if (continuityText !== undefined)
      analysis.failures.push(...assetEvidenceFailures(row, continuitySchema.parse(JSON.parse(continuityText)).assetPublicationFrame, analysis.publications))
    return { row, ...analysis }
  }))
  return analyses.flatMap((analysis) => analysis ?? [])
}

const analyzeRuns = async (runs: readonly string[], minimums: PooledMinimums): Promise<Analysis> => {
  const rows = (await Promise.all(runs.map((run) => analyzeRows(run, runs.length > 1 ? `${basename(dirname(run))}/` : "")))).flat()
  const publications = rows.flatMap((analysis) => analysis.publications)
  const pooled = judgePooled(publications, minimums)
  const failures = [
    ...(publications.length ? [] : [inputFailure("(run)", "no seam publications found")]),
    ...rows.flatMap((analysis) => [...analysis.failures, ...analysis.publications.flatMap(judgePublication)]),
    ...pooled.failures,
  ]
  const rowStatus = (row: { row: string; publications: Publication[] }): Status =>
    failures.some((failure) => failure.row === row.row) ? "FAIL"
      : row.publications.some((publication) => LIMITS[publication.class].prepareToPublishMaxMs === undefined) ? "INCOMPLETE" : "PASS"
  const rowStatuses = rows.map((row) => ({ row: row.row, status: rowStatus(row) }))
  const rowPrep = rows.flatMap((row) => {
    const { pooled: own, spectral } = poolOf(row.publications)
    return own.length ? [{ row: row.row, publications: own.length, spectral: spectral.length, prepP50Ms: percentile(own.map((publication) => publication.prepMs), 0.5) }] : []
  })
  const status: Status = failures.length ? "FAIL" : rowStatuses.some((entry) => entry.status === "INCOMPLETE") || pooled.incomplete.length ? "INCOMPLETE" : "PASS"
  return { publications, failures, incomplete: pooled.incomplete, rows: rowStatuses, rowPrep, status }
}

const phaseOf = (run: string) => {
  const phase = Number(/^phase(\d+)$/.exec(basename(run.replace(/\/$/, "")))?.[1])
  if (!Number.isInteger(phase)) throw new Error(`the run directory must end in phase<N>: ${run}`)
  return phase
}

// Per revision: prepare at `wall`, the bind at +1 ms, the armed Publish (last request) at +prepMs, the publication at +totalMs.
type Spec = {
  leadBlocks?: number; prepMs?: number; totalMs?: number; editMs?: number; blocksBeforeBind?: number; raise?: boolean
  install?: boolean; uploadBytes?: number; resend?: boolean; completeFrames?: number | "none"
  // The pinned and graph latency the host logs on this publication's graph-publish line.
  latency?: { pinned: number; graph: number }
  // The spectral predecessor count the host logs on that line; absent on evidence from before it did.
  spectral?: number
  // A latency publication stages no schedule window against its revision. A row without `windowed` has no schedule-window line at
  // all, as in evidence from before the line existed.
  unbound?: boolean
  // The app logged a ui-* mark this many ms before the publication; the step start is `editMs` before it.
  uiMarkMs?: number
  // The mark's name (default ui-parameter-commit), and the name of the harness step that made the edit.
  uiMark?: string; editName?: string
  // An earlier step this many ms before the edit that publishes nothing (the editor opening), with a ui-editor-open mark at its start.
  precededByMs?: number
}
// `delivers` writes the continuity analysis.json naming the publication at that index as the asset's; `noAsset` writes one naming none.
// `startLatency` is the latency of the session's first publication, before the first spec.
type RowOptions = { sampleRate?: number; declare?: string; delivers?: number; noAsset?: true; windowed?: true; startLatency?: { pinned: number; graph: number } }
const syntheticRow = (specs: readonly Spec[], options: RowOptions = {}) => {
  const base = { cause: "", pid: 1, transportEpoch: 5 }
  const lines: object[] = [{ event: "device-session", pid: 1, wallMs: 0, sampleRate: options.sampleRate ?? SAMPLE_RATE, blockSize: BLOCK }]
  if (options.startLatency)
    lines.push({ ...base, event: "graph-publish", cause: "configured-boundary", wallMs: 1, revision: 1, pinnedLatencyFrames: options.startLatency.pinned, graphLatencyFrames: options.startLatency.graph })
  const edits: object[] = []
  const frames: number[] = []
  specs.forEach((spec, index) => {
    const revision = index + 2, wall = 1_000_000 + index * 10_000, prepareFrame = BLOCK * 200 * (index + 1)
    const blocksBeforeBind = spec.blocksBeforeBind ?? 1
    const bindFrame = prepareFrame + BLOCK * blocksBeforeBind
    const publicationFrame = bindFrame + BLOCK * (spec.leadBlocks ?? 3)
    frames.push(publicationFrame)
    const request = (frame: number, wallMs: number) => ({ ...base, event: "graph-publish-request", wallMs, frame, revision: revision - 1, requestedRevision: revision })
    lines.push({ ...base, event: "graph-prepare", wallMs: wall, frame: prepareFrame, revision: revision - 1, requestedRevision: revision }, request(bindFrame, wall + 1))
    if (spec.install) lines.push({ ...base, event: "asset-install", wallMs: wall + 5 })
    if (spec.uploadBytes !== undefined) lines.push({ ...base, event: "asset-page-write", wallMs: wall + 6, bytes: spec.uploadBytes })
    lines.push(request(bindFrame + BLOCK, wall + (spec.prepMs ?? 4)))
    if (spec.resend) lines.push(request(publicationFrame - BLOCK, wall + 18))
    if (options.windowed && !spec.unbound) lines.push({ event: "schedule-window", wallMs: wall + 3, revision })
    if (spec.precededByMs !== undefined)
      lines.push({ event: "ui-editor-open", wallMs: wall + (spec.totalMs ?? 30) - (spec.editMs ?? 75) - spec.precededByMs + 5, pid: 1, key: "k" })
    if (spec.uiMarkMs !== undefined) lines.push({ event: spec.uiMark ?? "ui-parameter-commit", wallMs: wall + (spec.totalMs ?? 30) - spec.uiMarkMs, pid: 1, key: "k" })
    lines.push({ ...base, event: "graph-publish", cause: "block-boundary", wallMs: wall + (spec.totalMs ?? 30), frame: publicationFrame, publicationFrame, revision, requestedRevision: 0,
      pinnedLatencyFrames: spec.latency?.pinned, graphLatencyFrames: spec.latency?.graph,
      spectralPredecessors: spec.spectral })
    if (spec.completeFrames !== "none")
      lines.push({ ...base, event: "latency-move-complete", wallMs: wall + 100, frame: publicationFrame + (spec.completeFrames ?? COMPLETE_BASE_FRAMES + BLOCK * blocksBeforeBind), revision, requestedRevision: 0 })
    const editWallMs = wall + (spec.totalMs ?? 30) - (spec.editMs ?? 75)
    if (spec.precededByMs !== undefined) edits.push({ name: "editor-open", index: 2 * index + 1, wallMs: editWallMs - spec.precededByMs, fromLatencyFrames: 0, toLatencyFrames: 0 })
    edits.push({ name: spec.editName, index: 2 * index + 2, wallMs: editWallMs, fromLatencyFrames: 512, toLatencyFrames: spec.raise ? 4096 : 512 })
  })
  // An index past the last publication names frame 1, which no publication has.
  const delivered = options.delivers === undefined ? undefined : frames[options.delivers] ?? 1
  return { host: lines.map((line) => JSON.stringify(line)).join("\n"), edits: JSON.stringify({ edits }), declare: options.declare,
    continuity: delivered === undefined && !options.noAsset ? undefined : JSON.stringify(delivered === undefined ? {} : { assetPublicationFrame: delivered }) }
}

const SAMPLE_27_BYTES = 30_198_988

const selfTest = async (c1Runs: readonly string[]) => {
  const raise: Spec = { raise: true, totalMs: 42, completeFrames: 2560 }
  const clean: readonly Spec[] = [{}, { totalMs: 36 }, raise, { raise: true, totalMs: 62, blocksBeforeBind: 3, completeFrames: 3584 }]
  const withClean = (...extra: Spec[]): readonly Spec[] => [...clean, ...extra]
  // The cases written before the minimums judge pools of 3 to 7 publications, so they run with none; the cases of the minimums name POOLED_MIN_N.
  const NO_MINIMUM: PooledMinimums = { spectralPrepP50: 0, prepP50: 0, prepareToPublishP99: 0, editToPublishP50: 0 }
  const many = (count: number, spec: Spec): Spec[] => Array.from({ length: count }, () => spec)
  type Rows = [string, readonly Spec[], RowOptions?][]
  const cases: { name: string; rows: Rows; second?: Rows; pools?: PooledMinimums; status: Status; fails: Gate[] }[] = [
    { name: "conforming: plain, single raise, merged k=3 raise, asset add", status: "PASS", fails: [],
      rows: [["two-tone", clean], ["add-paged-asset", [{ totalMs: 90, install: true }]]] },
    { name: "re-sent Publish at the same seam is not a rebase", status: "PASS", fails: [], rows: [["two-tone", withClean({ resend: true })]] },
    { name: "asset install at the publication the continuity analysis names", status: "PASS", fails: [],
      rows: [["two-tone", clean, { noAsset: true }], ["add-paged-asset", [{ totalMs: 90, install: true }], { delivers: 0 }]] },
    // Without the cross-check the install lifts this plain publication from 70 ms to the asset class's 100 ms limit.
    { name: "spurious asset-install with no matching assetPublicationFrame", status: "FAIL", fails: ["inputs"],
      rows: [["two-tone", withClean({ totalMs: 90, install: true }), { noAsset: true }]] },
    { name: "asset-install on a publication other than the one the analysis names", status: "FAIL", fails: ["inputs"],
      rows: [["add-paged-asset", [{ totalMs: 90, install: true }, { totalMs: 90, install: true }], { delivers: 1 }]] },
    { name: "asset delivered without an asset-install", status: "FAIL", fails: ["inputs"],
      rows: [["add-paged-asset", [{ totalMs: 30 }], { delivers: 0 }]] },
    { name: "analysis names an asset frame no publication has", status: "FAIL", fails: ["inputs"],
      rows: [["add-paged-asset", [{ totalMs: 30 }], { delivers: 5 }]] },
    { name: "bound lead of 16 blocks", status: "FAIL", fails: ["lead", "rebase"], rows: [["two-tone", withClean({ leadBlocks: 16 })]] },
    { name: "bound lead of 1 block", status: "FAIL", fails: ["lead"], rows: [["two-tone", withClean({ leadBlocks: 1 })]] },
    { name: "moved publication frame (seam missed, 8 blocks late)", status: "FAIL", fails: ["lead", "rebase"], rows: [["two-tone", withClean({ leadBlocks: 11 })]] },
    { name: "late completion: k=1 raise completes 3584 frames", status: "FAIL", fails: ["completion"], rows: [["two-tone", withClean({ raise: true, completeFrames: 3584 })]] },
    { name: "raise with no completion", status: "FAIL", fails: ["completion"], rows: [["two-tone", withClean({ raise: true, completeFrames: "none" })]] },
    { name: "completion allowance is capped at k=3 (k=5 completes 4608)", status: "FAIL", fails: ["completion"],
      rows: [["two-tone", withClean({ raise: true, blocksBeforeBind: 5, completeFrames: 4608, totalMs: 60 })]] },
    { name: "plain publication at 75 ms (max and pooled p99)", status: "FAIL", fails: ["prepare-to-publish"], rows: [["two-tone", withClean({ totalMs: 75 })]] },
    { name: "merged raise at 85 ms", status: "FAIL", fails: ["prepare-to-publish"],
      rows: [["two-tone", withClean({ raise: true, totalMs: 85, blocksBeforeBind: 2, completeFrames: 3072 })]] },
    { name: "asset add at 105 ms", status: "FAIL", fails: ["prepare-to-publish"], rows: [["two-tone", clean], ["add-paged-asset", [{ totalMs: 105, install: true }]]] },
    { name: "resident swap (no bytes uploaded) at 101 ms fails the asset floor", status: "FAIL", fails: ["prepare-to-publish"],
      rows: [["add-paged-asset", [{ totalMs: 101, install: true }]]] },
    // 27 MiB sample: 30,198,988 bytes of planar PCM, so the limit is 70 + 90 = 160 ms.
    { name: "old evidence with no asset-page-write line keeps the 100 ms floor at 100 ms", status: "PASS", fails: [],
      rows: [["add-paged-asset", [{ totalMs: 100, install: true }]]] },
    { name: "27 MiB first swap at 105 ms is inside its 160 ms limit", status: "PASS", fails: [],
      rows: [["add-paged-asset", [{ totalMs: 105, install: true, uploadBytes: SAMPLE_27_BYTES }]]] },
    { name: "27 MiB first swap at 159 ms passes", status: "PASS", fails: [],
      rows: [["asset-159", [{ totalMs: 159, install: true, uploadBytes: SAMPLE_27_BYTES }]]] },
    { name: "27 MiB first swap at 161 ms fails", status: "FAIL", fails: ["prepare-to-publish"],
      rows: [["asset-161", [{ totalMs: 161, install: true, uploadBytes: SAMPLE_27_BYTES }]]] },
    { name: "edit to publish 160 ms", status: "FAIL", fails: ["edit-to-publish"], rows: [["two-tone", withClean({ editMs: 160 })]] },
    // A UI edit's step starts before the app commits it: with the mark the harness's own latency (here 85 ms) is not the product's.
    { name: "UI edit 160 ms from the step start but 75 ms from its ui mark", status: "PASS", fails: [], rows: [["two-tone", withClean({ editMs: 160, uiMarkMs: 75 })]] },
    { name: "UI edit 160 ms from its ui mark", status: "FAIL", fails: ["edit-to-publish"], rows: [["two-tone", withClean({ editMs: 170, uiMarkMs: 160 })]] },
    { name: "old evidence with no spectral field: prep time p50 9 ms keeps the 8 ms pool", status: "FAIL", fails: ["prep-time"], rows: [["two-tone", [{ prepMs: 9 }, { prepMs: 9 }, { prepMs: 9 }]]] },
    { name: "spectral population at prep p50 9 ms passes its 12 ms pool", status: "PASS", fails: [],
      rows: [["two-tone", [{ prepMs: 9, spectral: 1 }, { prepMs: 9, spectral: 1 }, { prepMs: 9, spectral: 2 }]]] },
    { name: "spectral population at prep p50 13 ms fails", status: "FAIL", fails: ["prep-time"],
      rows: [["two-tone", [{ prepMs: 13, spectral: 1 }, { prepMs: 13, spectral: 1 }, { prepMs: 13, spectral: 1 }]]] },
    { name: "non-spectral population (spectral 0) at prep p50 9 ms fails the 8 ms pool", status: "FAIL", fails: ["prep-time"],
      rows: [["two-tone", [{ prepMs: 9, spectral: 0 }, { prepMs: 9, spectral: 0 }, { prepMs: 9, spectral: 0 }]]] },
    { name: "spectral publications do not lift a non-spectral population over 8 ms", status: "FAIL", fails: ["prep-time"],
      rows: [["two-tone", [{ prepMs: 9, spectral: 0 }, { prepMs: 9, spectral: 0 }, { prepMs: 9, spectral: 1 }, { prepMs: 9, spectral: 1 }, { prepMs: 9, spectral: 1 }]]] },
    { name: "session at 44.1 kHz is an input failure", status: "FAIL", fails: ["inputs"], rows: [["two-tone", clean, { sampleRate: 44100 }]] },
    { name: "unknown declared class is an input failure", status: "FAIL", fails: ["inputs"], rows: [["two-tone", clean, { declare: JSON.stringify({ class: "mystery" }) }]] },
    { name: "latency publication with no seam (lead 0) in a row with schedule windows is not a lead failure", status: "PASS", fails: [],
      rows: [["open-editor", withClean({ unbound: true, leadBlocks: 0 }), { windowed: true }]] },
    { name: "seam-bound publication of a row with schedule windows still fails a lead of 1", status: "FAIL", fails: ["lead"],
      rows: [["open-editor", withClean({ leadBlocks: 1 }), { windowed: true }]] },
    { name: "a row with no schedule-window line judges lead 0", status: "FAIL", fails: ["lead"], rows: [["open-editor", withClean({ leadBlocks: 0 })]] },
    { name: "an editor step that publishes nothing owns no publication (edit 2 is 48 ms, the editor opened 1.7 s before)", status: "PASS", fails: [],
      rows: [["open-editor", withClean({ totalMs: 60, editMs: 48, precededByMs: 1700 })]] },
    { name: "the edit after the editor step still fails at 160 ms", status: "FAIL", fails: ["edit-to-publish"],
      rows: [["open-editor", withClean({ totalMs: 60, editMs: 160, precededByMs: 1700 })]] },
    { name: "VST insert 200 ms from its ui-device-insert mark, prepare 60 ms", status: "PASS", fails: [],
      rows: [["vst-remove-undo", withClean({ totalMs: 60, editMs: 260, uiMark: "ui-device-insert", uiMarkMs: 200 })]] },
    { name: "VST insert 260 ms from its mark", status: "FAIL", fails: ["edit-to-publish"],
      rows: [["vst-remove-undo", withClean({ totalMs: 60, editMs: 300, uiMark: "ui-device-insert", uiMarkMs: 260 })]] },
    { name: "VST insert prepare to publish 75 ms", status: "FAIL", fails: ["prepare-to-publish"],
      rows: [["vst-remove-undo", withClean({ totalMs: 75, editMs: 80, uiMark: "ui-device-insert", uiMarkMs: 75 })]] },
    { name: "the row's declared insert step is a VST insert at 160 ms", status: "PASS", fails: [],
      rows: [["vst-insert", withClean({ totalMs: 60, editMs: 160, editName: "vst-insert" }), { declare: JSON.stringify({ class: "vst-insert" }) }]] },
    { name: "a remove of a row declared vst-insert stays plain: 160 ms fails", status: "FAIL", fails: ["edit-to-publish"],
      rows: [["vst-insert", withClean({ totalMs: 60, editMs: 160, editName: "vst-remove" }), { declare: JSON.stringify({ class: "vst-insert" }) }]] },
    { name: "a VST insert still fails the lead gate", status: "FAIL", fails: ["lead", "rebase"],
      rows: [["vst-insert", withClean({ totalMs: 60, leadBlocks: 16, editName: "vst-insert" }), { declare: JSON.stringify({ class: "vst-insert" }) }]] },
    // The vst-latency-switch shape: a budget raise 512 -> 4608 completes in 2 fades (512 observed); a lower and a raise inside the
    // pinned budget move a head 4096 frames, so they complete in ceil((4096 + 480) / 512) = 9 blocks (4608 observed).
    { name: "budget raise completing 512, then in-budget lower and raise completing 4608", status: "PASS", fails: [],
      rows: [["vst-latency-switch", [{ raise: true, latency: { pinned: 4608, graph: 4608 }, completeFrames: 512 },
        { latency: { pinned: 4608, graph: 512 }, completeFrames: 4608 }, { latency: { pinned: 4608, graph: 4608 }, completeFrames: 4608 }],
        { startLatency: { pinned: 512, graph: 512 } }]] },
    { name: "in-budget lower completing 4608 + 1024 frames", status: "FAIL", fails: ["completion"],
      rows: [["vst-latency-switch", [{ raise: true, latency: { pinned: 4608, graph: 4608 }, completeFrames: 512 },
        { latency: { pinned: 4608, graph: 512 }, completeFrames: 5632 }], { startLatency: { pinned: 512, graph: 512 } }]] },
    { name: "in-budget raise completing late", status: "FAIL", fails: ["completion"],
      rows: [["vst-latency-switch", [{ raise: true, latency: { pinned: 4608, graph: 4608 }, completeFrames: 5632 }], { startLatency: { pinned: 4608, graph: 512 } }]] },
    { name: "budget raise completing 1536 frames", status: "FAIL", fails: ["completion"],
      rows: [["vst-latency-switch", [{ raise: true, latency: { pinned: 4608, graph: 4608 }, completeFrames: 1536 }], { startLatency: { pinned: 512, graph: 512 } }]] },
    // A spectral graph's stages hold completion (audio_core.cpp:9141-9145), so it keeps COMPLETE_BASE_FRAMES (2048) + bind slack.
    { name: "spectral raise completing 2048 passes", status: "PASS", fails: [],
      rows: [["spectral-raise", [{ raise: true, latency: { pinned: 4608, graph: 4608 }, spectral: 1, completeFrames: 2048 }], { startLatency: { pinned: 512, graph: 512 } }]] },
    { name: "spectral raise completing past 2048 + the bind slack fails", status: "FAIL", fails: ["completion"],
      rows: [["spectral-raise", [{ raise: true, latency: { pinned: 4608, graph: 4608 }, spectral: 1, completeFrames: 3072 }], { startLatency: { pinned: 512, graph: 512 } }]] },
    { name: "the same raise with no spectral predecessors and 2048 completion fails the formula", status: "FAIL", fails: ["completion"],
      rows: [["spectral-raise", [{ raise: true, latency: { pinned: 4608, graph: 4608 }, spectral: 0, completeFrames: 2048 }], { startLatency: { pinned: 512, graph: 512 } }]] },
    { name: "old evidence with no latency or spectral fields keeps the 2048 allowance", status: "PASS", fails: [],
      rows: [["old-evidence", [{ raise: true, completeFrames: 2048 }]]] },
    // The minimums (POOLED_MIN_N): spectral 40, non-spectral 100, p99 and edit p50 100.
    { name: "minimums: a spectral pool of 10 over its 12 ms limit is INCOMPLETE, not judged", status: "INCOMPLETE", fails: [], pools: POOLED_MIN_N,
      rows: [["two-tone", [...many(10, { prepMs: 13, spectral: 1 }), ...many(100, {})]]] },
    { name: "minimums: a spectral pool of 39 is INCOMPLETE", status: "INCOMPLETE", fails: [], pools: POOLED_MIN_N,
      rows: [["two-tone", [...many(39, { prepMs: 9, spectral: 1 }), ...many(100, {})]]] },
    { name: "minimums: a spectral pool of 40 at prep p50 9 ms is judged and passes", status: "PASS", fails: [], pools: POOLED_MIN_N,
      rows: [["two-tone", [...many(40, { prepMs: 9, spectral: 1 }), ...many(100, {})]]] },
    { name: "minimums: a spectral pool of 40 at prep p50 13 ms is judged and fails", status: "FAIL", fails: ["prep-time"], pools: POOLED_MIN_N,
      rows: [["two-tone", [...many(40, { prepMs: 13, spectral: 1 }), ...many(100, {})]]] },
    { name: "minimums: a non-spectral pool of 99 is INCOMPLETE", status: "INCOMPLETE", fails: [], pools: POOLED_MIN_N,
      rows: [["two-tone", [...many(40, { prepMs: 9, spectral: 1 }), ...many(99, {})]]] },
    { name: "minimums: a non-spectral pool of 100 at prep p50 9 ms is judged and fails", status: "FAIL", fails: ["prep-time"], pools: POOLED_MIN_N,
      rows: [["two-tone", [...many(40, { prepMs: 9, spectral: 1 }), ...many(100, { prepMs: 9 })]]] },
    { name: "minimums: 99 publications leave the pooled p99 and edit p50 INCOMPLETE", status: "INCOMPLETE", fails: [], pools: { ...POOLED_MIN_N, spectralPrepP50: 0, prepP50: 0 },
      rows: [["two-tone", many(99, {})]] },
    { name: "minimums: a failing publication beats an INCOMPLETE pool", status: "FAIL", fails: ["prepare-to-publish"], pools: POOLED_MIN_N,
      rows: [["two-tone", [{ totalMs: 75 }]]] },
    { name: "two run directories pool their publications: 20 + 20 spectral and 100 plain pass", status: "PASS", fails: [], pools: POOLED_MIN_N,
      rows: [["two-tone", [...many(20, { prepMs: 9, spectral: 1 }), ...many(100, {})]]], second: [["two-tone", many(20, { prepMs: 9, spectral: 1 })]] },
    { name: "two run directories pool: 20 + 20 spectral at 13 ms fail the pooled gate", status: "FAIL", fails: ["prep-time"], pools: POOLED_MIN_N,
      rows: [["two-tone", [...many(20, { prepMs: 13, spectral: 1 }), ...many(100, {})]]], second: [["two-tone", many(20, { prepMs: 13, spectral: 1 })]] },
    { name: "the first of two run directories alone is INCOMPLETE", status: "INCOMPLETE", fails: [], pools: POOLED_MIN_N,
      rows: [["two-tone", [...many(20, { prepMs: 9, spectral: 1 }), ...many(100, {})]]] },
  ]
  const root = await mkdtemp(join(tmpdir(), "ae08-latency-gates-"))
  let failed = 0
  const report = (ok: boolean, line: string) => { if (!ok) failed++; console.log(`${ok ? "ok  " : "BAD "} ${line}`) }
  try {
    const writeRun = async (run: string, rows: Rows) => {
      for (const [row, specs, options] of rows) {
        const synthetic = syntheticRow(specs, options)
        await mkdir(join(run, row), { recursive: true })
        await writeFile(join(run, row, "host.jsonl"), synthetic.host)
        await writeFile(join(run, row, "phase9-edits.json"), synthetic.edits)
        if (synthetic.declare) await writeFile(join(run, row, "latency-class.json"), synthetic.declare)
        if (synthetic.continuity) await writeFile(join(run, row, "analysis.json"), synthetic.continuity)
      }
      return run
    }
    for (const [index, testCase] of cases.entries()) {
      const runs = [await writeRun(join(root, `case-${index}`, "phase9"), testCase.rows), ...(testCase.second ? [await writeRun(join(root, `case-${index}-b`, "phase9"), testCase.second)] : [])]
      const analysis = await analyzeRuns(runs, testCase.pools ?? NO_MINIMUM)
      const actual = [...new Set(analysis.failures.map((failure) => failure.gate))]
      report(analysis.status === testCase.status && actual.join() === testCase.fails.join(),
        `${testCase.name}: want ${testCase.status} [${testCase.fails}], got ${analysis.status} [${actual}]`)
    }
    for (const run of c1Runs) {
      const analysis = await analyzeRuns([run], POOLED_MIN_N)
      const gates = [...new Set(analysis.failures.map((failure) => failure.gate))]
      report(analysis.status === "FAIL", `negative control ${run}: want FAIL, got ${analysis.status} [${gates}] (${analysis.failures.length} failures)`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  console.log(failed ? `self-test FAILED (${failed})` : `self-test passed (${cases.length} synthetic cases, ${c1Runs.length} negative controls)`)
  return failed === 0
}

const main = async () => {
  const args = process.argv.slice(2)
  const values = (flag: string) => args.flatMap((arg, index) => arg === flag ? args[index + 1] ?? [] : [])
  if (args.includes("--self-test")) {
    const c1Runs = values("--c1")
    if (!c1Runs.length) throw new Error("--self-test needs the C1 evidence as a negative control: --c1 <phaseDir> [--c1 <phaseDir>...]")
    return process.exit(await selfTest(c1Runs) ? 0 : 1)
  }
  const runs = values("--run")
  const [first] = runs
  if (!first) throw new Error("usage: ae-08-latency-gates.ts --run <phaseDir> [--run <phaseDir>...] [--out <file>] | --self-test --c1 <phaseDir>...")
  const analysis = await analyzeRuns(runs, POOLED_MIN_N)
  const out = values("--out")[0] ?? join(first, "latency-gates.json")
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify({ runs, sampleRate: SAMPLE_RATE, blockSize: BLOCK, minimums: POOLED_MIN_N, ...analysis }, null, 2)}\n`)
  for (const row of analysis.rows) console.log(`${row.status} ${row.row}`)
  for (const row of analysis.rowPrep) console.log(`prep p50 ${row.row}: ${row.prepP50Ms} ms over ${row.publications} publications (${row.spectral} spectral)`)
  for (const failure of analysis.failures) console.log(`FAIL ${failure.row} ${failure.gate}: ${failure.detail}`)
  for (const pool of analysis.incomplete) console.log(`INCOMPLETE (pooled) ${pool}`)
  console.log(`${analysis.status} LAT1 gates: ${analysis.publications.length} publications -> ${out}`)
  process.exit(analysis.status === "PASS" ? 0 : 1)
}

await main()
