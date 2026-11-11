// LAT1 timing judge: frozen and standalone. It reads each row's host.jsonl in a packaged phase directory and judges
// the late-seam-binding targets (PARENT-RULING-LAT1-CERTIFIED.md, LAT1-DESIGN.md §6) at 48 kHz with 512-frame blocks.
//
//   bun tools/acceptance/analyze-lat1-timing.ts --run <phaseDir> [--phase 4|5] [--out <file>]
//   bun tools/acceptance/analyze-lat1-timing.ts --self-test
//
// Host evidence has no requested-frame field. `graph-publish-request` logs the native applied frame, so:
// - the bind is the first `graph-publish-request` of a revision, and its lead is publicationFrame - request.frame;
// - a later request is a rebase request when the publication still lies more than 3 blocks after it. A re-sent
//   Publish (native answered PublishPending) is logged at the same seam and stays within the bound lead.
// - a publication is an asset publication when the host logged an `asset-install` for its pid between its prepare and
//   its publish. A track-only publication installs nothing and is judged against the plain limits.
// - the continuity analysis (analysis.json `assetPublicationFrame`) names the one publication that delivers an asset.
//   Exactly that publication must carry an install, and no other may. Missing or partial evidence is an input failure.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"

const SAMPLE_RATE = 48000
const BLOCK = 512
const LEAD_MIN_BLOCKS = 2
const LEAD_MAX_BLOCKS = 3
const PLAIN_LIMITS_MS = { p99: 60, max: 70 }
// Preparation time: from prepare to the armed Publish, the last publish request before the publication (PARENT-RULING-LAT1-PREP-OVERHEAD.md, Correction).
const PREP_P50_MS = 8
const ASSET_LIMIT_MS = 100
const COMPLETE_BASE_FRAMES = 2048

type HostEvent = z.infer<typeof hostEventSchema>
type Edit = z.infer<typeof editsSchema>["edits"][number]
type Publication = {
  row: string; revision: number; publicationFrame: number; asset: boolean
  leadBlocks: number; prepareToPublishMs: number; prepMs: number; blockPhaseMs: number; rebaseRequests: number; resentRequests: number
  blocksBeforeBind: number; raise: boolean; completeFrames: number | undefined; allowedCompleteFrames: number
}
type Verdict = { target: string; status: "PASS" | "FAIL" | "SKIP" | "INFO"; detail: string }
type Analysis = { publications: Publication[]; errors: string[]; verdicts: Verdict[] }

const hostEventSchema = z.object({
  event: z.string(), cause: z.string().default(""), pid: z.number().default(0), wallMs: z.number().default(0),
  frame: z.number().default(0), revision: z.number().default(0), requestedRevision: z.number().default(0),
  publicationFrame: z.number().default(0), transportEpoch: z.number().default(0), sampleRate: z.number().default(0),
  blockSize: z.number().default(0),
})
const editsSchema = z.object({ edits: z.array(z.object({
  wallMs: z.number(), fromLatencyFrames: z.number(), toLatencyFrames: z.number() })).default([]) })

const continuitySchema = z.object({ assetPublicationFrame: z.number().optional() }).passthrough()

const readHost = async (file: string): Promise<HostEvent[]> => (await readFile(file, "utf8")).split("\n")
  .filter((line) => line.trim()).map((line) => hostEventSchema.parse(JSON.parse(line)))
// Rows without an edits file (phase 5) have no latency edits.
const readEdits = async (file: string): Promise<Edit[]> => {
  const text = await readFile(file, "utf8").catch(() => undefined)
  return text === undefined ? [] : editsSchema.parse(JSON.parse(text)).edits
}

const percentile = (values: readonly number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * fraction
  const low = Math.floor(position), high = Math.ceil(position)
  return (sorted[low] ?? 0) + ((sorted[high] ?? 0) - (sorted[low] ?? 0)) * (position - low)
}
const statsOf = (values: readonly number[]) => ({ p50: percentile(values, 0.5), p99: percentile(values, 0.99), max: Math.max(...values) })

