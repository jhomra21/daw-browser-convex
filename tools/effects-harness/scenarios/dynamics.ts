// Acceptance tests from dynamics.md section 3: T1 (parity), L1 (smooth attack), L2 (true peak, EBU Tech 3341), L5 (lookahead
// latency), C1 (low-frequency THD+N), C2 (non-finite, shared), C3 (smoothing), C5 (zero latency), G1 (chatter), G2 (non-finite),
// G3 (timing), G4 (flip, key, key filter) and G5 (lookahead latency).
import { countNonFinite, lowpass, maxAbsDiff, peakAbs, peakDb, rmsDb, toneGainDb, truePeakDb } from '../dsp'
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

// Bluetooth headsets run at 16 and 24 kHz, where 1.5 ms is shorter than the limiter's smoothing boxes.
const limiterLowRate: Scenario = {
  effect: 'limiter',
  name: 'l2-true-peak-low-rate',
  rates: [16000, 24000],
  run: async (h) => {
    const frames = 2 * h.rate
    const ceiling = -1
    const atCeiling = dbToLinear(ceiling) * 0.99999

    const sources: [string, Float32Array][] = [
      ['noise low-passed at 0.45 fs, +4 dB', normalizePeak(bandLimitedNoise(frames, h.rate, 22), ceiling + 4)],
      ['fs/4 sine at 45 deg, +6 dB', Float32Array.from({ length: frames }, (_, n) => dbToLinear(ceiling + 6) * Math.sin(Math.PI / 2 * n + Math.PI / 4))],
    ]

    for (const [name, input] of sources) {
      const { output } = await h.render(fx.limiter({ ceilingDbtp: ceiling, lookaheadMs: 1.5 }), { input: [concat(input, silence(4096))] })
      h.atMost(`output true peak: ${name}, lookahead 1.5 ms`, truePeakDb(output[0]), ceiling + 0.05, 'dBTP')
      // The gain aims under the ceiling, so a sample at the ceiling is the safety clip acting.
      h.atMost(`output samples at the ceiling: ${name}, lookahead 1.5 ms`, output[0].filter((sample) => Math.abs(sample) >= atCeiling).length, 0, 'samples')
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

// The core crossfades the bypass over 10 ms; the worklet used to switch between wet and dry on a single sample.
const limiterBypassToggle: Scenario = {
  effect: 'limiter',
  name: 'parity-enabled-toggle',
  run: async (h) => {
    const frames = 2 * h.rate
    const off = Math.round(0.5 * h.rate / 128) * 128
    const on = Math.round(1.25 * h.rate / 128) * 128
    const spec = fx.limiter({ ceilingDbtp: -6 })
    const input = sine(frames, 1000, h.rate, 0.8)
    const { output, legacy } = await h.render(spec, { input: [input], enabledSteps: [{ frame: off, enabled: false }, { frame: on, enabled: true }] })

    if (legacy === null) throw new Error('limiter has a legacy worklet')
    h.atMost('parity, enabled off at 0.5 s and back on at 1.25 s', Math.max(maxAbsDiff(output[0], legacy[0]), maxAbsDiff(output[1], legacy[1])), 1e-5, 'abs')
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

// Before the kernel, on the machine that measured this phase: 79.7 / 76.9 / 64.4 ns/frame at 44.1 / 48 / 96 kHz. A timing on
// another machine is not comparable, so the row reports and does not judge.
const compressorCpu: Scenario = {
  effect: 'compressor',
  name: 'c7-cpu',
  run: async (h) => {
    h.info('CPU at defaults, threshold -30, ratio 4', await h.cpuNsPerFrame(compressorSpec), 'ns/frame')
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

// Expand is upward expansion, as in Live: a ratio of 1:2 adds 1 dB of output per dB of input above the threshold.
const compressorExpand: Scenario = {
  effect: 'compressor',
  name: 'c9-expand-curve',
  run: async (h) => {
    const f = coherentFrequency(1000, h.rate, h.rate)
    const base = { thresholdDb: -24, ratio: 2, kneeDb: 0, attackMs: 0.1, releaseMs: 50, autoRelease: false, detectorMode: 'peak', dynamicsMode: 'expand' } as const

    const gainAt = async (levelDb: number, state: Parameters<typeof fx.compressor>[0] = base) => {
      const input = sine(2 * h.rate, f, h.rate, dbToLinear(levelDb))
      const { output } = await h.render(fx.compressor(state), { input: [input] })

      return peakDb(output[0].slice(h.rate)) - peakDb(input.slice(h.rate))
    }

    h.within('gain at -12 dBFS, 1:2 over threshold -24 (expected +12)', await gainAt(-12), 12, 0.1, 'dB')
    h.within('gain at -6 dBFS, 1:2 over threshold -24 (expected +18)', await gainAt(-6), 18, 0.1, 'dB')
    h.within('gain at -30 dBFS, below the threshold (expected 0)', await gainAt(-30), 0, 0.05, 'dB')
    h.within('gain at -6 dBFS, ratio 1:1 (expected 0)', await gainAt(-6, { ...base, ratio: 1 }), 0, 0.05, 'dB')
    h.within('gain at 0 dBFS, ratio 1:100 stops at the limit', await gainAt(0, { ...base, ratio: 100 }), 24, 0.1, 'dB', 'COMPRESSOR_EXPAND_MAX_GAIN_DB')

    // A knee of 6 dB centred on the threshold: 0 dB at its lower edge, 0.75 dB at the threshold, 3 dB at its upper edge.
    const soft = { ...base, kneeDb: 6 }
    const levels = Array.from({ length: 17 }, (_, index) => -28 + index * 0.5)
    const gains = await Promise.all(levels.map((level) => gainAt(level, soft)))
    h.within('knee 6 dB: gain at the threshold', gains[8], 0.75, 0.05, 'dB')
    h.within('knee 6 dB: gain at the lower edge', gains[2], 0, 0.05, 'dB')
    h.within('knee 6 dB: gain at the upper edge', gains[14], 3, 0.05, 'dB')
    const steps = gains.slice(1).map((gain, index) => gain - gains[index])
    // The line's slope is 1 dB per dB, so a half-dB step is at most 0.5 dB; a jump in value would exceed it.
    h.atMost('knee 6 dB: largest gain change per 0.5 dB step, 28 to 20 dB under full scale', Math.max(...steps), 0.55, 'dB')
    // A slope that jumps shows as a second difference far above the knee's curvature (slope / knee * 0.5 dB squared = 0.042 dB).
    h.atMost('knee 6 dB: largest change of slope per 0.5 dB step', Math.max(...steps.slice(1).map((step, index) => Math.abs(step - steps[index]))), 0.09, 'dB')

    const makeup = await h.render(fx.compressor({ ...base, makeupDb: 3, autoMakeup: true }), { input: [sine(2 * h.rate, f, h.rate, dbToLinear(-40))] })
    h.within('Auto Makeup on in Expand, Makeup 3 dB: gain below the threshold (the knob applies)', peakDb(makeup.output[0].slice(h.rate)) - -40, 3, 0.05, 'dB')
  },
}

const gateChatter: Scenario = {
  effect: 'gate',
  name: 'g1-chatter-thd',
  run: async (h) => {
    for (const frequency of [30, 60, 100, 200]) {
      const f = coherentFrequency(frequency, h.rate, h.rate)
      const spec = fx.gate({ thresholdDb: -40, holdMs: 0, hysteresisDb: 6, rangeDb: -60 })
      const { output } = await h.render(spec, { input: [sine(3 * h.rate, f, h.rate, dbToLinear(-37))] })
      h.atMost(`THD+N, ${f} Hz at threshold +3 dB, hold 0`, measureThdPlusNoise(output[0].slice(2 * h.rate), f, h.rate), -100, 'dB')

      // A tone 10 dB under the threshold (4 dB under where the gate lets go) after a burst above it: once hold and release have run, the gate sits on the floor.
      const quiet = sine(2 * h.rate, f, h.rate, dbToLinear(-50))
      const input = concat(sine(h.rate / 2, f, h.rate, dbToLinear(-37)), quiet)
      const closed = (await h.render(spec, { input: [input] })).output[0]
      h.atMost(`gain once closed, ${f} Hz 10 dB under the threshold, floor -60`, toneGainDb(input, closed, f, h.rate, Math.round(1.5 * h.rate), 2 * h.rate), -59.5, 'dB')
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
    h.within('time from level step to 90 % gain, attack 10 ms', open ? (open.frame - half) / h.rate * 1000 : Infinity, 10, 1, 'ms')
    const closing = concat(tone(loud), sine(2 * h.rate, 1000, h.rate, quiet))
    const release = (await h.render(spec, { input: [closing] })).output[0]
    const close = envelopeDb(closing, release, latency, half, half + 3 * h.rate / 2, window, hop).find((p) => p.db <= -59)
    h.within('time from level step to -59 dB gain, release 100 ms, range -60 dB', close ? (close.frame - half) / h.rate * 1000 : Infinity, 100, 5, 'ms')
    await h.wav('release', [release])

    // A DC step shows the gain sample by sample, with no tone to read it through.
    const dc = concat(constant(half, quiet), constant(half, loud))
    const dcOut = (await h.render(spec, { input: [dc] })).output[0]
    let unity = Infinity

    for (let n = half; n < dc.length; n += 1) if (dcOut[n + latency] / dc[n] >= 0.999) { unity = (n - half) / h.rate * 1000; break }

    h.atMost('time from level step to 0 dB gain, attack 10 ms, floor -60 dB', unity, 10 + 1000 / h.rate, 'ms', 'attack 10 ms plus one frame')
  },
}

const gateGuards: Scenario = {
  effect: 'gate',
  name: 'g2-non-finite',
  run: async (h) => {
    const f = coherentFrequency(1000, h.rate, h.rate)
    const tone = sine(4 * h.rate, f, h.rate, 0.5)
    const clean = concat(silence(h.rate), tone.subarray(h.rate))
    const dirty = clean.slice()
    const tiny = ramp(Math.round(0.5 * h.rate), 0, 1e-40)
    dirty.set(tiny, 0)
    clean.set(silence(tiny.length), 0)
    ;[NaN, Infinity, -Infinity].forEach((value, index) => { dirty[Math.round(h.rate * (1.2 + index * 0.2))] = value })

    for (const [source, filter] of [['main input', false], ['main input', true], ['sidechain input', false], ['sidechain input', true]] as const) {
      const spec = fx.gate({ thresholdDb: -40, sidechain: { enabled: filter, filterType: 'highpass', frequencyHz: 120, q: 0.707, gainDb: 0, mix: 1 } })

      const render = (poison: Float32Array) => source === 'main input'
        ? h.render(spec, { input: [poison] }, { parity: false })
        : h.render(spec, { input: [clean], key: [poison] }, { parity: false })

      const [poisoned, reference] = await Promise.all([render(dirty), render(clean)])
      const label = `${source}, sidechain filter ${filter ? 'on' : 'off'}`
      h.atMost(`non-finite output samples, ${label}`, countNonFinite(poisoned.output[0]) + countNonFinite(poisoned.output[1]), 0, 'samples')
      h.atMost(`steady-state level difference from the clean run after 3 s, ${label}`, Math.abs(rmsDb(poisoned.output[0], 3 * h.rate) - rmsDb(reference.output[0], 3 * h.rate)), 0.1, 'dB')
    }
  },
}

/** Level of the output relative to the input over each [start + from, start + to) window, in dB. */
const windowGains = (input: Float32Array, output: Float32Array, starts: readonly number[], from: number, to: number) =>
  starts.map((start) => rmsDb(output, start + from, start + to) - rmsDb(input, start + from, start + to))

const gateFlip: Scenario = {
  effect: 'gate',
  name: 'g4-flip',
  run: async (h) => {
    const period = Math.round(0.25 * h.rate)
    const burst = Math.round(0.06 * h.rate)
    const bed = noise(2 * h.rate, dbToLinear(-70), 5).slice()
    const starts = Array.from({ length: 7 }, (_, index) => (index + 1) * period)
    const f = coherentFrequency(1000, h.rate, h.rate)

    for (const start of starts) bed.set(sine(burst, f, h.rate, dbToLinear(-10)), start)
    const ms = (value: number) => Math.round(value * h.rate / 1000)

    for (const flip of [false, true]) {
      const spec = fx.gate({ thresholdDb: -40, attackMs: 1, releaseMs: 20, holdMs: 0, hysteresisDb: 6, rangeDb: -60, flip })
      const { output } = await h.render(spec, { input: [bed] })
      const bursts = windowGains(bed, output[0], starts, ms(30), ms(55))
      const gaps = windowGains(bed, output[0], starts, ms(200), ms(245))
      const label = `flip ${flip ? 'on' : 'off'}`

      if (flip) {
        h.atMost(`worst burst gain, drum-like fixture, ${label}`, Math.max(...bursts), -55, 'dB', 'the burst is what the gate would pass, so it closes')
        h.within(`worst gap gain, drum-like fixture, ${label}`, Math.max(...gaps.map(Math.abs)), 0, 0.5, 'dB', 'the bed is what the gate would close on, so it passes')
      } else {
        h.within(`worst burst gain, drum-like fixture, ${label}`, Math.max(...bursts.map(Math.abs)), 0, 0.5, 'dB')
        h.atMost(`worst gap gain, drum-like fixture, ${label}`, Math.max(...gaps), -55, 'dB')
      }
    }
  },
}

const gateKey: Scenario = {
  effect: 'gate',
  name: 'g4-external-key',
  run: async (h) => {
    const f = coherentFrequency(1000, h.rate, h.rate)
    const frames = 3 * h.rate
    const quiet = sine(frames, f, h.rate, dbToLinear(-60))
    const from = 2 * h.rate
    const gain = (input: Float32Array, output: Float32Array) => toneGainDb(input, output, f, h.rate, from, frames)
    const loudKey = [noise(frames, dbToLinear(-10), 11)]
    const spec = (sidechain: { gainDb?: number; mix?: number }) => fx.gate({ thresholdDb: -40, holdMs: 0, rangeDb: -60, sidechain: { enabled: false, filterType: 'highpass', frequencyHz: 80, q: 0.707, gainDb: 0, mix: 1, ...sidechain } })

    const internal = await h.render(spec({ mix: 0 }), { input: [quiet] })
    const mixedOut = await h.render(spec({ mix: 0 }), { input: [quiet], key: loudKey })
    h.atMost('largest sample difference, external key at 0 % against no key', Math.max(maxAbsDiff(internal.output[0], mixedOut.output[0]), maxAbsDiff(internal.output[1], mixedOut.output[1])), 0, '', 'bit-exact')
    const keyed = await h.render(spec({ mix: 1 }), { input: [quiet], key: loudKey })
    h.within('gain with a loud key at 100 %, tone 20 dB under the threshold', gain(quiet, keyed.output[0]), 0, 0.5, 'dB')
    // A gate that has heard nothing stays open, so the key under it is quiet and not silent.
    const faint = await h.render(spec({ mix: 1 }), { input: [quiet], key: [sine(frames, f, h.rate, dbToLinear(-80))] })
    h.atMost('gain with a -80 dBFS key at 100 %', gain(quiet, faint.output[0]), -55, 'dB')

    const keyTone = [sine(frames, f, h.rate, dbToLinear(-50))]
    const unity = await h.render(spec({ gainDb: 0 }), { input: [quiet], key: keyTone })
    const boosted = await h.render(spec({ gainDb: 24 }), { input: [quiet], key: keyTone })
    h.atMost('gain with a -50 dBFS key, key gain 0 dB (10 dB under the threshold)', gain(quiet, unity.output[0]), -55, 'dB')
    h.within('gain with a -50 dBFS key, key gain +24 dB', gain(quiet, boosted.output[0]), 0, 0.5, 'dB')
  },
}

/**
 * Mean gain in dB over the samples of `input` that are not near a zero crossing. A low tone's RMS level ripples at twice its
 * frequency and takes the gain with it; that ripple, multiplied into the tone, leaks into the fundamental and biases a gain read
 * through the fundamental (by -0.3 dB for 60 Hz), while the mean of the dB values is not biased by it.
 */
const meanGainDb = (input: Float32Array, output: Float32Array, from: number, to: number, amplitude: number) => {
  let sum = 0
  let count = 0

  for (let n = from; n < to; n += 1) {
    if (Math.abs(input[n]) < 0.05 * amplitude) continue
    sum += linearToDb(output[n] / input[n])
    count += 1
  }

  return sum / count
}

const gateKeyFilter: Scenario = {
  effect: 'gate',
  name: 'g4-sidechain-filter-response',
  run: async (h) => {
    // An expander that never opens drops the gain by the detector level's distance under the threshold, so differences in
    // output gain read as detector gain.
    const gainDb = async (frequency: number, q: number) => {
      const f = coherentFrequency(frequency, h.rate, h.rate)
      const spec = fx.gate({ thresholdDb: -10, ratio: 2, mode: 'expander', detector: 'rms', attackMs: 5, releaseMs: 5, holdMs: 0, hysteresisDb: 0, rangeDb: -80, sidechain: { enabled: true, filterType: 'highpass', frequencyHz: 120, q, gainDb: 0, mix: 1 } })
      const input = sine(4 * h.rate, f, h.rate, 0.1)
      const { output } = await h.render(spec, { input: [input] }, { parity: false })

      return meanGainDb(input, output[0], 3 * h.rate, 4 * h.rate, 0.1)
    }

    const detector = async (frequency: number, q: number) => await gainDb(frequency, q) - await gainDb(1000, q)
    h.within('detector gain at 60 Hz, high-pass 120 Hz Q 0.707, vs 1 kHz', await detector(60, 0.707), -12, 0.5, 'dB')
    h.within('detector gain at 120 Hz, high-pass 120 Hz Q 0.707, vs 1 kHz', await detector(120, 0.707), -3, 0.3, 'dB')
    h.atLeast('detector gain at the corner, Q 4 minus Q 0.707', await detector(120, 4) - await detector(120, 0.707), 6, 'dB')
  },
}

const gateParityKey: Scenario = {
  effect: 'gate',
  name: 'parity-external-key',
  run: async (h) => {
    const spec = fx.gate({ thresholdDb: -30, mode: 'expander', detector: 'rms', lookaheadMs: 1, flip: true, sidechain: { enabled: true, filterType: 'bandpass', frequencyHz: 800, q: 2, gainDb: 6, mix: 0.5 } })
    await h.render(spec, { input: [noise(2 * h.rate, 0.5, 31)], key: [noise(2 * h.rate, 0.25, 32)] })
  },
}

const gateLatency: Scenario = {
  effect: 'gate',
  name: 'g5-lookahead-latency',
  run: async (h) => {
    for (const lookaheadMs of [0, 1, 10] as const) {
      h.within(`impulse delay, lookahead ${lookaheadMs} ms`, await h.latencyFrames(fx.gate({ lookaheadMs })), msFrames(lookaheadMs, h.rate), 1, 'frames')
    }
  },
}

const gateCpu: Scenario = {
  effect: 'gate',
  name: 'cpu',
  run: async (h) => {
    h.info('CPU, peak detector, threshold -20', await h.cpuNsPerFrame(fx.gate({ thresholdDb: -20 })), 'ns/frame')
    h.info('CPU, RMS detector with the sidechain filter, threshold -20', await h.cpuNsPerFrame(fx.gate({ thresholdDb: -20, detector: 'rms', sidechain: { enabled: true, filterType: 'highpass', frequencyHz: 80, q: 0.707, gainDb: 0, mix: 1 } })), 'ns/frame')
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
    limiterClick, limiterThd, limiterTruePeak, limiterLowRate, limiterBypassToggle, meterSelfCheck, limiterAuto, limiterGain, limiterLatency, limiterCpu,
    compressorThd('c1-thd-peak', 'peak', 10, 120, -55),
    compressorThd('c1-thd-rms', 'rms', 10, 120, -55),
    compressorThd('c1-thd-rms-fast', 'rms', 1, 50, -45),
    compressorPeakSteady, compressorRmsConstant, compressorKeyFilter, compressorGuards, compressorAutoRelease, compressorCpu, compressorAutoMakeup, compressorExpand,
    makeupStep, compressorLatency, gateChatter, gateTiming, gateGuards, gateFlip, gateKey, gateKeyFilter, gateParityKey, gateLatency, gateCpu,
    ...familyOf('limiter', limiterSpec, (rate) => msFrames(3, rate)),
    ...familyOf('compressor', compressorSpec, () => 0),
    { ...parityScenario('compressor', fx.compressor({ thresholdDb: -30, ratio: 3, kneeDb: 6, dynamicsMode: 'expand', autoMakeup: true, makeupDb: 2, envelopeCurve: 'linear', sidechain: { enabled: true, filterType: 'bandpass', frequencyHz: 800, q: 2 } })), name: 'parity-expand' },
    { ...parityScenario('compressor', fx.compressor({ thresholdDb: -30, ratio: 4, lookaheadMs: 10, detectorMode: 'peak', envelopeCurve: 'linear', autoMakeup: true, sidechain: { enabled: true, filterType: 'bandpass', frequencyHz: 800, q: 2 } })), name: 'parity-fixtures-peak-linear-lookahead' },
    ...familyOf('gate', gateSpec, () => 0),
  ],
  notEncoded: [
    'L2: the limiter\'s own detector reading on EBU 3341 cases 15 to 23 is internal; the harness instead validates its own true-peak meter against those cases and limits the signals above 0 dBTP.',
    'L6 (Mode) and L8 (routing) are not part of this phase.',
    'C2 10-minute silence CPU: covered by the shared denormal CPU ratio on 4 s renders.',
  ],
}
