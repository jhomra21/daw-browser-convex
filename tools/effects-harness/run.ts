#!/usr/bin/env bun
// Effects measurement harness: renders fixed signals through the real audio-core wasm (and the legacy worklets for parity)
// and writes JSON metrics, a markdown summary and short WAVs. Usage: bun tools/effects-harness/run.ts [--family <name>] [--out <dir>]
import path from 'node:path'
import { jsonReplacer, markdownSummary, runScenarios } from './report'
import type { RunMeta } from './report'
import { families } from './scenarios'
import { wasmPath } from './render-wasm'

const defaultOutRoot = '/Users/juan/Documents/daw-browser-convex/acceptance-reports/effects-harness'

const option = (name: string) => {
  const at = process.argv.indexOf(`--${name}`)

  return at === -1 ? undefined : process.argv[at + 1]
}

const git = async (...args: string[]) => {
  const process = Bun.spawn(['git', ...args], { cwd: import.meta.dir, stdout: 'pipe', stderr: 'ignore' })

  return (await new Response(process.stdout).text()).trim()
}

const wanted = option('family')
const known = Object.entries(families)
const names = known.map(([name]) => name)

if (wanted !== undefined && !names.includes(wanted)) {
  console.error(`Unknown family "${wanted}". Available: ${names.join(', ')}`)
  process.exit(1)
}

const selected = known.filter(([name]) => wanted === undefined || name === wanted)
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
const outDir = path.resolve(option('out') ?? `${defaultOutRoot}/${stamp}`)
const wavDir = `${outDir}/wav`

const scenarios = selected.flatMap(([, family]) => family.scenarios)
const runs = await runScenarios(scenarios, wavDir, (line) => console.error(line))

const sha = new Bun.CryptoHasher('sha256').update(await Bun.file(wasmPath).arrayBuffer()).digest('hex')

const meta: RunMeta = {
  timestamp: new Date().toISOString(),
  commit: (await git('rev-parse', '--short', 'HEAD')) || 'unknown',
  dirty: (await git('status', '--porcelain', '--', ':!tools/effects-harness')).length > 0,
  wasmSha256: sha,
  families: Object.fromEntries(selected.map(([name, family]) => [name, [...new Set(family.scenarios.map((scenario) => scenario.effect))]])),
}

const effects = [...new Set(runs.map((run) => run.effect))]

for (const effect of effects) {
  await Bun.write(`${outDir}/effects/${effect}.json`, JSON.stringify({ meta, effect, scenarios: runs.filter((run) => run.effect === effect) }, jsonReplacer, 2))
}

await Bun.write(`${outDir}/summary.json`, JSON.stringify({ meta, runs }, jsonReplacer, 2))

const gaps = Object.fromEntries(selected.map(([name, family]) => [name, family.notEncoded]))
const markdown = markdownSummary(meta, runs, gaps)

await Bun.write(`${outDir}/summary.md`, markdown)

const checks = runs.flatMap((run) => run.checks)
const failed = checks.filter((check) => check.pass === false).length

console.log(`${checks.length} checks, ${checks.filter((check) => check.pass === true).length} PASS, ${failed} FAIL`)

console.log(outDir)
