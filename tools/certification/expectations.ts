import { createHash } from "node:crypto"
import path from "node:path"
import { z } from "zod"

// The expectations file is the only place FAST-CERT keeps RC7's verdicts. It was built once from RC7's records (that builder is
// archived in the dv01-parent tooling-archive) and moves only by rebases/*.json; the runner judges every gate against it and
// never hard-codes an expected count, hash or failing test.
export const repoRoot = path.resolve(import.meta.dir, "../..")
export const expectationsFile = path.join(import.meta.dir, "expectations.json")
// Every argv, env value and spec string may name the job's own scratch directory through this token.
export const jobDirToken = "{{DIR}}"
// RC reference tooling lived under this /tmp root. Each file is archived byte-identical in fixtures/ with a .txt suffix (so root
// lint, tsc and bun test never pick it up) and is written back out, relocated, into each run's own directory.
export const archivedRoot = "/tmp/dv01-b6/"
export const fixturesDir = path.join(import.meta.dir, "fixtures")
export const archivedPath = (original: string) => path.join(fixturesDir, `${original.slice(archivedRoot.length)}.txt`)

const counts = z.object({ pass: z.number(), skip: z.number(), fail: z.number() })
export type Counts = z.infer<typeof counts>

const command = z.object({
  argv: z.array(z.string()),
  alarmSeconds: z.number(),
  env: z.record(z.string(), z.string()),
  // RC7 set DAW_INSTRUMENT_EVIDENCE for these; each job gets its own evidence directory so parallel jobs never share one.
  evidence: z.boolean(),
  rc7Seconds: z.number(),
})
export type Command = z.infer<typeof command>
// A command that runs one of these test files (as opposed to linting it) runs alone.
export const runsTestFile = (command: Command, files: string[]) =>
  command.argv.includes("test") && command.argv.some((value) => files.some((file) => value.endsWith(file)))

const judge = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tests"), exit: z.number(), counts, fails: z.array(z.string()), appended: z.number().nullable() }),
  z.object({ kind: z.literal("exit"), exit: z.number() }),
  z.object({ kind: z.literal("lint"), exit: z.number(), found: z.string(), signature: z.array(z.tuple([z.string(), z.string()])) }),
  z.object({ kind: z.literal("oxlint-clean"), exit: z.number() }),
  z.object({ kind: z.literal("tsc"), exit: z.number(), diagnostics: z.array(z.string()) }),
  z.object({ kind: z.literal("selftest"), exit: z.number(), rejected: z.number() }),
  z.object({ kind: z.literal("ctest"), exit: z.number(), total: z.number() }),
  z.object({ kind: z.literal("engine"), exit: z.number(), files: z.record(z.string(), counts) }),
  z.object({ kind: z.literal("stdout"), exit: z.number(), value: z.string(), files: z.record(z.string(), z.string()) }),
  z.object({ kind: z.literal("dp"), exit: z.number(), files: z.record(z.string(), z.string()) }),
  z.object({ kind: z.literal("campaign"), exit: z.number(), logSha256: z.string(), gateSha256: z.string(), summarySha256: z.string() }),
])
export type Judge = z.infer<typeof judge>

// When a gate runs in the default (change-scoped) mode. `full-only` gates repeat another gate's command in RC7 (or are
// RC7's comparison campaigns) and run only with --full.
const trigger = z.enum(["always", "native", "product", "fuzz", "full-only"])
export type Trigger = z.infer<typeof trigger>

const gate = z.object({
  name: z.string(),
  group: z.string(),
  // Isolated gates run one at a time after the parallel phase, with nothing else running.
  isolated: z.boolean(),
  trigger,
  command,
  judge,
})
export type Gate = z.infer<typeof gate>

const fuzzFailure = z.object({
  invariant: z.string().nullable(), detail: z.string().nullable(), class: z.string().nullable(),
  domain: z.string().nullable(), step: z.number().nullable(),
})

const specChange = z.object({ file: z.string(), from: z.string().optional(), to: z.string().optional(), contentsFile: z.string().optional() })
const spec = z.object({ id: z.string(), changes: z.array(specChange), bounded: z.boolean().optional(), childPreload: z.boolean().optional() })
export type Spec = z.infer<typeof spec>

