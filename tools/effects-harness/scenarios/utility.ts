// Acceptance tests from saturation-utility.md section 3.3 for the rebuilt Utility: the gain click (U1), the DC blocker (U2), Bass Mono
// (U3), Balance (U4), minimum gain, Mute, Phase L/R and Channel Mode (U5), Mid/Side width (U6), and parity with the legacy worklet
// for every control. The "before" values were measured on the base commit a49d9c57 with the same measurement code
// (utility-measure.ts) and the old state fields; where the base has no such control the same code measured the base's pass-through.
import { maxAbsDiff, toneGainDb } from '../dsp'
import { fx } from '../effects'
import type { Family } from './index'
import type { Scenario } from '../harness'
import { clickTrain, concat, constant, noise, sine, sineWithPeakAt, silence } from '../signals'
import {
  channelLevelsDb, controlStepChange, dcDecayPeak, dcOffNullDb, dcToneResponse, gainStepChange, leftOnlyMoved, loudestOfSweepDb, lr4HighPassDb, lr4LowPassDb,
  midSideRatios, monoLevelDb, phaseLeftError, sideLevelDb, silencedPeak, silenceTail, toneGainAt,
} from './utility-measure'
import type { Stereo, UtilityRender } from './utility-measure'
import { createDefaultUtilityParams } from '@daw-browser/shared'
import type { ParamStep } from '../types'
import { parityLimit, robustnessScenarios } from './shared'

const aligned = (frame: number) => Math.floor(frame / 128) * 128

const render = (h: Parameters<Scenario['run']>[0]): UtilityRender => async (state, input, steps = []) =>
  (await h.render(fx.utility(state), { input, steps }, { parity: false })).output

const sampleStep: Scenario = {
  effect: 'utility',
  name: 'util1-gain-step-and-dc-blocker',
  run: async (h) => {
    const frame = aligned(h.rate)
    const input = [sineWithPeakAt(2 * h.rate, 1000, h.rate, 0.5, frame)]
    const { stepped } = await h.stepClick(fx.utility({ gainDb: 0 }), input, { frame, set: { gainDb: -12 } }, 2048)
    const reference = await h.render(fx.utility({ gainDb: 0 }), { input }, { parity: false })
    let worst = 0

    for (let n = frame; n < frame + 2048; n += 1) worst = Math.max(worst, Math.abs(stepped.output[0][n] - stepped.output[0][n - 1] - (reference.output[0][n] - reference.output[0][n - 1])))
    // Kept as the first version measured it: the extra step over the unstepped 0 dB render. That includes the -12 dB level change itself
    // (0.75 of the 1 kHz sine's step, 0.053 at 44.1 kHz, whatever the ramp), so it is not a click measure and cannot be judged; the
    // research's signal is the full-scale 100 Hz sine stepped 0 to -6 dB at its peak, judged below.
    h.info('largest extra sample step after a 0 to -12 dB gain step, full-scale 0.5 sine, over the 0 dB render', worst, 'FS', 'before (a49d9c57): 0.374; this definition reads 0.0528 at 44.1 kHz with any ramp')
    h.atMost('0 to -6 dB gain step at the peak of a full-scale 100 Hz sine: largest sample-to-sample change', await gainStepChange(render(h), h.rate), 0.05, 'FS', 'before (a49d9c57): 0.500 (an unsmoothed step); the 1 kHz 0.5 sine row measured the sine slope (0.053 at 44.1 kHz) and could not pass')
    const tone = [sine(2 * h.rate, 40, h.rate, 0.5)]
    const { output } = await h.render(fx.utility({ dcBlock: true }), { input: tone })
    h.within('40 Hz gain with the DC blocker', toneGainDb(tone[0], output[0], 40, h.rate, h.rate, 2 * h.rate), 0, 0.05, 'dB')
  },
}

const smoothing: Scenario = {
  effect: 'utility',
  name: 'util1-smoothing',
  run: async (h) => {
    h.atMost('Balance 0 to 1 step at a peak: largest sample-to-sample change of the left output', await controlStepChange(render(h), h.rate, {}, { balance: 1 }), 0.05, 'FS', 'before (a49d9c57): not measured (the base row stepped the other channel)')
    h.atMost('Width 1 to 0 step on an out-of-phase sine: largest change of the left output', await controlStepChange(render(h), h.rate, {}, { width: 0 }), 0.05, 'FS', 'before (a49d9c57): 1.001, an unsmoothed step')
    h.atMost('Mid/Side -1 step on an out-of-phase sine: largest change of the left output', await controlStepChange(render(h), h.rate, { widthMode: 'mid-side' }, { midSide: -1 }), 0.05, 'FS', 'new control, no before value')
    h.atMost('Bass Mono frequency 100 to 400 Hz step on an out-of-phase sine: largest change of the left output', await controlStepChange(render(h), h.rate, { bassMono: true, bassMonoHz: 100 }, { bassMonoHz: 400 }), 0.05, 'FS', 'new control, no before value')
  },
}

