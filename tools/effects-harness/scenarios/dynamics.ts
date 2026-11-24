// Acceptance tests from dynamics.md section 3: T1 (parity), L1 (smooth attack), L2 (true peak, EBU Tech 3341), L5 (lookahead
// latency), C1 (low-frequency THD+N), C2 (non-finite, shared), C3 (smoothing), C5 (zero latency), G1 (chatter), G3 (timing).
import { lowpass, peakAbs, peakDb, truePeakDb } from '../dsp'
import { measureThdPlusNoise } from '../../../packages/audio-engine/src/dsp-characterization'
import { ebuTruePeakCases } from '../ebu3341'
import { fx } from '../effects'
import type { EffectSpec } from '../effects'
import type { Family } from './index'
import type { Scenario } from '../harness'
import { clickTrain, coherentFrequency, concat, dbToLinear, linearToDb, noise, scale, sine, sineWithPeakAt, square } from '../signals'
import { parityScenario, robustnessScenarios } from './shared'

const normalizePeak = (signal: Float32Array, db: number) => scale(signal, dbToLinear(db) / peakAbs(signal))

const msFrames = (ms: number, rate: number) => Math.ceil(ms * rate / 1000)

const limiterClick: Scenario = {
  effect: 'limiter',
  name: 'l1-click-in-tone',
  run: async (h) => {
    const spec = fx.limiter({ ceilingDbtp: -1 })
    const tone = sine(h.rate, 1000, h.rate, 0.1)
    const clickAt = h.rate / 2
    const input = tone.slice()
    input[clickAt] = 1.9
    const { output } = await h.render(spec, { input: [input] })
    const latency = await h.latencyFrames(spec)
    let previous: number | null = null
    let jump = 0

    for (let n = clickAt - 300; n < clickAt + latency + 2400; n += 1) {
      const reference = input[n - latency]
      const gain = Math.abs(reference) < 0.02 ? null : linearToDb(Math.abs(output[0][n]) / Math.abs(reference))

      if (gain !== null && previous !== null) jump = Math.max(jump, Math.abs(gain - previous))

      if (gain !== null) previous = gain
    }

    h.atMost('max gain change between consecutive valid samples around a 1.9 click', jump, 0.3, 'dB', 'report: 6.58 dB instant step')
    h.atMost('output sample peak', peakDb(output[0]), -1, 'dBFS')
    await h.wav('click', output)
  },
}

const limiterThd: Scenario = {
  effect: 'limiter',
  name: 'l1-steady-thd',
  run: async (h) => {
    const f = coherentFrequency(997, h.rate, h.rate)
    const { output } = await h.render(fx.limiter({ ceilingDbtp: -1 }), { input: [sine(3 * h.rate, f, h.rate, 2)] })
    h.atMost('THD+N, 997 Hz +6 dBFS into a -1 dBTP ceiling', measureThdPlusNoise(output[0].slice(2 * h.rate), f, h.rate), -100, 'dB')
  },
}

const bandLimitedNoise = (frames: number, rate: number, seed: number) => {
  const raw = noise(frames, 1, seed)
  const once = lowpass(raw, 0.45 * rate, rate)

  return Float32Array.from(lowpass(once, 0.45 * rate, rate))
}

const limiterTruePeak: Scenario = {
  effect: 'limiter',
  name: 'l2-true-peak',
  run: async (h) => {
    const frames = 2 * h.rate
    const ceiling = -1

    const sources: [string, Float32Array][] = [
      ['white noise +4 dB over ceiling', normalizePeak(noise(frames, 1, 21), ceiling + 4)],
      ['noise low-passed at 0.45 fs, +4 dB', normalizePeak(bandLimitedNoise(frames, h.rate, 22), ceiling + 4)],
      ['fs/4 sine at 45 deg, +6 dB', Float32Array.from({ length: frames }, (_, n) => dbToLinear(ceiling + 6) * Math.sin(Math.PI / 2 * n + Math.PI / 4))],
      ['1 kHz square at 1.5', square(frames, 1000, h.rate, 1.5)],
      ['isolated clicks at 1.5', clickTrain(frames, Math.round(h.rate / 10), 1.5)],
      ...ebuTruePeakCases(h.rate).filter((c) => c.expectedDbtp >= 0).map((c): [string, Float32Array] => [`EBU 3341 case ${c.id}: ${c.description}`, c.signal]),
    ]

    for (const [name, input] of sources) {
      const { output } = await h.render(fx.limiter({ ceilingDbtp: ceiling }), { input: [input] })
      h.atMost(`output true peak: ${name}`, truePeakDb(output[0]), ceiling + 0.05, 'dBTP')
    }
  },
}

