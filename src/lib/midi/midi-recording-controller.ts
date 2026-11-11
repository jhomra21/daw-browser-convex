import { createSignal, onCleanup, type Accessor } from 'solid-js'
import { buildLocalClip, pushClipCreateHistory } from '~/lib/clip-create'
import { trackColorForClip } from '~/lib/clip-color'
import { createMidiRecordingSession } from '~/lib/midi/recording-session'
import { createMidiRecordingCheckpointController, type MidiRecordingCheckpointController } from '~/lib/midi/recording-checkpoint'
import { isJsonString, isLocalId, isClipKindCompatibleWithTrack, type MidiClip, type SharedTimelineOperation } from '@daw-browser/shared'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import {
  enqueueSharedTimelineOperationOnFailure,
  isPermanentSharedOperationError,
} from '~/lib/shared-outbox'
import { publishSharedTimelineOperation } from '~/lib/shared-timeline-operations-api'
import {
  acquireTrackRecordingLock,
  clearRecordingLockHeartbeat,
  releaseTrackRecordingLock,
  startRecordingLockHeartbeat,
} from '~/lib/track-recording-session'
import { finalizeAutoCreatedTrackFailure, keptOnNewTrackNotice, type RecordingTargetLock } from '~/lib/track-recording-target'
import type { convexApi, convexClient } from '~/lib/convex'
import type { MidiAccessContextValue } from '~/context/midi-access'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import type { Track } from '@daw-browser/timeline-core/types'
import { buildTrackClipCreateHistoryEntry } from '~/lib/undo/builders'
import type { HistoryEntry } from '~/lib/undo/types'
import { z } from 'zod'

import type { TimelineSelectionController } from '~/hooks/useTimelineSelectionState'

export type MidiTrackRecordingControllerOptions = {
  audioEngine: Pick<AudioEngine, 'midiEventTimes'>
  tracks: Accessor<Track[]>
  projectId: Accessor<string | undefined>
  userId: Accessor<string | undefined>
  playheadSec: Accessor<number>
  bpm: Accessor<number>
  loopEnabled: Accessor<boolean>
  recordArmTrackId: Accessor<string | null>
  setTrackLock: (trackId: string, lockedBy: string | null) => void
  clearTrackLock: (trackId: string) => void
  createTrackForRecording: () => Promise<Track | null>
  convexClient: typeof convexClient
  convexApi: typeof convexApi
  removeLocalTrack: (trackId: Track['id']) => void
  clearRecordArmForTrack: (trackId: Track['id']) => void
  insertLocalClip: (trackId: string, clip: Track['clips'][number]) => void
  removeLocalClips: (clipIds: Iterable<string>) => void
  selection: Pick<TimelineSelectionController, 'selectPrimaryClip'>
  requestTransportPlay: () => Promise<void>
  pauseTransport: () => void
  notify: (message: string) => void
  onLocalSaveFailed?: (projectId: string, message: string) => void
  historyPush: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  setActiveRecordingTarget: (trackId: string | null) => void
  setProvisionalClipId: (clipId: string | null) => void
  isRecording: Accessor<boolean>
  setIsRecording: (value: boolean) => void
  recordingTrackId: Accessor<string | null>
  setRecordingTrackId: (trackId: string | null) => void
  targetLock?: RecordingTargetLock
}

type Checkpoint = {
  eventCount: number
  version: number
  duration: number
  midi: MidiClip
}

type ActiveTake = {
  projectId: string
  userId: string | undefined
  local: boolean
  track: Track
  clipId: string
  startSec: number
  bpm: number
  session: ReturnType<typeof createMidiRecordingSession>
  unsubscribe: () => void
  unsubscribeReset: () => void
  checkpoints: MidiRecordingCheckpointController<Checkpoint> | null
  eventVersion: number
  sourceIds: Set<string>
  historyPushed: boolean
  lockHeartbeatTimer: number | null
}

type RetainedCancelledClip = {
  projectId: string
  userId: string | undefined
  local: boolean
  clipId: string
  trackId: string
  lockAcquired: boolean
}

const recordingUnlockResultSchema = z.object({ ok: z.boolean().optional() })
const cancelledClipRemovalFailedNotice = 'Empty MIDI recording could not be removed from this project.'

