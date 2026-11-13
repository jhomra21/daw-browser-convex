// AE-08 frozen LAT1 latency gates. Standalone judge for the publication timing of a packaged run, 48 kHz / 512-frame blocks.
// It reads each row's host.jsonl (and phaseN-edits.json, and an optional latency-class.json) and gives a verdict per row.
//
//   bun tools/acceptance/ae-08-latency-gates.ts --run <phaseDir> [--out <file>]     phaseDir ends in phase<N>
//   bun tools/acceptance/ae-08-latency-gates.ts --self-test --c1 <phaseDir> [--c1 <phaseDir>...]
//
// FROZEN 2026-11-13 by the parent ruling on /tmp/ae08-lat1-gates-proposal.md §2, before any run it judges.
// Evidence the numbers come from (acceptance-reports/ae-08-phase-5-2026-10-18/):
//   C1 pre-LAT1: processor-owner-certification/phase4, /phase5 (negative control, every gate must fail)
//   LAT1 certified: rc-p5c/phase4, /phase5; earlier LAT1 runs rc-p5a, rc-p5b (spread)
// Only the parent changes a constant below, by a new ruling, and never after seeing the data it would judge.
// The verdict is the worst row: FAIL, else INCOMPLETE (a row has no frozen limit yet), else PASS.
// One publication over its limit fails its row and the run continues; only a product error dialog, a host crash
// or a freeze mismatch stops a campaign.
//
// Definitions, all read from host.jsonl (the host logs the native applied frame, not the requested one):
// - bind: the first `graph-publish-request` of a revision. Lead = publication frame - bind frame, in blocks.
// - rebase: the publication frame moved past the bound seam (lead above LEAD_MAX_BLOCKS). A re-sent Publish at the
//   same seam is not a rebase.
// - prepare to publish: `graph-prepare` to `graph-publish`. Edit to publish: the first edit the publication carries
//   (the first publication at or after the edit's wall time owns it) to `graph-publish`.
// - completion: `latency-move-complete` frame - publication frame. Frames, not time, so no margin is added.
// - class: asset when the host logged an `asset-install` between prepare and publish; raise when the edits' net
//   latency move is positive (merged when 2+ blocks pass between prepare and bind); else plain. A row can declare
//   its class in latency-class.json; an unknown class is an input failure.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { z } from "zod"

const SAMPLE_RATE = 48000
const BLOCK = 512
const LEAD_MIN_BLOCKS = 2
const LEAD_MAX_BLOCKS = 3
const COMPLETE_BASE_FRAMES = 2048
const COMPLETE_MAX_BLOCKS_BEFORE_BIND = 3
// A class with no frozen prepare-to-publish limit makes its row INCOMPLETE until the parent freezes one here.
const LIMITS = {
  plain: { prepareToPublishMaxMs: 70, editToPublishMaxMs: 150 },
  raise: { prepareToPublishMaxMs: 70, editToPublishMaxMs: 150 },
  "raise-merged": { prepareToPublishMaxMs: 80, editToPublishMaxMs: 150 },
  asset: { prepareToPublishMaxMs: 100, editToPublishMaxMs: undefined },
  "vst-insert": { prepareToPublishMaxMs: undefined, editToPublishMaxMs: undefined },
}
// Pooled over the plain and raise publications of the run.
const POOLED = { prepareToPublishP99Ms: 60, prepP50Ms: 8, editToPublishP50Ms: 100 }

type Class = keyof typeof LIMITS
type Gate = "inputs" | "lead" | "rebase" | "prepare-to-publish" | "prep-time" | "edit-to-publish" | "completion"
type Failure = { row: string; gate: Gate; detail: string }
type Status = "PASS" | "INCOMPLETE" | "FAIL"
type Publication = {
  row: string; revision: number; class: Class; raise: boolean; leadBlocks: number; prepareToPublishMs: number; prepMs: number
  editToPublishMs: number | undefined; completeFrames: number | undefined; blocksBeforeBind: number
}
type Analysis = { publications: Publication[]; failures: Failure[]; rows: { row: string; status: Status }[]; status: Status }

const inputFailure = (row: string, detail: string): Failure => ({ row, gate: "inputs", detail })

const hostEventSchema = z.object({
  event: z.string(), cause: z.string().default(""), pid: z.number().default(0), wallMs: z.number().default(0),
  frame: z.number().default(0), revision: z.number().default(0), requestedRevision: z.number().default(0),
  publicationFrame: z.number().default(0), transportEpoch: z.number().default(0), sampleRate: z.number().default(0),
  blockSize: z.number().default(0),
})
const editsSchema = z.object({ edits: z.array(z.object({
  wallMs: z.number(), fromLatencyFrames: z.number(), toLatencyFrames: z.number() })).default([]) })
const classSchema = z.object({ class: z.enum(["plain", "raise", "asset", "vst-insert"]) })
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

