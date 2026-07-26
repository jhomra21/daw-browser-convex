import { describe, expect, test } from 'bun:test'
import { createDefaultGateParams, createDefaultUtilityParams } from '@daw-browser/shared'
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