const findLast = (events: readonly HostEvent[], before: number, match: (event: HostEvent) => boolean) => {
  for (let index = before - 1; index >= 0; index--) {
    const event = events[index]
    if (event && match(event)) return { event, index }
  }
  return undefined
}

const analyzeRow = (row: string, events: readonly HostEvent[], edits: readonly Edit[]) => {
  const publications: Publication[] = []
  const errors: string[] = []
  const wallMsByPublication: number[] = []
  events.forEach((publish, index) => {
    if (publish.event !== "graph-publish" || publish.cause !== "block-boundary" || publish.publicationFrame === 0) return
    const revision = publish.revision
    const prepare = findLast(events, index, (event) => event.event === "graph-prepare" && event.pid === publish.pid
      && event.requestedRevision === revision)
    const requests = prepare ? events.slice(prepare.index + 1, index).filter((event) =>
      event.event === "graph-publish-request" && event.pid === publish.pid && event.requestedRevision === revision) : []
    const bind = requests[0]
    if (!prepare || !bind) return void errors.push(`${row}: revision ${revision} has no prepare or publish request before its publication`)
    const session = findLast(events, index, (event) => event.event === "device-session")?.event
    if (session?.sampleRate !== SAMPLE_RATE || session.blockSize !== BLOCK)
      return void errors.push(`${row}: revision ${revision} runs at ${session?.sampleRate}/${session?.blockSize}, not ${SAMPLE_RATE}/${BLOCK}`)
    const rebased = requests.slice(1).filter((request) => publish.publicationFrame - request.frame > LEAD_MAX_BLOCKS * BLOCK)
    const blocksBeforeBind = Math.max(1, Math.round((bind.frame - prepare.event.frame) / BLOCK))
    const complete = events.slice(index + 1).find((event) => event.event === "latency-move-complete" && event.pid === publish.pid
      && event.revision === revision && event.transportEpoch === publish.transportEpoch && event.frame >= publish.publicationFrame)
    const blockMs = (session.blockSize * 1000) / session.sampleRate
    const armed = requests[requests.length - 1] ?? bind
    const leadBlocks = (publish.publicationFrame - bind.frame) / BLOCK
    const prepareToPublishMs = publish.wallMs - prepare.event.wallMs
    publications.push({
      row, revision, publicationFrame: publish.publicationFrame,
      asset: events.some((event) => event.event === "asset-install" && event.pid === publish.pid
        && event.wallMs >= prepare.event.wallMs && event.wallMs <= publish.wallMs),
      leadBlocks, prepareToPublishMs, prepMs: armed.wallMs - prepare.event.wallMs,
      blockPhaseMs: publish.wallMs - bind.wallMs - leadBlocks * blockMs,
      rebaseRequests: rebased.length, resentRequests: requests.length - 1 - rebased.length, blocksBeforeBind, raise: false,
      completeFrames: complete ? complete.frame - publish.publicationFrame : undefined,
      allowedCompleteFrames: COMPLETE_BASE_FRAMES + BLOCK * blocksBeforeBind,
    })
    wallMsByPublication.push(publish.wallMs)
  })
  // A publication carries every edit made since the previous one: the first publication at or after the edit's wall time.
  const netMove = publications.map(() => 0)
  for (const edit of edits) {
    const owner = wallMsByPublication.findIndex((wallMs) => wallMs >= edit.wallMs)
    if (owner >= 0) netMove[owner] = (netMove[owner] ?? 0) + edit.toLatencyFrames - edit.fromLatencyFrames
  }
  return { publications: publications.map((publication, index) => ({ ...publication, raise: (netMove[index] ?? 0) > 0 })), errors }
}

// Phase 4 rows have no continuity analysis, so they carry no asset expectation.
const readContinuity = async (file: string) => {
  const text = await readFile(file, "utf8").catch(() => undefined)
  return text === undefined ? undefined : continuitySchema.parse(JSON.parse(text))
}
// The publication at the continuity analysis's asset frame must carry asset-install, and no other publication may.
const assetEvidenceErrors = (row: string, assetFrame: number | undefined, publications: readonly Publication[]): string[] => [
  ...(assetFrame !== undefined && !publications.some((publication) => publication.publicationFrame === assetFrame)
    ? [`${row}: the continuity analysis places an asset at frame ${assetFrame}, but no publication has that frame`] : []),
  ...publications.filter((publication) => (publication.publicationFrame === assetFrame) !== publication.asset)
    .map((publication) => publication.asset
      ? `${row}: revision ${publication.revision} carries asset-install, but the continuity analysis places no asset there`
      : `${row}: revision ${publication.revision} delivers the asset, but carries no asset-install`),
]

