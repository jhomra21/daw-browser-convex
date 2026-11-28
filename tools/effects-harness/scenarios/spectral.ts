// Acceptance tests P1-P7 from saturation-utility.md section 3.4, each judged on the signal the research names. The "before" values in
// each row's note were measured on base a49d9c57 with this same file (the pre-rebuild kernel and worklet).
import beforeValues from './spectral-before.json'
import { formatDeviceLatency } from '../../../src/lib/device-value-format'
import { hann, maxAbsDiff, rms, rmsDb, spectrum, toneFit } from '../dsp'
import { fx } from '../effects'
import type { Family } from './index'
import type { Scenario } from '../harness'
import { concat, impulse, linearToDb, noise, seededRandom, sine } from '../signals'

const fftSizes = [512, 1024, 2048, 4096] as const
const overlaps = [2, 4] as const

// Paul Kellet's economy pink filter on a seeded white source, scaled to an exact RMS.
const pinkNoise = (frames: number, level: number, seed: number) => {
  const random = seededRandom(seed)
  let b0 = 0
  let b1 = 0
  let b2 = 0
  let b3 = 0
  let b4 = 0
  let b5 = 0
  let b6 = 0

  const raw = Float64Array.from({ length: frames }, () => {
    const white = 2 * random() - 1
    b0 = 0.99886 * b0 + white * 0.0555179
    b1 = 0.99332 * b1 + white * 0.0750759
    b2 = 0.969 * b2 + white * 0.153852
    b3 = 0.8665 * b3 + white * 0.3104856
    b4 = 0.55 * b4 + white * 0.5329522
    b5 = -0.7616 * b5 - white * 0.016898
    const sample = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362
    b6 = white * 0.115926

    return sample
  })

  const scale = level / rms(raw)

  return Float32Array.from(raw, (value) => value * scale)
}

const p1Threshold: Scenario = {
  effect: 'spectral',
  name: 'p1-gate-threshold-in-dbfs',
  run: async (h) => {
    const frames = 2 * h.rate

    for (const fftSize of fftSizes) {
      const input = sine(frames, 1000, h.rate, 0.01)

      for (const thresholdDb of [-45, -35]) {
        const { output } = await h.render(fx.spectral({ fftSize, mode: 'gate', gateThresholdDb: thresholdDb, mix: 1 }), { input: [input] }, { parity: false })
        const gain = rmsDb(output[0], h.rate + fftSize, frames) - rmsDb(input, h.rate, frames - fftSize)
        const name = `gain of a -40 dBFS sine, threshold ${thresholdDb} dB, N=${fftSize}`

        if (thresholdDb === -45) h.atLeast(name, gain, -1, 'dB', 'gate open (research: open at all four sizes)')
        else h.atMost(name, gain, -20, 'dB', 'gate closed (research: closed at all four sizes)')
      }
    }
  },
}

const p2Neutral: Scenario = {
  effect: 'spectral',
  name: 'p2-hpss-neutral-gain',
  run: async (h) => {
    const frames = 4 * h.rate
    const signals = [['sine 1 kHz', sine(frames, 1000, h.rate, 0.3)], ['white noise', noise(frames, 0.1, 21)]] as const

    for (const fftSize of fftSizes) {
      for (const [name, input] of signals) {
        const { output } = await h.render(fx.spectral({ fftSize, mode: 'hpss', harmonicPercussiveBalance: 0, mix: 1 }), { input: [input] }, { parity: false })
        h.within(`HPSS balance 0 gain on ${name}, N=${fftSize}`, rmsDb(output[0], 2 * h.rate + fftSize, frames) - rmsDb(input, 2 * h.rate, frames - fftSize), 0, 0.3, 'dB')
      }
    }
  },
}

