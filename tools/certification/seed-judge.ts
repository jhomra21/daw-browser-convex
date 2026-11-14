import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { canonicalJsonSha256, type Expectations, type Observation } from "./expectations"

// A seed passes on its invariants, not on the bytes of its summary. A record keeps what a summary says about correctness (status,
// failures, rejections), what it says about cost (ceilings) and which checks ran (exercised); ids, step numbers and every other
// count move whenever the product legitimately changes and are not part of it.
export const seedRecordsFile = path.join(import.meta.dir, "seed-records.json")
export const seedRecord = z.object({
  status: z.string(),
  // "invariant|class|domain" and "name|classification|domain", sorted: a multiset compared by value, never by id.
  failures: z.array(z.string()),
  rejections: z.array(z.string()),
  // Invariants whose check ran at least once.
  exercised: z.array(z.string()),
  // Native activity counters. A live value above the recorded one is a regression.
  ceilings: z.record(z.string(), z.number()),
})
export type SeedRecord = z.infer<typeof seedRecord>
export const seedRecords = z.object({ controller: z.array(seedRecord), hook: z.array(seedRecord) })

const text = (value: string | null | undefined) => value ?? ""
const summary = z.object({
  status: z.string().nullish(),
  failures: z.array(z.object({ invariant: z.string().nullish(), class: z.string().nullish(), domain: z.string().nullish() })).optional(),
  checks: z.record(z.string(), z.number()).optional(),
  rejections: z.array(z.object({ name: z.string().nullish(), classification: z.string().nullish(), domain: z.string().nullish() })).optional(),
  metrics: z.object({ compileCount: z.number().optional(), candidateStatuses: z.record(z.string(), z.number()).optional() }).optional(),
})

export const recordOf = (summaryText: string): SeedRecord => {
  const parsed = summary.parse(JSON.parse(summaryText))
  return {
    status: parsed.status ?? "none",
    failures: (parsed.failures ?? []).map((failure) => `${text(failure.invariant)}|${text(failure.class)}|${text(failure.domain)}`).sort(),
    rejections: (parsed.rejections ?? []).map((entry) => `${text(entry.name)}|${text(entry.classification)}|${text(entry.domain)}`).sort(),
    exercised: Object.entries(parsed.checks ?? {}).filter(([, hits]) => hits > 0).map(([invariant]) => invariant).sort(),
    ceilings: Object.fromEntries([
      ...Object.entries({ compileCount: parsed.metrics?.compileCount }).filter((entry): entry is [string, number] => entry[1] !== undefined),
      ...Object.entries(parsed.metrics?.candidateStatuses ?? {}).map(([status, count]) => [`candidate:${status}`, count]),
    ]),
  }
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index])

// Reasons a live record fails its recorded one: moved status, failures or rejections; a counter above its ceiling; a check that
// ran when recorded and no longer runs (a seed that stops exercising an invariant would otherwise pass in silence).
export const judgeRecord = (recorded: SeedRecord, live: SeedRecord): string[] => [
  ...(recorded.status === live.status ? [] : [`status ${live.status}, recorded ${recorded.status}`]),
  ...(sameList(recorded.failures, live.failures) ? [] : [`failures [${live.failures.join(" ")}], recorded [${recorded.failures.join(" ")}]`]),
  ...(sameList(recorded.rejections, live.rejections) ? [] : [`rejections [${live.rejections.join(" ")}], recorded [${recorded.rejections.join(" ")}]`]),
  ...Object.entries(live.ceilings).filter(([name, count]) => count > (recorded.ceilings[name] ?? 0))
    .map(([name, count]) => `${name} ${count} is above the recorded ${recorded.ceilings[name] ?? 0}`),
  ...recorded.exercised.filter((invariant) => !live.exercised.includes(invariant)).map((invariant) => `${invariant} was exercised when recorded and no longer is`),
]

export type HashJudge = { compared: number; differing: number[] }

// Judges seeds first..first+count-1 written under `out` against the invariant records. The summary hash is compared as well and
// returned as a diagnostic only.
export const judgeSeeds = (exp: Expectations, records: z.infer<typeof seedRecords> | undefined, fixture: "controller" | "hook", out: string, first: number, count: number) => {
  const reasons: string[] = []
  const observed: Observation[] = []
  // Each seed's live record, addressed into seed-records.json (rebase.ts diffs these against the file on a bless).
  const recorded: Observation[] = []
  const differing: number[] = []
  for (let seed = first; seed < first + count; seed++) {
    const file = path.join(out, `seed-${seed}`, "summary.json")
    if (!existsSync(file)) {
      reasons.push(`seed ${seed}: no summary`)
      continue
    }
    const contents = readFileSync(file, "utf8")
    const hash = canonicalJsonSha256(contents, out, false)
    observed.push({ path: ["seeds", fixture, "summaries", `#${seed - 1}`], value: hash })
    if (hash !== exp.seeds[fixture].summaries[seed - 1]) differing.push(seed)
    const live = recordOf(contents)
    recorded.push({ path: [seedRecordsKey, fixture, `#${seed - 1}`], value: live })
    const known = records?.[fixture][seed - 1]
    if (!known) reasons.push(`seed ${seed}: no invariant record in seed-records.json`)
    else reasons.push(...judgeRecord(known, live).map((reason) => `seed ${seed}: ${reason}`))
  }
  const hashJudge: HashJudge = { compared: count, differing }
  return { reasons, observed, recorded, hashJudge }
}

// The first path segment of a seed record observation; the bless baseline holds seed-records.json under it.
export const seedRecordsKey = "seedRecords"

export const formatSeedRecords = (records: z.infer<typeof seedRecords>) => {
  const line = (record: SeedRecord) => `  ${JSON.stringify(record)}`
  return `{\n "controller": [\n${records.controller.map(line).join(",\n")}\n ],\n "hook": [\n${records.hook.map(line).join(",\n")}\n ]\n}\n`
}

// The command a seed shard runs: the fixture's B6 campaign command without its gate (a seed's summary does not depend on it).
export const seedArgv = (template: string[], first: number, count: number) =>
  template.flatMap((value, index) => value === "--gate" || template[index - 1] === "--gate" ? []
    : template[index - 1] === "--seed" ? [String(first)] : template[index - 1] === "--seeds" ? [String(count)] : [value])