const judge = (publications: readonly Publication[], errors: readonly string[]): Verdict[] => {
  const verdict = (target: string, failures: readonly string[], detail: string): Verdict =>
    ({ target, status: failures.length ? "FAIL" : "PASS", detail: failures.length ? `${failures.join("; ")} (${detail})` : detail })
  const skip = (target: string, detail: string): Verdict => ({ target, status: "SKIP", detail })
  const info = (target: string, detail: string): Verdict => ({ target, status: "INFO", detail })
  const name = (publication: Publication) => `${publication.row} rev ${publication.revision}`
  const plain = publications.filter((publication) => !publication.asset)
  const asset = publications.filter((publication) => publication.asset)
  const raises = publications.filter((publication) => publication.raise)
  const plainMs = plain.map((publication) => publication.prepareToPublishMs)
  const plainPrepMs = plain.map((publication) => publication.prepMs)
  const plainBlockPhaseMs = plain.map((publication) => publication.blockPhaseMs)
  const leads = publications.map((publication) => publication.leadBlocks)
  const plainStats = plainMs.length ? statsOf(plainMs) : undefined
  const prepStats = plainPrepMs.length ? statsOf(plainPrepMs) : undefined
  const blockPhaseStats = plainBlockPhaseMs.length ? statsOf(plainBlockPhaseMs) : undefined
  const verdicts: Verdict[] = [
    verdict("inputs", [...errors, ...(publications.length ? [] : ["no seam publications found"])], `${publications.length} publications`),
    verdict("bound-lead", publications.filter((publication) => publication.leadBlocks < LEAD_MIN_BLOCKS || publication.leadBlocks > LEAD_MAX_BLOCKS)
      .map((publication) => `${name(publication)} lead ${publication.leadBlocks} blocks`),
    leads.length ? `${Math.min(...leads)}..${Math.max(...leads)} blocks, want ${LEAD_MIN_BLOCKS}..${LEAD_MAX_BLOCKS}` : "no publications"),
  ]
  verdicts.push(!plainStats ? skip("prepare-to-publish", "no non-asset publications") : verdict("prepare-to-publish",
    [...(plainStats.p99 > PLAIN_LIMITS_MS.p99 ? [`p99 ${plainStats.p99} > ${PLAIN_LIMITS_MS.p99} ms`] : []),
      ...(plainStats.max > PLAIN_LIMITS_MS.max ? [`max ${plainStats.max} > ${PLAIN_LIMITS_MS.max} ms`] : [])],
    `n=${plainMs.length} p50 ${plainStats.p50} p99 ${plainStats.p99} max ${plainStats.max} ms`))
  verdicts.push(!prepStats ? skip("prep-time", "no non-asset publications") : verdict("prep-time",
    prepStats.p50 > PREP_P50_MS ? [`p50 ${prepStats.p50} > ${PREP_P50_MS} ms`] : [],
    `n=${plainPrepMs.length} prep p50 ${prepStats.p50} p99 ${prepStats.p99} max ${prepStats.max} ms`))
  verdicts.push(!blockPhaseStats ? skip("block-phase", "no non-asset publications") : info("block-phase",
    `not gated: n=${plainBlockPhaseMs.length} p50 ${blockPhaseStats.p50} range ${Math.min(...plainBlockPhaseMs)}..${blockPhaseStats.max} ms`))
  verdicts.push(!asset.length ? skip("prepare-to-publish-asset", "no asset-add publications") : verdict("prepare-to-publish-asset",
    asset.filter((publication) => publication.prepareToPublishMs > ASSET_LIMIT_MS)
      .map((publication) => `${name(publication)} ${publication.prepareToPublishMs} > ${ASSET_LIMIT_MS} ms`),
    `n=${asset.length} max ${Math.max(...asset.map((publication) => publication.prepareToPublishMs))} ms`))
  verdicts.push(verdict("rebases", publications.filter((publication) => publication.rebaseRequests > 0)
    .map((publication) => `${name(publication)} ${publication.rebaseRequests} rebase requests`),
  `${publications.reduce((sum, publication) => sum + publication.rebaseRequests, 0)} rebase requests, ${publications.reduce((sum, publication) => sum + publication.resentRequests, 0)} re-sent Publish`))
  verdicts.push(!raises.length ? skip("raise-move-complete", "no raises in this run") : verdict("raise-move-complete",
    raises.filter((publication) => publication.completeFrames === undefined || publication.completeFrames > publication.allowedCompleteFrames)
      .map((publication) => `${name(publication)} ${publication.completeFrames ?? "no completion"} > ${publication.allowedCompleteFrames} frames`),
    `n=${raises.length} max ${Math.max(...raises.map((publication) => publication.completeFrames ?? 0))} frames`))
  return verdicts
}

