#!/usr/bin/env bun
// Type-checks tools/ against tools/tsc-baseline.txt: diagnostics already in the baseline pass, any other one fails.
// Run with --update-baseline after fixing known errors so the baseline only shrinks.
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const baselinePath = path.join(import.meta.dir, "tsc-baseline.txt")

// Line and column are dropped so an unrelated edit above a known diagnostic does not turn it into a new one.
const diagnosticKeys = (output: string) => output.split("\n").flatMap((line) => {
  const match = /^(\S+?)\(\d+,\d+\): error (TS\d+): (.*)$/.exec(line)
  return match ? [`${match[1]} ${match[2]} ${match[3]}`] : []
})
const countKeys = (keys: string[]) =>
  keys.reduce((counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1), new Map<string, number>())

const tsc = Bun.spawn(["bun", "x", "tsc", "--noEmit", "-p", "tools/tsconfig.json"], { cwd: root, stdout: "pipe", stderr: "inherit" })
const output = await new Response(tsc.stdout).text()
const exitCode = await tsc.exited
const found = diagnosticKeys(output)
if (exitCode !== 0 && found.length === 0) {
  console.error(output)
  process.exit(exitCode)
}

if (process.argv.includes("--update-baseline")) {
  await Bun.write(baselinePath, found.toSorted().map((key) => `${key}\n`).join(""))
  console.log(`tools typecheck baseline: ${found.length} known diagnostics`)
  process.exit(0)
}

const known = countKeys((await Bun.file(baselinePath).text()).split("\n").filter(Boolean))
const added = [...countKeys(found)].filter(([key, count]) => count > (known.get(key) ?? 0)).map(([key]) => key)
if (added.length > 0) {
  console.error(`New tools type errors (${added.length}):\n${added.join("\n")}`)
  process.exit(1)
}
console.log(`tools typecheck: no new errors (${found.length} known in tsc-baseline.txt)`)
