import { describe, expect, test } from 'bun:test'
import {
  createSpectralTransformState,
  createSqrtHannWindow,
  fftInPlace,
  processStft,
  transformSpectrum,
} from './spectral-core'

const spectrum = (size: number, bin: number, magnitude = 1) => {
  const real = new Float64Array(size)
  const imaginary = new Float64Array(size)
  real[bin] = magnitude
  real[size - bin] = magnitude
  return { real, imaginary }
}

const baseParams = {
  mode: 'freeze' as const,
  freeze: 0,
  gateThresholdDb: -20,
  gateAttackMs: 1,
  gateReleaseMs: 1,
  morph: 0,
  binShift: 0,
  blur: 0,
  harmonicPercussiveBalance: 0,
  noiseReduction: 0,
  profileLearn: 0,
}

describe('spectral core', () => {
  test('radix-2 FFT roundtrips', () => {
    const real = Float64Array.from({ length: 1024 }, (_, index) => Math.sin(index * 0.17) + index % 7)
    const original = real.slice()
    const imaginary = new Float64Array(real.length)
    fftInPlace(real, imaginary)
    fftInPlace(real, imaginary, true)
    expect(Math.max(...real.map((value, index) => Math.abs(value - original[index])))).toBeLessThan(1e-10)
  })

  test('sqrt-Hann overlap normalization is constant in the interior', () => {
    const window = createSqrtHannWindow(1024)
    const sums = new Float64Array(1024)
    for (let shift = 0; shift < 4; shift += 1) {
      for (let index = 0; index < 1024; index += 1) sums[index] += window[(index + shift * 256) % 1024] ** 2
    }
    expect(Math.max(...sums) - Math.min(...sums)).toBeLessThan(1e-12)
  })

  test('centered STFT reconstructs and preserves channel isolation', () => {
    const left = Float64Array.from({ length: 8192 }, (_, index) => Math.sin(index * 0.037))
    const right = new Float64Array(left.length)
    const reconstructed = processStft(left, { fftSize: 1024, overlap: 4, centered: true })
    const isolated = processStft(right, { fftSize: 1024, overlap: 4, centered: true })
    expect(Math.max(...reconstructed.map((value, index) => Math.abs(value - left[index])))).toBeLessThan(1e-10)
    expect(Math.max(...isolated)).toBe(0)
  })

  test('freeze captures and holds magnitude and phase', () => {
    const state = createSpectralTransformState(512)
    const first = spectrum(512, 10, 2)
    transformSpectrum(first, undefined, { ...baseParams, mode: 'freeze', freeze: 1 }, state, 48_000, 128)
    const next = spectrum(512, 10, 0.25)
    transformSpectrum(next, undefined, { ...baseParams, mode: 'freeze', freeze: 1 }, state, 48_000, 128)
    expect(next.real[10]).toBeCloseTo(2, 10)
  })

  test('gate attenuates, morph reaches sidechain, and shift interpolates bins', () => {
    const state = createSpectralTransformState(512)
    const gated = spectrum(512, 8, 0.01)
    transformSpectrum(gated, undefined, { ...baseParams, mode: 'gate', gateThresholdDb: -20 }, state, 48_000, 128)
    expect(gated.real[8]).toBeLessThan(0.01)
    const morphed = spectrum(512, 8, 1)
    transformSpectrum(morphed, spectrum(512, 8, 3), { ...baseParams, mode: 'morph', morph: 1 }, state, 48_000, 128)
    expect(morphed.real[8]).toBeCloseTo(3, 10)
    const shifted = spectrum(512, 8, 1)
    transformSpectrum(shifted, undefined, { ...baseParams, mode: 'shift-blur', binShift: 1.5 }, state, 48_000, 128)
    expect(shifted.real[9]).toBeCloseTo(0.5, 10)
    expect(shifted.real[10]).toBeCloseTo(0.5, 10)
  })

  test('HPSS and noise reduction remain finite with bounded state arrays', () => {
    const state = createSpectralTransformState(4096)
    const hpss = spectrum(4096, 20, 1)
    transformSpectrum(hpss, undefined, { ...baseParams, mode: 'hpss' }, state, 48_000, 1024)
    const reduced = spectrum(4096, 20, 1)
    transformSpectrum(reduced, undefined, { ...baseParams, mode: 'noise-reduce', profileLearn: 1, noiseReduction: 1 }, state, 48_000, 1024)
    expect(Number.isFinite(hpss.real[20])).toBe(true)
    expect(reduced.real[20]).toBeCloseTo(0, 10)
    expect(state.hpssHistory).toHaveLength(31)
    expect(state.hpssHistory[0]).toHaveLength(2049)
  })
})