const classOf = (declared: Class | undefined, asset: boolean, raise: boolean, blocksBeforeBind: number): Class => {
  const base = declared ?? (asset ? "asset" : raise ? "raise" : "plain")
  return base === "raise" && blocksBeforeBind >= 2 ? "raise-merged" : base
}

const analyzeRow = (row: string, events: readonly HostEvent[], edits: z.infer<typeof editsSchema>["edits"], declared: Class | undefined) => {
  const drafts: (Omit<Publication, "class" | "raise" | "editToPublishMs"> & { asset: boolean; wallMs: number })[] = []
  const failures: Failure[] = []
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
    const blocksBeforeBind = Math.max(1, Math.round((bind.frame - prepare.event.frame) / BLOCK))
    drafts.push({
      row, revision, asset, blocksBeforeBind, wallMs: publish.wallMs,
      leadBlocks: (publish.publicationFrame - bind.frame) / BLOCK, prepareToPublishMs: publish.wallMs - prepare.event.wallMs,
      prepMs: armed.wallMs - prepare.event.wallMs, completeFrames: complete ? complete.frame - publish.publicationFrame : undefined,
    })
  })
  const netMove = drafts.map(() => 0)
  const firstEditMs: (number | undefined)[] = drafts.map(() => undefined)
  for (const edit of edits) {
    const owner = drafts.findIndex((draft) => draft.wallMs >= edit.wallMs)
    if (owner < 0) continue
    netMove[owner] = (netMove[owner] ?? 0) + edit.toLatencyFrames - edit.fromLatencyFrames
    firstEditMs[owner] = Math.min(firstEditMs[owner] ?? edit.wallMs, edit.wallMs)
  }
  const publications = drafts.map(({ asset, wallMs, ...draft }, index): Publication => {
    const raise = (netMove[index] ?? 0) > 0
    const editMs = firstEditMs[index]
    return { ...draft, raise, editToPublishMs: editMs === undefined ? undefined : wallMs - editMs, class: classOf(declared, asset, raise, draft.blocksBeforeBind) }
  })
  return { failures, publications }
}

const judgePublication = (publication: Publication): Failure[] => {
  const { row, revision, leadBlocks } = publication
  const limits = LIMITS[publication.class]
  const allowedComplete = COMPLETE_BASE_FRAMES + BLOCK * Math.min(publication.blocksBeforeBind, COMPLETE_MAX_BLOCKS_BEFORE_BIND)
  const fail = (gate: Gate, detail: string): Failure => ({ row, gate, detail: `rev ${revision} ${detail}` })
  return [
    ...(!Number.isInteger(leadBlocks) || leadBlocks < LEAD_MIN_BLOCKS || leadBlocks > LEAD_MAX_BLOCKS
      ? [fail("lead", `lead ${leadBlocks} blocks, want ${LEAD_MIN_BLOCKS}..${LEAD_MAX_BLOCKS}`)] : []),
    ...(leadBlocks > LEAD_MAX_BLOCKS ? [fail("rebase", "publication frame moved past the bound seam")] : []),
    ...(limits.prepareToPublishMaxMs !== undefined && publication.prepareToPublishMs > limits.prepareToPublishMaxMs
      ? [fail("prepare-to-publish", `${publication.prepareToPublishMs} > ${limits.prepareToPublishMaxMs} ms (${publication.class})`)] : []),
    ...(limits.editToPublishMaxMs !== undefined && (publication.editToPublishMs ?? 0) > limits.editToPublishMaxMs
      ? [fail("edit-to-publish", `${publication.editToPublishMs} > ${limits.editToPublishMaxMs} ms (${publication.class})`)] : []),
    ...((publication.raise && publication.completeFrames === undefined) || (publication.completeFrames ?? 0) > allowedComplete
      ? [fail("completion", `${publication.completeFrames ?? "no completion"} > ${allowedComplete} frames`)] : []),
  ]
}

const judgePooled = (publications: readonly Publication[]): Failure[] => {
  const pooled = publications.filter((publication) => publication.class === "plain" || publication.class === "raise")
  const editMs = pooled.flatMap((publication) => publication.editToPublishMs ?? [])
  const stat = (values: readonly number[], fraction: number) => values.length ? percentile(values, fraction) : 0
  const p99 = stat(pooled.map((publication) => publication.prepareToPublishMs), 0.99)
  const prepP50 = stat(pooled.map((publication) => publication.prepMs), 0.5)
  const editP50 = stat(editMs, 0.5)
  const fail = (gate: Gate, detail: string): Failure => ({ row: "(pooled)", gate, detail })
  return [
    ...(p99 > POOLED.prepareToPublishP99Ms ? [fail("prepare-to-publish", `pooled p99 ${p99} > ${POOLED.prepareToPublishP99Ms} ms`)] : []),
    ...(prepP50 > POOLED.prepP50Ms ? [fail("prep-time", `pooled prep p50 ${prepP50} > ${POOLED.prepP50Ms} ms`)] : []),
    ...(editP50 > POOLED.editToPublishP50Ms ? [fail("edit-to-publish", `pooled p50 ${editP50} > ${POOLED.editToPublishP50Ms} ms`)] : []),
  ]
}