const armExpect = z.object({
  exit: z.number(),
  applied: z.number(),
  counts: counts.nullable(),
  fails: z.array(z.string()).nullable(),
  fuzz: z.object({ seed: z.number(), status: z.string().nullable(), failures: z.array(fuzzFailure) }).nullable(),
  rejection: z.array(z.tuple([z.number(), z.number()])).nullable(),
  tsErrors: z.array(z.string()).nullable(),
  matches: z.number().nullable(),
  // An analyzer self-test kill: the oracle that threw, and the defects it left unrejected.
  oracle: z.object({ message: z.string(), unrejected: z.array(z.string()) }).nullable(),
})

const arm = z.object({
  id: z.string(),
  family: z.enum(["rc2", "ledger", "c0", "diag", "search", "analyzer"]),
  row: z.string(),
  role: z.enum(["control", "mutant", "case", "search"]),
  control: z.string().nullable(),
  targets: z.array(z.string()),
  witnesses: z.array(z.string()),
  command,
  marker: z.string(),
  spec: spec.nullable(),
  // A whole-file mutant (row 444) is rebuilt from the live file with exact-anchor edits, so it never goes stale.
  materialize: z.array(z.object({ file: z.string(), source: z.string(), edits: z.array(z.object({ from: z.string(), to: z.string() })) })),
  rejectionGate: z.boolean(),
  expect: armExpect,
})
export type Arm = z.infer<typeof arm>

const row = z.object({
  row: z.string(),
  family: z.string(),
  disposition: z.string(),
  ruling: z.string().nullable(),
  armIds: z.array(z.string()),
})

const campaign = z.object({
  name: z.string(),
  fixture: z.enum(["controller", "hook"]),
  trace: z.enum(["failures", "none", "all"]),
  // `fuzz` campaigns are the traced pairs that also run in the default mode when a fuzz-loaded source changed.
  trigger,
  command,
  judge,
})
export type Campaign = z.infer<typeof campaign>

const traceReference = z.object({ treeSha256: z.string(), files: z.number(), a: z.string(), b: z.string() })

const seedFixture = z.object({
  secondsPerSeed: z.number(),
  shardCap: z.number(),
  named: z.array(z.number()),
  // Index i holds seed i + 1's summary, canonical SHA-256 with the batch output root replaced.
  summaries: z.array(z.string()),
})

export const expectationsSchema = z.object({
  version: z.literal(1),
  source: z.object({ rc: z.string(), scratch: z.string(), report: z.string(), builder: z.string(), builtAt: z.string() }),
  env: z.record(z.string(), z.string()),
  head: z.string(),
  manifest: z.object({ path: z.string(), sha256: z.string(), entries: z.record(z.string(), z.string().nullable()) }),
  // The base when it is not RC7's own manifest: RC7's manifest with ruled tool changes replaced, and the records the gates
  // that read those tools are judged against instead of RC7's.
  rebase: z.object({
    from: z.object({ path: z.string(), sha256: z.string() }),
    replaced: z.record(z.string(), z.object({ from: z.string(), to: z.string() })),
    gates: z.record(z.string(), z.object({ log: z.string(), logSha256: z.string(), exit: z.number(), evidence: z.string() })),
    rulings: z.array(z.string()),
  }).nullable(),
  // Files each fuzz fixture records in every trace (sourceHashes), at their RC7 hashes. They widen the watched set past the
  // manifest, and every arm that runs a fixture is witnessed by its list.
  fuzzSources: z.object({ controller: z.record(z.string(), z.string()), hook: z.record(z.string(), z.string()) }),
  gitStatus: z.array(z.string()),
  // Test files with wall-clock budget assertions: every gate and arm that runs one goes to the isolated tail.
  isolatedTests: z.array(z.string()),
  // Known environmental faults an RC reran alone: a parallel job whose log carries one is rerun alone, and the rerun's verdict
  // stands against the same expectation. The failing attempt is kept in the result.
  environmentalFaults: z.array(z.object({ signature: z.string(), evidence: z.string() })),
  references: z.record(z.string(), z.string()),
  gates: z.array(gate),
  campaigns: z.array(campaign),
  traces: z.object({
    controller: traceReference, hook: traceReference,
    compareScript: z.string(), reportPathLine: z.string(),
  }),
  seeds: z.object({
    processSeconds: z.number(),
    hook206: z.object({ seed: z.number(), ids: z.array(z.number()) }),
    controller: seedFixture, hook: seedFixture,
  }),
  mutations: z.object({ rejectionGateScript: z.string(), arms: z.array(arm), rows: z.array(row) }),
  // Dated policy notes a run prints, so a temporary arrangement (the hash judge beside the invariant judge) carries its own end date.
  notes: z.array(z.object({ topic: z.string(), since: z.string(), dropAfter: z.string(), text: z.string() })).optional(),
})
export type Expectations = z.infer<typeof expectationsSchema>

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")

