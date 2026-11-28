import { describe, expect, test } from 'bun:test'
import {
  createDefaultDelayParams,
  createDefaultGateParams,
  createDefaultReverbParams,
  createDefaultUtilityParams,
} from '@daw-browser/shared'
import { getEffectChainTimingWithExternal, getEffectTiming } from './timing'

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
  ).tail).toEqual({ kind: 'finite', frames: 106_561 })
})