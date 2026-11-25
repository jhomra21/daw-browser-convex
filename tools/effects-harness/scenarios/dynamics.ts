// Acceptance tests from dynamics.md section 3: T1 (parity), L1 (smooth attack), L2 (true peak, EBU Tech 3341), L5 (lookahead
// latency), C1 (low-frequency THD+N), C2 (non-finite, shared), C3 (smoothing), C5 (zero latency), G1 (chatter), G3 (timing).
import { countNonFinite, lowpass, peakAbs, peakDb, rmsDb, toneGainDb, truePeakDb } from '../dsp'
import { measureThdPlusNoise } from '../../../packages/audio-engine/src/dsp-characterization'
import { ebuTruePeakCases } from '../ebu3341'
import { fx } from '../effects'
import type { EffectSpec } from '../effects'
import type { Family } from './index'
import type { Scenario } from '../harness'
import { clickTrain, coherentFrequency, concat, constant, dbToLinear, linearToDb, noise, ramp, scale, silence, sine, sineWithPeakAt, square } from '../signals'
import { parityScenario, robustnessScenarios } from './shared'

const normalizePeak = (signal: Float32Array, db: number) => scale(signal, dbToLinear(db) / peakAbs(signal))

const msFrames = (ms: number, rate: number) => Math.ceil(ms * rate / 1000)

const lookaheads = [1.5, 3, 6] as const

const limiterClick: Scenario = {
  effect: 'limiter',
  name: 'l1-click-in-tone',
  run: async (h) => {
    for (const lookaheadMs of lookaheads) {
      const spec = fx.limiter({ ceilingDbtp: -1, lookaheadMs })
      const tone = sine(h.rate, 1000, h.rate, 0.1)
      const clickAt = h.rate / 2
      const input = tone.slice()
      input[clickAt] = 1.9
      const { output } = await h.render(spec, { input: [input] })
      const latency = await h.latencyFrames(spec)
      let previous: { gain: number; frame: number } | null = null
      let jump = 0

      for (let n = clickAt - 300; n < clickAt + latency + 2400; n += 1) {
        const reference = input[n - latency]

        if (Math.abs(reference) < 0.02) continue
        const gain = linearToDb(Math.abs(output[0][n]) / Math.abs(reference))

        // Samples near the tone's zero crossings carry no gain reading; the change across them is spread over the frames skipped.
        if (previous) jump = Math.max(jump, Math.abs(gain - previous.gain) / (n - previous.frame))

        previous = { gain, frame: n }
      }

      h.atMost(`max gain change per sample around a 1.9 click, lookahead ${lookaheadMs} ms`, jump, 0.3, 'dB', 'report: 6.58 dB instant step')
      h.atMost(`output sample peak, lookahead ${lookaheadMs} ms`, peakDb(output[0]), -1, 'dBFS')

      if (lookaheadMs === 3) await h.wav('click', output)
    }
  },
}