const jsonValue = z.json()
export type JsonValue = z.infer<typeof jsonValue>
const jsonRecord = z.record(z.string(), jsonValue)

// ---------- observations and rebases ----------
// A job's measurement of the expectation it is judged against: a path into expectations.json and the value the run produced.
// Array elements are addressed `name=<gate or campaign>`, `id=<arm>` or `#<index>`; object members by key.
export type Observation = { path: string[]; value: JsonValue }
const isRecord = (value: JsonValue | undefined): value is { [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const indexOf = (items: JsonValue[], segment: string) => segment.startsWith("#") ? Number(segment.slice(1))
  : items.findIndex((item) => isRecord(item) && [`name=${item.name}`, `id=${item.id}`].includes(segment))
export const getAt = (node: JsonValue | undefined, path: string[]): JsonValue | undefined => {
  const [head, ...rest] = path
  if (head === undefined) return node
  if (Array.isArray(node)) return getAt(node[indexOf(node, head)], rest)
  return isRecord(node) ? getAt(node[head], rest) : undefined
}
export const setAt = (node: JsonValue, path: string[], value: JsonValue): JsonValue => {
  const [head, ...rest] = path
  if (head === undefined) return value
  if (Array.isArray(node)) {
    const at = indexOf(node, head)
    if (!(at >= 0 && at < node.length)) throw new Error(`rebase path ${path.join(" / ")} names no element`)
    return node.map((item, index) => index === at ? setAt(item, rest, value) : item)
  }
  if (!isRecord(node) || !(head in node) && rest.length > 0) throw new Error(`rebase path ${path.join(" / ")} names nothing`)
  return { ...node, [head]: setAt(node[head] ?? null, rest, value) }
}
const stable = (value: JsonValue): JsonValue => Array.isArray(value) ? value.map(stable)
  : isRecord(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, stable(entry)])) : value
