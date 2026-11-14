// AE-08 phase 9 portable campaign: the packaged matrix's bursts on the portable engine in Chromium (real worklet, WASM core and
// portable controller; the DP stub never runs them, T:953). The page side is ae-08-portable-campaign.browser-runtime.ts.
//
//   bun tools/acceptance/ae-08-portable-campaign.ts --out <dir> [--rows gain,note,...] [--edits 20]
//   bun tools/acceptance/ae-08-portable-campaign.ts --self-test
//
// Evidence under <dir>/phase9/<row>/: host.jsonl (the packaged host's event names and fields, for the packaged gates and
// analyzer), phase9-edits.json, latency-class.json, burst.json (raw measurements); reference.json and verdicts.json in <dir>.
// Tolerance is calibrated from a duplicate no-edit run of every state; it is never set by hand.
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"
import { z } from "zod"

const root = resolve(import.meta.dir, "../..")

// The burst schedule as data: each row alternates `to`, `from`, `to`... A state is a name the page knows.
export type PortableCampaignRow = { row: string; class: "plain" | "raise"; from: string; to: string; latency: boolean }
export const portableCampaignRows: PortableCampaignRow[] = [
  { row: "mixer-gain", class: "plain", from: "base", to: "gain", latency: false },
  { row: "clip-note", class: "plain", from: "base", to: "note", latency: false },
  { row: "effect-insert-remove", class: "plain", from: "base", to: "effect", latency: false },
  { row: "latency-raise-lower", class: "raise", from: "spec512", to: "spec1024", latency: true },
]
type Row = PortableCampaignRow

const windowSchema = z.array(z.number())
const silenceSchema = z.array(z.object({ frame: z.number(), length: z.number() }))
const integritySchema = z.object({ blocks: z.number(), gaps: z.array(z.number()), nonFinite: z.number(), maxAbs: z.number(), leftSilence: silenceSchema, rightSilence: silenceSchema })
const referenceSchema = z.object({
  state: z.string(), seconds: z.number(), windows: z.array(windowSchema),
  duplicate: z.object({ maxDiff: z.number(), frames: z.number() }).optional(),
  integrity: integritySchema, faults: z.array(z.string()), sessions: z.number(),
})
const eventSchema = z.object({ event: z.string(), wallMs: z.number(), pid: z.number() }).passthrough()
const burstSchema = z.object({
  row: z.string(), from: z.string(), to: z.string(), fromLatencyFrames: z.number(),
  edits: z.array(z.object({
    index: z.number(), state: z.string(), result: z.string(), publicationFrame: z.number().optional(), requestWall: z.number(), publishWall: z.number(),
    rightTones: windowSchema.optional(), leftMaxDiff: z.number(), declaredLatencyFrames: z.number(), measuredShift: z.number().optional(),
    timing: z.object({ prepareMs: z.number(), installMs: z.number(), publishMs: z.number() }).optional(),
  })),
  left: z.object({ compared: z.number(), fullMaxDiff: z.number(), stateSpread: z.number(), firstDiffFrame: z.number().optional() }),
  integrity: integritySchema, events: z.array(eventSchema), faults: z.array(z.string()), sessions: z.number(),
})
type Reference = z.infer<typeof referenceSchema>
type Burst = z.infer<typeof burstSchema>

// ---- calibration: what a duplicate no-edit run says the oracle can resolve ----
// Two tone vectors (one amplitude per tone) differ by their largest per-tone difference.
const toneDistance = (left: readonly number[], right: readonly number[]) => Math.max(0, ...left.map((amp, index) => Math.abs(amp - (right[index] ?? 0))))
type Calibration = { left: number; right: number; expected: Map<string, number[]> }
// The capture is float32: one ulp at the top of [0.5, 1) is the finest difference it can show, so no tolerance is calibrated below it.
const floatUlp = 2 ** -23
const calibrate = (references: readonly Reference[]): Calibration => {
  const expected = new Map<string, number[]>()
  let right = 0
  for (const [state, runs] of Map.groupBy(references, (reference) => reference.state)) {
    const windows = runs.flatMap((run) => run.windows)
    const mean = (windows[0] ?? []).map((_, index) => windows.reduce((total, window) => total + (window[index] ?? 0), 0) / windows.length)
    expected.set(state, mean)
    for (const window of windows) right = Math.max(right, toneDistance(window, mean))
  }
  return { left: Math.max(floatUlp, ...references.map((reference) => reference.duplicate?.maxDiff ?? 0)), right: Math.max(floatUlp, right), expected }
}

