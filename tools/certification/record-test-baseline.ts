import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import path from "node:path"
import { expectationsFile, expectationsSchema, repoRoot } from "./expectations"
import { failuresByFile, testBaselineFile, testShards } from "./test-baseline"
import { allTestFiles } from "./tiers"

// Writes test-baseline.json from a run of every test file (the isolated ones run alone afterwards) on the bytes in the working tree.
// Usage: bun tools/certification/record-test-baseline.ts [--out <dir>]
const args = process.argv.slice(2)
const out = path.resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] ?? "" : path.join("/tmp/fast-cert", `record-tests-${new Date().toISOString().replaceAll(":", "-")}`))
const exp = expectationsSchema.parse(JSON.parse(readFileSync(expectationsFile, "utf8")))
mkdirSync(out, { recursive: true })
const files = allTestFiles()
const shards = [...testShards(files.filter((file) => !exp.isolatedTests.includes(file)), 40), ...exp.isolatedTests.map((file) => [file])]
const logs: string[] = []
const run = async (shard: string[], index: number) => {
  const log = path.join(out, `shard-${index}.log`)
  // bun treats arguments as substring filters: absolute paths keep archived copies of a test (acceptance-reports/) out.
  const child = spawn("sh", ["-c", `exec perl -e 'alarm shift; exec @ARGV' 900 bun --conditions=browser test --timeout 30000 ${shard.map((file) => path.join(repoRoot, file)).join(" ")} > ${log} 2>&1`], { cwd: repoRoot, env: { ...process.env, ...exp.env } })
  await once(child, "exit")
  logs.push(log)
}
const queue = shards.map((shard, index) => ({ shard, index }))
// Isolated files run last and alone.
const parallel = queue.slice(0, queue.length - exp.isolatedTests.length)
await Promise.all(Array.from({ length: Math.max(1, availableParallelism() - 4) }, async () => {
  for (let next = parallel.shift(); next; next = parallel.shift()) await run(next.shard, next.index)
}))
for (const entry of queue.slice(queue.length - exp.isolatedTests.length)) await run(entry.shard, entry.index)
const knownRed: Record<string, string[]> = {}
for (const log of logs.sort()) for (const [file, names] of failuresByFile(readFileSync(log, "utf8"))) knownRed[file] = names
writeFileSync(testBaselineFile, `${JSON.stringify({ knownRed: Object.fromEntries(Object.entries(knownRed).sort(([a], [b]) => a < b ? -1 : 1)) }, null, 1)}\n`)
console.log(`${files.length} test files, ${Object.keys(knownRed).length} with failures, ${Object.values(knownRed).flat().length} known-red tests, logs ${out}`)
