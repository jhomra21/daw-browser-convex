// Version 1 filtered inside the loop with a one-pole low pass at the High Cut and a one-pole "high pass" at the Low Cut. The high
// pass is not unity in its passband (it loses 20 log10((1 + a) / 2a) dB per trip at Nyquist, a = exp(-2 pi cut / rate)), and the
// low pass was always on (20 kHz when open), so a cut changed the whole decay curve and not one edge of it. The Diffusion Network
// shelves of version 2 move the decay at the band edges, so the cuts migrate to the pair of shelves whose T60 curve is nearest the
// old one over 80 Hz to 16 kHz, with the line lengths of both networks and the kernel's own shelf design (reverb_kernel.h design()).

const SAMPLE_RATE = 48000
const OLD_LINES = [1447, 1583, 1789, 1951, 2203, 2399, 2663, 3011]
const SPARSE_LINES = [503, 773, 1069, 1373, 1693, 2039, 2393, 2777]
const SHELF_DB_MIN = -24

// The renders read the new shelves' decay shorter than the curve they were fitted to, most where the old network's unequal
// per-trip losses left its slowest lines ringing (a High Cut of 4 kHz at 8 kHz, a Low Cut of 1 kHz at 125 Hz). Aiming this much
// above the old curve centres the band decays between the two (the old harness measurements, 8 cut settings).
const TARGET_BIAS = 1.12

type Shelf = { hz: number; db: number }

export type ReverbCutShelves = { low: Shelf; high: Shelf }

const logSteps = (from: number, to: number, count: number) => Array.from({ length: count }, (_, index) => from * (to / from) ** (index / (count - 1)))

const CURVE_OMEGAS = logSteps(80, 16000, 32).map((hz) => 2 * Math.PI * hz / SAMPLE_RATE)
const LOW_HZ = logSteps(20, 1200, 24)
const HIGH_HZ = logSteps(1200, 20000, 24)
const DB_STEPS = Array.from({ length: 25 }, (_, index) => SHELF_DB_MIN + index)

const magnitudeSquared = (b0: number, b1: number, a1: number, omega: number) =>
  ((b0 + b1 * Math.cos(omega)) ** 2 + (b1 * Math.sin(omega)) ** 2) / ((1 + a1 * Math.cos(omega)) ** 2 + (a1 * Math.sin(omega)) ** 2)

const oldCutLossDb = (omega: number, lowCutHz: number, highCutHz: number) => {
  const alpha = 1 - Math.exp(-2 * Math.PI * Math.min(highCutHz, SAMPLE_RATE * 0.49) / SAMPLE_RATE)
  const pole = Math.exp(-2 * Math.PI * lowCutHz / SAMPLE_RATE)

  return -10 * Math.log10(magnitudeSquared(alpha, 0, alpha - 1, omega) * magnitudeSquared(pole, -pole, -pole, omega))
}

// The kernel's first-order shelf for a line that loses lossDb per trip, in dB at omega.
const shelfGainDb = (high: boolean, shelf: Shelf, lossDb: number, omega: number) => {
  const tangent = Math.tan(Math.PI * shelf.hz / SAMPLE_RATE)
  const q = 10 ** (lossDb * (1 - 10 ** (-shelf.db / 20)) / 40)

  if (high) {
    const den = 1 + tangent * q

    return 10 * Math.log10(magnitudeSquared(q * q * (1 + tangent / q) / den, q * q * (tangent / q - 1) / den, (tangent * q - 1) / den, omega))
  }

  const den = 1 + tangent / q

  return 10 * Math.log10(magnitudeSquared((1 + tangent * q) / den, (tangent * q - 1) / den, (tangent / q - 1) / den, omega))
}

// Mean T60 of a network whose lines decay at the given rates in dB per second.
const t60 = (rates: readonly number[]) => 60 / (rates.reduce((sum, rate) => sum + rate, 0) / rates.length)

export const fitReverbCutShelves = (decaySec: number, size: number, lowCutHz: number, highCutHz: number): ReverbCutShelves => {
  const scale = 0.7 + 0.5 * size
  const base = 60 / decaySec

  const target = CURVE_OMEGAS.map((omega) =>
    Math.log(TARGET_BIAS * t60(OLD_LINES.map((frames) => base + oldCutLossDb(omega, lowCutHz, highCutHz) * SAMPLE_RATE / (frames * scale)))))

  const cost = (low: Shelf, high: Shelf) => CURVE_OMEGAS.reduce((sum, omega, index) => {
    const fitted = t60(SPARSE_LINES.map((lines) => {
      const frames = lines * scale
      const lossDb = base * frames / SAMPLE_RATE

      return base - (shelfGainDb(false, low, lossDb, omega) + shelfGainDb(true, high, lossDb, omega)) * SAMPLE_RATE / frames
    }))

    return sum + (Math.log(fitted) - target[index]) ** 2
  }, 0)

  const grid = (hzs: readonly number[]) => hzs.flatMap((hz) => DB_STEPS.map((db) => ({ hz, db })))
  let low: Shelf = { hz: 200, db: 0 }
  let high: Shelf = { hz: 5000, db: 0 }
  let best = cost(low, high)

  // Coordinate descent: each shelf is the best of its grid with the other held, a few rounds settle the pair. An open Low Cut
  // (its 20 Hz pole costs the lows almost nothing) leaves the low shelf out.
  for (let round = 0; round < 3; round += 1) {
    for (const candidate of lowCutHz > 20 ? grid(LOW_HZ) : []) {
      const value = cost(candidate, high)

      if (value < best) [best, low] = [value, candidate]
    }

    for (const candidate of grid(HIGH_HZ)) {
      const value = cost(low, candidate)

      if (value < best) [best, high] = [value, candidate]
    }
  }

  return { low, high }
}