// ---- judging ----
type Failure = { row: string; check: string; owner: "oracle" | "product"; detail: string }
// `declaredLatencyFrames` is the compensated latency L after the edit: a lower keeps it. The edited channel may go silent while a new processor fills its declared latency, and through the 5 ms fade that ends it.
const fadeFrames = 240
const gapInEditWindow = (burst: Burst, gap: number) => burst.edits.some((edit) =>
  edit.publicationFrame !== undefined && gap >= edit.publicationFrame - 4_096 && gap <= edit.publicationFrame + 4_800)
const judgeBurst = (burst: Burst, row: Row, calibration: Calibration): Failure[] => {
  const failures: Failure[] = []
  const fail = (check: string, detail: string, owner: Failure["owner"] = "product") => failures.push({ row: burst.row, check, owner, detail })
  burst.edits.forEach((edit) => {
    if (edit.result !== "adopted") fail("adopted", `edit ${edit.index} to ${edit.state} answered ${edit.result}`)
  })
  if (burst.sessions !== 1) fail("no-restart", `${burst.sessions} sessions in one burst`)
  if (burst.faults.length) fail("no-fault", burst.faults.join("; "))
  burst.integrity.gaps.forEach((gap) => fail("callback-gap", `capture gap at transport frame ${gap}, ${gapInEditWindow(burst, gap) ? "inside" : "outside"} an edit's window`))
  if (burst.integrity.nonFinite) fail("finite", `${burst.integrity.nonFinite} non-finite samples`)
  if (burst.integrity.leftSilence.length) fail("dropout", `unaffected channel silent: ${JSON.stringify(burst.integrity.leftSilence.slice(0, 3))}`)
  const allowed = row.latency ? Math.max(...burst.edits.map((edit) => edit.declaredLatencyFrames), burst.fromLatencyFrames) + fadeFrames : 0
  const longSilence = burst.integrity.rightSilence.filter((run) => run.length > allowed)
  if (longSilence.length) fail("dropout", `edited channel silent beyond the declared ${allowed} frames: ${JSON.stringify(longSilence.slice(0, 3))}`)
  // A latency raise moves the unaffected track by the declared frames, so only its steady windows (shifted by the declared move) are exact.
  // The band is the duplicate-run difference and, without a latency move, the difference between the row's two no-edit states.
  const band = (row.latency ? calibration.left : Math.max(calibration.left, burst.left.stateSpread)) * transitionFactor
  if (!row.latency && burst.left.fullMaxDiff > band)
    fail("unaffected-exact", `unaffected channel differs from the no-edit run by ${burst.left.fullMaxDiff} from frame ${burst.left.firstDiffFrame}, band ${band}`)
  // A latency row tells its two states apart by the unaffected channel's delay; the edited tone is the same in both.
  const [fromTones, toTones] = [calibration.expected.get(row.from), calibration.expected.get(row.to)]
  const sensitive = row.latency ? burst.edits.some((edit) => edit.declaredLatencyFrames !== burst.fromLatencyFrames)
    : fromTones && toTones && toneDistance(fromTones, toTones) > 10 * calibration.right
  if (!sensitive) fail("oracle-sensitive", `states ${row.from} and ${row.to} cannot be told apart by ${row.latency ? "declared latency" : `10x the calibrated ${calibration.right}`}`, "oracle")
  burst.edits.forEach((edit) => {
    if (edit.leftMaxDiff > band) fail("unaffected-exact", `edit ${edit.index} to ${edit.state}: unaffected channel differs by ${edit.leftMaxDiff} in its steady window`)
    const declared = edit.declaredLatencyFrames - burst.fromLatencyFrames
    if (edit.measuredShift !== declared) fail("declared-move", `edit ${edit.index} to ${edit.state}: unaffected channel moved ${edit.measuredShift} frames, declared ${declared}`)
    const expected = calibration.expected.get(edit.state)
    if (!edit.rightTones || !expected || toneDistance(edit.rightTones, expected) > calibration.right * transitionFactor)
      fail("edit-applied", `edit ${edit.index} to ${edit.state}: tone distance ${edit.rightTones && expected ? toneDistance(edit.rightTones, expected) : "unmeasured"} from its reference, calibrated ${calibration.right} x ${transitionFactor}`)
  })
  return failures
}
// The recorded burst with the defect its row exists to catch put back in: the edit did not take effect. The judge must fail it.
const withoutTheEdit = (burst: Burst, row: Row): Burst => row.latency
  ? { ...burst, edits: burst.edits.map((edit) => ({ ...edit, measuredShift: 0 })) }
  : { ...burst, edits: burst.edits.map((edit) => ({ ...edit, state: edit.state === burst.to ? burst.from : burst.to })) }
