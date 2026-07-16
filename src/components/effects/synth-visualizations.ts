import type { SynthEnvelopeParams, SynthFilterMode, SynthWave } from '@daw-browser/shared'

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const pathFromPoints = (points: readonly [number, number][]) => (
  points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
)

export function createSynthWavePath(wave: SynthWave, width: number, height: number): string {
  const padding = 4
  const steps = 64
  const middle = height / 2
  const amplitude = (height - padding * 2) / 2
  const points: Array<[number, number]> = []
  for (let index = 0; index <= steps; index += 1) {
    const phase = index / steps
    const value = wave === 'sine'
      ? Math.sin(phase * Math.PI * 2)
      : wave === 'square'
        ? (phase < 0.5 ? 1 : -1)
        : wave === 'sawtooth'
          ? phase * 2 - 1
          : 1 - 4 * Math.abs(phase - 0.5)
    points.push([
      padding + phase * (width - padding * 2),
      middle - value * amplitude,
    ])
  }
  return pathFromPoints(points)
}

export function createSynthEnvelopePath(
  envelope: SynthEnvelopeParams,
  width: number,
  height: number,
): string {
  const padding = 6
  const holdSec = 0.5
  const total = Math.max(0.001, envelope.attackSec + envelope.decaySec + holdSec + envelope.releaseSec)
  const x = (time: number) => padding + time / total * (width - padding * 2)
  const y = (level: number) => padding + (1 - clamp(level, 0, 1)) * (height - padding * 2)
  return pathFromPoints([
    [x(0), y(0)],
    [x(envelope.attackSec), y(1)],
    [x(envelope.attackSec + envelope.decaySec), y(envelope.sustain)],
    [x(envelope.attackSec + envelope.decaySec + holdSec), y(envelope.sustain)],
    [x(total), y(0)],
  ])
}

function filterMagnitude(
  mode: SynthFilterMode,
  frequencyHz: number,
  q: number,
  sampleFrequencyHz: number,
): number {
  const omega = 2 * Math.PI * sampleFrequencyHz / 48_000
  const filterOmega = 2 * Math.PI * frequencyHz / 48_000
  const sine = Math.sin(filterOmega)
  const cosine = Math.cos(filterOmega)
  const alpha = sine / (2 * Math.max(0.0001, q))
  const a0 = 1 + alpha
  const a1 = -2 * cosine
  const a2 = 1 - alpha
  const coefficients = mode === 'lowpass'
    ? [(1 - cosine) / 2, 1 - cosine, (1 - cosine) / 2]
    : mode === 'highpass'
      ? [(1 + cosine) / 2, -(1 + cosine), (1 + cosine) / 2]
      : mode === 'bandpass'
        ? [sine / 2, 0, -sine / 2]
        : [1, -2 * cosine, 1]
  const numerator = coefficients[0] ** 2
    + coefficients[1] ** 2
    + coefficients[2] ** 2
    + 2 * (coefficients[0] * coefficients[1] + coefficients[1] * coefficients[2]) * Math.cos(omega)
    + 2 * coefficients[0] * coefficients[2] * Math.cos(2 * omega)
  const denominator = a0 ** 2
    + a1 ** 2
    + a2 ** 2
    + 2 * (a0 * a1 + a1 * a2) * Math.cos(omega)
    + 2 * a0 * a2 * Math.cos(2 * omega)
  return Math.sqrt(Math.max(0, numerator) / Math.max(1e-12, denominator))
}

export function createSynthFilterResponsePath(
  mode: SynthFilterMode,
  frequencyHz: number,
  q: number,
  width: number,
  height: number,
): string {
  // This is a static RBJ-style response approximation, so opening the editor
  // never allocates or starts an audio context solely for visualization.
  const padding = 6
  const steps = 48
  const logMin = Math.log(20)
  const logMax = Math.log(20_000)
  const points: Array<[number, number]> = []
  for (let index = 0; index <= steps; index += 1) {
    const fraction = index / steps
    const sampleFrequencyHz = Math.exp(logMin + (logMax - logMin) * fraction)
    const magnitudeDb = 20 * Math.log10(filterMagnitude(mode, frequencyHz, q, sampleFrequencyHz))
    const x = padding + fraction * (width - padding * 2)
    const y = padding + (clamp(magnitudeDb, -48, 18) - 18) / -66 * (height - padding * 2)
    points.push([x, y])
  }
  return pathFromPoints(points)
}
