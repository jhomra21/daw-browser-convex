import { describe, expect, test } from 'bun:test'
import 'fake-indexeddb/auto'
import { createRoot, createSignal, untrack } from 'solid-js'

import { saveLocalProjectState } from '~/lib/local-project-state'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { resolveTimelineTracks } from '~/lib/resolve-timeline-tracks'
import type { LocalMixMap } from '~/lib/timeline-storage'
import type { Track, TrackSend } from '@daw-browser/timeline-core/types'
import { useTimelineLocalMix } from './useTimelineLocalMix'
import { useTimelineMixerController } from './useTimelineMixerController'
import {
  getReturnSendTargets,
  resolveSendTargetId,
} from '~/components/timeline/track-send-targets'

const projectId = 'project:local-send-reload'
const sourceTrackId = 'track:source'
const returnTrackId = 'track:return'
const normalTargetTrackId = 'track:normal-target'

type TimelineTracksClient = Parameters<typeof resolveTimelineTracks>[0]['client']

const emptyClientState = (localMix: LocalMixMap): TimelineTracksClient => ({
  mix: {
    syncMix: false,
    writableTrackIds: new Set([sourceTrackId, returnTrackId]),
    localByTrackId: localMix,
    pendingSharedTrackVolumes: new Map(),
    pendingSharedTrackRouting: new Map(),
    pendingSharedMixByTrackId: new Map(),
  },
  tracks: {
    pendingEntriesById: new Map(),
    removedIds: new Set(),
    pendingLocksById: new Map(),
    historyRefsById: new Map(),
    namesByHistoryRef: new Map(),
  },
  clips: {
    pendingCreatesById: new Map(),
    removedIds: new Set(),
    committedEditsById: new Map(),
    draftEditsById: new Map(),
    previewByTrackId: new Map(),
    historyRefsById: new Map(),
  },
})

