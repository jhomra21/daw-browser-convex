import { describe, expect, test } from 'bun:test'
import { createDefaultGateParams, createDefaultUtilityParams } from '@daw-browser/shared'
import { getEffectTiming } from './timing'

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