export const sameJson = (a: JsonValue | undefined, b: JsonValue | undefined) => JSON.stringify(a === undefined ? null : stable(a)) === JSON.stringify(b === undefined ? null : stable(b))
// Leaf-level differences: records member by member, equal-length arrays element by element, anything else whole.
export const diffJson = (old: JsonValue | undefined, next: JsonValue, path: string[]): { path: string[]; old: JsonValue | null; new: JsonValue }[] => {
  if (isRecord(old) && isRecord(next))
    return [...new Set([...Object.keys(old), ...Object.keys(next)])].flatMap((key) => diffJson(old[key], next[key] ?? null, [...path, key]))
  if (Array.isArray(old) && Array.isArray(next) && old.length === next.length)
    return next.flatMap((item, index) => diffJson(old[index], item, [...path, `#${index}`]))
  return sameJson(old, next) ? [] : [{ path, old: old ?? null, new: next }]
}
// A rebase record (rebases/<name>.json): ruled changes that rebase.ts applies to expectations.json in place. `evidence.mode` is "bless", "rebase", or "anchor" (a hand-made edit cited by its `reason`).
export const rebaseSchema = z.object({
  name: z.string(), sequence: z.number(), createdAt: z.string(),
  revert: z.array(z.object({ file: z.string(), entryCopy: z.string(), entrySha256: z.string(), liveSha256: z.string() })),
  evidence: z.json(),
  watched: z.array(z.object({ file: z.string(), from: z.string(), to: z.string() })),
  changes: z.array(z.object({ path: z.array(z.string()), old: z.json(), new: z.json() })),
  // Ruled changes to seed-records.json (paths `<fixture> / #<seed - 1> / <field>`); rebase.ts applies them to that file, not to the expectations.
  seedRecordChanges: z.array(z.object({ path: z.array(z.string()), old: z.json(), new: z.json() })).default([]),
})
export type Rebase = z.input<typeof rebaseSchema>
type Change = Rebase["changes"][number]
// Moves each field old -> new; a field that no longer holds the recorded `old` means the base it was measured against is gone.
export const applyChanges = (base: JsonValue, changes: Change[], label: string) => changes.reduce((current, change) => {
  if (!sameJson(getAt(current, change.path), change.old)) throw new Error(`${label}: ${change.path.join(" / ")} does not hold its recorded old value`)
  return setAt(current, change.path, change.new)
}, base)
export const rebasesDir = path.join(import.meta.dir, "rebases")
// Applies one rebase: the watched file hashes (manifest entries and fuzz sources) move from -> to, then every changed field moves
// old -> new. A field that no longer holds the rebase's `old` value means the base it was measured against is gone.
export const applyRebase = (base: JsonValue, rebase: Rebase): JsonValue => {
  const watched = rebase.watched.reduce((current, { file, from, to }) => {
    const holders = [["manifest", "entries", file], ["fuzzSources", "controller", file], ["fuzzSources", "hook", file]].filter((at) => getAt(current, at) === from)
    if (holders.length === 0) throw new Error(`rebase ${rebase.name}: no watched hash ${from} for ${file}`)
    return holders.reduce((next, at) => setAt(next, at, to), current)
  }, base)
  return applyChanges(watched, rebase.changes, `rebase ${rebase.name}`)
}
// RC's compare-manifest normalization: wall-clock keys are dropped wherever they occur.
const timingKey = /(^|[a-z])(ms|Ms|seconds|Seconds|elapsed|Elapsed|duration|Duration|startedAt|endedAt|timestamp|Timestamp|wallClock|WallClock|durationMs)$/

const keyedByScenario = (items: JsonValue[]): JsonValue => {
  const entries = items.map((item): [string, JsonValue] | undefined => {
    const record = jsonRecord.safeParse(item)
    const scenario = record.success ? z.string().safeParse(record.data.scenario) : undefined
    return scenario?.success ? [`@${scenario.data}`, item] : undefined
  })
  return entries.every((entry) => entry !== undefined) ? Object.fromEntries(entries) : items
}

const canonicalize = (value: JsonValue, root: string, key: string, dropTiming: boolean): JsonValue => {
  if (Array.isArray(value)) {
    const items = value.map((entry) => canonicalize(entry, root, "", dropTiming))
    return key === "prefixes" ? keyedByScenario(items) : items
  }
  const record = jsonRecord.safeParse(value)
  if (record.success) {
    const kept = Object.entries(record.data).filter(([name]) => !dropTiming || !timingKey.test(name))
    kept.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    return Object.fromEntries(kept.map(([name, entry]) => [name, canonicalize(entry, root, name, dropTiming)]))
  }
  const text = z.string().safeParse(value)
  return text.success ? text.data.split(root).join("<out>") : value
}

// The output root becomes "<out>" and keys are sorted; campaign roots also drop wall-clock keys and key `prefixes` by scenario.
export const canonicalJsonSha256 = (text: string, root: string, dropTiming: boolean) =>
  sha256(JSON.stringify(canonicalize(jsonValue.parse(JSON.parse(text)), root, "", dropTiming)))

export const testCounts = (log: string): Counts => {
  const found = new Map([...log.matchAll(/^\s*(\d+) (pass|skip|fail)\s*$/gm)].map((match) => [match[2], Number(match[1])]))
  return { pass: found.get("pass") ?? 0, skip: found.get("skip") ?? 0, fail: found.get("fail") ?? 0 }
}

export const failedTests = (log: string) =>
  [...new Set([...log.matchAll(/^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/gm)].map((match) => match[1] ?? ""))].sort()

export const leafName = (name: string) => name.split(" > ").at(-1) ?? name

