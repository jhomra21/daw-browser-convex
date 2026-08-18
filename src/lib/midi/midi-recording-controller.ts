import type { Accessor } from 'solid-js'
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
import type { MidiAccessContextValue } from '~/context/midi-access'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import type { Track } from '@daw-browser/timeline-core/types'
import type { HistoryEntry } from '~/lib/undo/types'

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
  insertLocalClip: (trackId: string, clip: Track['clips'][number]) => void
  removeLocalClips: (clipIds: Iterable<string>) => void
  selection: Pick<TimelineSelectionController, 'selectPrimaryClip'>
  requestTransportPlay: () => Promise<void>
  pauseTransport: () => void
  notify: (message: string) => void
  historyPush: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  setActiveRecordingTarget: (trackId: string | null) => void
  setProvisionalClipId: (clipId: string | null) => void
  isRecording: Accessor<boolean>
  setIsRecording: (value: boolean) => void
  recordingTrackId: Accessor<string | null>
  setRecordingTrackId: (trackId: string | null) => void
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

export const createMidiTrackRecordingController = (
  options: MidiTrackRecordingControllerOptions,
  midiAccess: MidiAccessContextValue,
) => {
  let active: ActiveTake | null = null
  let startPromise: Promise<boolean> | null = null
  let settlingPromise: Promise<void> | null = null

  const timelineTime = (timeStamp: number) => (
    options.audioEngine.midiEventTimes(timeStamp)?.timelineTime ?? options.playheadSec()
  )
  const currentTimelineTime = () => timelineTime(performance.now())

  const projectClip = (take: ActiveTake, duration: number, midi: MidiClip) => {
    if (options.projectId() !== take.projectId) return
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

  const persist = async (take: ActiveTake, checkpoint: Checkpoint, final: boolean) => {
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
        await publishSharedTimelineOperation(take.projectId, operation)
      } catch (error) {
        if (!final || isPermanentSharedOperationError(error) || !take.userId) throw error
        await enqueueSharedTimelineOperationOnFailure({ projectId: take.projectId, userId: take.userId, operation, error })
        options.notify('MIDI recording was queued and will retry when sync resumes.')
      }
    }
    if (checkpoint.version < take.eventVersion) return
    projectClip(take, checkpoint.duration, checkpoint.midi)
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

  const settle = (): Promise<void> => {
    if (settlingPromise) return settlingPromise
    if (startPromise) return startPromise.then(() => settle())
    const take = active
    if (!take) return Promise.resolve()
    settlingPromise = (async () => {
      let clearProvisionalClip = true
      let emptyTake = false
      take.checkpoints?.clear()
      take.unsubscribe()
      take.unsubscribeReset()
      take.session.close(currentTimelineTime())
      try {
        const snapshot = take.session.snapshot(take.bpm, currentTimelineTime())
        if (snapshot.eventCount === 0) {
          emptyTake = true
          if (take.local) await createLocalTimelineRepository(take.projectId).deleteClip(take.clipId)
          else await deleteCloudClip(take.projectId, take.userId, take.clipId)
          if (options.projectId() === take.projectId) options.removeLocalClips([take.clipId])
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
          options.notify('Empty MIDI recording could not be removed from this project.')
        } else if (take.local || isPermanentSharedOperationError(error)) {
          try {
            if (take.local) await createLocalTimelineRepository(take.projectId).deleteClip(take.clipId)
            else await publishSharedTimelineOperation(take.projectId, {
              kind: 'clips.removeMany',
              payload: { clipIds: [take.clipId], operationId: crypto.randomUUID() },
            })
            removed = true
          } catch {}
          if (removed && options.projectId() === take.projectId) options.removeLocalClips([take.clipId])
          options.notify('MIDI recording could not be saved to this project.')
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
    })().finally(() => { settlingPromise = null })
    return settlingPromise
  }

  const startRecording = () => {
    if (startPromise) return startPromise
    if (active || settlingPromise) return Promise.resolve(false)
    let completeStart: (value: boolean) => void = () => {}
    const pendingStart = new Promise<boolean>((resolve) => { completeStart = resolve })
    startPromise = pendingStart
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
    options.setActiveRecordingTarget(track.id)
    try {
      await midiAccess.requestAccess()
      if (!local) {
        const lock = await acquireTrackRecordingLock({
          projectId, trackId: track.id, locker: userId ?? '',
          setTrackLock: options.setTrackLock, clearTrackLock: options.clearTrackLock,
        })
        if (!lock.ok) {
          options.setActiveRecordingTarget(null)
          return false
        }
      }
    } catch {
      options.setActiveRecordingTarget(null)
      options.notify('Unable to start MIDI recording.')
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
        persist: (checkpoint, final) => persist(take, checkpoint, final),
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
          onError: () => options.notify('MIDI recording lock could not be refreshed.'),
          onLost: () => {
            resolveLostOwnership(take)
          },
        })
      }
      options.setIsRecording(true)
      options.setRecordingTrackId(track.id)
      options.setActiveRecordingTarget(track.id)
      options.setProvisionalClipId(clipId)
      await options.requestTransportPlay()
      return true
    } catch {
      if (startedTake) {
        startedTake.checkpoints?.clear()
        startedTake.unsubscribe()
        startedTake.unsubscribeReset()
        if (active === startedTake) active = null
        startedTake.lockHeartbeatTimer = clearRecordingLockHeartbeat(startedTake.lockHeartbeatTimer)
      }
      if (clipId) {
        options.removeLocalClips([clipId])
        if (local) await createLocalTimelineRepository(projectId).deleteClip(clipId).catch(() => undefined)
        else await deleteCloudClip(projectId, userId, clipId).catch(() => undefined)
      }
      if (!local) await releaseTrackRecordingLock({ projectId, trackId: track.id, locker: userId, setTrackLock: options.setTrackLock, clearTrackLock: options.clearTrackLock })
      options.setIsRecording(false)
      options.setRecordingTrackId(null)
      options.setActiveRecordingTarget(null)
      options.setProvisionalClipId(null)
      options.notify('Unable to start MIDI recording.')
      return false
    }
    })().then(
      (result) => {
        if (startPromise === pendingStart) startPromise = null
        completeStart(result)
      },
      () => {
        if (startPromise === pendingStart) startPromise = null
        completeStart(false)
      },
    )
    return pendingStart
  }

  return {
    isRecording: () => options.isRecording() || startPromise !== null || settlingPromise !== null,
    recordingTrackId: options.recordingTrackId,
    startRecording,
    stopRecording: settle,
  }
}
