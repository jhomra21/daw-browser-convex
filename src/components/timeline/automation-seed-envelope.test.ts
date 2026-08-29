import { describe, expect, test } from 'bun:test'
import { createAutomationSeedEnvelope } from './automation-seed-envelope'

describe('automation seed envelope', () => {
  test('uses the current value before the descriptor default', () => {
    const current = createAutomationSeedEnvelope({
      projectId: 'project:local',
      target: { kind: 'track', trackId: 'track-1' },
      parameterId: 'volume',
      initialValue: 0.42,
    })
    const fallback = createAutomationSeedEnvelope({
      projectId: 'project:local',
      target: { kind: 'track', trackId: 'track-1' },
      parameterId: 'volume',
    })

    expect(current?.points).toHaveLength(1)
    expect(current?.points[0]).toMatchObject({ timeSec: 0, value: 0.42 })
    expect(fallback?.points[0]).toMatchObject({ timeSec: 0, value: 1 })
  })

  test('rejects unknown parameters', () => {
    expect(createAutomationSeedEnvelope({
      projectId: 'project:local',
      target: { kind: 'track', trackId: 'track-1' },
      parameterId: 'unknown',
      initialValue: 0.5,
    })).toBeUndefined()
  })
})
