import { describe, expect, test } from 'bun:test'
import { createRoot, createSignal } from 'solid-js'

import type { LocalMixPatch } from '~/lib/timeline-storage'
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