const meterSelfCheck: Scenario = {
  effect: 'limiter',
  name: 'ebu-3341-meter-self-check',
  run: async (h) => {
    for (const c of ebuTruePeakCases(h.rate)) {
      h.between(`harness true-peak meter, case ${c.id}: ${c.description} (expected ${c.expectedDbtp})`, truePeakDb(c.signal), c.expectedDbtp - 0.4, c.expectedDbtp + 0.2, 'dBTP', 'EBU Tech 3341 tolerance +0.2/-0.4')
    }
  },
}

const limiterLatency: Scenario = {
  effect: 'limiter',
  name: 'l5-lookahead-latency',
  run: async (h) => {
    for (const lookaheadMs of [1, 3, 5]) {
      h.within(`impulse delay, lookahead ${lookaheadMs} ms`, await h.latencyFrames(fx.limiter({ lookaheadMs })), msFrames(lookaheadMs, h.rate), 1, 'frames')
    }
  },
}

const compressorThd = (name: string, detectorMode: 'peak' | 'rms', attackMs: number, releaseMs: number, limit: number): Scenario => ({
  effect: 'compressor',
  name,
  run: async (h) => {
    for (const frequency of [50, 100]) {
      const f = coherentFrequency(frequency, h.rate, h.rate)
      const spec = fx.compressor({ thresholdDb: -24, ratio: 4, kneeDb: 0, attackMs, releaseMs, autoRelease: false, detectorMode })
      const { output } = await h.render(spec, { input: [sine(3 * h.rate, f, h.rate, 0.5)] })
      h.atMost(`THD+N, ${f} Hz at -6 dBFS, ${detectorMode}, attack ${attackMs} / release ${releaseMs} ms`, measureThdPlusNoise(output[0].slice(2 * h.rate), f, h.rate), limit, 'dB')
    }
  },
})

const makeupStep: Scenario = {
  effect: 'compressor',
  name: 'c3-makeup-step-click',
  run: async (h) => {
    const frame = Math.floor(h.rate / 128) * 128
    const { ratio, stepped } = await h.stepClick(fx.compressor({ ratio: 1, thresholdDb: 0 }), [sineWithPeakAt(2 * h.rate, 1000, h.rate, 0.25, frame)], { frame, set: { makeupDb: -12 } }, 2048)
    h.atMost('max sample step after 0 to -12 dB makeup step / sine slope', ratio, 1.5, 'x')
    await h.wav('makeup-step', stepped.output)
  },
}

const compressorLatency: Scenario = {
  effect: 'compressor',
  name: 'c5-lookahead-latency',
  run: async (h) => {
    for (const lookaheadMs of [0, 1, 10]) {
      h.within(`impulse delay, lookahead ${lookaheadMs} ms`, await h.latencyFrames(fx.compressor({ ratio: 1, thresholdDb: 0, lookaheadMs })), msFrames(lookaheadMs, h.rate), 1, 'frames')
    }
  },
}

const gateChatter: Scenario = {
  effect: 'gate',
  name: 'g1-chatter-thd',
  run: async (h) => {
    for (const frequency of [30, 60, 100, 200]) {
      const f = coherentFrequency(frequency, h.rate, h.rate)
      const { output } = await h.render(fx.gate({ thresholdDb: -40, holdMs: 0, hysteresisDb: 6, rangeDb: -80 }), { input: [sine(3 * h.rate, f, h.rate, dbToLinear(-37))] })
      h.atMost(`THD+N, ${f} Hz at threshold +3 dB, hold 0`, measureThdPlusNoise(output[0].slice(2 * h.rate), f, h.rate), -100, 'dB')
    }
  },
}