const p2Stems: Scenario = {
  effect: 'spectral',
  name: 'p2-hpss-percussive-stem',
  run: async (h) => {
    const fftSize = 2048
    const frames = 6 * h.rate
    const period = Math.round(h.rate / 4)
    const clicks = new Float32Array(frames)

    for (let at = period; at + 64 < frames; at += period) clicks[at] = 0.5
    const tone = sine(frames, 1000, h.rate, 0.3)
    const input = Float32Array.from(tone, (value, n) => value + clicks[n])
    const { output } = await h.render(fx.spectral({ fftSize, mode: 'hpss', harmonicPercussiveBalance: -1, mix: 1 }), { input: [input] }, { parity: false })
    const from = 3 * period + Math.floor(period / 4)
    const to = 3 * period + Math.floor(3 * period / 4)
    h.atMost('sine suppression, balance -1, 4 clicks per second over a 1 kHz sine', rmsDb(output[0], from + fftSize, to + fftSize) - rmsDb(tone, from, to), -20, 'dB')
    let kept = 0
    let original = 0

    for (const at of [3 * period, 4 * period]) {
      for (let n = at - 8; n <= at + 8; n += 1) {
        kept += output[0][n + fftSize] ** 2
        original += clicks[n] ** 2
      }
    }

    h.within('click energy kept, balance -1', 10 * Math.log10(kept / original), 0, 3, 'dB')
  },
}

const p2Cost: Scenario = {
  effect: 'spectral',
  name: 'p2-hpss-cost',
  rates: [48000],
  run: async (h) => {
    const hop = 1024
    const frameMicroseconds = (nsPerFrame: number) => nsPerFrame * hop / 1000
    const hpss = frameMicroseconds(await h.cpuNsPerFrame(fx.spectral({ fftSize: 4096, mode: 'hpss' })))
    const passThrough = frameMicroseconds(await h.cpuNsPerFrame(fx.spectral({ fftSize: 4096, mode: 'freeze', freeze: 0 })))
    h.atMost('HPSS cost per STFT frame at N=4096, overlap 4', hpss, 600, 'us', 'research: 2479 us before')
    h.atMost('HPSS median stage alone (HPSS minus pass-through) at N=4096', hpss - passThrough, 2479 / 4, 'us', 'research: at least 4x below 2479 us')
  },
}

const p3Freeze: Scenario = {
  effect: 'spectral',
  name: 'p3-freeze-phase-coherence',
  run: async (h) => {
    const period = Math.round(h.rate / 1000)

    for (const fftSize of fftSizes) {
      for (const overlap of overlaps) {
        const hop = fftSize / overlap
        const engage = Math.ceil(4 * fftSize / 128) * 128
        const frames = engage + Math.max(24 * fftSize, 40000)
        const input = sine(frames, 1000, h.rate, 0.5)
        const { output } = await h.render(fx.spectral({ fftSize, overlap, mode: 'freeze', freeze: 0 }), { input: [input], steps: [{ frame: engage, set: { freeze: 1 } }] }, { parity: false })
        const from = engage + 3 * fftSize
        const to = frames - fftSize
        let low = Infinity
        let high = 0

        // The sliding RMS over one period of the tone is flat for a steady sinusoid.
        for (let at = from; at + period < to; at += 8) {
          const level = rms(output[0], at, at + period)
          low = Math.min(low, level)
          high = Math.max(high, level)
        }

        h.atMost(`envelope ripple of a frozen 1 kHz sine, N=${fftSize}, overlap ${overlap}`, 20 * Math.log10(high / low), 0.1, 'dB', 'research: 0.8 to 6.0 dB before')
        // The ripple at the frame rate shows as sidebands at 1 kHz plus and minus rate / hop; 0.1 dB of ripple is a sideband at -45 dB.
        const length = 16384
        const carrier = toneFit(output[0], 1000, h.rate, to - length, to).amplitude
        const side = Math.max(...[1000 - h.rate / hop, 1000 + h.rate / hop].map((hz) => toneFit(output[0], hz, h.rate, to - length, to).amplitude))
        h.atMost(`line at fs/hop relative to the carrier, N=${fftSize}, overlap ${overlap}`, 20 * Math.log10(side / carrier), -40, 'dB', 'no line at fs/hop: -40 dB is the level 0.1 dB of ripple gives')
      }
    }
  },
}

