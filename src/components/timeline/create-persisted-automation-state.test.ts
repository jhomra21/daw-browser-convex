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

const trackEnvelope: AutomationEnvelope = {
  id: 'automation-2',
  projectId: 'project-1',
  target: { kind: 'track', trackId: 'track-1' },
  targetKey: 'track:track-1:volume',
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

  test('cancels a draft preview back to persisted envelopes', async () => {
    await createRoot(async (dispose) => {
      const applied: AutomationEnvelope[][] = []
      const state = createPersistedAutomationState({
        targetKey: () => envelope.targetKey,
        envelopes: () => [],
        applyToEngine: (envelopes) => applied.push(envelopes),
        persistEnvelope: () => {},
        deleteEnvelope: () => {},
      })

      state.previewEnvelope(envelope)
      state.cancelPreview(envelope.targetKey)

      expect(applied).toEqual([[envelope], []])
      expect(state.envelopes()).toEqual([])
      dispose()
    })
  })

  test('passes previous envelopes and changed target keys when deleting a draft', async () => {
    await createRoot(async (dispose) => {
      const applied: Array<{
        next: AutomationEnvelope[]
        previous: AutomationEnvelope[]
        changed: string[]
      }> = []
      const state = createPersistedAutomationState({
        targetKey: () => envelope.targetKey,
        envelopes: () => [envelope],
        applyToEngine: (next, previous, changed) => {
          applied.push({ next, previous, changed: [...changed] })
        },
        persistEnvelope: () => {},
        deleteEnvelope: () => {},
      })

      await state.commitEnvelope(undefined, envelope.targetKey)

      expect(applied).toEqual([{
        next: [],
        previous: [envelope],
        changed: [envelope.targetKey],
      }])
      dispose()
    })
  })

  test('uses last applied envelopes when persistence mutates source state before deletion applies', async () => {
    await createRoot(async (dispose) => {
      let persisted: AutomationEnvelope[] = [envelope]
      const applied: Array<{
        next: AutomationEnvelope[]
        previous: AutomationEnvelope[]
        changed: string[]
      }> = []
      const state = createPersistedAutomationState({
        targetKey: () => envelope.targetKey,
        envelopes: () => persisted,
        applyToEngine: (next, previous, changed) => {
          applied.push({ next, previous, changed: [...changed] })
        },
        persistEnvelope: () => {},
        deleteEnvelope: () => {
          persisted = []
        },
      })

      await state.commitEnvelope(undefined, envelope.targetKey)

      expect(applied).toEqual([{
        next: [],
        previous: [envelope],
        changed: [envelope.targetKey],
      }])
      dispose()
    })
  })

  test('uses last applied envelopes when remote sync deletes an envelope', async () => {
    await createRoot(async (dispose) => {
      let persisted: AutomationEnvelope[] = []
      const applied: Array<{
        next: AutomationEnvelope[]
        previous: AutomationEnvelope[]
        changed: string[]
      }> = []
      const state = createPersistedAutomationState({
        targetKey: () => envelope.targetKey,
        envelopes: () => persisted,
        applyToEngine: (next, previous, changed) => {
          applied.push({ next, previous, changed: [...changed] })
        },
        persistEnvelope: () => {},
        deleteEnvelope: () => {},
      })

      persisted = [envelope]
      state.syncRemote()
      persisted = []
      state.syncRemote()

      expect(applied).toEqual([
        { next: [envelope], previous: [], changed: [envelope.targetKey] },
        { next: [], previous: [envelope], changed: [envelope.targetKey] },
      ])
      dispose()
    })
  })

  test('skips remote sync when applied envelopes are unchanged', async () => {
    await createRoot(async (dispose) => {
      let persisted: AutomationEnvelope[] = []
      const applied: AutomationEnvelope[][] = []
      const state = createPersistedAutomationState({
        targetKey: () => envelope.targetKey,
        envelopes: () => persisted,
        applyToEngine: (next) => {
          applied.push(next)
        },
        persistEnvelope: () => {},
        deleteEnvelope: () => {},
      })

      state.syncRemote()
      persisted = [envelope]
      state.syncRemote()
      state.syncRemote()

      expect(applied).toEqual([[envelope]])
      dispose()
    })
  })

  test('applies dirty drafts and remotely changed non-dirty envelopes during sync', async () => {
    await createRoot(async (dispose) => {
      const draftEnvelope = { ...envelope, updatedAt: 2 }
      const remoteTrackEnvelope = { ...trackEnvelope, updatedAt: 2 }
      let persisted: AutomationEnvelope[] = [envelope, trackEnvelope]
      const applied: Array<{
        next: AutomationEnvelope[]
        previous: AutomationEnvelope[]
        changed: string[]
      }> = []
      const state = createPersistedAutomationState({
        targetKey: () => envelope.targetKey,
        envelopes: () => persisted,
        applyToEngine: (next, previous, changed) => {
          applied.push({ next, previous, changed: [...changed] })
        },
        persistEnvelope: () => {},
        deleteEnvelope: () => {},
      })

      state.syncRemote()
      state.previewEnvelope(draftEnvelope)
      persisted = [envelope, remoteTrackEnvelope]
      state.syncRemote()

      expect(applied.at(-1)).toEqual({
        next: [draftEnvelope, remoteTrackEnvelope],
        previous: [draftEnvelope, trackEnvelope],
        changed: [envelope.targetKey, trackEnvelope.targetKey],
      })
      dispose()
    })
  })
})
