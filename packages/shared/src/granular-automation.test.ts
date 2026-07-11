import { describe, expect, test } from 'bun:test'
import {
  GRANULAR_AUTOMATION_DESCRIPTORS,
  GRANULAR_AUTOMATION_PARAMETER_IDS,
  granularAutomationKey,
  parseGranularAutomationKey,
} from './granular-automation'

describe('granular automation', () => {
  test('uses strict track and instrument instance identity keys', () => {
    const key = granularAutomationKey('track-1', 'instrument:instance:1', 'grainSize')
    expect(parseGranularAutomationKey(key)).toEqual({
      kind: 'instrument',
      trackId: 'track-1',
      instanceId: 'instrument:instance:1',
      parameterId: 'grainSize',
    })
    expect(parseGranularAutomationKey('instrument:track-1:instrument:instance:2:unknown')).toBeUndefined()
  })

  test('publishes descriptors for every continuous granular parameter', () => {
    expect(Object.keys(GRANULAR_AUTOMATION_DESCRIPTORS)).toEqual([...GRANULAR_AUTOMATION_PARAMETER_IDS])
    expect(GRANULAR_AUTOMATION_DESCRIPTORS.position).toMatchObject({ min: 0, max: 1 })
    expect(GRANULAR_AUTOMATION_DESCRIPTORS.pitch).toMatchObject({ min: -48, max: 48 })
  })
})