// An edit's samples sum a transition's residue, and the tone fit adds its own float32 rounding: each lands a few ulp from the duplicate runs'
// spread. A dropout, retrigger or tail reset is 1e-3 or more, four orders above the band.
const transitionFactor = 4
const referenceFailure = (reference: Reference, check: string, detail: string): Failure => ({ row: `reference:${reference.state}`, check, owner: "oracle", detail })
const judgeReference = (reference: Reference): Failure[] => [
  ...(reference.sessions !== 1 ? [referenceFailure(reference, "reference-session", `${reference.sessions} sessions in a no-edit run (a schedule handoff restarted the session)`)] : []),
  ...(reference.integrity.gaps.length || reference.integrity.nonFinite ? [referenceFailure(reference, "reference-integrity", JSON.stringify(reference.integrity.gaps))] : []),
]

// ---- self-test: a defect per check, injected into a clean synthetic burst ----
const syntheticBurst = (row: Row, mutate: (burst: Burst) => void = () => undefined): Burst => {
  const [fromLatency, toLatency] = row.latency ? [512, 1024] : [0, 0]
  const edits = Array.from({ length: 4 }, (_, index) => ({
    index, state: index % 2 === 0 ? row.to : row.from, result: "adopted", publicationFrame: 20_000 * (index + 1), requestWall: 1_000 + index * 600, publishWall: 1_300 + index * 600,
    // A lower leaves the compensated latency at its highest, so every edit after the raise holds the raised delay.
    rightTones: index % 2 === 0 ? [0.4, 0] : [0.8, 0], leftMaxDiff: 0, declaredLatencyFrames: toLatency, measuredShift: toLatency - fromLatency, timing: { prepareMs: 1, installMs: 1, publishMs: 250 },
  }))
  const burst: Burst = { row: row.row, from: row.from, to: row.to, fromLatencyFrames: fromLatency, edits, left: { compared: 100_000, fullMaxDiff: 0, stateSpread: 0 },
    integrity: { blocks: 800, gaps: [], nonFinite: 0, maxAbs: 0.5, leftSilence: [], rightSilence: [] }, events: [], faults: [], sessions: 1 }
  mutate(burst)
  return burst
}
const syntheticReference = (state: string): Reference => ({ state, seconds: 24, windows: [[0.8, 0]], integrity: { blocks: 1, gaps: [], nonFinite: 0, maxAbs: 0.5, leftSilence: [], rightSilence: [] }, faults: [], sessions: 1 })
const syntheticCalibration = (row: Row): Calibration => ({ left: floatUlp, right: floatUlp, expected: new Map([[row.from, [0.8, 0]], [row.to, [0.4, 0]]]) })
const selfTest = () => {
  const edit = (burst: Burst, index: number) => {
    const found = burst.edits[index]
    if (!found) throw new Error(`No synthetic edit ${index}`)
    return found
  }
  const cases: { name: string; mutate: (burst: Burst) => void; check: string | undefined; row?: number; blind?: true }[] = [
    { name: "clean burst", mutate: () => undefined, check: undefined },
    { name: "clean latency burst", mutate: () => undefined, check: undefined, row: 3 },
    { name: "an edit the session refused", mutate: (burst) => { edit(burst, 1).result = "failed" }, check: "adopted" },
    { name: "a second session (a restart)", mutate: (burst) => { burst.sessions = 2 }, check: "no-restart" },
    { name: "a worklet fault", mutate: (burst) => { burst.faults = ["worklet fault"] }, check: "no-fault" },
    { name: "a gap between capture blocks inside an edit window", mutate: (burst) => { burst.integrity.gaps = [20_100] }, check: "callback-gap" },
    { name: "a gap between capture blocks between edits", mutate: (burst) => { burst.integrity.gaps = [31_000] }, check: "callback-gap" },
    { name: "a non-finite sample", mutate: (burst) => { burst.integrity.nonFinite = 1 }, check: "finite" },
    { name: "a dropout on the edited channel", mutate: (burst) => { burst.integrity.rightSilence = [{ frame: 30_000, length: 64 }] }, check: "dropout" },
    { name: "a dropout on the unaffected channel", mutate: (burst) => { burst.integrity.leftSilence = [{ frame: 30_000, length: 64 }] }, check: "dropout" },
    { name: "silence on the edited channel within the declared latency (latency row)", mutate: (burst) => { burst.integrity.rightSilence = [{ frame: 30_000, length: 1_024 }] }, check: undefined, row: 3 },
    { name: "silence on the edited channel past the declared latency (latency row)", mutate: (burst) => { burst.integrity.rightSilence = [{ frame: 30_000, length: 4_096 }] }, check: "dropout", row: 3 },
    { name: "the unaffected channel moves by one sample (non-latency row)", mutate: (burst) => { burst.left.fullMaxDiff = 1e-3; burst.left.firstDiffFrame = 41_000 }, check: "unaffected-exact" },
    { name: "a difference of one float32 ulp is inside the capture's resolution", mutate: (burst) => { burst.left.fullMaxDiff = floatUlp }, check: undefined },
    { name: "the states' own no-edit difference widens the band", mutate: (burst) => { burst.left.stateSpread = 3 * floatUlp; burst.left.fullMaxDiff = 12 * floatUlp; edit(burst, 0).leftMaxDiff = 12 * floatUlp }, check: undefined },
    { name: "a difference beyond the states' own no-edit difference fails", mutate: (burst) => { burst.left.stateSpread = 3 * floatUlp; burst.left.fullMaxDiff = 13 * floatUlp }, check: "unaffected-exact" },
    { name: "a 1e-3 defect (a retrigger, a gap's edge) fails", mutate: (burst) => { burst.left.fullMaxDiff = 1e-3 }, check: "unaffected-exact" },
    { name: "a difference of two float32 ulp is inside the transition band", mutate: (burst) => { burst.left.fullMaxDiff = 2 * floatUlp }, check: undefined },
    { name: "a difference of five float32 ulp is not", mutate: (burst) => { burst.left.fullMaxDiff = 5 * floatUlp }, check: "unaffected-exact" },
    { name: "a tone off by five ulp of its amplitude", mutate: (burst) => { edit(burst, 1).rightTones = [0.8 + 5 * floatUlp, 0] }, check: "edit-applied" },
    { name: "the unaffected channel moves in one edit's window", mutate: (burst) => { edit(burst, 2).leftMaxDiff = 1e-3 }, check: "unaffected-exact" },
    { name: "a lower that moves the unaffected channel back (the policy keeps L until the transport stops)", mutate: (burst) => { edit(burst, 1).measuredShift = 0 }, check: "declared-move", row: 3 },
    { name: "the unaffected channel moves with no declared latency", mutate: (burst) => { edit(burst, 0).measuredShift = 3 }, check: "declared-move" },
    { name: "a raise that moves the unaffected channel by the wrong frames (latency row)", mutate: (burst) => { edit(burst, 0).measuredShift = 256 }, check: "declared-move", row: 3 },
    { name: "a latency row tolerates the declared move in the full compare", mutate: (burst) => { burst.left.fullMaxDiff = 0.3 }, check: undefined, row: 3 },
    { name: "a latency row still fails a steady window that is not the declared move", mutate: (burst) => { edit(burst, 1).leftMaxDiff = 1e-3 }, check: "unaffected-exact", row: 3 },
    { name: "the edit is not applied (state A tones after a B edit)", mutate: (burst) => { edit(burst, 0).rightTones = [0.8, 0] }, check: "edit-applied" },
    { name: "the deleted contribution is still audible", mutate: (burst) => { edit(burst, 1).rightTones = [0.8, 0.05] }, check: "edit-applied" },
    { name: "an edit with no measured window", mutate: (burst) => { edit(burst, 3).rightTones = undefined }, check: "edit-applied" },
    { name: "an oracle that cannot tell the two states apart", mutate: () => undefined, check: "oracle-sensitive", blind: true },
  ]
  let bad = 0
  for (const testCase of cases) {
    const tested = portableCampaignRows[testCase.row ?? 0]
    if (!tested) throw new Error("Unknown synthetic row")
    const calibration = syntheticCalibration(tested)
    if (testCase.blind) calibration.expected.set(tested.to, calibration.expected.get(tested.from) ?? [])
    const failures = judgeBurst(syntheticBurst(tested, testCase.mutate), tested, calibration)
    const checks = [...new Set(failures.map((failure) => failure.check))]
    const ok = testCase.check === undefined ? checks.length === 0 : checks.includes(testCase.check)
    if (!ok) bad += 1
    console.log(`${ok ? "ok  " : "BAD "} ${testCase.name}: want ${testCase.check ?? "no failure"}, got [${checks}]`)
  }
  const handoff = judgeReference({ ...syntheticReference("base"), sessions: 3 }).some((failure) => failure.check === "reference-session")
  if (!handoff) bad += 1
  console.log(`${handoff ? "ok  " : "BAD "} a reference whose session was replaced by the schedule handoff is an oracle failure`)
  for (const row of portableCampaignRows) {
    const calibration = syntheticCalibration(row)
    const rejected = judgeBurst(withoutTheEdit(syntheticBurst(row), row), row, calibration).length > 0
    if (!rejected) bad += 1
    console.log(`${rejected ? "ok  " : "BAD "} negative control rejects ${row.row} with its edits removed`)
  }
  console.log(bad ? `self-test FAILED (${bad})` : `self-test passed (${cases.length} cases)`)
  return bad === 0
}

