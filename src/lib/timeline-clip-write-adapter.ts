import { isJsonObject, isJsonString, isLocalId, normalizeAudioWarp, normalizeClipGain, normalizeClipTimingPatch } from '@daw-browser/shared'
import { isSharedOutboxQueuedError } from '~/lib/shared-outbox'
import { publishDurableSharedTimelineOperation } from '~/lib/shared-outbox-publishers'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import type { MoveClipInput } from '~/lib/timeline-repository/types'
import type { AudioWarp } from '@daw-browser/timeline-core/types'
import { normalizeClipFades, type ClipFades } from '@daw-browser/timeline-core/clip-fades'
import { z } from 'zod'

type ClipWriteContext = {
  projectId: string
  userId: string | undefined
}

const toSharedClipFades = (fades: ClipFades) => ({
  fadeInStartSec: fades.fadeInStartSec ?? 0,
  fadeInSec: fades.fadeInSec,
  fadeOutSec: fades.fadeOutSec,
  fadeOutEndSec: fades.fadeOutEndSec ?? 0,
  fadeInCurve: fades.fadeInCurve,
  fadeOutCurve: fades.fadeOutCurve,
  fadeInCurvePosition: fades.fadeInCurvePosition ?? 0.5,
  fadeOutCurvePosition: fades.fadeOutCurvePosition ?? 0.5,
})

type ClipTimingInput = {
  clipId: string
  startSec: number
  duration: number
  leftPadSec?: number
  bufferOffsetSec?: number
  midiOffsetBeats?: number
  audioWarp?: AudioWarp
  fades?: ClipFades
}

type ClipDeletion = {
  removedIds: Set<string>
  recoveryIdsByClipId: Map<string, string>
  recoveryOperationId?: string
}

const emptyDeletion = (): ClipDeletion => ({ removedIds: new Set<string>(), recoveryIdsByClipId: new Map<string, string>() })

// Local writes go through the local timeline repository (IndexedDB rows, flushed by its write queue).
const createLocalClipWrites = (projectId: string) => ({
  deleteClips: async (clipIds: string[]): Promise<ClipDeletion> => {
    await createLocalTimelineRepository(projectId).deleteClips(clipIds)

    return { removedIds: new Set(clipIds), recoveryIdsByClipId: new Map<string, string>() }
  },
  moveClips: async (moves: MoveClipInput[]) => {
    await createLocalTimelineRepository(projectId).moveClips(moves)

    return true
  },
  setAudioWarp: async (clipId: string, audioWarp: AudioWarp) => {
    const row = await createLocalTimelineRepository(projectId).updateClip({ clipId, audioWarp })

    return Boolean(row)
  },
  setGain: async (clipId: string, gain: number) => {
    const row = await createLocalTimelineRepository(projectId).updateClip({ clipId, gain })

    return Boolean(row)
  },
  setFades: async (clipId: string, fades: ClipFades) => {
    const row = await createLocalTimelineRepository(projectId).updateClip({ clipId, fades })

    return Boolean(row)
  },
  updateClipTiming: async (input: ClipTimingInput) => {
    const row = await createLocalTimelineRepository(projectId).updateClip(input)

    return Boolean(row)
  },
})

type ClipWrites = ReturnType<typeof createLocalClipWrites>

// A signed-out user on a cloud project drops every write with a failure-shaped result.
const signedOutClipWrites = {
  deleteClips: async (_clipIds: string[]) => emptyDeletion(),
  moveClips: async (_moves: MoveClipInput[]) => false,
  setAudioWarp: async (_clipId: string, _audioWarp: AudioWarp) => false,
  setGain: async (_clipId: string, _gain: number) => false,
  setFades: async (_clipId: string, _fades: ClipFades) => false,
  updateClipTiming: async (_input: ClipTimingInput) => false,
}