const dcBlocker: Scenario = {
  effect: 'utility',
  name: 'util2-dc-blocker',
  run: async (h) => {
    h.atMost('DC blocker off: output vs input, peak difference over peak', await dcOffNullDb(render(h), h.rate), -120, 'dB', 'before (a49d9c57, DC blocker off): -132 dB; the base default was on')
    const tone = await dcToneResponse(render(h), h.rate)
    h.within('DC blocker on: 40 Hz gain', tone.gainDb, 0, 0.05, 'dB', 'before (a49d9c57, 10 Hz corner): -0.258 dB')
    h.within('DC blocker on: 40 Hz phase lead', tone.leadDegrees, 0, 8, 'deg', 'before (a49d9c57, 10 Hz corner): +14.04 deg')
    h.atMost('DC blocker on: 0.1 constant, peak between 1 s and 2 s', await dcDecayPeak(render(h), h.rate), 1e-4, 'FS', 'before (a49d9c57, 10 Hz corner): 5e-29')
    const tail = await silenceTail(render(h), h.rate)
    h.atMost('DC blocker on: nonzero samples below 1e-20 after 4 s of a 10 s silence', tail.tiny, 0, 'samples', 'before (a49d9c57): 288000, every sample of the tail')
    h.atMost('DC blocker on: subnormal samples after 4 s of a 10 s silence', tail.subnormal, 0, 'samples', 'before (a49d9c57): 288000')
    h.atMost('DC blocker on: peak after 4 s of a 10 s silence', tail.peak, 0, 'FS', 'the state flushes at the float floor, so a silent input settles to exact zeros; before (a49d9c57): 5.4e-43, subnormal')
    h.flag('DC blocker is off in a new instance', createDefaultUtilityParams().dcBlock === false, 'default off', 'before (a49d9c57): on')
  },
}

const bassMono: Scenario = {
  effect: 'utility',
  name: 'util3-bass-mono',
  run: async (h) => {
    const side80 = await sideLevelDb(render(h), h.rate, 80, 150)
    h.within('80 Hz out-of-phase at Bass Mono 150 Hz: side (L-R)/2 level rel. input', side80, lr4HighPassDb(80, 150), 0.2, 'dB',
      'the exact Linkwitz-Riley value at the set frequency, -22.5 dB; the research asks 40 dB, which a 4th-order split cannot give at 80 Hz (the high-pass leaves x^4/(1+x^4) of a tone at x = f/fc, so an 8th-order split would be needed); owner decision: keep LR4. before (a49d9c57, no control): -0.06 dB, from its default-on DC blocker')
    h.atMost('40 Hz out-of-phase at Bass Mono 150 Hz: side level rel. input', await sideLevelDb(render(h), h.rate, 40, 150), -40, 'dB', 'before (a49d9c57, no control): -0.06 dB at 80 Hz, from its default-on DC blocker; the LR4 value is -46 dB')
    h.within('2 kHz out-of-phase at Bass Mono 150 Hz: side level rel. input', await sideLevelDb(render(h), h.rate, 2000, 150), 0, 0.1, 'dB', 'before (a49d9c57, no control): -0.06 dB at 80 Hz, from its default-on DC blocker')
    h.within('Bass Mono 300 Hz: 150 Hz out-of-phase side level, the LR4 high-pass value', await sideLevelDb(render(h), h.rate, 150, 300), lr4HighPassDb(150, 300), 0.2, 'dB')
    h.within('Bass Mono 50 Hz: 50 Hz out-of-phase side level, the LR4 corner value of -6 dB', await sideLevelDb(render(h), h.rate, 50, 50), lr4HighPassDb(50, 50), 0.2, 'dB')

    for (const toneHz of [60, 150, 1000]) {
      h.within(`in-phase ${toneHz} Hz at Bass Mono 150 Hz: level rel. input (the split's mono sum is all-pass)`, await monoLevelDb(render(h), h.rate, toneHz, 150), 0, 0.1, 'dB', 'before (a49d9c57, no control): -0.06 dB at 80 Hz, from its default-on DC blocker')
    }

    h.within('Audition at 150 Hz: 80 Hz in-phase level, the LR4 low-pass value', await monoLevelDb(render(h), h.rate, 80, 150, { bassMonoAudition: true }), lr4LowPassDb(80, 150), 0.2, 'dB')
    h.atMost('Audition at 150 Hz: 2 kHz in-phase level rel. input', await monoLevelDb(render(h), h.rate, 2000, 150, { bassMonoAudition: true }), -60, 'dB')
  },
}