// A `bun test` file header (`<file>.ts:`), keyed by its path without a leading `./`, so every reader of a log keys a file the same way.
const fileHeader = (line: string) => /^\S.*\.(ts|tsx):$/.test(line) ? line.slice(0, -1).replace(/^\.\//, "") : undefined
// The passing tests of a `bun test` log by file, in log order: the `(pass) <qualified name>` lines under each file header, without the duration.
// A header that repeats appends its tests to the file's.
export const passedTests = (log: string) => {
  const files = new Map<string, string[]>()
  let current: string[] | undefined
  for (const line of log.split("\n")) {
    const file = fileHeader(line)
    if (file !== undefined) {
      current = files.get(file) ?? []
      files.set(file, current)
    } else if (current && line.startsWith("(pass) ")) current.push(line.slice("(pass) ".length).replace(/ \[[\d.]+m?s\]$/, ""))
  }
  return files
}

const fuzzOutcome = z.object({ status: z.string().nullable(), failures: z.array(fuzzFailure) })

export const fuzzFailures = (summaryText: string): z.infer<typeof fuzzOutcome> => {
  const summary = z.object({
    status: z.string().nullable().optional(),
    failures: z.array(z.object({ invariant: z.string().nullish(), detail: z.string().nullish(), class: z.string().nullish(),
      domain: z.string().nullish(), step: z.number().nullish() })).optional(),
  }).parse(JSON.parse(summaryText))
  return {
    status: summary.status ?? null,
    failures: (summary.failures ?? []).map((failure) => ({ invariant: failure.invariant ?? null, detail: failure.detail ?? null,
      class: failure.class ?? null, domain: failure.domain ?? null, step: failure.step ?? null })),
  }
}

const oracleReport = z.record(z.string(), z.json())
const defectReport = z.object({ defects: z.record(z.string(), z.object({ rejected: z.boolean() })) })
// The analyzer self-test throws "<oracle> failed: {json}". Unrejected are the defects marked rejected: false (phase 5), or the
// proof keys that are false (phase 4 attribution).
export const oracleFailures = (log: string) => [...log.matchAll(/^error: (.+?): (\{.*\})$/gm)].map((match) => {
  const report = oracleReport.parse(JSON.parse(match[2] ?? "{}"))
  const defects = defectReport.safeParse(report)
  const unrejected = defects.success ? Object.entries(defects.data.defects).filter(([, entry]) => !entry.rejected).map(([name]) => name)
    : Object.entries(report).filter(([, value]) => value === false).map(([name]) => name)
  return { message: match[1] ?? "", unrejected: unrejected.sort() }
})

// Sorted: oxlint prints its diagnostics in thread order.
export const lintSignature = (log: string): [string, string][] => {
  const lines = log.split("\n")
  return lines.flatMap((line, index): [string, string][] => {
    const head = /^ {2}([!x×]) (.+)$/.exec(line)
    if (!head) return []
    const location = lines.slice(index + 1, index + 4).map((next) => /,-\[(.+?)\]/.exec(next)).find((match) => match !== null)
    return location ? [[`${head[1]} ${head[2]}`, location[1] ?? ""]] : []
  }).sort(([a, b], [c, d]) => `${a}\t${b}` < `${c}\t${d}` ? -1 : 1)
}

// A multiset of "file|code|message" (the first line of each diagnostic): no line or column, so unrelated edits above a known
// diagnostic do not move it.
export const tscDiagnostics = (log: string) =>
  [...log.matchAll(/^(\S+?)\(\d+,\d+\): error (TS\d+): (.*)$/gm)].map((match) => `${match[1]}|${match[2]}|${match[3]}`).sort()

export const perFileCounts = (log: string) => {
  const files = new Map<string, Counts>()
  let current: Counts | undefined
  for (const line of log.split("\n")) {
    const file = fileHeader(line)
    if (file !== undefined) {
      current = files.get(file) ?? { pass: 0, skip: 0, fail: 0 }
      files.set(file, current)
    } else if (current && line.startsWith("(pass) ")) current.pass++
    else if (current && line.startsWith("(skip) ")) current.skip++
    else if (current && line.startsWith("(fail) ")) current.fail++
  }
  return files
}