// ---- browser driver ----
const fixtureServer = async () => {
  const result = await build({
    root, logLevel: "error", configFile: false,
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.VITE_CONVEX_URL": '"https://fixture.convex.cloud"', "import.meta.env.BASE_URL": '"/"' },
    plugins: [solidPlugin()],
    resolve: { alias: { "~": `${root}/src` } },
    build: { write: false, minify: false, rollupOptions: { output: { inlineDynamicImports: true } },
      lib: { entry: `${root}/tools/acceptance/ae-08-portable-campaign.browser-runtime.ts`, formats: ["iife"], name: "portableCampaign" } },
  })
  const bundle = Array.isArray(result) ? result[0] : result
  if (!bundle || !("output" in bundle)) throw new Error("Expected the campaign bundle.")
  const chunk = bundle.output.find((value) => value.type === "chunk")
  if (!chunk) throw new Error("Campaign JavaScript missing.")
  // The product's own static files, at the product's own paths, so the backend resolves the worklet and the WASM as it does in the app.
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
    const path = new URL(request.url).pathname
    if (path === "/result") {
      const { id, value, error } = resultSchema.parse(await request.json())
      const waiting = results.get(id)
      results.delete(id)
      if (error !== undefined) waiting?.reject(new Error(error))
      else waiting?.resolve(value)
      return new Response("ok")
    }
    if (path === "/") return new Response('<!doctype html><meta charset="utf-8"><script src="/campaign.js"></script>', { headers: { "content-type": "text/html" } })
    if (path === "/campaign.js") return new Response(chunk.code, { headers: { "content-type": "text/javascript" } })
    if (path.startsWith("/audio-worklets/") || path.startsWith("/audio-core/")) return new Response(Bun.file(`${root}/public${path}`))
    return new Response("not found", { status: 404 })
  } })
  return server
}