const balanceSweep = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]

const balance: Scenario = {
  effect: 'utility',
  name: 'util4-balance',
  run: async (h) => {
    h.atMost('Balance sweep -1 to 1 on a stereo tone: loudest channel rel. input', await loudestOfSweepDb(render(h), h.rate, 'balance', balanceSweep), 0.01, 'dB', 'nothing may get louder; before (a49d9c57, Pan -1 mono): L +3.01 dB')
    const [centreLeft, centreRight] = await channelLevelsDb(render(h), h.rate, { balance: 0 })
    h.within('Balance 0: left channel rel. input', centreLeft, 0, 0.01, 'dB')
    h.within('Balance 0: right channel rel. input', centreRight, 0, 0.01, 'dB')
    const [halfLeft, halfRight] = await channelLevelsDb(render(h), h.rate, { balance: 0.5 })
    h.within('Balance +50%: far (left) channel rel. input', halfLeft, -6.0206, 0.05, 'dB', 'before (a49d9c57): -6.02 dB, with Pan at centre')
    h.within('Balance +50%: near (right) channel rel. input', halfRight, 0, 0.01, 'dB', 'before (a49d9c57, Pan -0.5): L +2.32 dB, R -5.33 dB')
    const [hardLeft, hardRight] = await channelLevelsDb(render(h), h.rate, { balance: -1 })
    h.within('Balance -100%: near (left) channel rel. input', hardLeft, 0, 0.01, 'dB', 'before (a49d9c57, Pan -1): +3.01 dB')
    h.atMost('Balance -100%: far (right) channel rel. input', hardRight, -100, 'dB')
    const swapped = await leftOnlyMoved(render(h), h.rate, { channelMode: 'swap' })
    h.within('Swap on a left-only tone: right channel rel. input', swapped.rightDb, 0, 0.01, 'dB', 'a left-only input can be moved right; before (a49d9c57): the same through Swap, 0 dB; Pan -1 on it gave L +3.01 dB with R silent, Pan +1 silenced it')
    h.atMost('Swap on a left-only tone: left output peak', swapped.leftPeak, 0, 'FS')
    const hard = await leftOnlyMoved(render(h), h.rate, { balance: 1 })
    h.atMost('Balance +100% on a left-only tone: left output peak', hard.leftPeak, 0, 'FS', 'Balance attenuates, it does not move content')
  },
}

const gainAndSwitches: Scenario = {
  effect: 'utility',
  name: 'util5-gain-mute-phase-channel',
  run: async (h) => {
    h.atMost('Gain -inf (-70 dB) on noise: peak after 1 s', await silencedPeak(render(h), h.rate, { gainDb: -70 }), 0, 'FS', 'digital silence; before (a49d9c57, minimum -60 dB): peak 0.00025')
    h.atMost('Mute on noise: peak after 1 s', await silencedPeak(render(h), h.rate, { mute: true }), 0, 'FS', 'new control, no before value')
    h.within('Gain +35 dB: gain of a quiet tone', await toneGainAt(render(h), h.rate, 35), 35, 0.01, 'dB', 'before (a49d9c57, maximum +24 dB)')
    h.within('Gain -60 dB: gain of a quiet tone', await toneGainAt(render(h), h.rate, -60), -60, 0.01, 'dB')
    const phase = await phaseLeftError(render(h), h.rate)
    h.atMost('Phase L: left output vs inverted input', phase.left, 1e-7, 'abs', 'before (a49d9c57, polarity inverted both channels): right differed by up to 0.5')
    h.atMost('Phase L: right output vs input', phase.right, 1e-7, 'abs')
    const input: Stereo = [noise(h.rate, 0.25, 51), noise(h.rate, 0.25, 52)]
    const [rightLeft, rightRight] = await render(h)({ phaseRight: true }, input)
    h.atMost('Phase R: left output vs input', maxAbsDiff(rightLeft, input[0]), 1e-7, 'abs')
    h.atMost('Phase R: right output vs inverted input', maxAbsDiff(rightRight, input[1].map((value) => 0 - value)), 1e-7, 'abs')

    const exact = async (mode: string, wanted: (left: Float32Array, right: Float32Array) => readonly [Float32Array, Float32Array]) => {
      const [left, right] = await render(h)({ channelMode: mode }, input)
      const [expectedLeft, expectedRight] = wanted(input[0], input[1])
      h.atMost(`Channel Mode ${mode}: largest error of both outputs`, Math.max(maxAbsDiff(left, expectedLeft), maxAbsDiff(right, expectedRight)), 1e-7, 'abs')
    }

    await exact('left', (left) => [left, left])
    await exact('right', (_left, right) => [right, right])
    await exact('swap', (left, right) => [right, left])
    const narrowed = await render(h)({ channelMode: 'left', width: 0 }, input)
    h.atMost('Channel Mode Left ignores Width: error vs the left channel at Width 0', Math.max(maxAbsDiff(narrowed[0], input[0]), maxAbsDiff(narrowed[1], input[0])), 1e-7, 'abs')
  },
}