const analyzeRun = async (run: string, phase: number): Promise<Analysis> => {
  const rows = (await readdir(run, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  const analyses = await Promise.all(rows.map(async (row) => {
    const host = await readHost(join(run, row, "host.jsonl")).catch(() => undefined)
    if (!host) return undefined
    const analysis = analyzeRow(row, host, await readEdits(join(run, row, `phase${phase}-edits.json`)))
    const continuity = await readContinuity(join(run, row, "analysis.json"))
    if (continuity) analysis.errors.push(...assetEvidenceErrors(row, continuity.assetPublicationFrame, analysis.publications))
    return analysis
  }))
  const publications = analyses.flatMap((analysis) => analysis?.publications ?? [])
  const errors = analyses.flatMap((analysis) => analysis?.errors ?? [])
  return { publications, errors, verdicts: judge(publications, errors) }
}

// Per revision: prepare at `wall`, bind at +1 ms, the armed Publish (the last request) at +prepMs, the publication at
// +totalMs. Block phase is what the judge derives: totalMs − 1 − leadBlocks × blockMs.
type SyntheticSpec = {
  prepMs?: number; totalMs?: number; bindLeadBlocks?: number; blocksBeforeBind?: number; armed?: boolean
  resend?: boolean; rebase?: boolean; completeFrames?: number; install?: boolean
}
const syntheticRow = (specs: readonly SyntheticSpec[], raise: boolean) => {
  const base = { cause: "", pid: 1, transportEpoch: 5 }
  const lines: object[] = [{ event: "device-session", pid: 1, wallMs: 0, sampleRate: SAMPLE_RATE, blockSize: BLOCK }]
  const edits: object[] = []
  const frames: number[] = []
  specs.forEach((spec, index) => {
    const revision = index + 2, wall = 1_000_000 + index * 10_000, prepareFrame = BLOCK * 200 * (index + 1)
    const bindFrame = prepareFrame + BLOCK * (spec.blocksBeforeBind ?? 1)
    const request = (frame: number, wallMs: number) => ({ ...base, event: "graph-publish-request", wallMs, frame, revision: revision - 1, requestedRevision: revision })
    const armedFrame = bindFrame + BLOCK
    const publicationFrame = spec.rebase ? armedFrame + BLOCK * 8 + BLOCK * 6 : bindFrame + BLOCK * (spec.bindLeadBlocks ?? 3)
    frames.push(publicationFrame)
    lines.push({ ...base, event: "graph-prepare", wallMs: wall, frame: prepareFrame, revision: revision - 1, requestedRevision: revision },
      request(bindFrame, wall + 1))
    if (spec.install) lines.push({ ...base, event: "asset-install", wallMs: wall + 5 })
    if (spec.armed !== false) lines.push(request(armedFrame, wall + (spec.prepMs ?? 4)))
    if (spec.resend) lines.push(request(publicationFrame - BLOCK, wall + 18))
    if (spec.rebase) lines.push(request(armedFrame + BLOCK * 8, wall + 20), request(armedFrame + BLOCK * 9, wall + 22))
    lines.push({ ...base, event: "graph-publish", cause: "block-boundary", wallMs: wall + (spec.totalMs ?? 30), frame: publicationFrame,
      publicationFrame, revision, requestedRevision: 0 })
    lines.push({ ...base, event: "latency-move-complete", wallMs: wall + 100, frame: publicationFrame + (spec.completeFrames ?? COMPLETE_BASE_FRAMES + BLOCK * (spec.blocksBeforeBind ?? 1)),
      publicationFrame, revision, requestedRevision: 0 })
    if (raise) edits.push({ wallMs: wall - 5, fromLatencyFrames: 512, toLatencyFrames: 4096 })
  })
  return { host: lines.map((line) => JSON.stringify(line)).join("\n"), edits: JSON.stringify({ edits }), frames }
}

const selfTest = async () => {
  const clean: readonly SyntheticSpec[] = [{ totalMs: 25 }, { totalMs: 30 }, { totalMs: 35, blocksBeforeBind: 3, completeFrames: 3584 }]
  const assetClean: readonly SyntheticSpec[] = [{ totalMs: 90, install: true }]
  // An import during playback: a track-only publication, then the asset's.
  const trackThenAsset: readonly SyntheticSpec[] = [{ totalMs: 40 }, { totalMs: 90, install: true }]
  // `delivered` is the index of the asset row's publication that delivers the asset (the continuity analysis's asset frame).
  const cases: { name: string; rows: [readonly SyntheticSpec[], readonly SyntheticSpec[]]; fails: string[]; delivered?: number }[] = [
    { name: "clean LAT1 shape (single, merged k=3 and asset add)", rows: [clean, assetClean], fails: [] },
    { name: "track-only publication then asset publication", rows: [clean, trackThenAsset], fails: [], delivered: 1 },
    { name: "track-only publication at 75 ms is judged against the plain limits", rows: [clean, [{ totalMs: 75 }, { totalMs: 90, install: true }]],
      fails: ["prepare-to-publish"], delivered: 1 },
    { name: "track-only publication seam miss still fails lead and rebases", rows: [clean, [{ rebase: true }, { totalMs: 90, install: true }]],
      fails: ["bound-lead", "rebases"], delivered: 1 },
    { name: "asset publication that installs nothing is refused as unlabelled", rows: [clean, [{ totalMs: 40 }, { totalMs: 90 }]],
      fails: ["inputs", "prepare-to-publish"], delivered: 1 },
    { name: "single-publication asset with no install is refused", rows: [clean, [{ totalMs: 40 }]], fails: ["inputs"], delivered: 0 },
    { name: "restored-track asset with no install is refused", rows: [clean, [{ totalMs: 40 }, { totalMs: 40 }, { totalMs: 40 }]],
      fails: ["inputs"], delivered: 1 },
    { name: "restored-track asset with install passes", rows: [clean, [{ totalMs: 40 }, { totalMs: 90, install: true }, { totalMs: 40 }]],
      fails: [], delivered: 1 },
    { name: "partial evidence: install on the track-only publication, not on the asset's", rows: [clean, [{ totalMs: 40, install: true }, { totalMs: 40 }]],
      fails: ["inputs"], delivered: 1 },
    { name: "re-sent Publish is not a rebase", rows: [[...clean, { resend: true }], assetClean], fails: [] },
    { name: "bound lead of 16 blocks", rows: [[...clean, { bindLeadBlocks: 16, armed: false }], assetClean], fails: ["bound-lead"] },
    { name: "bound lead of 1 block", rows: [[...clean, { bindLeadBlocks: 1, armed: false }], assetClean], fails: ["bound-lead"] },
    { name: "lead-3 prep p50 13 ms fails (total p50 45 ms)", rows: [[{ prepMs: 13, totalMs: 45 }, { prepMs: 13, totalMs: 45 }, { prepMs: 13, totalMs: 45 }], assetClean], fails: ["prep-time"] },
    { name: "prep-time p50 9 ms fails (lead 3)", rows: [[{ prepMs: 9, totalMs: 40 }, { prepMs: 9, totalMs: 40 }, { prepMs: 9, totalMs: 40 }], assetClean], fails: ["prep-time"] },
    { name: "lead-3 prep p50 3 ms passes with a large block phase (total p50 43 ms)", rows: [[{ prepMs: 3, totalMs: 43 }, { prepMs: 3, totalMs: 43 }, { prepMs: 3, totalMs: 43 }], assetClean], fails: [] },
    { name: "lead-2 prep p50 12 ms fails (total p50 33 ms)", rows: [[{ prepMs: 12, totalMs: 33, bindLeadBlocks: 2 }, { prepMs: 12, totalMs: 33, bindLeadBlocks: 2 }, { prepMs: 12, totalMs: 33, bindLeadBlocks: 2 }], assetClean], fails: ["prep-time"] },
    { name: "prepare to publish max 75 ms", rows: [[...clean, { totalMs: 75 }], assetClean], fails: ["prepare-to-publish"] },
    { name: "asset add 120 ms", rows: [clean, [{ totalMs: 120, install: true }]], fails: ["prepare-to-publish-asset"] },
    { name: "real seam-miss rebase", rows: [[...clean, { rebase: true }], assetClean], fails: ["bound-lead", "rebases"] },
    { name: "single raise completes 3584 frames after publication", rows: [[...clean, { completeFrames: 3584 }], assetClean], fails: ["raise-move-complete"] },
  ]
  const root = await mkdtemp(join(tmpdir(), "lat1-timing-"))
  let failed = 0
  try {
    for (const [index, testCase] of cases.entries()) {
      const run = join(root, `case-${index}`, "phase4")
      const [plain, asset] = testCase.rows
      const rows: [string, readonly SyntheticSpec[], boolean][] = [["two-tone", plain, true], ["add-paged-asset", asset, false]]
      for (const [row, specs, raise] of rows) {
        const synthetic = syntheticRow(specs, raise)
        await mkdir(join(run, row), { recursive: true })
        await writeFile(join(run, row, "host.jsonl"), synthetic.host)
        await writeFile(join(run, row, "phase4-edits.json"), synthetic.edits)
        if (testCase.delivered !== undefined && row === "add-paged-asset")
          await writeFile(join(run, row, "analysis.json"), JSON.stringify({ assetPublicationFrame: synthetic.frames[testCase.delivered] }))
      }
      const analysis = await analyzeRun(run, 4)
      const actual = analysis.verdicts.filter((entry) => entry.status === "FAIL").map((entry) => entry.target)
      const ok = actual.join() === testCase.fails.join()
      if (!ok) failed++
      console.log(`${ok ? "ok  " : "BAD "} ${testCase.name}: expected FAIL [${testCase.fails}], got [${actual}]`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  console.log(failed ? `self-test FAILED (${failed}/${cases.length})` : `self-test passed (${cases.length}/${cases.length})`)
  return failed === 0
}

const main = async () => {
  const args = process.argv.slice(2)
  const option = (flag: string) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined }
  if (args.includes("--self-test")) return process.exit(await selfTest() ? 0 : 1)
  const run = option("--run")
  if (!run) throw new Error("usage: analyze-lat1-timing.ts --run <phaseDir> [--phase 4|5] [--out <file>] | --self-test")
  const phase = Number(option("--phase") ?? /phase([45])\/?$/.exec(run)?.[1])
  if (phase !== 4 && phase !== 5) throw new Error("--phase must be 4 or 5 (or the run directory must end in phase4/phase5)")
  const analysis = await analyzeRun(run, phase)
  const out = option("--out") ?? join(run, "lat1-timing.json")
  await mkdir(dirname(out), { recursive: true })
  const pass = analysis.verdicts.every((entry) => entry.status !== "FAIL")
  await writeFile(out, `${JSON.stringify({ run, phase, sampleRate: SAMPLE_RATE, blockSize: BLOCK, verdict: pass ? "PASS" : "FAIL", ...analysis }, null, 2)}\n`)
  for (const entry of analysis.verdicts) console.log(`${entry.status} ${entry.target}: ${entry.detail}`)
  console.log(`${pass ? "PASS" : "FAIL"} LAT1 timing, phase ${phase}: ${analysis.publications.length} publications -> ${out}`)
  process.exit(pass ? 0 : 1)
}

await main()