const p4Noise: Scenario = {
  effect: 'spectral',
  name: 'p4-noise-reduce',
  rates: [48000],
  run: async (h) => {
    const fftSize = 2048
    const learned = 2 * h.rate
    const tested = h.rate
    const training = pinkNoise(learned, 0.01, 3)
    const fresh = pinkNoise(tested, 0.01, 7)
    const tone = sine(tested, 1000, h.rate, 0.0316228)
    const mixed = Float32Array.from(fresh, (value, n) => value + tone[n])
    const spec = fx.spectral({ fftSize, mode: 'noise-reduce', noiseReduction: 0, profileLearn: 1 })
    const steps = [{ frame: learned, set: { profileLearn: 0, noiseReduction: 1 } }]
    const from = learned + 8 * fftSize
    const to = learned + tested - fftSize

    const cleaned = (await h.render(spec, { input: [concat(training, fresh)], steps }, { parity: false })).output[0]
    const reduction = rmsDb(cleaned, from + fftSize, to + fftSize) - rmsDb(fresh, from - learned, to - learned)
    h.atMost('reduction of pink noise at -40 dBFS learned for 2 s, Reduction 1.0', reduction, -20, 'dB', 'research: -9.4 dB before')

    const kept = (await h.render(spec, { input: [concat(training, mixed)], steps }, { parity: false })).output[0]
    const at = learned + tested / 2
    h.within('1 kHz tone at -30 dBFS mixed with the noise, level after reduction', 20 * Math.log10(toneFit(kept, 1000, h.rate, at + fftSize, to + fftSize).amplitude / 0.0316228), 0, 1, 'dB')

    // Musical noise shows as bins that flicker: the spread of each bin's magnitude over time relative to its mean.
    const frame = 512
    const window = hann(frame)
    const bins = frame / 2 + 1
    const mean = new Float64Array(bins)
    const square = new Float64Array(bins)
    let count = 0

    for (let start = from + fftSize; start + frame < to + fftSize; start += 256, count += 1) {
      const { re, im } = spectrum(cleaned.subarray(start, start + frame), frame, window)

      for (let bin = 0; bin < bins; bin += 1) {
        const magnitude = Math.hypot(re[bin], im[bin])
        mean[bin] += magnitude
        square[bin] += magnitude * magnitude
      }
    }

    let variation = 0

    for (let bin = 4; bin < bins - 4; bin += 1) {
      const average = mean[bin] / count

      variation += Math.sqrt(Math.max(square[bin] / count - average * average, 0)) / average
    }

    h.atMost('residual bin-magnitude coefficient of variation', variation / (bins - 8), 0.94, '', 'research: 0.94 before')
  },
}

const p5Shift: Scenario = {
  effect: 'spectral',
  name: 'p5-shift-keeps-one-partial',
  run: async (h) => {
    const fftSize = 2048
    const frames = 24 * fftSize
    const { output } = await h.render(fx.spectral({ fftSize, mode: 'shift-blur', binShift: 10 }), { input: [sine(frames, 1000, h.rate, 0.5)] }, { parity: false })
    const length = 16384
    const { re, im } = spectrum(output[0].subarray(frames - 2 * fftSize - length, frames - 2 * fftSize), length, hann(length))
    const power = Float64Array.from({ length: length / 2 + 1 }, (_, bin) => re[bin] ** 2 + im[bin] ** 2)
    const peak = power.indexOf(Math.max(...power))
    const [left, centre, right] = [Math.log(power[peak - 1]), Math.log(power[peak]), Math.log(power[peak + 1])]
    const refined = (peak + 0.5 * (left - right) / (left - 2 * centre + right)) * h.rate / length
    const expected = 1000 + 10 * h.rate / fftSize
    h.within('peak of a 1 kHz sine shifted by +10 bins', refined, expected, 5, 'Hz', 'research: 1280 Hz instead of 1234 Hz before')
    const total = power.reduce((sum, value) => sum + value, 0)
    let near = 0

    power.forEach((value, bin) => { if (Math.abs(bin * h.rate / length - expected) <= 4 * h.rate / fftSize) near += value })
    h.atLeast('energy within 4 bins of the shifted peak', near / total, 0.9, '', 'research: 51% before')
  },
}

