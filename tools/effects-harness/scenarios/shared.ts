// Scenarios every effect gets: golden-vector parity with the legacy worklet (research T1/M4/A2), non-finite and denormal
// robustness (E2, C2, G2), latency and relative CPU.
import { countNonFinite, maxAbsDiff } from '../dsp'
import type { EffectSpec } from '../effects'
import type { Scenario } from '../harness'
import { clickTrain, concat, constant, noise, sine, silence } from '../signals'

const parityLimit = 1e-5

/** Fixed fixtures, 2 s: tone, noise, step, isolated clicks and a near-Nyquist tone. */
export const parityFixtures = (rate: number): [string, Float32Array][] => {
  const frames = 2 * rate

  return [
    ['sine 1 kHz', sine(frames, 1000, rate, 0.5)],
    ['noise', noise(frames, 0.25, 5)],
    ['step', concat(silence(rate / 10), constant(frames - rate / 10, 0.5))],
    ['clicks', clickTrain(frames, Math.round(rate / 10), 0.8)],
    ['near-Nyquist', sine(frames, 0.45 * rate, rate, 0.5)],
  ]
}

export const parityScenario = (effect: string, spec: EffectSpec): Scenario => ({
  effect,
  name: 'parity-fixtures',
  run: async (h) => {
    for (const [name, input] of parityFixtures(h.rate)) {
      const { output, legacy } = await h.render(spec, { input: [input] })

      if (legacy === null) h.info(`parity ${name}`, null, '', 'not measured: legacy implementation is a Web Audio node chain')
      else h.atMost(`parity ${name}`, Math.max(maxAbsDiff(output[0], legacy[0]), maxAbsDiff(output[1], legacy[1])), parityLimit, 'abs')
    }
  },
})

const floatMin = 1.1754943508222875e-38

export const robustnessScenarios = (effect: string, spec: EffectSpec, expectedLatency: ((rate: number) => number) | null): Scenario[] => [
  {
    effect,
    name: 'non-finite-input',
    run: async (h) => {
      const frames = 4 * h.rate
      const clean = noise(frames, 0.25, 11)
      const dirty = clean.slice()
      const bad = [NaN, Infinity, -Infinity]
      bad.forEach((value, index) => { dirty[h.rate * (1 + index * 0.5)] = value })
      const cleaned = clean.slice()
      bad.forEach((_, index) => { cleaned[h.rate * (1 + index * 0.5)] = 0 })

      const [poisoned, reference] = await Promise.all([
        h.render(spec, { input: [dirty, clean] }, { parity: false }),
        h.render(spec, { input: [cleaned, clean] }, { parity: false }),
      ])

      h.atMost('non-finite output samples', countNonFinite(poisoned.output[0]) + countNonFinite(poisoned.output[1]), 0, 'samples')
      h.atMost('divergence from zero-replaced input after 1 s', Math.max(maxAbsDiff(poisoned.output[0], reference.output[0], 3 * h.rate), maxAbsDiff(poisoned.output[1], reference.output[1], 3 * h.rate)), 1e-4, 'abs')
    },
  },
  {
    effect,
    name: 'denormals',
    run: async (h) => {
      const burst = concat(noise(h.rate, 0.5, 13), silence(3 * h.rate))
      const { output } = await h.render(spec, { input: [burst] }, { parity: false })
      let tiny = 0
      let subnormal = 0

      for (let n = 3 * h.rate; n < output[0].length; n += 1) {
        const magnitude = Math.abs(output[0][n])

        if (magnitude > 0 && magnitude < 1e-20) tiny += 1

        if (magnitude > 0 && magnitude < floatMin) subnormal += 1
      }

      h.atMost('output samples in (0, 1e-20) after 3 s of silence', tiny, 0, 'samples')
      h.atMost('subnormal output samples', subnormal, 0, 'samples')
      const frames = 4 * h.rate
      const timeOf = async (input: Float32Array) => Math.min(...(await Promise.all([0, 1, 2].map(() => h.render(spec, { input: [input] }, { parity: false })))).map((run) => run.nsPerSample))
      const denormalInput = sine(frames, 997, h.rate, 3e-39)
      const quiet = await timeOf(silence(frames))
      const slow = await timeOf(denormalInput)
      h.atMost('CPU of subnormal input relative to silence', slow / quiet, 2, 'x')
    },
  },
  {
    effect,
    name: 'latency-and-cpu',
    run: async (h) => {
      const measured = await h.latencyFrames(spec)

      if (expectedLatency === null) h.info('impulse peak delay', measured, 'frames')
      else h.within('impulse peak delay vs declared latency', measured, expectedLatency(h.rate), 0, 'frames')
      h.info('CPU relative to empty graph', await h.cpuNsPerFrame(spec), 'ns/frame')
    },
  },
]