export const createMidiTrackRecordingController = (
  rawOptions: MidiTrackRecordingControllerOptions,
  midiAccess: MidiAccessContextValue,
) => {
  // Cleanup can fail after the owning Timeline unmounts; its notices must not reach the UI then.
  let disposed = false
  onCleanup(() => { disposed = true })
  const options = {
    ...rawOptions,
    notify: (message: string) => { if (!disposed) rawOptions.notify(message) },
    // The lock follows the target the controller already publishes, so no exit path can leave it held.
    setActiveRecordingTarget: (trackId: string | null) => {
      rawOptions.setActiveRecordingTarget(trackId)
      if (trackId === null) rawOptions.targetLock?.release()
    },
    setRecordingTrackId: (trackId: string | null) => {
      rawOptions.setRecordingTrackId(trackId)
      if (trackId !== null) rawOptions.targetLock?.recording()
    },
  }
  let active: ActiveTake | null = null
  let startPromise: Promise<boolean> | null = null
  let settlingPromise: Promise<void> | null = null
  let retainedCancelledClip: RetainedCancelledClip | null = null
  let cancelledCleanupPromise: Promise<boolean> | null = null
  const [isStarting, setIsStarting] = createSignal(false)
  const [isSettling, setIsSettling] = createSignal(false)
  const [hasPendingCleanup, setHasPendingCleanup] = createSignal(false)
  let startGeneration = 0
  let pendingStartGeneration = 0
  const timelineTime = (timeStamp: number) => (
    options.audioEngine.midiEventTimes(timeStamp)?.timelineTime ?? options.playheadSec()
  )
  const currentTimelineTime = () => timelineTime(performance.now())

  const projectClip = (take: ActiveTake, duration: number, midi: MidiClip) => {
    if (active !== take || options.projectId() !== take.projectId) return
    options.removeLocalClips([take.clipId])
    options.insertLocalClip(take.track.id, buildLocalClip({
      id: take.clipId,
      clip: {
        startSec: take.startSec,
        duration,
        name: 'MIDI Recording',
        color: trackColorForClip(take.track.color) ?? 'clip-midi',
        midi,
      },
    }))
  }

  const createCheckpoint = (take: ActiveTake): Checkpoint => {
    const end = currentTimelineTime()
    const snapshot = take.session.snapshot(take.bpm, end)
    return {
      eventCount: snapshot.eventCount,
      version: take.eventVersion,
      duration: Math.max(0.001, end - take.startSec),
      midi: snapshot.midi,
    }
  }

  const deleteCloudClip = async (projectId: string, userId: string | undefined, clipId: string) => {
    const operation: SharedTimelineOperation = {
      kind: 'clips.removeMany',
      payload: { clipIds: [clipId], operationId: crypto.randomUUID() },
    }
    try {
      await publishSharedTimelineOperation(projectId, operation)
    } catch (error) {
      if (isPermanentSharedOperationError(error) || !userId) throw error
      await enqueueSharedTimelineOperationOnFailure({ projectId, userId, operation, error })
      options.notify('Empty MIDI recording cleanup was queued and will retry when sync resumes.')
    }
  }

  const retryCancelledClipCleanup = (): Promise<boolean> => {
    if (cancelledCleanupPromise) return cancelledCleanupPromise
    const retained = retainedCancelledClip
    if (!retained) return Promise.resolve(true)
    const cleanup = (async () => {
      try {
        if (retained.local) {
          await createLocalTimelineRepository(retained.projectId).deleteClip(retained.clipId)
        } else {
          await deleteCloudClip(retained.projectId, retained.userId, retained.clipId)
        }
      } catch {
        return false
      }
      if (retained.lockAcquired && !retained.local) {
        try {
          const response = await publishSharedTimelineOperation(retained.projectId, {
            kind: 'tracks.unlock',
            payload: { trackId: retained.trackId },
          })
          if (recordingUnlockResultSchema.safeParse(response).data?.ok !== true) return false
          options.setTrackLock(retained.trackId, null)
        } catch {
          return false
        }
      }
      if (retainedCancelledClip !== retained) return false
      if (options.projectId() === retained.projectId) options.removeLocalClips([retained.clipId])
      options.setProvisionalClipId(null)
      retainedCancelledClip = null
      setHasPendingCleanup(false)
      return true
    })()
    cancelledCleanupPromise = cleanup
    void cleanup.finally(() => {
      if (cancelledCleanupPromise === cleanup) cancelledCleanupPromise = null
    })
    return cleanup
  }

  const persist = async (take: ActiveTake, checkpoint: Checkpoint, final: boolean, signal: AbortSignal) => {
    if (signal.aborted || active !== take) return
    if (take.local) {
      const row = await createLocalTimelineRepository(take.projectId).updateClip({
        clipId: take.clipId,
        startSec: take.startSec,
        duration: checkpoint.duration,
        midi: checkpoint.midi,
      })
      if (!row) throw new Error('MIDI recording clip disappeared.')
    } else {
      const operation: SharedTimelineOperation = {
        kind: 'clips.setMidiAndTiming',
        payload: {
          clipId: take.clipId,
          startSec: take.startSec,
          duration: checkpoint.duration,
          midi: checkpoint.midi,
          operationId: crypto.randomUUID(),
        },
      }
      try {
        await publishSharedTimelineOperation(take.projectId, operation, { signal })
      } catch (error) {
        if (!final || isPermanentSharedOperationError(error) || !take.userId) throw error
        await enqueueSharedTimelineOperationOnFailure({ projectId: take.projectId, userId: take.userId, operation, error })
        options.notify('MIDI recording was queued and will retry when sync resumes.')
      }
    }
    if (signal.aborted || active !== take || checkpoint.version < take.eventVersion) return
    projectClip(take, checkpoint.duration, checkpoint.midi)
  }

  // The take's target track was removed mid-take: the captured events live in the session, so
  // the take is saved on a fresh instrument track as one undoable track + clip entry.
  const keepOnNewTrack = async (take: ActiveTake, midi: MidiClip, duration: number) => {
    const track = await options.createTrackForRecording()
    if (!track) throw new Error('A track for the kept MIDI take could not be created.')
    const clip = {
      startSec: take.startSec,
      duration,
      name: 'MIDI Recording',
      color: trackColorForClip(track.color) ?? 'clip-midi',
      midi,
    }
    let clipId: string | null
    try {
      if (take.local) {
        clipId = (await createLocalTimelineRepository(take.projectId).createClip({ trackId: track.id, ...clip })).id
      } else {
        const result = await publishSharedTimelineOperation(take.projectId, {
          kind: 'clips.create',
          payload: { trackId: track.id, ...clip, clipKind: 'midi', operationId: crypto.randomUUID() },
        })
        clipId = isJsonString(result) ? result : null
      }
      if (!clipId) throw new Error('MIDI clip creation was rejected.')
    } catch (error) {
      // The new track holds no clip, so it is removed with the audio path's cleanup before the failure reaches settle.
      await finalizeAutoCreatedTrackFailure({
        track,
        tracks: options.tracks(),
        projectId: take.projectId,
        userId: take.userId,
        historyPush: options.historyPush,
        convexClient: options.convexClient,
        convexApi: options.convexApi,
        removeLocalTrack: options.removeLocalTrack,
        clearRecordArmForTrack: options.clearRecordArmForTrack,
        emit: options.notify,
      })
      throw error
    }
    options.insertLocalClip(track.id, buildLocalClip({ id: clipId, clip }))
    options.historyPush(buildTrackClipCreateHistoryEntry({
      projectId: take.projectId, track, tracks: options.tracks(), clipId, clip,
    }))
    options.notify(keptOnNewTrackNotice)
  }

  const resolveLostOwnership = (take: ActiveTake) => {
    if (active !== take) return
    take.checkpoints?.clear()
    take.unsubscribe()
    take.unsubscribeReset()
    take.session.close(currentTimelineTime())
    take.lockHeartbeatTimer = clearRecordingLockHeartbeat(take.lockHeartbeatTimer)
    active = null
    if (options.projectId() === take.projectId) options.removeLocalClips([take.clipId])
    options.clearTrackLock(take.track.id)
    options.setIsRecording(false)
    options.setRecordingTrackId(null)
    options.setActiveRecordingTarget(null)
    options.setProvisionalClipId(null)
    options.notify('MIDI recording could not be saved because the track lock was lost.')
  }

  const cancelStarting = () => {
    if (!startPromise) return
    startGeneration += 1
  }

  const retryRetainedCleanup = (): Promise<void> => retryCancelledClipCleanup().then((removed) => {
    if (!removed) {
      options.notify(cancelledClipRemovalFailedNotice)
      throw new Error('MIDI recording remains protected until its cancelled clip can be removed.')
    }
  })

  const settleWith = (settlement: Promise<void>): Promise<void> => {
    setIsSettling(true)
    settlingPromise = settlement.finally(() => {
      settlingPromise = null
      setIsSettling(false)
    })
    return settlingPromise
  }

  const settle = (stopTransport = true): Promise<void> => {
    if (settlingPromise) {
      cancelStarting()
      return settlingPromise
    }
    if (startPromise) {
      // Cancel synchronously so a late setup cannot create a take or start transport, then wait
      // for the cancelled setup to release its lock and provisional clip before callers proceed.
      const cancelledStart = startPromise
      cancelStarting()
      if (stopTransport) options.pauseTransport()
      const settlement = cancelledStart.then(() => {
        if (retainedCancelledClip) return retryRetainedCleanup()
      })
      return settleWith(settlement)
    }
    if (retainedCancelledClip) return settleWith(retryRetainedCleanup())
    const take = active
    if (!take) return Promise.resolve()
    options.targetLock?.finishing()
    return settleWith((async () => {
      let clearProvisionalClip = true
      let emptyTake = false
      // Deleting the target removed the provisional clip with it, so a failed keep has nothing left to delete.
      let targetRemoved = false
      take.checkpoints?.clear()
      take.unsubscribe()
      take.unsubscribeReset()
      take.session.close(currentTimelineTime())
      try {
        const end = currentTimelineTime()
        const snapshot = take.session.snapshot(take.bpm, end)
        if (snapshot.eventCount === 0) {
          emptyTake = true
          if (take.local) await createLocalTimelineRepository(take.projectId).deleteClip(take.clipId)
          else await deleteCloudClip(take.projectId, take.userId, take.clipId)
          if (options.projectId() === take.projectId) options.removeLocalClips([take.clipId])
        } else if (options.projectId() === take.projectId && !options.tracks().some((entry) => entry.id === take.track.id)) {
          targetRemoved = true
          await keepOnNewTrack(take, snapshot.midi, Math.max(0.001, end - take.startSec))
        } else {
          await take.checkpoints?.request(true)
          const checkpoint = take.checkpoints?.last()
          if (checkpoint && !take.historyPushed) {
            take.historyPushed = true
            pushClipCreateHistory({
              historyPush: options.historyPush, projectId: take.projectId, trackId: take.track.id, clipId: take.clipId,
              clip: {
                startSec: take.startSec, duration: checkpoint.duration, name: 'MIDI Recording',
                color: trackColorForClip(take.track.color) ?? 'clip-midi', midi: checkpoint.midi,
              },
            })
          }
        }
      } catch (error) {
        let removed = false
        if (emptyTake && !take.local && isPermanentSharedOperationError(error)) {
          if (options.projectId() === take.projectId) options.removeLocalClips([take.clipId])
          removed = true
          options.notify(cancelledClipRemovalFailedNotice)
        } else if (take.local || isPermanentSharedOperationError(error)) {
          try {
            if (!targetRemoved) {
              if (take.local) await createLocalTimelineRepository(take.projectId).deleteClip(take.clipId)
              else await publishSharedTimelineOperation(take.projectId, {
                kind: 'clips.removeMany',
                payload: { clipIds: [take.clipId], operationId: crypto.randomUUID() },
              })
            }
            removed = true
          } catch {}
          if (removed && options.projectId() === take.projectId) options.removeLocalClips([take.clipId])
          const message = 'MIDI recording could not be saved to this project.'
          if (take.local && options.onLocalSaveFailed) options.onLocalSaveFailed(take.projectId, message)
          else options.notify(message)
        } else {
          options.notify('MIDI recording could not be finalized.')
        }
        if (!removed) {
          clearProvisionalClip = false
          options.setProvisionalClipId(take.clipId)
        }
      } finally {
        take.lockHeartbeatTimer = clearRecordingLockHeartbeat(take.lockHeartbeatTimer)
        if (!take.local) {
          await releaseTrackRecordingLock({
            projectId: take.projectId, trackId: take.track.id, locker: take.userId,
            setTrackLock: options.setTrackLock, clearTrackLock: options.clearTrackLock,
          })
        } else options.clearTrackLock(take.track.id)
        if (active === take) active = null
        options.setIsRecording(false)
        options.setRecordingTrackId(null)
        options.setActiveRecordingTarget(null)
        if (clearProvisionalClip) options.setProvisionalClipId(null)
      }
    })())
  }

  const startRecording = (): Promise<boolean> => {
    if (startPromise) {
      if (pendingStartGeneration === startGeneration) return startPromise
      const generation = startGeneration
      return (settlingPromise ?? startPromise).then(
        () => generation === startGeneration ? startRecording() : false,
        () => false,
      )
    }
    if (active || settlingPromise) return Promise.resolve(false)
    if (retainedCancelledClip) {
      options.notify('Finishing cleanup of a cancelled MIDI recording… retry.')
      return Promise.resolve(false)
    }
    let completeStart: (value: boolean) => void = () => {}
    const pendingStart = new Promise<boolean>((resolve) => { completeStart = resolve })
    startPromise = pendingStart
    const generation = startGeneration
    pendingStartGeneration = generation
    const isStartCurrent = () => generation === startGeneration
    setIsStarting(true)
    void (async () => {
    const projectId = options.projectId()
    const userId = options.userId()
    const track = options.tracks().find((entry) => entry.id === options.recordArmTrackId())
    const local = projectId ? isLocalId('project', projectId) : false
    if (!projectId || !track || !isClipKindCompatibleWithTrack(track, 'midi') || (!local && !userId)) {
      options.notify('Arm an available instrument track to record MIDI.')
      return false
    }
    if (options.loopEnabled()) {
      options.notify('Disable looping before recording MIDI.')
      return false
    }
    if (track.lockedBy && track.lockedBy !== userId) {
      options.notify('Track is locked by another collaborator.')
      return false
    }
    if (options.targetLock && !options.targetLock.start(track.id)) {
      options.notify('Another recording is active.')
      return false
    }
    options.setActiveRecordingTarget(track.id)
    try {
      await midiAccess.requestAccess()
      if (!isStartCurrent()) {
        options.setActiveRecordingTarget(null)
        return false
      }
      if (!local) {
        const lock = await acquireTrackRecordingLock({
          projectId, trackId: track.id, locker: userId ?? '',
          setTrackLock: options.setTrackLock, clearTrackLock: options.clearTrackLock,
        })
        if (!isStartCurrent()) {
          if (lock.ok) await releaseTrackRecordingLock({
            projectId, trackId: track.id, locker: userId ?? '',
            setTrackLock: options.setTrackLock, clearTrackLock: options.clearTrackLock,
          })
          options.setActiveRecordingTarget(null)
          return false
        }
        if (!lock.ok) {
          options.setActiveRecordingTarget(null)
          return false
        }
      }
    } catch {
      options.setActiveRecordingTarget(null)
      if (isStartCurrent()) options.notify('Unable to start MIDI recording.')
      return false
    }
    options.pauseTransport()
    const startSec = Math.max(0, options.playheadSec())
    const initialMidi: MidiClip = { wave: 'sine', notes: [] }
    let clipId: string | null = null
    let startedTake: ActiveTake | null = null
    try {
      if (local) {
        const row = await createLocalTimelineRepository(projectId).createClip({
          trackId: track.id, startSec, duration: 0.001, name: 'MIDI Recording',
          color: trackColorForClip(track.color) ?? 'clip-midi', midi: initialMidi,
        })
        clipId = row.id
      } else {
        const result = await publishSharedTimelineOperation(projectId, {
          kind: 'clips.create',
          payload: {
            trackId: track.id, startSec, duration: 0.001, name: 'MIDI Recording',
            color: trackColorForClip(track.color) ?? 'clip-midi', midi: initialMidi,
            clipKind: 'midi', operationId: crypto.randomUUID(),
          },
        })
        clipId = isJsonString(result) ? result : null
      }
      if (!isStartCurrent()) {
        if (clipId) {
          options.setProvisionalClipId(clipId)
          retainedCancelledClip = {
            projectId, userId, local, clipId, trackId: track.id, lockAcquired: !local,
          }
          setHasPendingCleanup(true)
          const cleanupDeferred = settlingPromise !== null
          const removed = cleanupDeferred ? false : await retryCancelledClipCleanup()
          if (!removed && !cleanupDeferred) options.notify(cancelledClipRemovalFailedNotice)
        } else if (!local) await releaseTrackRecordingLock({
          projectId, trackId: track.id, locker: userId,
          setTrackLock: options.setTrackLock, clearTrackLock: options.clearTrackLock,
        })
        options.setActiveRecordingTarget(null)
        return false
      }
      if (!clipId) throw new Error('MIDI clip creation was rejected.')
      const session = createMidiRecordingSession(startSec)
      const take: ActiveTake = {
        projectId, userId, local, track, clipId, startSec, bpm: options.bpm(), session,
        checkpoints: null,
        eventVersion: 0,
        sourceIds: new Set(), historyPushed: false,
        unsubscribe: () => {}, unsubscribeReset: () => {},
        lockHeartbeatTimer: null,
      }
      take.checkpoints = createMidiRecordingCheckpointController({
        snapshot: () => {
          const checkpoint = createCheckpoint(take)
          return { checkpoint, eventCount: checkpoint.eventCount, version: checkpoint.version }
        },
        state: () => ({ eventCount: take.session.eventCount(), version: take.eventVersion }),
        persist: (checkpoint, final, signal) => persist(take, checkpoint, final, signal),
        isActive: () => active === take,
      })
      startedTake = take
      active = take
      projectClip(take, 0.001, initialMidi)
      options.selection.selectPrimaryClip({ trackId: track.id, clipId })
      take.unsubscribe = midiAccess.subscribe((event) => {
        session.receive(event, timelineTime(event.timeStamp))
        take.sourceIds.add(event.sourceId)
        take.eventVersion += 1
        const checkpoints = take.checkpoints
        if (session.isComplete()) {
          void settle()
        } else if (checkpoints?.shouldRequest()) {
          void checkpoints.request().catch(() => undefined)
        } else {
          checkpoints?.schedule()
        }
      })
      take.unsubscribeReset = midiAccess.subscribeSourceReset((event) => {
        if (!take.sourceIds.has(event.sourceId)) return
        session.resetSource(event.sourceId, currentTimelineTime())
        take.sourceIds.delete(event.sourceId)
        queueMicrotask(() => {
          if (active === take && !midiAccess.inputs().some((input) => input.selected && input.connected)) void settle()
        })
      })
      if (!local) {
        take.lockHeartbeatTimer = startRecordingLockHeartbeat({
          projectId, trackId: track.id, locker: userId ?? '',
          onError: () => {
            if (active === take && isStartCurrent()) options.notify('MIDI recording lock could not be refreshed.')
          },
          onLost: () => {
            if (active === take && isStartCurrent()) resolveLostOwnership(take)
          },
        })
      }
      options.setIsRecording(true)
      options.setRecordingTrackId(track.id)
      options.setActiveRecordingTarget(track.id)
      options.setProvisionalClipId(clipId)
      await options.requestTransportPlay()
      if (!isStartCurrent()) {
        throw new Error('MIDI recording start was cancelled.')
      }
      return true
    } catch {
      if (startedTake) {
        startedTake.checkpoints?.clear()
        startedTake.unsubscribe()
        startedTake.unsubscribeReset()
        if (active === startedTake) active = null
        startedTake.lockHeartbeatTimer = clearRecordingLockHeartbeat(startedTake.lockHeartbeatTimer)
        await startedTake.checkpoints?.cancel()
      }
      let clipWasRemoved = clipId === null
      if (clipId) {
        retainedCancelledClip = {
          projectId, userId, local, clipId, trackId: track.id, lockAcquired: !local,
        }
        setHasPendingCleanup(true)
        const cleanupDeferred = settlingPromise !== null
        clipWasRemoved = cleanupDeferred ? false : await retryCancelledClipCleanup()
        if (!clipWasRemoved && !cleanupDeferred) options.notify(cancelledClipRemovalFailedNotice)
      }
      if (!local && !clipId) await releaseTrackRecordingLock({ projectId, trackId: track.id, locker: userId, setTrackLock: options.setTrackLock, clearTrackLock: options.clearTrackLock })
      options.setIsRecording(false)
      options.setRecordingTrackId(null)
      options.setActiveRecordingTarget(null)
      if (clipWasRemoved) options.setProvisionalClipId(null)
      else if (clipId) options.setProvisionalClipId(clipId)
      if (isStartCurrent()) options.notify('Unable to start MIDI recording.')
      return false
    }
    })().then(
      (result) => {
        if (startPromise === pendingStart) startPromise = null
        setIsStarting(false)
        completeStart(result)
      },
      () => {
        if (startPromise === pendingStart) startPromise = null
        setIsStarting(false)
        completeStart(false)
      },
    )
    return pendingStart
  }

  return {
    isRecording: () => options.isRecording() || isStarting() || isSettling(),
    // A take from creation until its final settle; cancelled-clip cleanup retries are not takes.
    // Plain read for event handlers, not reactive.
    hasLiveTake: () => active !== null,
    hasPendingCleanup,
    isStarting,
    recordingTrackId: options.recordingTrackId,
    startRecording,
    stopRecording: settle,
  }
}
