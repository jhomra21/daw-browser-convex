import { describe, expect, test } from 'bun:test'
import { automationEnvelopeValueRange, automationTargetKey, type AutomationEnvelope } from './automation'
import { createEqBandParameterId, getAutomationParameterDescriptor, getAutomationParameterOptions, normalizeAutomationPoints, valueAtAutomationTime } from './automation-parameters'

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

  test('lists EQ automation options with real default band ids', () => {
    const options = getAutomationParameterOptions()
    expect(options.some((option) => option.id === createEqBandParameterId('b1', 'frequencyHz'))).toBe(true)
    expect(options.some((option) => option.id === createEqBandParameterId('low', 'frequencyHz'))).toBe(false)
  })

  test('computes envelope value ranges with optional bounds', () => {
    const envelope: AutomationEnvelope = {
      id: 'automation-1',
      projectId: 'project-1',
      target: { kind: 'master' },
      targetKey: 'master:volume',
      parameterId: 'volume',
      enabled: true,
      points: [
        { id: 'a', timeSec: 0, value: -1, interpolation: 'linear' },
        { id: 'b', timeSec: 1, value: 2, interpolation: 'linear' },
      ],
      updatedAt: 1,
    }
    expect(automationEnvelopeValueRange(envelope, { min: 0, max: 1 })).toEqual({ min: 0, max: 1 })
  })
})