/** Level of the output relative to the input in sliding one-cycle windows, aligned by `latency`. */
const envelopeDb = (input: Float32Array, output: Float32Array, latency: number, from: number, to: number, window: number, hop: number) => {
  const points: { frame: number; db: number }[] = []

  for (let n = from; n < to; n += hop) {
    points.push({ frame: n, db: linearToDb(peakAbs(output.subarray(n + latency, n + latency + window)) / Math.max(peakAbs(input.subarray(n, n + window)), 1e-12)) })
  }

  return points
}

const gateTiming: Scenario = {
  effect: 'gate',
  name: 'g3-attack-release-time',
  rates: [48000],
  run: async (h) => {
    const spec = fx.gate({ thresholdDb: -40, attackMs: 10, releaseMs: 100, holdMs: 0, rangeDb: -60, hysteresisDb: 6 })
    const latency = await h.latencyFrames(spec)
    const window = Math.round(h.rate / 1000)
    const hop = Math.round(h.rate / 4000)
    const loud = dbToLinear(-10)
    const quiet = dbToLinear(-50)
    const half = h.rate
    const tone = (amplitude: number) => sine(half, 1000, h.rate, amplitude)

    const opening = concat(tone(quiet), tone(loud))
    const attack = (await h.render(spec, { input: [opening] })).output[0]
    const open = envelopeDb(opening, attack, latency, half - 200, half + 4800, window, hop).find((p) => p.frame >= half && p.db >= linearToDb(0.9))
    h.within('time from level step to 90 % gain, attack 10 ms', open ? (open.frame - half) / h.rate * 1000 : Infinity, 10, 1, 'ms', 'report G3: about 25 ms today')
    const closing = concat(tone(loud), sine(2 * h.rate, 1000, h.rate, quiet))
    const release = (await h.render(spec, { input: [closing] })).output[0]
    const close = envelopeDb(closing, release, latency, half, half + 3 * h.rate / 2, window, hop).find((p) => p.db <= -59)
    h.within('time from level step to -59 dB gain, release 100 ms, range -60 dB', close ? (close.frame - half) / h.rate * 1000 : Infinity, 100, 5, 'ms', 'report G3: about 700 ms today')
    await h.wav('release', [release])
  },
}

const limiterSpec = fx.limiter({ ceilingDbtp: -6 })
const compressorSpec = fx.compressor({ thresholdDb: -30, ratio: 4 })
const gateSpec = fx.gate({ thresholdDb: -20 })

const familyOf = (effect: string, spec: EffectSpec, latency: (rate: number) => number): Scenario[] => [
  parityScenario(effect, spec),
  ...robustnessScenarios(effect, spec, latency),
]

export const dynamics: Family = {
  scenarios: [
    limiterClick, limiterThd, limiterTruePeak, meterSelfCheck, limiterLatency,
    compressorThd('c1-thd-peak', 'peak', 10, 120, -55),
    compressorThd('c1-thd-rms', 'rms', 10, 120, -55),
    compressorThd('c1-thd-rms-fast', 'rms', 1, 50, -45),
    makeupStep, compressorLatency, gateChatter, gateTiming,
    ...familyOf('limiter', limiterSpec, (rate) => msFrames(5, rate)),
    ...familyOf('compressor', compressorSpec, (rate) => msFrames(10, rate)),
    ...familyOf('gate', gateSpec, (rate) => msFrames(2, rate)),
  ],
  notEncoded: [
    'L2: the limiter\'s own detector reading on EBU 3341 cases 15 to 23 is internal; the harness instead validates its own true-peak meter against those cases and limits the signals above 0 dBTP.',
    'L3/L4/L6/L7, C4 (sidechain filter response), C6 (auto release), C7, G4: need parameters or taps the core does not expose yet.',
    'C1 RMS time-constant identity across rates and C2 10-minute silence CPU: covered by the shared denormal CPU ratio on 4 s renders.',
  ],
}