describe('local send reload path', () => {
  test('keeps regular tracks out of send options and rejects their routing at the controller boundary', async () => {
    const noReturnProjectId = 'project:local-send-no-return'
    const firstTrackId = 'track:first'
    const secondTrackId = 'track:second'
    const thirdTrackId = 'track:third'
    const tracks: Track[] = [
      { id: firstTrackId, name: 'Track 1', volume: 0.8, clips: [], channelRole: 'track' },
      { id: secondTrackId, name: 'Track 2', volume: 0.8, clips: [], channelRole: 'track' },
      { id: thirdTrackId, name: 'Track 3', volume: 0.8, clips: [], channelRole: 'track' },
    ]

    expect(getReturnSendTargets(tracks)).toEqual([])
    expect(resolveSendTargetId(thirdTrackId, thirdTrackId, getReturnSendTargets(tracks))).toBe('')

    const previousWindow = globalThis.window
    Reflect.set(globalThis, 'window', {
      addEventListener: () => undefined,
      clearTimeout,
      setTimeout,
    })

    try {
      const repository = createLocalTimelineRepository(noReturnProjectId)
      await Promise.all(tracks.map((track, index) => repository.createTrack({
        id: track.id,
        index,
        name: track.name,
      })))

      await new Promise<void>((resolve, reject) => createRoot((dispose) => {
        const [writableTrackIds] = createSignal<Set<Track['id']>>(new Set(tracks.map((track) => track.id)))
        const localMix = useTimelineLocalMix({
          projectId: () => noReturnProjectId,
          writableTrackIds,
        })
        const controller = useTimelineMixerController({
          projectId: () => noReturnProjectId,
          userId: () => '',
          syncMix: () => false,
          tracks: () => tracks,
          localMix,
          optimisticTrackIds: () => new Set(),
          canWriteTrack: (trackId) => writableTrackIds().has(trackId),
          pushHistory: () => undefined,
          serverTrackState: () => null,
        })

        void (async () => {
          await new Promise((settle) => setTimeout(settle, 10))
          controller.updateTrackSends(firstTrackId, [{
            targetId: thirdTrackId,
            amount: 0.75,
            tap: 'pre-fader',
          }])
          await new Promise((settle) => setTimeout(settle, 200))
          const reloaded = await repository.loadSnapshot()
          expect(reloaded.tracks.find((track) => track.id === firstTrackId)?.sends).toEqual([])
          dispose()
          resolve()
        })().catch((error) => {
          dispose()
          reject(error)
        })
      }))
    } finally {
      Reflect.set(globalThis, 'window', previousWindow)
    }
  })

  test('persists a send to a return created after controller setup, reloads it, and clears it', async () => {
    const previousWindow = globalThis.window
    Reflect.set(globalThis, 'window', {
      addEventListener: () => undefined,
      clearTimeout,
      setTimeout,
    })

    try {
      const repository = createLocalTimelineRepository(projectId)
      await repository.createTrack({ id: sourceTrackId, index: 0 })
      await saveLocalProjectState<LocalMixMap>(projectId, 'localMix', {
        [sourceTrackId]: { sends: [] },
      })
      const initialSnapshot = await repository.loadSnapshot()
      const sourceTrack: Track = {
        ...initialSnapshot.tracks[0],
        clips: [],
      }
      const initialTracks: Track[] = [sourceTrack]
      expect(getReturnSendTargets(initialTracks)).toEqual([])

      await new Promise<void>((resolve, reject) => createRoot((dispose) => {
        const [renderTracks, setRenderTracks] = createSignal<Track[]>(initialTracks)
        const [mixerTracks, setMixerTracks] = createSignal<() => Track[]>(renderTracks)
        const [writableTrackIds] = createSignal<Set<Track['id']>>(new Set([sourceTrackId, returnTrackId]))
        const localMix = useTimelineLocalMix({
          projectId: () => projectId,
          writableTrackIds,
        })
        const controller = useTimelineMixerController({
          projectId: () => projectId,
          userId: () => '',
          syncMix: () => false,
          tracks: () => mixerTracks()(),
          localMix,
          optimisticTrackIds: () => new Set(),
          canWriteTrack: (trackId) => writableTrackIds().has(trackId),
          pushHistory: () => undefined,
          serverTrackState: () => null,
        })

        void (async () => {
          await new Promise((settle) => setTimeout(settle, 10))
          const returnRow = await repository.createTrack({
            id: returnTrackId,
            index: 1,
            channelRole: 'return',
          })
          const regularRow = await repository.createTrack({
            id: normalTargetTrackId,
            index: 2,
          })
          const returnTrack: Track = {
            ...returnRow,
            clips: [],
          }
          const regularTrack: Track = {
            ...regularRow,
            clips: [],
          }
          setRenderTracks([sourceTrack, returnTrack, regularTrack])
          setMixerTracks(() => renderTracks)
          expect(untrack(() => getReturnSendTargets(mixerTracks()()).map((track) => track.id))).toEqual([returnTrackId])
          controller.updateTrackSends(sourceTrackId, [{
            targetId: returnTrackId,
            amount: 1,
            tap: 'pre-fader',
          }])
          await new Promise((settle) => setTimeout(settle, 200))
          const persisted = await repository.loadSnapshot()
          const persistedSource = persisted.tracks.find((track) => track.id === sourceTrackId)
          expect(persistedSource?.sends).toEqual([{
            targetId: returnTrackId,
            amount: 1,
            tap: 'pre-fader',
          }])

          const reopened = resolveTimelineTracks({
            projectId,
            server: { localSnapshot: persisted },
            client: emptyClientState(localMix.byTrackId()),
            buffers: {
              getBuffer: () => undefined,
              getMediaStatus: () => undefined,
            },
          })
          expect(reopened.find((track) => track.id === sourceTrackId)?.sends).toEqual(persistedSource?.sends)

          controller.updateTrackSends(sourceTrackId, [])
          await new Promise((settle) => setTimeout(settle, 200))
          const cleared = await repository.loadSnapshot()
          expect(cleared.tracks.find((track) => track.id === sourceTrackId)?.sends).toEqual([])
          dispose()
          resolve()
        })().catch((error) => {
          dispose()
          reject(error)
        })
      }))
    } finally {
      Reflect.set(globalThis, 'window', previousWindow)
    }
  })

  test('retains a durable return send instead of restoring a stale local mix overlay', async () => {
    const previousWindow = globalThis.window
    Reflect.set(globalThis, 'window', {
      addEventListener: () => undefined,
      clearTimeout,
      setTimeout,
    })

    try {
      const repository = createLocalTimelineRepository('project:local-send-stale-local-mix')
      await repository.createTrack({ id: sourceTrackId, index: 0 })
      await repository.createTrack({ id: returnTrackId, index: 1, channelRole: 'return' })
      await repository.updateTrack({
        trackId: sourceTrackId,
        sends: [{ targetId: returnTrackId, amount: 0.25, tap: 'pre-fx' }],
      })
      await saveLocalProjectState<LocalMixMap>('project:local-send-stale-local-mix', 'localMix', {
        [sourceTrackId]: { sends: [] },
      })
      const snapshot = await repository.loadSnapshot()
      const tracks: Track[] = snapshot.tracks.map((track) => ({
        id: track.id,
        name: track.name,
        volume: track.volume,
        clips: [],
        muted: track.muted,
        soloed: track.soloed,
        kind: track.kind,
        channelRole: track.channelRole,
        sends: track.sends,
      }))
      expect(getReturnSendTargets(tracks).map((track) => track.id)).toEqual([returnTrackId])

      await new Promise<void>((resolve, reject) => createRoot((dispose) => {
        const [writableTrackIds] = createSignal<Set<Track['id']>>(new Set([sourceTrackId, returnTrackId]))
        const localMix = useTimelineLocalMix({
          projectId: () => 'project:local-send-stale-local-mix',
          writableTrackIds,
        })
        void (async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          const reopened = resolveTimelineTracks({
            projectId: 'project:local-send-stale-local-mix',
            server: { localSnapshot: snapshot },
            client: emptyClientState(localMix.byTrackId()),
            buffers: {
              getBuffer: () => undefined,
              getMediaStatus: () => undefined,
            },
          })
          expect(reopened.find((track) => track.id === sourceTrackId)?.sends).toEqual([{
            targetId: returnTrackId,
            amount: 0.25,
            tap: 'pre-fx',
          }])
          dispose()
          resolve()
        })().catch((error) => {
          dispose()
          reject(error)
        })
      }))
    } finally {
      Reflect.set(globalThis, 'window', previousWindow)
    }
  })

  test('normalizes stale non-return sends from durable and transient routing state', async () => {
    const repository = createLocalTimelineRepository('project:local-send-stale-routing')
    await repository.createTrack({ id: sourceTrackId, index: 0 })
    await repository.createTrack({ id: normalTargetTrackId, index: 1 })
    const snapshot = await repository.loadSnapshot()
    const staleDurableSend: TrackSend = {
      targetId: normalTargetTrackId,
      amount: 0.75,
      tap: 'post-fader',
    }
    const staleSnapshot = {
      ...snapshot,
      tracks: snapshot.tracks.map((track) => track.id === sourceTrackId
        ? {
            ...track,
            sends: [staleDurableSend],
          }
        : track),
    }
    const reopened = resolveTimelineTracks({
      projectId: staleSnapshot.projectId,
      server: { localSnapshot: staleSnapshot },
      client: emptyClientState({
        [sourceTrackId]: {
          sends: [{ targetId: normalTargetTrackId, amount: 0.5, tap: 'pre-fx' }],
        },
      }),
      buffers: {
        getBuffer: () => undefined,
        getMediaStatus: () => undefined,
      },
    })

    expect(reopened.find((track) => track.id === sourceTrackId)?.sends).toEqual([])
    const returnTargets = getReturnSendTargets(reopened)
    expect(resolveSendTargetId(normalTargetTrackId, normalTargetTrackId, returnTargets)).toBe('')
  })
})