const width: Scenario = {
  effect: 'utility',
  name: 'util6-width-mid-side',
  run: async (h) => {
    const identity = await midSideRatios(render(h), h.rate, { widthMode: 'mid-side', midSide: 0 })
    // before (a49d9c57): no Mid/Side control, every ratio reads 1.0004 (its default-on DC blocker)
    h.within('Mid/Side 0: mid ratio', identity.mid, 1, 1e-4, '')
    h.within('Mid/Side 0: side ratio', identity.side, 1, 1e-4, '')
    const mono = await midSideRatios(render(h), h.rate, { widthMode: 'mid-side', midSide: -1 })
    h.within('Mid/Side -1 (mono): mid ratio', mono.mid, 1, 1e-4, '')
    h.atMost('Mid/Side -1 (mono): side ratio', mono.side, 1e-6, '')
    const sideOnly = await midSideRatios(render(h), h.rate, { widthMode: 'mid-side', midSide: 1 })
    h.atMost('Mid/Side +1 (side only): mid ratio', sideOnly.mid, 1e-6, '')
    h.within('Mid/Side +1 (side only): side ratio', sideOnly.side, 1, 1e-4, '')
    let monotonic = true
    let previous = { mid: Infinity, side: -Infinity }

    for (let step = -10; step <= 10; step += 1) {
      const ratios = await midSideRatios(render(h), h.rate, { widthMode: 'mid-side', midSide: step / 10 })
      monotonic &&= ratios.mid <= previous.mid + 1e-6 && ratios.side >= previous.side - 1e-6
      previous = ratios
    }

    h.flag('Mid/Side -1 to 1 in steps of 0.1: mid never rises and side never falls', monotonic, 'continuous mono to side-only')
    const narrow = await midSideRatios(render(h), h.rate, { width: 0 })
    h.atMost('Width 0: side ratio', narrow.side, 1e-6, '', 'before (a49d9c57): the same')
    const wide = await midSideRatios(render(h), h.rate, { width: 2 })
    h.within('Width 200%: side ratio', wide.side, 2, 1e-4, '')
    h.within('Width 200%: mid ratio', wide.mid, 1, 1e-4, '')
  },
}

const stereoFixtures = (rate: number): [string, Stereo][] => {
  const frames = 2 * rate
  const step = concat(silence(rate / 10), constant(frames - rate / 10, 0.5))

  return [
    ['stereo noise', [noise(frames, 0.25, 5), noise(frames, 0.25, 6)]],
    ['sine pair', [sine(frames, 997, rate, 0.5), sine(frames, 313, rate, 0.4)]],
    ['out-of-phase 80 Hz', [sine(frames, 80, rate, 0.5), sine(frames, 80, rate, -0.5)]],
    ['step', [step, step.map((value) => -0.5 * value)]],
    ['left-only clicks', [clickTrain(frames, Math.round(rate / 10), 0.8), silence(frames)]],
    ['near-Nyquist', [sine(frames, 0.45 * rate, rate, 0.5), sine(frames, 0.4 * rate, rate, 0.5)]],
  ]
}

