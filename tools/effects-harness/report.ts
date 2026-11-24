import { createHarness, defaultRates } from './harness'
import type { Scenario } from './harness'
import type { Check, ParityRow } from './types'

export type ScenarioRun = { effect: string; scenario: string; rate: number; seconds: number; checks: Check[]; parity: ParityRow[]; wavs: string[] }

export type RunMeta = { timestamp: string; commit: string; dirty: boolean; wasmSha256: string; families: Record<string, string[]> }

/** Runs every scenario at each of its sample rates; a throwing scenario becomes one failing row instead of aborting the run. */
export const runScenarios = async (scenarios: readonly Scenario[], wavDir: string, onProgress: (line: string) => void) => {
  const runs: ScenarioRun[] = []

  for (const scenario of scenarios) {
    for (const rate of scenario.rates ?? defaultRates) {
      const harness = createHarness({ effect: scenario.effect, scenario: scenario.name, rate, wavDir })
      const started = performance.now()

      try {
        await scenario.run(harness)
      } catch (error) {
        harness.checks.push({
          effect: scenario.effect, scenario: scenario.name, rate, metric: 'scenario completed', value: null, unit: '',
          threshold: 'no exception', pass: false, note: error instanceof Error ? error.message : String(error),
        })
      }

      const seconds = (performance.now() - started) / 1000
      onProgress(`${scenario.effect} / ${scenario.name} @${rate}: ${harness.checks.length} checks, ${seconds.toFixed(1)} s`)
      runs.push({ effect: scenario.effect, scenario: scenario.name, rate, seconds, checks: harness.checks, parity: harness.parity, wavs: harness.wavs })
    }
  }

  return runs
}

const number = (value: number | null) => {
  if (value === null) return 'n/a'

  if (!Number.isFinite(value)) return value > 0 ? '+inf' : value < 0 ? '-inf' : 'NaN'

  return Math.abs(value) >= 1e5 || (Math.abs(value) < 1e-3 && value !== 0) ? value.toExponential(2) : String(Number(value.toPrecision(4)))
}

const status = (check: Check) => check.pass === null ? 'info' : check.pass ? 'PASS' : 'FAIL'

const parityCell = (run: ScenarioRun) => {
  const measured = run.parity.flatMap((row) => row.maxAbsDiff === null ? [] : [row.maxAbsDiff])

  if (measured.length > 0) return Math.max(...measured).toExponential(1)
  const reason = run.parity[0]?.reason

  return reason === undefined ? '-' : 'not measured'
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON.stringify replacers receive untyped values
export const jsonReplacer = (_key: string, value: unknown) =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- only numbers can be non-finite
  typeof value === 'number' && !Number.isFinite(value) ? (Number.isNaN(value) ? 'NaN' : value > 0 ? '+Infinity' : '-Infinity') : value

const escapeCell = (text: string) => text.replaceAll('|', '\\|')

export const markdownSummary = (meta: RunMeta, runs: readonly ScenarioRun[], gaps: Record<string, readonly string[]>) => {
  const rows = runs.flatMap((run) => run.checks.map((check) => ({ run, check })))
  const failed = rows.filter(({ check }) => check.pass === false).length
  const passed = rows.filter(({ check }) => check.pass === true).length
  const notMeasured = new Map<string, string>()

  for (const run of runs) {
    const reason = run.parity.find((row) => row.maxAbsDiff === null)?.reason

    if (reason !== undefined) notMeasured.set(run.effect, reason)
  }

  const lines = [
    '# Effects measurement harness',
    '',
    `Run ${meta.timestamp}, commit ${meta.commit}${meta.dirty ? ' (dirty tree)' : ''}, audio-core wasm sha256 ${meta.wasmSha256}`,
    '',
    `**${passed} PASS, ${failed} FAIL**, ${rows.length - passed - failed} informational. Failures on current code are expected: each row is a research acceptance test.`,
    '',
    'Parity is the max absolute sample difference between the C++ wasm render and the legacy browser worklet for the same scenario (n/m: no worklet).',
    notMeasured.size > 0 ? `Not measured for parity: ${[...notMeasured].map(([effect, reason]) => `${effect} (${reason})`).join('; ')}.` : '',
    '',
  ]

  for (const [family, effects] of Object.entries(meta.families)) {
    const familyRuns = runs.filter((run) => effects.includes(run.effect))
    lines.push(`## ${family}`, '', '| effect | scenario | rate | metric | value | threshold | pass | parity |', '|---|---|---|---|---|---|---|---|')

    for (const run of familyRuns) {
      for (const check of run.checks) {
        const unit = check.unit === '' || check.unit === 'bool' ? '' : ` ${check.unit}`
        const value = `${number(check.value)}${unit}`
        const note = check.note === undefined ? '' : ` (${check.note})`
        lines.push(`| ${run.effect} | ${run.scenario} | ${run.rate / 1000}k | ${escapeCell(check.metric)}${escapeCell(note)} | ${value} | ${escapeCell(check.threshold)} | ${status(check)} | ${parityCell(run)} |`)
      }
    }

    lines.push('')
    const familyGaps = gaps[family]

    if (familyGaps !== undefined && familyGaps.length > 0) lines.push(`Acceptance tests from the report that are not encoded (feature absent or needs a signal the core cannot expose):`, '', ...familyGaps.map((gap) => `- ${gap}`), '')
  }

  const slowest = [...runs].sort((a, b) => b.seconds - a.seconds).slice(0, 3)
  lines.push('## Run time', '', `Slowest scenarios: ${slowest.map((run) => `${run.effect}/${run.scenario}@${run.rate / 1000}k ${run.seconds.toFixed(1)} s`).join(', ')}.`, '')

  return lines.join('\n')
}
