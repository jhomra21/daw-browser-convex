import { describe, expect, test } from 'bun:test'
import {
  createDefaultDelayParams,
  createDefaultCompressorParams,
  createDefaultGateParams,
  createDefaultLimiterParams,
  createDefaultReverbParams,
  createDefaultUtilityParams,
} from '@daw-browser/shared'
import {
  gateCompressorLatencyFrames,
  getEffectChainTimingWithExternal,
  getEffectTiming,
  limiterLatencyFrames,
  type EffectTimingInput,
} from './timing'

describe('utility and gate timing', () => {
  test('keeps utility at zero latency and gate at the latency its lookahead chooses', () => {
    expect(getEffectTiming(
      { id: 'utility-1', kind: 'utility', params: { version: 1, state: createDefaultUtilityParams() } },
      48_000,
    ).latencyFrames).toBe(0)

    const gateLatency = (lookaheadMs: 0 | 1 | 10, enabled = true) => getEffectTiming(
      { id: 'gate-1', kind: 'gate', params: { version: 1, state: { ...createDefaultGateParams(), enabled, lookaheadMs } } },
      44_100,
    ).latencyFrames

    expect(gateLatency(0)).toBe(0)
    expect(gateLatency(1)).toBe(45)
    expect(gateLatency(10)).toBe(441)
    expect(gateLatency(10, false)).toBe(441)
  })
})

// The native core refuses a Gate, Compressor or Limiter whose declared latency differs from its kernel's.
describe('lookahead latency matches the native kernels', () => {
  test('declares the lookahead of each device at the kernel rate', () => {
    const declared = (input: EffectTimingInput, rate: number) => getEffectTiming(input, rate).latencyFrames

    expect(declared({ id: 'limiter-1', kind: 'limiter', params: { version: 1, state: { ...createDefaultLimiterParams(), lookaheadMs: 1.5 } } }, 48_000)).toBe(72)
    expect(declared({ kind: 'compressor', params: { ...createDefaultCompressorParams(), lookaheadMs: 10 } }, 48_000)).toBe(480)
    expect(declared({ id: 'gate-1', kind: 'gate', params: { version: 1, state: { ...createDefaultGateParams(), lookaheadMs: 10 } } }, 48_000)).toBe(480)
  })

  test('keeps the Limiter delay between the kernel minimum and its capacity', () => {
    expect(limiterLatencyFrames(1.5, 8_000)).toBe(14)
    expect(limiterLatencyFrames(0, 48_000)).toBe(14)
    expect(limiterLatencyFrames(1_000, 48_000)).toBe(2_000)
  })

  test('caps the Gate and Compressor delay one frame under the kernel capacity', () => {
    expect(gateCompressorLatencyFrames(1_000, 48_000)).toBe(2_047)
  })

  test('rounds a float32 lookahead like the kernel does', () => {
    // 0.1f is 0.10000000149, so at 48 kHz the kernel needs 4.8000000715 frames and rounds up to 5.
    expect(gateCompressorLatencyFrames(0.1, 48_000)).toBe(5)
    expect(gateCompressorLatencyFrames(-1, 48_000)).toBe(0)
  })
})

test('includes external reported latency in PDC timing without widening built-in runtime unions', () => {
  expect(getEffectChainTimingWithExternal([], [{
    latencyFrames: 256,
    tailFrames: 512,
  }], 48_000)).toEqual({
    latencyFrames: 256,
    tail: { kind: 'finite', frames: 512 },
  })
})

test('bounds sync-resolved Delay timing and removes disabled or dry-only tails', () => {
  const params = createDefaultDelayParams()
  expect(getEffectTiming(
    { kind: 'delay', params: { ...params, mode: 'sync', syncDivision: '1/1', feedback: 0 } },
    48_000,
    20,
  ).tail).toEqual({ kind: 'finite', frames: 144_000 })
  expect(getEffectTiming(
    { kind: 'delay', params: { ...params, dryWet: 0 } },
    48_000,
  ).tail).toEqual({ kind: 'finite', frames: 0 })
  expect(getEffectTiming(
    { kind: 'delay', params: { ...params, enabled: false } },
    48_000,
  ).tail).toEqual({ kind: 'finite', frames: 0 })
})

test('removes disabled or dry-only Reverb tails while retaining wet decay timing', () => {
  const params = createDefaultReverbParams()
  expect(getEffectTiming(
    { kind: 'reverb', params: { ...params, wet: 0 } },
    48_000,
  ).tail).toEqual({ kind: 'finite', frames: 0 })
  expect(getEffectTiming(
    { kind: 'reverb', params },
    48_000,
  ).tail).toEqual({ kind: 'finite', frames: Math.ceil((0.02 + 0.15 + 2.2) * 48_000) })
  expect(getEffectTiming(
    { kind: 'reverb', params: { ...params, freeze: true } },
    48_000,
  ).tail).toEqual({ kind: 'unbounded' })
})
