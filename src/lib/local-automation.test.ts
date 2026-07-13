import { describe, expect, test } from 'bun:test'
import { automationTargetKey, type AutomationEnvelope, type AutomationTarget } from '@daw-browser/shared'
import { normalizeLocalAutomationEnvelopes } from './local-automation'

const envelope = (input: Partial<AutomationEnvelope> & Pick<AutomationEnvelope, 'id' | 'target' | 'targetKey' | 'parameterId' | 'updatedAt'>): AutomationEnvelope => ({
  projectId: 'project-1',
  enabled: true,
  points: [],
  ...input,
})

describe('normalizeLocalAutomationEnvelopes', () => {
  test('deduplicates structured logical identities by updatedAt then stable id', () => {
    const target: AutomationTarget = { kind: 'track', trackId: 'track:one', effectInstanceId: 'delay:one' }
    const targetKey = automationTargetKey(target, 'delay.feedback')
    const rows = normalizeLocalAutomationEnvelopes([
      envelope({ id: 'z', target, targetKey, parameterId: 'delay.feedback', updatedAt: 2 }),
      envelope({ id: 'b', target, targetKey, parameterId: 'delay.feedback', updatedAt: 3 }),
      envelope({ id: 'a', target, targetKey, parameterId: 'delay.feedback', updatedAt: 3 }),
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('a')
  })

  test('normalizes mixer rows to the canonical target key', () => {
    const target: AutomationTarget = { kind: 'track', trackId: 'track:one' }
    const rows = normalizeLocalAutomationEnvelopes([
      envelope({ id: 'old', target, targetKey: 'opaque:a', parameterId: 'volume', updatedAt: 1 }),
      envelope({ id: 'new', target, targetKey: 'opaque:b', parameterId: 'volume', updatedAt: 2 }),
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('new')
    expect(rows[0]?.targetKey).toBe(automationTargetKey(target, 'volume'))
  })

  test('drops malformed and unsupported effect rows', () => {
    const rows = normalizeLocalAutomationEnvelopes([
      { schemaVersion: 3, targetKey: 'future:key', payload: { untouched: true } },
      envelope({
        id: 'known',
        target: { kind: 'master' },
        targetKey: 'legacy:master:volume',
        parameterId: 'volume',
        updatedAt: 1,
      }),
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.targetKey).toBe(automationTargetKey({ kind: 'master' }, 'volume'))
  })
})