// Past the 30 s schedule horizon, so every reference crosses at least one schedule handoff.
const referenceSeconds = 60
const browserSession = `ae08-portable-${crypto.randomUUID()}`
const browser = async (...args: string[]) => {
  const { AGENT_BROWSER_CDP: _cdp, AGENT_BROWSER_SESSION: _session, ...inherited } = process.env
  const child = Bun.spawn(["agent-browser", "--session", browserSession, ...args], { env: { ...inherited, AGENT_BROWSER_ARGS: "--autoplay-policy=no-user-gesture-required", AGENT_BROWSER_DEFAULT_TIMEOUT: "170000" }, stdout: "pipe", stderr: "pipe" })
  // One bounded deadline per command, cleared on exit: a hung page must fail the campaign, not hang it.
  const timer = setTimeout(() => child.kill(), 180_000)
  try {
    const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (exit !== 0) throw new Error(`agent-browser ${args.join(" ")}: ${error || out}`)
    return out.trim()
  } finally { clearTimeout(timer) }
}
const resultSchema = z.object({ id: z.string(), value: z.json().optional(), error: z.string().optional() })
const results = new Map<string, PromiseWithResolvers<unknown>>()
// The expression runs in the page; its value arrives on the fixture server's /result, however long the run takes.
const evalJson = async <Value>(expression: string, schema: z.ZodType<Value>) => {
  const id = crypto.randomUUID()
  const settled = Promise.withResolvers<unknown>()
  results.set(id, settled)
  await browser("eval", `portableCampaign.dispatch(${JSON.stringify(id)}, async () => ${expression})`)
  return schema.parse(await settled.promise)
}

