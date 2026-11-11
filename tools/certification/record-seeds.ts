import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import path from "node:path"
import { expectationsFile, expectationsSchema, repoRoot } from "./expectations"
import { formatSeedRecords, judgeSeeds, recordOf, seedArgv, seedRecordsFile, seedRecords, type SeedRecord } from "./seed-judge"

// Writes seed-records.json: the invariant record of seeds 1..N of both fuzz fixtures, measured on the bytes in the working tree.
// Usage: bun tools/certification/record-seeds.ts [--out <dir>] [--seeds N]. It also reports how many summary hashes differ from
// expectations.json, so a record is never taken from bytes the hash judge would reject.
const args = process.argv.slice(2)
const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const total = Number(option("--seeds") ?? 1000)
const out = path.resolve(option("--out") ?? path.join("/tmp/fast-cert", `record-seeds-${new Date().toISOString().replaceAll(":", "-")}`))
const exp = expectationsSchema.parse(JSON.parse(readFileSync(expectationsFile, "utf8")))
const fixtures: ("controller" | "hook")[] = ["controller", "hook"]
const pool = Math.max(1, availableParallelism() - 4)

const shards = fixtures.flatMap((fixture) => {
  const size = exp.seeds[fixture].shardCap
  return Array.from({ length: Math.ceil(total / size) }, (_, index) => ({ fixture, first: index * size + 1, count: Math.min(size, total - index * size) }))
})
const template = (fixture: "controller" | "hook") => exp.campaigns.find((campaign) => campaign.name === `${fixture}-b6`)?.command.argv ?? []
const run = async ({ fixture, first, count }: (typeof shards)[number]) => {
  const dir = path.join(out, `${fixture}-${first}`)
  mkdirSync(dir, { recursive: true })
  const argv = seedArgv(template(fixture), first, count).map((value) => value.replace("{{DIR}}", dir))
  const child = spawn("perl", ["-e", "alarm shift; exec @ARGV", "900", ...argv], { cwd: repoRoot, env: { ...process.env, ...exp.env }, stdio: "ignore" })
  await once(child, "exit")
}
const queue = [...shards]
await Promise.all(Array.from({ length: pool }, async () => {
  for (let shard = queue.shift(); shard; shard = queue.shift()) await run(shard)
}))

const records = { controller: new Array<SeedRecord>(), hook: new Array<SeedRecord>() }
const problems: string[] = []
for (const { fixture, first, count } of shards) {
  const dir = path.join(out, `${fixture}-${first}`, "out")
  const verdict = judgeSeeds(exp, undefined, fixture, dir, first, count)
  problems.push(...verdict.reasons.filter((reason) => !reason.includes("no invariant record")))
  console.log(`${fixture} ${first}-${first + count - 1}: hash judge differs on ${verdict.hashJudge.differing.length} seeds`)
  if (verdict.hashJudge.differing.length > 0) problems.push(`${fixture} seeds differ from the recorded hashes: ${verdict.hashJudge.differing.join(",")}`)
  for (let seed = first; seed < first + count; seed++) {
    const file = path.join(dir, `seed-${seed}`, "summary.json")
    if (existsSync(file)) records[fixture].push(recordOf(readFileSync(file, "utf8")))
  }
}
if (problems.length > 0 || fixtures.some((fixture) => records[fixture].length !== total)) {
  console.error(`not written: ${problems.slice(0, 10).join("; ")} (records ${records.controller.length}/${records.hook.length} of ${total})`)
  process.exit(1)
}
writeFileSync(seedRecordsFile, formatSeedRecords(records))
seedRecords.parse(JSON.parse(readFileSync(seedRecordsFile, "utf8")))
console.log(`wrote ${seedRecordsFile}`)
