import { describe, expect, test } from 'bun:test'
import {
  SPECTRAL_RESOURCE_BOUNDS,
  createDefaultSpectralParams,
  getSpectralLatencyFrames,
  normalizeSpectralParamsEnvelope,
} from './spectral-params'

describe('spectral params', () => {
  test('normalizes legacy state into the version 1 envelope and clamps bounds', () => {
    const normalized = normalizeSpectralParamsEnvelope({
      fftSize: 4096,
      overlap: 2,
      mode: 'noise-reduce',
      gateThresholdDb: -200,
      blur: 2,
    })
    expect(normalized.version).toBe(1)
    expect(normalized.state).toEqual({
      ...createDefaultSpectralParams(),
      fftSize: 4096,
      overlap: 2,
      mode: 'noise-reduce',
      gateThresholdDb: -120,
      blur: 1,
    })
  })

  test('defines bounded resources and exact centered/non-centered latency', () => {
    expect(SPECTRAL_RESOURCE_BOUNDS.maxSpectrumBins).toBe(2049)
    expect(getSpectralLatencyFrames(2048, 4, true)).toBe(1024)
    expect(getSpectralLatencyFrames(2048, 4, false)).toBe(2048)
    expect(getSpectralLatencyFrames(2048, 2, false)).toBe(2048)
  })
})