const analyzeRun = async (run: string, phase: number): Promise<Analysis> => {
  const names = (await readdir(run, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  const analyses = await Promise.all(names.map(async (row) => {
    const hostText = await readText(join(run, row, "host.jsonl"))
    if (hostText === undefined) return undefined
    const editsText = await readText(join(run, row, `phase${phase}-edits.json`))
    const classText = await readText(join(run, row, "latency-class.json"))
    const declared = classText === undefined ? undefined : classSchema.safeParse(JSON.parse(classText))
    if (declared && !declared.success) return { row, publications: [], failures: [inputFailure(row, "latency-class.json names an unknown class")] }
    const edits = editsText === undefined ? [] : editsSchema.parse(JSON.parse(editsText)).edits
    return { row, ...analyzeRow(row, parseHost(hostText), edits, declared?.data.class) }
  }))
  const rows = analyses.flatMap((analysis) => analysis ?? [])
  const publications = rows.flatMap((analysis) => analysis.publications)
  const failures = [
    ...(publications.length ? [] : [inputFailure("(run)", "no seam publications found")]),
    ...rows.flatMap((analysis) => [...analysis.failures, ...analysis.publications.flatMap(judgePublication)]),
    ...judgePooled(publications),
  ]
  const rowStatus = (row: { row: string; publications: Publication[] }): Status =>
    failures.some((failure) => failure.row === row.row) ? "FAIL"
      : row.publications.some((publication) => LIMITS[publication.class].prepareToPublishMaxMs === undefined) ? "INCOMPLETE" : "PASS"
  const rowStatuses = rows.map((row) => ({ row: row.row, status: rowStatus(row) }))
  const status: Status = failures.length ? "FAIL" : rowStatuses.some((entry) => entry.status === "INCOMPLETE") ? "INCOMPLETE" : "PASS"
  return { publications, failures, rows: rowStatuses, status }
}

const phaseOf = (run: string) => {
  const phase = Number(/^phase(\d+)$/.exec(basename(run.replace(/\/$/, "")))?.[1])
  if (!Number.isInteger(phase)) throw new Error(`the run directory must end in phase<N>: ${run}`)
  return phase
}

// Per revision: prepare at `wall`, the bind at +1 ms, the armed Publish (last request) at +prepMs, the publication at +totalMs.
type Spec = {
  leadBlocks?: number; prepMs?: number; totalMs?: number; editMs?: number; blocksBeforeBind?: number; raise?: boolean
  install?: boolean; resend?: boolean; completeFrames?: number | "none"
}
const syntheticRow = (specs: readonly Spec[], options: { sampleRate?: number; declare?: string } = {}) => {
  const base = { cause: "", pid: 1, transportEpoch: 5 }
  const lines: object[] = [{ event: "device-session", pid: 1, wallMs: 0, sampleRate: options.sampleRate ?? SAMPLE_RATE, blockSize: BLOCK }]
  const edits: object[] = []
  specs.forEach((spec, index) => {
    const revision = index + 2, wall = 1_000_000 + index * 10_000, prepareFrame = BLOCK * 200 * (index + 1)
    const blocksBeforeBind = spec.blocksBeforeBind ?? 1
    const bindFrame = prepareFrame + BLOCK * blocksBeforeBind
    const publicationFrame = bindFrame + BLOCK * (spec.leadBlocks ?? 3)
    const request = (frame: number, wallMs: number) => ({ ...base, event: "graph-publish-request", wallMs, frame, revision: revision - 1, requestedRevision: revision })
    lines.push({ ...base, event: "graph-prepare", wallMs: wall, frame: prepareFrame, revision: revision - 1, requestedRevision: revision }, request(bindFrame, wall + 1))
    if (spec.install) lines.push({ ...base, event: "asset-install", wallMs: wall + 5 })
    lines.push(request(bindFrame + BLOCK, wall + (spec.prepMs ?? 4)))
    if (spec.resend) lines.push(request(publicationFrame - BLOCK, wall + 18))
    lines.push({ ...base, event: "graph-publish", cause: "block-boundary", wallMs: wall + (spec.totalMs ?? 30), frame: publicationFrame, publicationFrame, revision, requestedRevision: 0 })
    if (spec.completeFrames !== "none")
      lines.push({ ...base, event: "latency-move-complete", wallMs: wall + 100, frame: publicationFrame + (spec.completeFrames ?? COMPLETE_BASE_FRAMES + BLOCK * blocksBeforeBind), revision, requestedRevision: 0 })
    edits.push({ wallMs: wall + (spec.totalMs ?? 30) - (spec.editMs ?? 75), fromLatencyFrames: 512, toLatencyFrames: spec.raise ? 4096 : 512 })
  })
  return { host: lines.map((line) => JSON.stringify(line)).join("\n"), edits: JSON.stringify({ edits }), declare: options.declare }
}

const selfTest = async (c1Runs: readonly string[]) => {
  const raise: Spec = { raise: true, totalMs: 42, completeFrames: 2560 }
  const clean: readonly Spec[] = [{}, { totalMs: 36 }, raise, { raise: true, totalMs: 62, blocksBeforeBind: 3, completeFrames: 3584 }]
  const withClean = (...extra: Spec[]): readonly Spec[] => [...clean, ...extra]
  const cases: { name: string; rows: [string, readonly Spec[], { sampleRate?: number; declare?: string }?][]; status: Status; fails: Gate[] }[] = [
    { name: "conforming: plain, single raise, merged k=3 raise, asset add", status: "PASS", fails: [],
      rows: [["two-tone", clean], ["add-paged-asset", [{ totalMs: 90, install: true }]]] },
    { name: "re-sent Publish at the same seam is not a rebase", status: "PASS", fails: [], rows: [["two-tone", withClean({ resend: true })]] },
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
    { name: "edit to publish 160 ms", status: "FAIL", fails: ["edit-to-publish"], rows: [["two-tone", withClean({ editMs: 160 })]] },
    { name: "prep time p50 9 ms", status: "FAIL", fails: ["prep-time"], rows: [["two-tone", [{ prepMs: 9 }, { prepMs: 9 }, { prepMs: 9 }]]] },
    { name: "session at 44.1 kHz is an input failure", status: "FAIL", fails: ["inputs"], rows: [["two-tone", clean, { sampleRate: 44100 }]] },
    { name: "unknown declared class is an input failure", status: "FAIL", fails: ["inputs"], rows: [["two-tone", clean, { declare: JSON.stringify({ class: "mystery" }) }]] },
    { name: "vst-insert row with in-range lead has no frozen limit: INCOMPLETE", status: "INCOMPLETE", fails: [],
      rows: [["two-tone", clean], ["vst-insert", [{ totalMs: 400 }], { declare: JSON.stringify({ class: "vst-insert" }) }]] },
    { name: "vst-insert row still fails the lead gate", status: "FAIL", fails: ["lead", "rebase"],
      rows: [["vst-insert", [{ totalMs: 400, leadBlocks: 16 }], { declare: JSON.stringify({ class: "vst-insert" }) }]] },
  ]
  const root = await mkdtemp(join(tmpdir(), "ae08-latency-gates-"))
  let failed = 0
  const report = (ok: boolean, line: string) => { if (!ok) failed++; console.log(`${ok ? "ok  " : "BAD "} ${line}`) }
  try {
    for (const [index, testCase] of cases.entries()) {
      const run = join(root, `case-${index}`, "phase9")
      for (const [row, specs, options] of testCase.rows) {
        const synthetic = syntheticRow(specs, options)
        await mkdir(join(run, row), { recursive: true })
        await writeFile(join(run, row, "host.jsonl"), synthetic.host)
        await writeFile(join(run, row, "phase9-edits.json"), synthetic.edits)
        if (synthetic.declare) await writeFile(join(run, row, "latency-class.json"), synthetic.declare)
      }
      const analysis = await analyzeRun(run, 9)
      const actual = [...new Set(analysis.failures.map((failure) => failure.gate))]
      report(analysis.status === testCase.status && actual.join() === testCase.fails.join(),
        `${testCase.name}: want ${testCase.status} [${testCase.fails}], got ${analysis.status} [${actual}]`)
    }
    for (const run of c1Runs) {
      const analysis = await analyzeRun(run, phaseOf(run))
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
  const run = values("--run")[0]
  if (!run) throw new Error("usage: ae-08-latency-gates.ts --run <phaseDir> [--out <file>] | --self-test --c1 <phaseDir>...")
  const analysis = await analyzeRun(run, phaseOf(run))
  const out = values("--out")[0] ?? join(run, "latency-gates.json")
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify({ run, sampleRate: SAMPLE_RATE, blockSize: BLOCK, ...analysis }, null, 2)}\n`)
  for (const row of analysis.rows) console.log(`${row.status} ${row.row}`)
  for (const failure of analysis.failures) console.log(`FAIL ${failure.row} ${failure.gate}: ${failure.detail}`)
  console.log(`${analysis.status} LAT1 gates: ${analysis.publications.length} publications -> ${out}`)
  process.exit(analysis.status === "PASS" ? 0 : 1)
}

await main()