const timingSchema = z.object({ nodes: z.number(), processors: z.number(), edges: z.number(), blockMs: z.number(), faults: z.array(z.string()),
  series: z.record(z.string(), z.object({ prepare: z.array(z.number()), install: z.array(z.number()), publish: z.array(z.number()) })) })
const percentile = (values: readonly number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0 : 0
}
const summarize = (values: readonly number[]) => ({ n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: percentile(values, 1) })

const campaign = async (out: string, rowNames: readonly string[], edits: number) => {
  const started = performance.now()
  const rows = portableCampaignRows.filter((row) => rowNames.includes(row.row))
  const server = await fixtureServer()
  const references: Reference[] = []
  const bursts: Burst[] = []
  let clock = ""
  try {
    await browser("open", `http://127.0.0.1:${server.port}/`)
    clock = await evalJson("portableCampaign.workletClock()", z.string())
    const adoption = await evalJson(`portableCampaign.adoptionTiming(${edits * 2})`, timingSchema)
    // A capture gap off every edit window is the machine stalling the audio device, not the engine: that run is repeated and counted.
    const stalls = { references: 0, bursts: 0 }
    for (const state of new Set(rows.flatMap((row) => [row.from, row.to]))) {
      // The state's first clean run is as long as a burst and is the reference its bursts compare against; the second, shorter, is the duplicate that calibrates.
      for (let clean = 0, attempts = 0; clean < 2; attempts++) {
        if (attempts === 5) throw new Error(`Reference ${state} kept stalling the audio device`)
        const run = await evalJson(`portableCampaign.reference(${JSON.stringify(state)}, ${clean === 0 ? referenceSeconds : 4})`, referenceSchema)
        if (run.integrity.gaps.length) stalls.references += 1
        else { references.push(run); clean += 1 }
      }
    }
    const calibration = calibrate(references)
    for (const row of rows) {
      for (let attempt = 0; ; attempt++) {
        const burst = await evalJson(`portableCampaign.burst(${JSON.stringify(row.row)}, ${JSON.stringify(row.from)}, ${JSON.stringify(row.to)}, ${edits})`, burstSchema)
        const offWindow = burst.integrity.gaps.length > 0 && burst.integrity.gaps.every((gap) => !gapInEditWindow(burst, gap))
        if (!offWindow || attempt === 2) { bursts.push(burst); break }
        stalls.bursts += 1
      }
    }
    // Each recorded burst is also judged as if its edits had not taken effect: that must fail, or the oracle sees nothing in this row.
    const controls = bursts.flatMap((burst) => {
      const row = rows.find((candidate) => candidate.row === burst.row)
      return row ? [{ row: burst.row, failed: judgeBurst(withoutTheEdit(burst, row), row, calibration).length > 0 }] : []
    })
    const failures = [...controls.filter((control) => !control.failed).map((control): Failure => ({ row: control.row, check: "negative-control", owner: "oracle", detail: "a burst whose edits did not take effect passed" })),
      ...references.flatMap(judgeReference), ...bursts.flatMap((burst) => {
      const row = rows.find((candidate) => candidate.row === burst.row)
      return row ? judgeBurst(burst, row, calibration) : []
    })]
    const phase = `${out}/phase9`
    for (const burst of bursts) {
      const directory = `${phase}/${burst.row}`
      await mkdir(directory, { recursive: true })
      await writeFile(`${directory}/host.jsonl`, burst.events.map((event) => JSON.stringify(event)).join("\n"))
      await writeFile(`${directory}/burst.json`, JSON.stringify(burst))
      await writeFile(`${directory}/latency-class.json`, JSON.stringify({ class: rows.find((row) => row.row === burst.row)?.class }))
      await writeFile(`${directory}/phase9-edits.json`, JSON.stringify({ edits: burst.edits.map((edit) => ({ wallMs: edit.requestWall, fromLatencyFrames: 0, toLatencyFrames: 0 })) }))
    }
    const timing = (pick: (burst: Burst) => number[]) => summarize(bursts.flatMap(pick))
    const verdicts = {
      wallSeconds: Math.round((performance.now() - started) / 100) / 10, workletClock: clock, stalls, tolerance: { left: calibration.left, right: calibration.right },
      negativeControls: controls, rows: rows.map((row) => ({ row: row.row, status: failures.some((failure) => failure.row === row.row) ? "FAIL" : "PASS" })), failures,
      adoption: { ...adoption, series: undefined, ...Object.fromEntries(Object.entries(adoption.series).map(([name, steps]) => [name, {
        prepare: summarize(steps.prepare), install: summarize(steps.install), publish: summarize(steps.publish),
        adoption: summarize(steps.prepare.map((prepare, index) => prepare + (steps.install[index] ?? 0) + (steps.publish[index] ?? 0))) }])) },
      timing: {
        prepareMs: timing((burst) => burst.edits.flatMap((edit) => edit.timing?.prepareMs ?? [])),
        installMs: timing((burst) => burst.edits.flatMap((edit) => edit.timing?.installMs ?? [])),
        publishMs: timing((burst) => burst.edits.flatMap((edit) => edit.timing?.publishMs ?? [])),
        editToPublishMs: timing((burst) => burst.edits.map((edit) => edit.publishWall - edit.requestWall)),
      },
    }
    await mkdir(out, { recursive: true })
    await writeFile(`${out}/reference.json`, JSON.stringify(references))
    await writeFile(`${out}/verdicts.json`, `${JSON.stringify(verdicts, null, 2)}\n`)
    console.log(JSON.stringify(verdicts, null, 2))
    return failures.length === 0
  } finally {
    await browser("close").catch(() => undefined)
    await server.stop(true)
  }
}

