// EBU Tech 3341 (2023) true-peak test signals, cases 15 to 23 (section 2.6, "minimum requirements" table).
import { kaiserSinc } from './dsp'
import { taper } from './signals'

export type EbuCase = { id: number; description: string; expectedDbtp: number; signal: Float32Array }

const tone = (frames: number, rate: number, divisor: number, amplitude: number, phaseDegrees: number) =>
  taper(Float32Array.from({ length: frames }, (_, n) => amplitude * Math.sin(2 * Math.PI * (rate / divisor) * n / rate + phaseDegrees * Math.PI / 180)), Math.round(0.01 * rate))

/** fs/6 at 0.5 with a single phase-continuous period of fs/4 at 1.0, built at 4 fs, low-passed and decimated with an offset. */
const embeddedPeriod = (rate: number, offset: number) => {
  const oversampled = 4 * rate
  const frames = Math.round(0.2 * rate)
  const burstStart = Math.round(frames / 2) * 4
  const burstLength = Math.round(oversampled / (rate / 4))
  let phase = 0

  const raw = Float64Array.from({ length: frames * 4 }, (_, m) => {
    const inBurst = m >= burstStart && m < burstStart + burstLength
    const frequency = inBurst ? rate / 4 : rate / 6
    phase += 2 * Math.PI * frequency / oversampled

    return (inBurst ? 1 : 0.5) * Math.sin(phase)
  })

  const filter = kaiserSinc(255, 0.5 / 4, 9)
  const half = (filter.length - 1) / 2

  const filtered = Float64Array.from({ length: frames }, (_, n) => {
    const center = n * 4 + offset
    let sum = 0

    for (let k = -half; k <= half; k += 1) {
      const index = center + k

      if (index >= 0 && index < raw.length) sum += raw[index] * filter[half + k]
    }

    return sum
  })

  return taper(Float32Array.from(filtered), Math.round(0.01 * rate))
}

export const ebuTruePeakCases = (rate: number): EbuCase[] => {
  const frames = Math.round(0.5 * rate)

  return [
    { id: 15, description: 'fs/4, 0.50, 0 deg', expectedDbtp: -6, signal: tone(frames, rate, 4, 0.5, 0) },
    { id: 16, description: 'fs/4, 0.50, 45 deg', expectedDbtp: -6, signal: tone(frames, rate, 4, 0.5, 45) },
    { id: 17, description: 'fs/6, 0.50, 60 deg', expectedDbtp: -6, signal: tone(frames, rate, 6, 0.5, 60) },
    { id: 18, description: 'fs/8, 0.50, 67.5 deg', expectedDbtp: -6, signal: tone(frames, rate, 8, 0.5, 67.5) },
    { id: 19, description: 'fs/4, 1.41, 45 deg', expectedDbtp: 3, signal: tone(frames, rate, 4, 1.41, 45) },
    ...[0, 1, 2, 3].map((offset) => ({
      id: 20 + offset, description: `fs/6 with one fs/4 period, offset ${offset}`, expectedDbtp: 0, signal: embeddedPeriod(rate, offset),
    })),
  ]
}