// Cloud writes are durable shared-outbox operations, replayed until the server accepts them.
const createCloudClipWrites = (projectId: string, userId: string) => {
  const publishApplied = async (operation: Parameters<typeof publishDurableSharedTimelineOperation>[0]['operation']) => {
    const result = z.json().parse(await publishDurableSharedTimelineOperation({
      projectId,
      userId,
      operation,
      queuedResult: { status: 'applied' },
    }))

    return isJsonObject(result) && result.status === 'applied'
  }

  return {
    deleteClips: async (clipIds: string[]): Promise<ClipDeletion> => {
      const operationId = crypto.randomUUID()

      const published = await publishDurableSharedTimelineOperation({
        projectId,
        userId,
        operation: { kind: 'clips.removeMany', payload: { clipIds, operationId } },
        throwQueued: true,
      })
        .then((result) => ({
          result: z.json().parse(result),
          recoveryOperationId: undefined,
        }))
        .catch((error) => {
          if (!isSharedOutboxQueuedError(error)) throw error

          return {
            result: z.json().parse({ removedClipIds: clipIds }),
            recoveryOperationId: error.operationId,
          }
        })

      const result = published.result

      const removedIds = new Set(
        isJsonObject(result) && Array.isArray(result.removedClipIds)
          ? result.removedClipIds.map(String)
          : [],
      )

      const recoveryIdsByClipId = new Map<string, string>()

      if (isJsonObject(result) && Array.isArray(result.recoveries)) {
        for (const recovery of result.recoveries) {
          if (!isJsonObject(recovery) || !isJsonString(recovery.sourceClipId) || !isJsonString(recovery.recoveryId)) continue
          recoveryIdsByClipId.set(recovery.sourceClipId, recovery.recoveryId)
        }
      }

      return { removedIds, recoveryIdsByClipId, recoveryOperationId: published.recoveryOperationId }
    },
    moveClips: (moves: MoveClipInput[]) => publishApplied({ kind: 'clips.moveMany', payload: { moves } }),
    setAudioWarp: (clipId: string, audioWarp: AudioWarp) => publishApplied({ kind: 'clips.setAudioWarp', payload: { clipId, audioWarp } }),
    setGain: (clipId: string, gain: number) => publishApplied({ kind: 'clips.setGain', payload: { clipId, gain } }),
    setFades: (clipId: string, fades: ClipFades) => publishApplied({ kind: 'clips.setFades', payload: { clipId, fades: toSharedClipFades(fades) } }),
    updateClipTiming: (input: ClipTimingInput) => {
      const timing = { clipId: input.clipId, ...normalizeClipTimingPatch(input) }
      const fades = input.fades ? normalizeClipFades(input.fades, input.duration) : undefined

      if (input.audioWarp === undefined) return publishApplied({ kind: 'clips.setTiming', payload: { ...timing, fades } })

      const audioWarp = normalizeAudioWarp(input.audioWarp)

      return publishApplied({
        kind: 'clips.setTimingAndAudioWarp',
        payload: { ...timing, audioWarp: audioWarp ? audioWarp : undefined, fades },
      })
    },
  } satisfies ClipWrites
}

// The backend (local repository or cloud outbox) is chosen once here; empty inputs and
// normalization that both sides share stay in front of it.
export const createTimelineClipWriteAdapter = (context: ClipWriteContext) => {
  const writes: ClipWrites = isLocalId('project', context.projectId)
    ? createLocalClipWrites(context.projectId)
    : context.userId ? createCloudClipWrites(context.projectId, context.userId) : signedOutClipWrites

  return {
    deleteClips: async (clipIds: string[]) => clipIds.length === 0 ? emptyDeletion() : await writes.deleteClips(clipIds),
    moveClips: async (moves: MoveClipInput[]) => moves.length === 0 ? false : await writes.moveClips(moves),
    setAudioWarp: async (clipId: string, audioWarp: AudioWarp) => {
      const normalized = normalizeAudioWarp(audioWarp)

      return normalized ? await writes.setAudioWarp(clipId, normalized) : false
    },
    setGain: async (clipId: string, gain: number) => await writes.setGain(clipId, normalizeClipGain(gain)),
    setFades: writes.setFades,
    updateClipTiming: writes.updateClipTiming,
  }
}
