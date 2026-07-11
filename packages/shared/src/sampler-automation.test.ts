import { describe, expect, test } from 'bun:test'
import {
  instrumentAutomationKey,
  parseInstrumentAutomationKey,
  SAMPLER_AUTOMATION_DESCRIPTORS,
  SAMPLER_AUTOMATION_PARAMETER_IDS,
} from './sampler-automation'

describe('sampler automation contracts', () => {
  test('parses only supported sampler parameter keys and preserves instance identity', () => {
    const key = instrumentAutomationKey('track-1', 'instrument:sampler:one', 'filter.frequency')
    expect(parseInstrumentAutomationKey(key)).toEqual({
      kind: 'instrument',
      trackId: 'track-1',
      instanceId: 'instrument:sampler:one',
      parameterId: 'filter.frequency',
    })
    expect(parseInstrumentAutomationKey('instrument:track-1:instrument:sampler:one:filter.unknown')).toBeUndefined()
    expect(parseInstrumentAutomationKey('track:track-1:volume')).toBeUndefined()
  })

  test('defines complete finite descriptor bounds and defaults', () => {
    expect(SAMPLER_AUTOMATION_PARAMETER_IDS).toHaveLength(14)
    for (const id of SAMPLER_AUTOMATION_PARAMETER_IDS) {
      const descriptor = SAMPLER_AUTOMATION_DESCRIPTORS[id]
      expect(Number.isFinite(descriptor.defaultValue)).toBe(true)
      expect(descriptor.min).toBeLessThanOrEqual(descriptor.defaultValue)
      expect(descriptor.defaultValue).toBeLessThanOrEqual(descriptor.max)
    }
  })
})