// D3: the core's maximum graph plays a carrier while it adopts; the page returns how the render thread's blocks and the carrier's phase held up.
const stallPhaseSchema = z.object({ phase: z.string(), driftMsPerSec: z.number(), blocks: z.number(), phaseStepMaxRad: z.number().optional(), phaseStepOver: z.number(), waitP99Ms: z.number(), waitMaxMs: z.number(), latenessResidualMinMs: z.number(), latenessResidualMaxMs: z.number(), latenessResidualRangeMs: z.number() })
const renderStallSchema = z.object({ faults: z.array(z.string()), adoptMs: z.array(z.number()), gaps: z.array(z.object({ block: z.number(), phase: z.string(), frames: z.number() })), nonFinite: z.number(), silentRuns: z.number(), driftMsPerSec: z.number(), phases: z.array(stallPhaseSchema) })
const renderStall = async (out: string, adoptions: number) => {
  const server = await fixtureServer()
  try {
    await browser("open", `http://127.0.0.1:${server.port}/`)
    const result = await evalJson(`portableCampaign.renderStall(${adoptions})`, renderStallSchema)
    await mkdir(out, { recursive: true })
    await writeFile(`${out}/render-stall.json`, `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify({ ...result, adoptMs: summarize(result.adoptMs) }, null, 2))
    return result.faults.length === 0
  } finally {
    await browser("close").catch(() => undefined)
    await server.stop(true)
  }
}

const args = process.argv.slice(2)
const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined
if (import.meta.main) {
  if (args.includes("--self-test")) process.exit(selfTest() ? 0 : 1)
  const out = value("--out")
  if (!out) throw new Error("usage: ae-08-portable-campaign.ts --out <dir> [--rows a,b] [--edits 20] | --render-stall --out <dir> [--edits 40] | --self-test")
  const rows = value("--rows")?.split(",") ?? portableCampaignRows.map((row) => row.row)
  if (args.includes("--render-stall")) process.exit(await renderStall(resolve(out), Number(value("--edits") ?? 40)) ? 0 : 1)
  process.exit(await campaign(resolve(out), rows, Number(value("--edits") ?? 20)) ? 0 : 1)
}
