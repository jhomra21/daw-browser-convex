import { describe, expect, test } from 'bun:test'
import { createDefaultDelayParams, createDefaultGateParams, createDefaultUtilityParams } from '@daw-browser/shared'
import { getEffectChainTimingWithExternal, getEffectTiming } from './timing'

describe('utility and gate timing', () => {
  test('keeps utility at zero latency and gate at fixed two millisecond latency', () => {
    expect(getEffectTiming(
      { id: 'utility-1', kind: 'utility', params: { version: 1, state: createDefaultUtilityParams() } },
      48_000,
    ).latencyFrames).toBe(0)
    expect(getEffectTiming(
      { id: 'gate-1', kind: 'gate', params: { version: 1, state: { ...createDefaultGateParams(), enabled: false } } },
      44_100,
    ).latencyFrames).toBe(89)
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