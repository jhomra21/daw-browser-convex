import { readFileSync } from "node:fs"
import path from "node:path"
import { expectationsFile, expectationsSchema, repoRoot } from "./expectations"
import { retiredArms } from "./tiers"

const paths = new Set(process.argv.slice(2).map((file) => path.relative(repoRoot, path.resolve(repoRoot, file))))
const expectations = expectationsSchema.parse(JSON.parse(readFileSync(expectationsFile, "utf8")))
const retired = retiredArms(expectations)
const arms = expectations.mutations.arms
const selected = new Set<string>()

const reachesPath = (file: string) => [...paths].some((candidate) => candidate === file || file.startsWith(`${candidate}/`))
const fixtureOf = (argv: string[]) => argv.includes("--fixture") ? argv[argv.indexOf("--fixture") + 1] : undefined

const armFiles = (arm: typeof arms[number]) => {
  const fixture = fixtureOf(arm.command.argv)

  const fuzzSources = fixture === "hook" ? expectations.fuzzSources.hook
    : fixture === "controller" ? expectations.fuzzSources.controller
      : {}

  return [
    ...arm.targets,
    ...arm.witnesses,
    ...(arm.spec?.changes.map((change) => change.file) ?? []),
    ...Object.keys(fuzzSources),
  ]
}

const rowKey = (arm: typeof arms[number]) => `${arm.family === "search" ? "rc2" : arm.family}:${arm.row}`

for (const arm of arms) {
  if (retired.has(arm.id)) continue

  if (!armFiles(arm).some(reachesPath)) continue

  const row = rowKey(arm)

  for (const sibling of arms) {
    if (!retired.has(sibling.id) && rowKey(sibling) === row) selected.add(sibling.id)
  }

  if (arm.control !== null && !retired.has(arm.control)) selected.add(arm.control)
}

for (const gate of expectations.gates) {
  if (gate.command.argv.some((value) => [...paths].some((file) => /\.test\.tsx?$/.test(file) && value.endsWith(file)))) {
    selected.add(`gate:${gate.name}`)
  }
}

for (const id of [...selected].sort()) console.log(id.startsWith("gate:") ? id : `arm:${id}`)
