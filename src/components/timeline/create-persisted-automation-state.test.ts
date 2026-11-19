import 'fake-indexeddb/auto'
import { describe, expect, onTestFinished, test } from 'bun:test'
import { createRoot, createSignal } from 'solid-js'
import { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { automationTargetKey, type AutomationEnvelope } from '@daw-browser/shared'
import { useTimelineAutomationController } from '~/hooks/useTimelineAutomationController'
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
      expect(state.snapshotPatches()).toEqual([{ targetKey: envelope.targetKey, envelope }])
      await state.commitEnvelope(envelope)

      expect(applied.at(-1)).toEqual([envelope])
      expect(persisted).toEqual([envelope])
      expect(state.snapshotPatches()).toEqual([])
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

  test('exports an explicit deletion patch without treating an empty projection as authoritative', async () => {
    await createRoot(async (dispose) => {
      const state = createPersistedAutomationState({
        targetKey: () => envelope.targetKey,
        envelopes: () => [envelope],
        applyToEngine: () => {},
        persistEnvelope: () => {},
        deleteEnvelope: () => {},
      })

      expect(state.snapshotPatches()).toEqual([])
      state.previewEnvelope(undefined)
      expect(state.snapshotPatches()).toEqual([{
        targetKey: envelope.targetKey,
        envelope: undefined,
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

  test('persists one empty-lane seed and does not reseed an existing envelope', async () => {
    await createRoot(async (dispose) => {
      let persisted: AutomationEnvelope[] = []
      let writes = 0
      const state = createPersistedAutomationState({
        targetKey: () => trackEnvelope.targetKey,
        envelopes: () => persisted,
        applyToEngine: () => {},
        persistEnvelope: (next) => {
          writes += 1
          persisted = [next]
        },
        deleteEnvelope: () => {},
      })

      await state.commitEnvelope({
        ...trackEnvelope,
        points: [{ id: 'seed', timeSec: 0, value: 0.42, interpolation: 'linear' }],
      })
      expect(writes).toBe(1)
      expect(persisted[0]?.points).toHaveLength(1)
      dispose()
    })
  })

  test('applies remote point changes even when updatedAt is unchanged', async () => {
    await createRoot(async (dispose) => {
      let persisted: AutomationEnvelope[] = [envelope]
      const remotePoint: AutomationEnvelope['points'][number] = {
        id: 'point-1',
        timeSec: 1,
        value: 0.5,
        interpolation: 'linear',
      }
      const remoteEnvelope = {
        ...envelope,
        points: [remotePoint],
      }
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
      persisted = [remoteEnvelope]
      state.syncRemote()

      expect(applied.at(-1)).toEqual({
        next: [remoteEnvelope],
        previous: [envelope],
        changed: [envelope.targetKey],
      })
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

type RemoteEffect = NonNullable<ReturnType<Parameters<typeof useTimelineAutomationController>[0]['remoteEffects']>>[number]

describe('useTimelineAutomationController', () => {
  type Reply = { accepted: true; sequence: number } | { accepted: false; reason: 'bridge-error' }
  // Re-enabling the processor lane A is answered by the test; the track lane B has no processor and needs no reply.
  const mountReEnable = () => {
    const previousLocalStorage = globalThis.localStorage
    Reflect.set(globalThis, 'localStorage', { getItem: () => null, setItem: () => {} })
    onTestFinished(() => Reflect.set(globalThis, 'localStorage', previousLocalStorage))
    const targetA = automationTargetKey({ kind: 'track', trackId: 'track-1', effectInstanceId: 'processor-1' }, 'gain')
    const targetB = automationTargetKey({ kind: 'track', trackId: 'track-2' }, 'volume')
    const replies: Array<(reply: Reply) => void> = []
    const installed: string[][] = []
    const audioEngine = new AudioEngine()
    Reflect.set(audioEngine, 'cancelAutomationSchedules', () => {})
    Reflect.set(audioEngine, 'applyAutomationAtTimelineSec', () => {})
    Reflect.set(audioEngine, 'setAutomationEnvelopes', (envelopes: AutomationEnvelope[]) => {
      installed.push(envelopes.map((installedEnvelope) => installedEnvelope.targetKey))
    })
    const controller = createRoot((dispose) => {
      onTestFinished(dispose)
      return useTimelineAutomationController({
        projectId: () => 'shared-project',
        userId: () => 'user-1',
        tracks: () => [],
        masterVolume: () => 1,
        masterReady: () => false,
        remoteRows: () => [
          { _id: 'a', projectId: 'shared-project', targetKind: 'track', trackId: 'track-1', effectInstanceId: 'processor-1', targetKey: targetA, parameterId: 'gain', enabled: true, points: [{ id: 'a1', timeSec: 0, value: 0.5, interpolation: 'linear' }], updatedAt: 1 },
          { _id: 'b', projectId: 'shared-project', targetKind: 'track', trackId: 'track-2', targetKey: targetB, parameterId: 'volume', enabled: true, points: [{ id: 'b1', timeSec: 0, value: 0.5, interpolation: 'linear' }], updatedAt: 1 },
        ],
        remoteEffects: () => [],
        audioEngine,
        reenableProcessorAutomation: () => new Promise<Reply>((resolve) => { replies.push(resolve) }),
        isPlaying: () => false,
        playheadSec: () => 0,
        selectedTrackId: () => '',
        pushHistory: () => {},
      })
    })
    return { controller, targetA, targetB, replies, installed }
  }

  test('a refused re-enable preserves overrides added while publication is pending', async () => {
    const { controller, targetA, targetB, replies } = mountReEnable()
    controller.overrideTarget(targetA)
    const reenable = controller.reEnable()
    controller.overrideTarget(targetB)
    replies[0]?.({ accepted: false, reason: 'bridge-error' })
    await reenable

    expect(controller.overrideCount()).toBe(2)
  })

  test('an accepted re-enable does not schedule a lane overridden while publication was pending', async () => {
    const { controller, targetA, targetB, replies, installed } = mountReEnable()
    controller.overrideTarget(targetA)
    const reenable = controller.reEnable()
    controller.overrideTarget(targetB)
    replies[0]?.({ accepted: true, sequence: 1 })
    await reenable

    expect(controller.overrideCount()).toBe(1)
    expect(installed.at(-1)).toEqual([targetA])
  })

  test('a refused re-enable restores its own lanes after a later re-enable started', async () => {
    const { controller, targetA, targetB, replies } = mountReEnable()
    controller.overrideTarget(targetA)
    const first = controller.reEnable()
    controller.overrideTarget(targetB)
    const second = controller.reEnable()
    replies[0]?.({ accepted: false, reason: 'bridge-error' })
    await Promise.all([first, second])

    expect(controller.overrideCount()).toBe(1)
  })

  test('a refused re-enable does not restore a lane a later accepted re-enable released', async () => {
    const { controller, targetA, replies } = mountReEnable()
    controller.overrideTarget(targetA)
    const first = controller.reEnable()
    controller.overrideTarget(targetA)
    const second = controller.reEnable()
    replies[1]?.({ accepted: true, sequence: 2 })
    await second
    replies[0]?.({ accepted: false, reason: 'bridge-error' })
    await first

    expect(controller.overrideCount()).toBe(0)
  })

  test('reloading unchanged effect data keeps the lanes workspace', () => {
    const previousLocalStorage = globalThis.localStorage
    Reflect.set(globalThis, 'localStorage', { getItem: () => null, setItem: () => {} })
    onTestFinished(() => Reflect.set(globalThis, 'localStorage', previousLocalStorage))
    const reverb = (instanceId: string): RemoteEffect => (
      { targetType: 'track', trackId: 'track-1', type: 'reverb', instanceId, index: 0, params: {} }
    )
    // Solid runs a root's effects after its body returns, so the hook is read from outside createRoot.
    const { controller, setRemoteEffects } = createRoot((dispose) => {
      onTestFinished(dispose)
      const [remoteEffects, setRemoteEffects] = createSignal([reverb('reverb-1')])
      return {
        setRemoteEffects,
        controller: useTimelineAutomationController({
          projectId: () => 'shared-project', userId: () => 'user-1', tracks: () => [], masterVolume: () => 1, masterReady: () => false,
          remoteRows: () => [], remoteEffects, audioEngine: new AudioEngine(), isPlaying: () => false,
          playheadSec: () => 0, selectedTrackId: () => '', pushHistory: () => {},
        }),
      }
    })
    const lanes = controller.workspace().lanes
    expect(lanes.effectInstancesByOwnerKey['track-1']).toEqual([{ id: 'reverb-1', kind: 'reverb' }])

    setRemoteEffects([reverb('reverb-1')])
    expect(controller.workspace().lanes).toBe(lanes)

    setRemoteEffects([reverb('reverb-2')])
    expect(controller.workspace().lanes.effectInstancesByOwnerKey['track-1']).toEqual([{ id: 'reverb-2', kind: 'reverb' }])
  })
})
