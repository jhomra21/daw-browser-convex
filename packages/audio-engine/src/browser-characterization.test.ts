import { describe, expect, test } from 'bun:test'
import {
  getStaticModuleDeclaredLatencyFrames,
  isStaticModuleCharacterization,
} from './browser-characterization'

describe('browser characterization report schema', () => {
  test('accepts machine-readable static module results', () => {
    expect(isStaticModuleCharacterization({
      kind: 'limiter',
      sampleRate: 48_000,
      channels: 2,
      supported: true,
      declaredLatencyFrames: 240,
      registrationStatus: 'pass',
      renderStatus: 'pass',
      finiteOutput: true,
    })).toBe(true)
  })

  test('requires explicit unsupported status and nullable output evidence', () => {
    expect(isStaticModuleCharacterization({
      kind: 'utility',
      sampleRate: 44_100,
      channels: 1,
      supported: false,
      declaredLatencyFrames: 0,
      registrationStatus: 'unsupported',
      renderStatus: 'unsupported',
      finiteOutput: null,
      message: 'AudioWorklet unavailable.',
    })).toBe(true)
    expect(isStaticModuleCharacterization({
      kind: 'utility',
      sampleRate: 44_100,
      channels: 3,
      supported: false,
      declaredLatencyFrames: 0,
      registrationStatus: 'unsupported',
      renderStatus: 'unsupported',
      finiteOutput: null,
    })).toBe(false)
  })

  test('declares deterministic latency for every static module family', () => {
    expect(getStaticModuleDeclaredLatencyFrames('utility', 48_000)).toBe(0)
    expect(getStaticModuleDeclaredLatencyFrames('autofilter', 48_000)).toBe(6)
    expect(getStaticModuleDeclaredLatencyFrames('gate', 44_100)).toBe(89)
    expect(getStaticModuleDeclaredLatencyFrames('limiter', 96_000)).toBe(480)
    expect(getStaticModuleDeclaredLatencyFrames('lofi', 48_000)).toBe(0)
    expect(getStaticModuleDeclaredLatencyFrames('ensemble', 48_000)).toBe(0)
    expect(getStaticModuleDeclaredLatencyFrames('spectral', 48_000)).toBe(2048)
  })
})
