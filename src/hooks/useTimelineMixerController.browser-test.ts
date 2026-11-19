import { describe, expect, test } from 'bun:test'
import 'fake-indexeddb/auto'
import { createRoot, createSignal } from 'solid-js'

import { getProjectDbName } from '~/lib/local-project-db'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { installHermeticWindow } from '~/lib/test/hermetic-browser-environment'
import type { LocalMixPatch } from '~/lib/timeline-storage'
import type { HistoryEntry } from '~/lib/undo/types'
import type { Track } from '@daw-browser/timeline-core/types'
import { useTimelineMixerController } from './useTimelineMixerController'

const originalTrackId = 'track:original'
const autoCreatedTrackId = 'track:auto-created'

const track = (id: string): Track => ({
  id,
  name: id,
  volume: 0.8,
  clips: [],
})

describe('useTimelineMixerController browser reactivity', () => {
  // Exercise both dropped-field directions, explicit false, and writes on either
  // side of the debounce before checking durable state and history together.
  for (const muteFirst of [true, false]) {
    for (const initial of [false, true]) {
      for (const separated of [false, true]) {
        test(`${muteFirst ? 'mute then solo' : 'solo then mute'} to ${!initial}, ${separated ? 'after' : 'within'} debounce`, async () => {
          const projectId = `project:mixer-toggle-${muteFirst}-${initial}-${separated}`
          const repository = createLocalTimelineRepository(projectId)
          await repository.createTrack({ id: originalTrackId, index: 0 })
          await repository.updateTrack({ trackId: originalTrackId, muted: initial, soloed: initial })
          const restoreWindow = installHermeticWindow({ clearTimeout, setTimeout })
          let dispose: () => void = () => undefined
          const history: HistoryEntry[] = []
          const failures: string[] = []
          const [serverTrackState, setServerTrackState] = createSignal({
            serverVolumes: new Map([[originalTrackId, 0.8]]),
            serverMuted: new Map([[originalTrackId, initial]]),
            serverSoloed: new Map([[originalTrackId, initial]]),
            serverRouting: new Map(),
          })
          try {
            const controller = createRoot((cleanup) => {
              dispose = cleanup
              return useTimelineMixerController({
                projectId: () => projectId,
                userId: () => '',
                syncMix: () => false,
                tracks: () => [{ ...track(originalTrackId), muted: initial, soloed: initial }],
                localMix: {
                  byTrackId: () => ({}),
                  apply: () => undefined,
                  persist: () => undefined,
                },
                optimisticTrackIds: () => new Set(),
                canWriteTrack: () => true,
                pushHistory: (entry) => { history.push(entry) },
                onLocalSaveFailed: (_failedProjectId, message) => { failures.push(message) },
                serverTrackState,
              })
            })
            // Let the initial project-scope effect and its flush settle.
            await Bun.sleep(0)
            const first = muteFirst ? controller.handleToggleTrackMute : controller.handleToggleTrackSolo
            const second = muteFirst ? controller.handleToggleTrackSolo : controller.handleToggleTrackMute
            first(originalTrackId)
            expect(controller.pendingSharedTrackMix().get(originalTrackId)).toEqual(
              muteFirst ? { muted: !initial } : { soloed: !initial },
            )
            if (separated) {
              // Bounded wait for the production 150 ms debounce; no polling.
              await Bun.sleep(200)
              expect(history).toHaveLength(1)
              const firstSaved = (await repository.loadSnapshot()).tracks[0]
              expect(firstSaved?.muted).toBe(muteFirst ? !initial : initial)
              expect(firstSaved?.soloed).toBe(muteFirst ? initial : !initial)
            }
            second(originalTrackId)
            expect(controller.pendingSharedTrackMix().get(originalTrackId)).toEqual({
              muted: !initial,
              soloed: !initial,
            })
            if (!separated) {
              // loadSnapshot flushes pending writes, so do not read it here.
              expect(history).toHaveLength(0)
            }
            await Bun.sleep(200)
            expect(history).toHaveLength(2)
            const saved = (await repository.loadSnapshot()).tracks[0]
            expect(saved?.muted).toBe(!initial)
            expect(saved?.soloed).toBe(!initial)
            expect(failures).toEqual([])
            expect(new Set(history.map((entry) => entry.type))).toEqual(new Set(['track-mute', 'track-solo']))
            for (const entry of history) {
              if (entry.type !== 'track-mute' && entry.type !== 'track-solo') throw new Error('Unexpected history entry')
              expect(entry.data).toMatchObject({ scope: 'shared', from: initial, to: !initial })
            }

            // Acknowledging only one field must not clear the other overlay.
            setServerTrackState((current) => ({
              ...current,
              serverMuted: new Map([[originalTrackId, !initial]]),
            }))
            expect(controller.pendingSharedTrackMix().get(originalTrackId)).toEqual({ soloed: !initial })
            setServerTrackState((current) => ({
              ...current,
              serverSoloed: new Map([[originalTrackId, !initial]]),
            }))
            expect(controller.pendingSharedTrackMix().has(originalTrackId)).toBe(false)
          } finally {
            dispose()
            restoreWindow()
          }
        })
      }
    }
  }

  for (const write of ['volume', 'mute', 'routing'] as const) {
    test(`attributes a failed ${write} write to its issuing project after a project switch`, async () => {
      const projectA = `project:mixer-failure-a-${write}`
      const projectB = `project:mixer-failure-b-${write}`
      const returnTrackId = 'track:return'
      const failingDbName = getProjectDbName(projectA)
      const open = indexedDB.open
      indexedDB.open = (...args: Parameters<IDBFactory['open']>) => {
        if (args[0] === failingDbName) throw new Error('Local mix write failed.')
        return open.apply(indexedDB, args)
      }
      const restoreWindow = installHermeticWindow({ clearTimeout, setTimeout })
      let dispose: () => void = () => undefined
      const history: HistoryEntry[] = []
      const failures: Array<{ projectId: string; message: string }> = []
      const [projectId, setProjectId] = createSignal(projectA)
      try {
        const controller = createRoot((cleanup) => {
          dispose = cleanup
          return useTimelineMixerController({
            projectId,
            userId: () => '',
            syncMix: () => false,
            tracks: () => [track(originalTrackId), { ...track(returnTrackId), channelRole: 'return' }],
            localMix: {
              byTrackId: () => ({}),
              apply: () => undefined,
              persist: () => undefined,
            },
            optimisticTrackIds: () => new Set(),
            canWriteTrack: () => true,
            pushHistory: (entry) => { history.push(entry) },
            onLocalSaveFailed: (failedProjectId, message) => { failures.push({ projectId: failedProjectId, message }) },
            serverTrackState: () => null,
          })
        })
        await Bun.sleep(0)
        if (write === 'volume') controller.setTrackVolume(originalTrackId, 0.4)
        if (write === 'mute') controller.handleToggleTrackMute(originalTrackId)
        if (write === 'routing') controller.updateTrackSends(originalTrackId, [{ targetId: returnTrackId, amount: 0.5 }])
        // Switching flushes the debounced project-A write; its failure settles after B is current.
        setProjectId(projectB)
        // Bounded wait for the flushed write to reject; no polling.
        await Bun.sleep(50)
        expect(failures).toEqual([{ projectId: projectA, message: 'Local mix write failed.' }])
        expect(history).toEqual([])
      } finally {
        dispose()
        restoreWindow()
        indexedDB.open = open
      }
    })
  }

  test('retains pending volumes through track insertion and prunes only after every track source removes them', async () => {
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [tracks, setTracks] = createSignal<Track[]>([track(originalTrackId)])
      const [optimisticTrackIds, setOptimisticTrackIds] = createSignal<Set<Track['id']>>(new Set([originalTrackId]))
      const [serverTrackState, setServerTrackState] = createSignal({
        serverVolumes: new Map<Track['id'], number>([[originalTrackId, 0.8]]),
        serverMuted: new Map<Track['id'], boolean>(),
        serverSoloed: new Map<Track['id'], boolean>(),
        serverRouting: new Map(),
      })
      const localMix = {
        byTrackId: () => ({}),
        apply: (_trackId: Track['id'], _patch: LocalMixPatch) => undefined,
        persist: (_trackId: Track['id'], _patch: LocalMixPatch) => undefined,
      }
      const controller = useTimelineMixerController({
        projectId: () => 'project:local-mixer-retention',
        userId: () => 'user:local',
        syncMix: () => false,
        tracks,
        localMix,
        optimisticTrackIds,
        canWriteTrack: () => true,
        pushHistory: () => undefined,
        serverTrackState,
      })

      void (async () => {
        await new Promise((settle) => setTimeout(settle, 0))
        controller.applyTrackVolume(originalTrackId, 0.35)
        setTracks([track(originalTrackId), track(autoCreatedTrackId)])
        expect(controller.pendingSharedTrackVolumes()).toEqual(new Map([[originalTrackId, 0.35]]))

        setOptimisticTrackIds(new Set<Track['id']>())
        setServerTrackState({
          serverVolumes: new Map(),
          serverMuted: new Map(),
          serverSoloed: new Map(),
          serverRouting: new Map(),
        })
        await new Promise((settle) => setTimeout(settle, 0))
        expect(controller.pendingSharedTrackVolumes()).toEqual(new Map([[originalTrackId, 0.35]]))

        setTracks([track(autoCreatedTrackId)])
        await new Promise((settle) => setTimeout(settle, 0))
        expect(controller.pendingSharedTrackVolumes()).toEqual(new Map())
        dispose()
        resolve()
      })().catch((error) => {
        dispose()
        reject(error)
      })
    }))
  })
})
