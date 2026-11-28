// The per-scenario context handed to scenario files: renders through the C++ core (and the legacy worklet for parity),
// records threshold checks, and measures the cross-cutting quantities (latency, CPU, step clicks).
import type { EffectSpec } from './effects'
import { clickMetric, maxAbsDiff, maxStep } from './dsp'
import { legacySupported, renderLegacy, unsupportedReason } from './render-legacy'
import { renderInstrument } from './render-instrument'
import type { Instrument, InstrumentRenderOptions } from './render-instrument'
import { renderWasm } from './render-wasm'
import { impulse, noise } from './signals'
import { withPaths } from './state-path'
import type { Check, ParamStep, ParityRow, Planar, RenderOptions, Rendered } from './types'
import { wavBytes } from './wav'

export type Scenario = {
  effect: string
  name: string
  /** Sample rates to run at; defaults to 44.1, 48 and 96 kHz. */
  rates?: readonly number[]
  run: (h: Harness) => Promise<void>
}

export const defaultRates = [44100, 48000, 96000] as const

export type RenderFlags = { parity?: boolean; rate?: number }

export type RenderResult = Rendered & { legacy: Planar | null }

export const patchSpec = <S extends EffectSpec>(spec: S, set: Readonly<Record<string, number>>): S =>
  ({ ...spec, state: withPaths(spec.state, set) })

const overheadByRate = new Map<number, number>()

export type Harness = ReturnType<typeof createHarness>

export const createHarness = (context: { effect: string; scenario: string; rate: number; wavDir: string | null }) => {
  const { effect, scenario, rate, wavDir } = context
  const checks: Check[] = []
  const parity: ParityRow[] = []
  const wavs: string[] = []

  const push = (metric: string, value: number | null, unit: string, threshold: string, pass: boolean | null, note?: string) =>
    checks.push({ effect, scenario, rate, metric, value, unit, threshold, pass, note })

  const render = async (spec: EffectSpec, options: RenderOptions, flags: RenderFlags = {}): Promise<RenderResult> => {
    const at = flags.rate ?? rate
    const rendered = await renderWasm(spec, at, options)
    const legacy = flags.parity === false ? null : await renderLegacy(spec, at, options)

    if (flags.parity !== false) {
      parity.push(legacy
        ? { effect, scenario, rate: at, maxAbsDiff: Math.max(maxAbsDiff(rendered.output[0], legacy[0]), maxAbsDiff(rendered.output[1], legacy[1])) }
        : { effect, scenario, rate: at, maxAbsDiff: null, reason: legacySupported(spec.kind) ? 'not rendered' : unsupportedReason })
    }

    return { ...rendered, legacy }
  }

  const renderInstrumentAt = (instrument: Instrument, options: InstrumentRenderOptions) => renderInstrument(instrument, rate, options)

  const overhead = async () => {
    const cached = overheadByRate.get(rate)

    if (cached !== undefined) return cached
    const input = [noise(rate * 2, 0.25, 7)]
    const runs = await Promise.all([0, 1, 2].map(() => renderWasm(null, rate, { input })))
    const best = Math.min(...runs.map((run) => run.nsPerSample))
    overheadByRate.set(rate, best)

    return best
  }

  /** CPU of the processor alone: best of three 4 s stereo noise renders minus the empty graph, in ns per frame. */
  const cpuNsPerFrame = async (spec: EffectSpec, input: readonly Float32Array[] = [noise(rate * 4, 0.25, 3)]) => {
    const base = await overhead()
    const runs = await Promise.all([0, 1, 2].map(() => renderWasm(spec, rate, { input })))

    return Math.min(...runs.map((run) => run.nsPerSample)) - base
  }

  /**
   * The slowest single 128-frame process call of a graph with the processor, best of nine 2 s renders so a preempted run does not count,
   * in ns. The empty graph's own worst call is a few microseconds and stays in the number.
   */
  const worstBlockNs = async (spec: EffectSpec, input: readonly Float32Array[] = [noise(rate * 2, 0.25, 3)]) => {
    let best = Infinity

    for (let run = 0; run < 9; run += 1) best = Math.min(best, (await renderWasm(spec, rate, { input })).worstBlockNs)

    return best
  }

  /** Frame of the largest output sample for a unit impulse at frame 0 (the dry or wet path delay of the processor). */
  const latencyFrames = async (spec: EffectSpec, frames = Math.round(0.4 * rate)) => {
    const { output } = await render(spec, { input: [impulse(frames, 0.5)] }, { parity: false })
    let best = 0

    for (let n = 1; n < frames; n += 1) if (Math.abs(output[0][n]) > Math.abs(output[0][best])) best = n

    return best
  }

  /**
   * Click metrics of `channel` over [frame, frame+window) for a parameter step. `ratio`: largest sample-to-sample step relative to the
   * larger of the steady-state renders before and after the step. `extraRatio`: largest extra step the change adds to the unstepped
   * render, relative to that render's own largest step (the reverb research's m2.cjs definition).
   */
  const stepClick = async (spec: EffectSpec, input: readonly Float32Array[], step: ParamStep, window: number, channel = 0) => {
    const [stepped, before, after] = await Promise.all([
      render(spec, { input, steps: [step] }),
      render(spec, { input }, { parity: false }),
      render(patchSpec(spec, step.set), { input }, { parity: false }),
    ])

    const steppedMax = maxStep(stepped.output[channel], step.frame, step.frame + window)
    const referenceMax = Math.max(maxStep(before.output[channel], step.frame, step.frame + window), maxStep(after.output[channel], step.frame, step.frame + window))

    const { extraRatio } = clickMetric(stepped.output[channel], before.output[channel], step.frame, window)

    return { steppedMax, referenceMax, ratio: steppedMax / referenceMax, extraRatio, stepped }
  }

  const wav = async (name: string, output: readonly Float32Array[]) => {
    if (wavDir === null || rate !== 48000) return
    const file = `${wavDir}/${effect}-${scenario}-${name}.wav`
    await Bun.write(file, wavBytes(output, rate))
    wavs.push(file)
  }

  return {
    rate, effect, scenario, checks, parity, wavs,
    render, renderInstrument: renderInstrumentAt, cpuNsPerFrame, worstBlockNs, latencyFrames, stepClick, wav,
    atMost: (metric: string, value: number, limit: number, unit = '', note?: string) =>
      push(metric, value, unit, `≤ ${limit} ${unit}`.trim(), value <= limit, note),
    atLeast: (metric: string, value: number, limit: number, unit = '', note?: string) =>
      push(metric, value, unit, `≥ ${limit} ${unit}`.trim(), value >= limit, note),
    within: (metric: string, value: number, target: number, tolerance: number, unit = '', note?: string) =>
      push(metric, value, unit, `${target} ± ${tolerance} ${unit}`.trim(), Math.abs(value - target) <= tolerance, note),
    between: (metric: string, value: number, low: number, high: number, unit = '', note?: string) =>
      push(metric, value, unit, `${low} … ${high} ${unit}`.trim(), value >= low && value <= high, note),
    info: (metric: string, value: number | null, unit = '', note?: string) => push(metric, value, unit, 'informational', null, note),
    flag: (metric: string, ok: boolean, requirement: string, note?: string) => push(metric, ok ? 1 : 0, 'bool', requirement, ok, note),
  }
}
