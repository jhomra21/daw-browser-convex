import { describe, expect, test } from 'bun:test'
import { automationTargetKey } from './automation'
import { getAutomationParameterDescriptor, normalizeAutomationPoints, valueAtAutomationTime } from './automation-parameters'

describe('automation helpers', () => {
  test('builds stable target keys', () => {
    expect(automationTargetKey({ kind: 'master' }, 'volume')).toBe('master:volume')
    expect(automationTargetKey({ kind: 'track', trackId: 'track-1' }, 'volume')).toBe('track:track-1:volume')
  })

  test('normalizes point ordering, duplicate times, and values', () => {
    const descriptor = getAutomationParameterDescriptor('volume')
    expect(descriptor).toBeDefined()
    if (!descriptor) return

    expect(normalizeAutomationPoints([
      { id: 'late', timeSec: 2, value: 2, interpolation: 'linear' },
      { id: 'early', timeSec: -1, value: -1, interpolation: 'linear' },
      { id: 'replace', timeSec: 2, value: 0.5, interpolation: 'hold' },
    ], descriptor)).toEqual([
      { id: 'early', timeSec: 0, value: 0, interpolation: 'linear' },
      { id: 'replace', timeSec: 2, value: 0.5, interpolation: 'hold' },
    ])
  })

  test('interpolates linear and hold values', () => {
    expect(valueAtAutomationTime([
      { id: 'a', timeSec: 0, value: 0, interpolation: 'linear' },
      { id: 'b', timeSec: 10, value: 10, interpolation: 'hold' },
      { id: 'c', timeSec: 20, value: 20, interpolation: 'linear' },
    ], 5, 1)).toBe(5)
    expect(valueAtAutomationTime([
      { id: 'a', timeSec: 0, value: 0, interpolation: 'hold' },
      { id: 'b', timeSec: 10, value: 10, interpolation: 'linear' },
    ], 5, 1)).toBe(0)
  })
})
