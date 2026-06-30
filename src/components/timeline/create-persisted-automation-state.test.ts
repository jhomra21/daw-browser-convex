import { describe, expect, test } from 'bun:test'
import { createRoot } from 'solid-js'
import type { AutomationEnvelope } from '@daw-browser/shared'
import { createPersistedAutomationState } from './create-persisted-automation-state'

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

describe('createPersistedAutomationState', () => {
  test('previews and commits an envelope through the provided adapter', async () => {
    await createRoot(async (dispose) => {
      const applied: AutomationEnvelope[][] = []
      const persisted: AutomationEnvelope[] = []
      const state = createPersistedAutomationState({
        targetKey: () => envelope.targetKey,
        envelopes: () => [],
        applyToEngine: (envelopes) => applied.push(envelopes),
        persistEnvelope: (next) => {
          persisted.push(next)
        },
        deleteEnvelope: () => {},
      })

      state.previewEnvelope(envelope)
      await state.commitEnvelope(envelope)

      expect(applied.at(-1)).toEqual([envelope])
      expect(persisted).toEqual([envelope])
      dispose()
    })
  })
})