const parityStates: [string, Parameters<typeof fx.utility>[0]][] = [
  ['defaults', {}],
  ['gain -7 dB', { gainDb: -7 }],
  ['gain +35 dB', { gainDb: 35 }],
  ['gain -inf', { gainDb: -70 }],
  ['mute', { mute: true }],
  ['balance -0.6', { balance: -0.6 }],
  ['balance +0.4', { balance: 0.4 }],
  ['width 0.3', { width: 0.3 }],
  ['width 1.7', { width: 1.7 }],
  ['mid/side +0.5', { widthMode: 'mid-side', midSide: 0.5 }],
  ['mid/side -0.5', { widthMode: 'mid-side', midSide: -0.5 }],
  ['phase L', { phaseLeft: true }],
  ['phase R', { phaseRight: true }],
  ['channel left', { channelMode: 'left' }],
  ['channel right', { channelMode: 'right' }],
  ['channel swap', { channelMode: 'swap' }],
  ['mono sum', { inputMode: 'mono-sum' }],
  ['mid/side encode', { matrix: 'mid-side-encode' }],
  ['mid/side decode', { matrix: 'mid-side-decode' }],
  ['dc blocker', { dcBlock: true }],
  ['bass mono 120 Hz', { bassMono: true }],
  ['bass mono 300 Hz', { bassMono: true, bassMonoHz: 300 }],
  ['bass mono audition', { bassMono: true, bassMonoHz: 200, bassMonoAudition: true }],
  ['everything', { gainDb: -3, balance: 0.2, width: 1.4, phaseLeft: true, matrix: 'mid-side-encode', channelMode: 'swap', dcBlock: true, bassMono: true, bassMonoHz: 90 }],
]

const stereoParity = (name: string, state: Parameters<typeof fx.utility>[0]): Scenario => ({
  effect: 'utility',
  name: `parity-${name}`,
  run: async (h) => {
    for (const [label, input] of stereoFixtures(h.rate)) {
      const { output, legacy } = await h.render(fx.utility(state), { input })

      if (legacy === null) throw new Error('The utility has a legacy worklet')
      h.atMost(`parity ${label}`, Math.max(maxAbsDiff(output[0], legacy[0]), maxAbsDiff(output[1], legacy[1])), parityLimit, 'abs')
    }
  },
})

const automationParity: Scenario = {
  effect: 'utility',
  name: 'parity-automation',
  run: async (h) => {
    const input: Stereo = [noise(2 * h.rate, 0.25, 7), noise(2 * h.rate, 0.25, 8)]
    const at = (seconds: number) => aligned(seconds * h.rate)
    const steps: ParamStep[] = [{ frame: at(0.2), set: { gainDb: -9 } }, { frame: at(0.4), set: { balance: 0.5, width: 0.4 } }, { frame: at(0.6), set: { bassMonoHz: 300 } }, { frame: at(0.8), set: { midSide: -0.3 } }]

    for (const state of [{ bassMono: true, bassMonoHz: 80, widthMode: 'mid-side' as const }, { bassMono: true, bassMonoHz: 80 }]) {
      const { output, legacy } = await h.render(fx.utility(state), { input, steps })

      if (legacy === null) throw new Error('The utility has a legacy worklet')
      h.atMost(`parity automation of every control, ${state.widthMode ?? 'stereo'} width`, Math.max(maxAbsDiff(output[0], legacy[0]), maxAbsDiff(output[1], legacy[1])), parityLimit, 'abs')
    }
  },
}

const utilitySpec = fx.utility()
const loadedSpec = fx.utility({ gainDb: -3, dcBlock: true, bassMono: true, widthMode: 'mid-side', midSide: 0.2 })

export const utility: Family = {
  scenarios: [
    sampleStep, smoothing, dcBlocker, bassMono, balance, gainAndSwitches, width,
    ...parityStates.map(([name, state]) => stereoParity(name, state)),
    automationParity,
    ...robustnessScenarios('utility', utilitySpec, null),
    ...robustnessScenarios('utility', loadedSpec, null).map((scenario) => ({ ...scenario, name: `${scenario.name}-all-on` })),
  ],
  notEncoded: [
    'The 80 Hz Bass Mono row of the research (40 dB): a 4th-order split cannot give it; the row asserts the exact Linkwitz-Riley value, and a 40 Hz row asserts 40 dB (owner decision).',
    'A Mute click row: the harness steps numeric state paths, and Mute is a switch; the ramp is covered by the native utility test.',
    'A pan-to-balance migration of automation lanes: the retired utility.pan lane is dropped.',
  ],
}
