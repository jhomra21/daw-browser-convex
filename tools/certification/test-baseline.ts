import path from "node:path"
import { z } from "zod"
import { leafName, testCounts } from "./expectations"

// What the T1 test jobs judge against: for each test file, the tests that fail in the certified tree (known reds). A run passes
// when, file by file, the set of failing tests equals the recorded set by name; a test that is new, renamed or added never fails it.
export const testBaselineFile = path.join(import.meta.dir, "test-baseline.json")
export const testBaseline = z.object({ knownRed: z.record(z.string(), z.array(z.string())) })

export const testShards = (files: string[], size: number) => Array.from({ length: Math.ceil(files.length / size) }, (_, index) => files.slice(index * size, (index + 1) * size))

// bun prints "<file>:" before the tests of each file it ran.
export const failuresByFile = (log: string) => {
  const failures = new Map<string, string[]>()
  let current = ""
  // The failures are listed again, under no file, after "N tests failed:".
  for (const line of log.split(/^\d+ tests? failed:$/m)[0]?.split("\n") ?? []) {
    const heading = /^(\S.*\.(?:ts|tsx)):$/.exec(line)
    if (heading) current = heading[1] ?? ""
    const failed = /^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/.exec(line)
    if (failed && current !== "") failures.set(current, [...new Set([...(failures.get(current) ?? []), leafName(failed[1] ?? "")])].sort())
  }
  return failures
}

export const judgeTestShard = (files: string[], run: { exit: number | null; text: string }, baseline: z.infer<typeof testBaseline>) => {
  const live = failuresByFile(run.text)
  const reasons = files.flatMap((file) => {
    const known = baseline.knownRed[file] ?? []
    const failing = live.get(file) ?? []
    const unexpected = failing.filter((name) => !known.includes(name))
    const missing = known.filter((name) => !failing.includes(name))
    return [...unexpected.map((name) => `${file}: new failure ${name}`), ...missing.map((name) => `${file}: known-red test did not fail: ${name}`)]
  })
  const counts = testCounts(run.text)
  if (counts.pass + counts.skip + counts.fail === 0) reasons.push("no tests ran")
  if (run.exit !== 0 && live.size === 0) reasons.push(`exit ${run.exit} with no failing test (a load error)`)
  return reasons
}
