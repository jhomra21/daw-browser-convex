import { describe, expect, test } from 'bun:test'
import type { AutomationEnvelope } from '@daw-browser/shared'
import { scheduleAutomationEnvelope } from './automation'

const envelope = (interpolation: 'hold' | 'linear'): AutomationEnvelope => ({
  id: 'automation-1',
  projectId: 'project-1',
  target: { kind: 'master' },
  targetKey: 'master:volume',
  parameterId: 'volume',
  enabled: true,
  points: [
    { id: 'point-1', timeSec: 0, value: 0, interpolation },
    { id: 'point-2', timeSec: 100, value: 1, interpolation: 'linear' },
  ],
  updatedAt: 1,
})

const createParam = () => {
  const calls: Array<{ kind: 'cancel' | 'ramp' | 'set'; value?: number; time: number }> = []
  return {
    calls,
    param: {
      cancelScheduledValues: (time: number) => {
        calls.push({ kind: 'cancel', time })
        return undefined
      },
      linearRampToValueAtTime: (value: number, time: number) => {
        calls.push({ kind: 'ramp', value, time })
        return undefined
      },
      setValueAtTime: (value: number, time: number) => {
        calls.push({ kind: 'set', value, time })
        return undefined
      },
    },
  }
}

describe('scheduleAutomationEnvelope', () => {
  test('ramps to interpolated window end value for linear segments extending beyond the window', () => {
    const { calls, param } = createParam()

    scheduleAutomationEnvelope(
      [{ param, valueToAudioValue: (value) => value }],
      envelope('linear'),
      { playheadSec: 0, startLimitSec: 0, endLimitSec: 30 },
      (timeSec) => timeSec,
      0,
    )

    expect(calls).toEqual([
      { kind: 'cancel', time: 0 },
      { kind: 'set', value: 0, time: 0 },
      { kind: 'ramp', value: 0.3, time: 30 },
    ])
  })

  test('does not ramp to the window end for hold segments extending beyond the window', () => {
    const { calls, param } = createParam()

    scheduleAutomationEnvelope(
      [{ param, valueToAudioValue: (value) => value }],
      envelope('hold'),
      { playheadSec: 0, startLimitSec: 0, endLimitSec: 30 },
      (timeSec) => timeSec,
      0,
    )

    expect(calls).toEqual([
      { kind: 'cancel', time: 0 },
      { kind: 'set', value: 0, time: 0 },
    ])
  })
})
