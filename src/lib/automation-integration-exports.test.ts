import { describe, expect, test } from 'bun:test'
import type { AutomationEnvelope } from '@daw-browser/shared'
import { buildAutomationEnvelopeHistoryEntry } from '~/lib/undo/builders'

const envelope: AutomationEnvelope = {
  id: 'automation-1',
  projectId: 'project-1',
  target: { kind: 'master' },
  targetKey: 'master:volume',
  parameterId: 'volume',
  enabled: true,
  points: [],
  updatedAt: 1,
}

describe('automation integration exports', () => {
  test('builds automation history entries', () => {
    expect(buildAutomationEnvelopeHistoryEntry({
      projectId: envelope.projectId,
      before: null,
      after: envelope,
    })).toEqual({
      type: 'automation-envelope-change',
      projectId: envelope.projectId,
      data: {
        before: null,
        after: envelope,
      },
    })
  })

})