const limiterThd: Scenario = {
  effect: 'limiter',
  name: 'l1-steady-thd',
  run: async (h) => {
    const f = coherentFrequency(997, h.rate, h.rate)

    for (const lookaheadMs of lookaheads) {
      const { output } = await h.render(fx.limiter({ ceilingDbtp: -1, lookaheadMs }), { input: [sine(3 * h.rate, f, h.rate, 2)] })
      h.atMost(`THD+N, 997 Hz +6 dBFS into a -1 dBTP ceiling, lookahead ${lookaheadMs} ms`, measureThdPlusNoise(output[0].slice(2 * h.rate), f, h.rate), -100, 'dB')
    }
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

    const fullBandNoise = 'white noise +4 dB over ceiling'

    const sources: [string, Float32Array][] = [
      [fullBandNoise, normalizePeak(noise(frames, 1, 21), ceiling + 4)],
      ['noise low-passed at 0.45 fs, +4 dB', normalizePeak(bandLimitedNoise(frames, h.rate, 22), ceiling + 4)],
      ['fs/4 sine at 45 deg, +6 dB', Float32Array.from({ length: frames }, (_, n) => dbToLinear(ceiling + 6) * Math.sin(Math.PI / 2 * n + Math.PI / 4))],
      ['1 kHz square at 1.5', square(frames, 1000, h.rate, 1.5)],
      ['isolated clicks at 1.5', clickTrain(frames, Math.round(h.rate / 10), 1.5)],
      ...ebuTruePeakCases(h.rate).filter((c) => c.expectedDbtp >= 0).map((c): [string, Float32Array] => [`EBU 3341 case ${c.id}: ${c.description}`, c.signal]),
    ]

    const atCeiling = dbToLinear(ceiling) * 0.99999

    for (const lookaheadMs of lookaheads) {
      let touched = 0

      for (const [name, input] of sources) {
        // Silence after the source so the delayed tail is rendered whole: a file cut inside the signal would read as a truncation overshoot.
        const { output } = await h.render(fx.limiter({ ceilingDbtp: ceiling, lookaheadMs }), { input: [concat(input, silence(4096))] })
        const metric = `output true peak: ${name}, lookahead ${lookaheadMs} ms`

        if (name === fullBandNoise) h.info(metric, truePeakDb(output[0]), 'dBTP', 'full-band noise reaching fs/2: inter-sample peaks depend on samples beyond any lookahead; owner accepted as informational')
        else h.atMost(metric, truePeakDb(output[0]), ceiling + 0.05, 'dBTP')

        for (const sample of output[0]) if (Math.abs(sample) >= atCeiling) touched += 1
      }

      h.info(`output samples at the ceiling over every source above, lookahead ${lookaheadMs} ms`, touched, 'samples', 'the gain aims 0.03 dB under the ceiling, so a sample at the ceiling is the safety clip acting; the native ceiling test logs the exact trigger count')
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

const limiterAuto: Scenario = {
  effect: 'limiter',
  name: 'l3-auto-release',
  run: async (h) => {
    const tone = (seconds: number, amplitude: number) => sine(Math.round(seconds * h.rate), 1000, h.rate, amplitude)
    const spec = fx.limiter({ ceilingDbtp: -1, autoRelease: true, releaseMs: 1000 })
    const latency = await h.latencyFrames(spec)
    const window = Math.round(h.rate / 1000)

    // First 1 ms window, after the loud part ends, whose gain is back within 0.5 dB of unity.
    const recoveryMs = async (loudSeconds: number) => {
      const loud = tone(loudSeconds, 2)
      const input = concat(loud, tone(3, dbToLinear(-10)))
      const { output } = await h.render(spec, { input: [input] })

      for (let n = loud.length; n + window < input.length; n += window) {
        const gain = rmsDb(output[0], n + latency, n + latency + window) - rmsDb(input, n, n + window)

        if (gain > -0.5) return (n - loud.length) / h.rate * 1000
      }

      return Infinity
    }

    const isolated = await recoveryMs(0.005)
    const sustained = await recoveryMs(2)
    h.atMost('recovery to within 0.5 dB after a 5 ms peak', isolated, 100, 'ms', 'four times the 25 ms fast stage')
    h.atLeast('recovery after 2 s of limiting relative to the isolated one', sustained / isolated, 3, 'x', 'the slow stage engages with sustained gain reduction')
    h.atMost('recovery to within 0.5 dB after 2 s of limiting', sustained, 2000, 'ms', 'four times the 500 ms slow stage')

    for (const automatic of [false, true]) {
      const steady = tone(2, 1)
      const { output } = await h.render(fx.limiter({ ceilingDbtp: -1, autoRelease: automatic }), { input: [steady] })
      const delay = await h.latencyFrames(fx.limiter({ lookaheadMs: 3 }))
      let low = Infinity
      let high = -Infinity

      for (let n = h.rate; n < steady.length; n += 1) {
        if (Math.abs(steady[n - delay]) < 0.5) continue
        const gain = linearToDb(output[0][n] / steady[n - delay])
        low = Math.min(low, gain)
        high = Math.max(high, gain)
      }

      h.atMost(`steady gain ripple peak-to-peak, auto ${automatic ? 'on' : 'off'}`, high - low, 0.1, 'dB')
    }
  },
}

const limiterGain: Scenario = {
  effect: 'limiter',
  name: 'l4-input-gain',
  run: async (h) => {
    const input = sine(2 * h.rate, 1000, h.rate, dbToLinear(-10))
    const { output } = await h.render(fx.limiter({ gainDb: 6, ceilingDbtp: -9 }), { input: [input] })
    const settled = output[0].slice(h.rate)
    h.within('output peak, +6 dB gain on a -10 dBFS tone, ceiling -9 dBTP', peakDb(settled), -9, 0.05, 'dBFS')
    h.within('gain reduction, same render', peakDb(settled) - (peakDb(input) + 6), -5, 0.1, 'dB')
    const unity = await h.render(fx.limiter({ gainDb: 0, ceilingDbtp: -9 }), { input: [input] })
    h.within('level change with 0 dB gain and the tone 1 dB below the ceiling', peakDb(unity.output[0].slice(h.rate)) - peakDb(input), 0, 0.02, 'dB')
  },
}

const limiterLatency: Scenario = {
  effect: 'limiter',
  name: 'l5-lookahead-latency',
  run: async (h) => {
    for (const lookaheadMs of lookaheads) {
      h.within(`impulse delay, lookahead ${lookaheadMs} ms`, await h.latencyFrames(fx.limiter({ lookaheadMs })), msFrames(lookaheadMs, h.rate), 1, 'frames')
    }
  },
}

const limiterCpu: Scenario = {
  effect: 'limiter',
  name: 'cpu',
  run: async (h) => {
    h.info('CPU, noise 14 dB under the ceiling', await h.cpuNsPerFrame(fx.limiter({ ceilingDbtp: 0 })), 'ns/frame')
    h.info('CPU, noise 6 dB over the ceiling', await h.cpuNsPerFrame(fx.limiter({ ceilingDbtp: -12 })), 'ns/frame')
  },
}

const compressorSpec = fx.compressor({ thresholdDb: -30, ratio: 4 })

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
    for (const lookaheadMs of [0, 1, 10] as const) {
      h.within(`impulse delay, lookahead ${lookaheadMs} ms`, await h.latencyFrames(fx.compressor({ ratio: 1, thresholdDb: 0, lookaheadMs })), msFrames(lookaheadMs, h.rate), 1, 'frames')
    }
  },
}

const compressorPeakSteady: Scenario = {
  effect: 'compressor',
  name: 'c1-peak-steady-level',
  run: async (h) => {
    const spec = fx.compressor({ thresholdDb: -24, ratio: 4, kneeDb: 0, attackMs: 10, releaseMs: 120, autoRelease: false, detectorMode: 'peak' })
    const f = coherentFrequency(1000, h.rate, h.rate)
    const { output } = await h.render(spec, { input: [sine(3 * h.rate, f, h.rate, 0.5)] })
    h.within('steady output peak, 1 kHz at -6 dBFS, threshold -24, ratio 4 (expected -19.50)', peakDb(output[0].slice(2 * h.rate)), -19.5, 0.1, 'dBFS')
  },
}

// A DC step into a hard-knee compressor with instant attack: the gain follows the detector, so the time its dB value is 3 dB
// under the final one is the detector's own time constant times ln 2 (a one-pole mean square).
const compressorRmsConstant: Scenario = {
  effect: 'compressor',
  name: 'c1-rms-time-constant',
  run: async (h) => {
    const start = Math.round(0.5 * h.rate)
    const input = concat(silence(start), constant(Math.round(0.5 * h.rate), 0.25))
    const spec = fx.compressor({ thresholdDb: -60, ratio: 100, kneeDb: 0, attackMs: 0.1, releaseMs: 5, autoRelease: false, detectorMode: 'rms' })
    const { output } = await h.render(spec, { input: [input] })
    const final = linearToDb(output[0][input.length - 1] / 0.25)
    const slope = 1 - 1 / 100
    let crossing = -1

    for (let n = start; n < input.length; n += 1) {
      if (linearToDb(output[0][n] / 0.25) - final <= slope * 10 * Math.log10(2)) { crossing = n; break }
    }
    h.within('RMS time constant measured from a level step', (crossing - start) / h.rate * 1000 / Math.LN2, 10, 0.2, 'ms')
  },
}

const compressorKeyFilter: Scenario = {
  effect: 'compressor',
  name: 'c4-sidechain-filter-response',
  run: async (h) => {
    const gainDb = async (frequency: number, q: number) => {
      const f = coherentFrequency(frequency, h.rate, h.rate)
      const spec = fx.compressor({ thresholdDb: -60, ratio: 4, kneeDb: 0, attackMs: 100, releaseMs: 100, autoRelease: false, detectorMode: 'rms', sidechain: { enabled: true, filterType: 'highpass', frequencyHz: 120, q } })
      const input = sine(4 * h.rate, f, h.rate, 0.1)
      const { output } = await h.render(spec, { input: [input] }, { parity: false })

      return toneGainDb(input, output[0], f, h.rate, 3 * h.rate, 4 * h.rate)
    }
    // Gain reduction is 0.75 of the detector level over the threshold, so differences in output gain read as detector gain.
    const detector = async (frequency: number, q: number) => (await gainDb(1000, q) - await gainDb(frequency, q)) / 0.75
    h.within('detector gain at 60 Hz, high-pass 120 Hz Q 0.707, vs 1 kHz', await detector(60, 0.707), -12, 0.5, 'dB')
    h.within('detector gain at 120 Hz, high-pass 120 Hz Q 0.707, vs 1 kHz', await detector(120, 0.707), -3, 0.3, 'dB')
    h.atLeast('detector gain at the corner, Q 4 minus Q 0.707', await detector(120, 4) - await detector(120, 0.707), 6, 'dB')
  },
}

const compressorGuards: Scenario = {
  effect: 'compressor',
  name: 'c2-non-finite-sidechain',
  run: async (h) => {
    const f = coherentFrequency(1000, h.rate, h.rate)
    const tone = sine(4 * h.rate, f, h.rate, 0.5)
    const clean = concat(silence(h.rate), tone.subarray(h.rate))
    const dirty = clean.slice()
    const tiny = ramp(Math.round(0.5 * h.rate), 0, 1e-40)
    dirty.set(tiny, 0)
    clean.set(silence(tiny.length), 0)
    ;[NaN, Infinity, -Infinity].forEach((value, index) => { dirty[Math.round(h.rate * (1.2 + index * 0.2))] = value })

    for (const sidechain of [false, true]) {
      const spec = fx.compressor({ thresholdDb: -24, ratio: 4, kneeDb: 0, autoRelease: false, sidechain: { enabled: sidechain, filterType: 'highpass', frequencyHz: 120, q: 0.707 } })
      const [poisoned, reference] = await Promise.all([h.render(spec, { input: [dirty] }, { parity: false }), h.render(spec, { input: [clean] }, { parity: false })])
      const label = `sidechain filter ${sidechain ? 'on' : 'off'}`
      h.atMost(`non-finite output samples, ${label}`, countNonFinite(poisoned.output[0]) + countNonFinite(poisoned.output[1]), 0, 'samples')
      h.atMost(`steady-state level difference from the clean run after 3 s, ${label}`, Math.abs(rmsDb(poisoned.output[0], 3 * h.rate) - rmsDb(reference.output[0], 3 * h.rate)), 0.1, 'dB')
    }
  },
}

// Time for the gain to return 63.2 % of the way to unity after a loud burst of DC, relative to the same render with a fixed release.
const compressorAutoRelease: Scenario = {
  effect: 'compressor',
  name: 'c6-auto-release',
  run: async (h) => {
    const recoveryMs = async (burstSeconds: number, autoRelease: boolean) => {
      const burst = Math.round(burstSeconds * h.rate)
      const input = concat(constant(burst, 0.5), constant(Math.round(1.5 * h.rate), 0.01))
      const spec = fx.compressor({ thresholdDb: -24, ratio: 4, kneeDb: 0, attackMs: 10, releaseMs: 120, autoRelease, detectorMode: 'peak' })
      const { output } = await h.render(spec, { input: [input] }, { parity: false })
      const gain = Array.from(output[0], (value, n) => linearToDb(value / input[n]))
      let low = burst
      // The deepest gain reduction after the burst ends: inside a long burst the gain only wobbles in the last float digit.
      for (let n = burst; n < burst + Math.round(0.1 * h.rate); n += 1) if (gain[n] < gain[low]) low = n
      const target = gain[low] * (1 - 0.632)
      let at = gain.length

      for (let n = low; n < gain.length; n += 1) if (gain[n] >= target) { at = n; break }

      return (at - low) / h.rate * 1000
    }

    for (const [name, seconds, low, high] of [['20 ms burst', 0.02, 0, 0.5], ['2 s burst', 2, 1.5, 3]] as const) {
      const ratio = await recoveryMs(seconds, true) / await recoveryMs(seconds, false)
      h.between(`recovery time with auto release over fixed release, ${name}`, ratio, low, high, 'x')
    }
  },
}

// Compressor CPU per frame at the defaults on the shared 4 s noise render, before this phase (release build, same machine).
const compressorCpuBaseline = new Map([[44100, 79.72], [48000, 76.88], [96000, 64.4]])

const compressorCpu: Scenario = {
  effect: 'compressor',
  name: 'c7-cpu-vs-baseline',
  run: async (h) => {
    const baseline = compressorCpuBaseline.get(h.rate)
    const cpu = await h.cpuNsPerFrame(compressorSpec)

    if (baseline === undefined) h.info('CPU at defaults', cpu, 'ns/frame')
    else h.atMost('CPU at defaults, threshold -30, ratio 4 (baseline before the kernel)', cpu, baseline, 'ns/frame')
  },
}

const compressorAutoMakeup: Scenario = {
  effect: 'compressor',
  name: 'c8-auto-makeup',
  run: async (h) => {
    const spec = fx.compressor({ thresholdDb: -24, ratio: 4, kneeDb: 0, autoRelease: false, detectorMode: 'peak', autoMakeup: true })
    const f = coherentFrequency(1000, h.rate, h.rate)
    const { output } = await h.render(spec, { input: [sine(3 * h.rate, f, h.rate, 1)] })
    h.within('steady output peak, 1 kHz at 0 dBFS, auto makeup (expected 0)', peakDb(output[0].slice(2 * h.rate)), 0, 0.1, 'dBFS')
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
const gateSpec = fx.gate({ thresholdDb: -20 })

const familyOf = (effect: string, spec: EffectSpec, latency: (rate: number) => number): Scenario[] => [
  parityScenario(effect, spec),
  ...robustnessScenarios(effect, spec, latency),
]

export const dynamics: Family = {
  scenarios: [
    limiterClick, limiterThd, limiterTruePeak, meterSelfCheck, limiterAuto, limiterGain, limiterLatency, limiterCpu,
    compressorThd('c1-thd-peak', 'peak', 10, 120, -55),
    compressorThd('c1-thd-rms', 'rms', 10, 120, -55),
    compressorThd('c1-thd-rms-fast', 'rms', 1, 50, -45),
    compressorPeakSteady, compressorRmsConstant, compressorKeyFilter, compressorGuards, compressorAutoRelease, compressorCpu, compressorAutoMakeup,
    makeupStep, compressorLatency, gateChatter, gateTiming,
    ...familyOf('limiter', limiterSpec, (rate) => msFrames(3, rate)),
    ...familyOf('compressor', compressorSpec, () => 0),
    { ...parityScenario('compressor', fx.compressor({ thresholdDb: -30, ratio: 4, lookaheadMs: 10, detectorMode: 'peak', envelopeCurve: 'linear', autoMakeup: true, sidechain: { enabled: true, filterType: 'bandpass', frequencyHz: 800, q: 2 } })), name: 'parity-fixtures-peak-linear-lookahead' },
    ...familyOf('gate', gateSpec, (rate) => msFrames(2, rate)),
  ],
  notEncoded: [
    'L2: the limiter\'s own detector reading on EBU 3341 cases 15 to 23 is internal; the harness instead validates its own true-peak meter against those cases and limits the signals above 0 dBTP.',
    'L6 (Mode) and L8 (routing) are not part of this phase; G4 needs parameters or taps the core does not expose yet.',
    'C2 10-minute silence CPU: covered by the shared denormal CPU ratio on 4 s renders.',
  ],
}