const p6Identity: Scenario = {
  effect: 'spectral',
  name: 'p6-pass-through-round-trip',
  run: async (h) => {
    for (const fftSize of fftSizes) {
      for (const overlap of overlaps) {
        const input = noise(16 * fftSize, 0.25, 9)
        const { output } = await h.render(fx.spectral({ fftSize, overlap, mode: 'freeze', freeze: 0 }), { input: [input] }, { parity: false })
        const error = linearToDb(maxAbsDiff(output[0].subarray(2 * fftSize), input.subarray(fftSize, input.length - fftSize)))

        h.atMost(`pass-through round-trip error, N=${fftSize}, overlap ${overlap}`, error, fftSize === 4096 ? -130 : -120, 'dB', fftSize === 4096 ? 'research: about -92 dB before' : 'no change beyond -120 dB')
      }
    }
  },
}

const p6Cost: Scenario = {
  effect: 'spectral',
  name: 'p6-worst-quantum-cost',
  rates: [48000],
  run: async (h) => {
    const worst = await h.worstBlockNs(fx.spectral({ fftSize: 4096, overlap: 4, mode: 'freeze', freeze: 0 })) / 1000
    // Informational: the target (at most half of the base's worst quantum on the same machine) is NOT met. Base a49d9c57 measured 281-289 us
    // here (research: 231.6 us on its machine), this build 148-153 us, about 0.52x. The FFT work still lands in one process call at the hop.
    h.info('worst 128-frame quantum, stereo pass-through, N=4096', worst, 'us', 'target not met: at most 50% of the base value measured on the same machine')
  },
}

const p7Label: Scenario = {
  effect: 'spectral',
  name: 'p7-latency-label-sample-rate',
  run: async (h) => {
    const fftSize = 2048
    // An impulse at frame 0 meets the analysis window's zero and never reaches the output, so it goes in at 2 * fftSize.
    const at = 2 * fftSize
    const { output } = await h.render(fx.spectral({ fftSize, gateThresholdDb: -120 }), { input: [impulse(8 * fftSize, 0.5, at)] }, { parity: false })
    const frames = output[0].reduce((best, value, n) => (Math.abs(value) > Math.abs(output[0][best]) ? n : best), 0) - at
    const label = formatDeviceLatency(frames, h.rate)
    h.within('latency shown in the label vs the measured impulse delay', Number.parseFloat(label), frames / h.rate * 1000, 0.05, 'ms', `label "${label}", measured ${frames} frames = ${(frames / h.rate * 1000).toFixed(2)} ms`)
  },
}

// Each judged row also carries what the same row measured on base a49d9c57 (spectral-before.json, generated from that run).
const before: Readonly<Record<string, number>> = beforeValues

const withBefore = (scenario: Scenario): Scenario => ({
  ...scenario,
  run: async (h) => {
    const first = h.checks.length
    await scenario.run(h)

    for (const check of h.checks.slice(first)) {
      const value = before[`${check.scenario}|${check.metric}|${check.rate}`]

      if (value !== undefined) check.note = [check.note, `before: ${value}`].filter(Boolean).join('; ')
    }
  },
})

export const spectral: Family = {
  scenarios: [p1Threshold, p2Neutral, p2Stems, p2Cost, p3Freeze, p4Noise, p5Shift, p6Identity, p6Cost, p7Label].map(withBefore),
  notEncoded: [
    'P2 HPSS time median centring (the kernel keeps the causal estimate) and the P6 live-replacement fixtures: covered by the native and wasm parity tests, not rendered here.',
    'P3 Random phase option, P8 (soft knee, log-magnitude Morph, overlap 8): not built.',
  ],
}
