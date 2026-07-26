import { isLocalId, normalizeAudioWarp, normalizeClipGain, normalizeClipTimingPatch } from '@daw-browser/shared'
import { isSharedOutboxQueuedError, publishDurableSharedTimelineOperation } from '~/lib/shared-outbox'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import type { MoveClipInput } from '~/lib/timeline-repository/types'
import type { AudioWarp } from '@daw-browser/timeline-core/types'
import { normalizeClipFades, type ClipFades } from '@daw-browser/timeline-core/clip-fades'

type ClipWriteContext = {
  projectId: string
  userId: string | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

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

export const createTimelineClipWriteAdapter = (context: ClipWriteContext) => ({
  deleteClips: async (clipIds: string[]) => {
    if (clipIds.length === 0) return { removedIds: new Set<string>(), recoveryIdsByClipId: new Map<string, string>() }
    if (isLocalId('project', context.projectId)) {
      await createLocalTimelineRepository(context.projectId).deleteClips(clipIds)
      return { removedIds: new Set(clipIds), recoveryIdsByClipId: new Map<string, string>() }
    }
    if (!context.userId) return { removedIds: new Set<string>(), recoveryIdsByClipId: new Map<string, string>() }
    const operationId = crypto.randomUUID()
    const userId = context.userId
    let result: unknown
    let recoveryOperationId: string | undefined
    try {
      result = await publishDurableSharedTimelineOperation({
        projectId: context.projectId,
        userId,
        operation: { kind: 'clips.removeMany', payload: { clipIds, operationId } },
        throwQueued: true,
      })
    } catch (error) {
      if (!isSharedOutboxQueuedError(error)) throw error
      result = { removedClipIds: clipIds }
      recoveryOperationId = error.operationId
    }
    const removedIds = new Set(
      isRecord(result) && Array.isArray(result.removedClipIds)
        ? result.removedClipIds.map((clipId: unknown) => String(clipId))
        : [],
    )
    const recoveryIdsByClipId = new Map<string, string>()
    if (isRecord(result) && Array.isArray(result.recoveries)) {
      for (const recovery of result.recoveries) {
        if (!isRecord(recovery) || typeof recovery.sourceClipId !== 'string' || typeof recovery.recoveryId !== 'string') continue
        recoveryIdsByClipId.set(recovery.sourceClipId, recovery.recoveryId)
      }
    }
    return { removedIds, recoveryIdsByClipId, recoveryOperationId }
  },
  moveClips: async (moves: MoveClipInput[]) => {
    if (moves.length === 0) return false
    if (isLocalId('project', context.projectId)) {
      await createLocalTimelineRepository(context.projectId).moveClips(moves)
      return true
    }
    if (!context.userId) return false
    const userId = context.userId
    const result = await publishDurableSharedTimelineOperation({
      projectId: context.projectId,
      userId,
      operation: { kind: 'clips.moveMany', payload: { moves } },
      queuedResult: { status: 'applied' },
    })
    return isRecord(result) && result.status === 'applied'
  },
  setAudioWarp: async (clipId: string, audioWarp: AudioWarp) => {
    const normalizedAudioWarp = normalizeAudioWarp(audioWarp)
    if (!normalizedAudioWarp) return false
    if (isLocalId('project', context.projectId)) {
      const row = await createLocalTimelineRepository(context.projectId).updateClip({ clipId, audioWarp: normalizedAudioWarp })
      return Boolean(row)
    }
    if (!context.userId) return false
    const userId = context.userId
    const result = await publishDurableSharedTimelineOperation({
      projectId: context.projectId,
      userId,
      operation: { kind: 'clips.setAudioWarp', payload: { clipId, audioWarp: normalizedAudioWarp } },
      queuedResult: { status: 'applied' },
    })
    return isRecord(result) && result.status === 'applied'
  },
  setGain: async (clipId: string, gain: number) => {
    const normalizedGain = normalizeClipGain(gain)
    if (isLocalId('project', context.projectId)) {
      const row = await createLocalTimelineRepository(context.projectId).updateClip({ clipId, gain: normalizedGain })
      return Boolean(row)
    }
    if (!context.userId) return false
    const userId = context.userId
    const result = await publishDurableSharedTimelineOperation({
      projectId: context.projectId,
      userId,
      operation: { kind: 'clips.setGain', payload: { clipId, gain: normalizedGain } },
      queuedResult: { status: 'applied' },
    })
    return isRecord(result) && result.status === 'applied'
  },
  setFades: async (clipId: string, fades: ClipFades) => {
    if (isLocalId('project', context.projectId)) {
      const row = await createLocalTimelineRepository(context.projectId).updateClip({ clipId, fades })
      return Boolean(row)
    }
    if (!context.userId) return false
    const result = await publishDurableSharedTimelineOperation({
      projectId: context.projectId,
      userId: context.userId,
      operation: { kind: 'clips.setFades', payload: { clipId, fades: toSharedClipFades(fades) } },
      queuedResult: { status: 'applied' },
    })
    return isRecord(result) && result.status === 'applied'
  },
  updateClipTiming: async (input: {
    clipId: string
    startSec: number
    duration: number
    leftPadSec?: number
    bufferOffsetSec?: number
    midiOffsetBeats?: number
    audioWarp?: AudioWarp
    fades?: ClipFades
  }) => {
    if (isLocalId('project', context.projectId)) {
      const row = await createLocalTimelineRepository(context.projectId).updateClip(input)
      return Boolean(row)
    }
    if (!context.userId) return false
    if (input.audioWarp !== undefined) {
      const normalizedAudioWarp = normalizeAudioWarp(input.audioWarp)
      const result = await publishDurableSharedTimelineOperation({
        projectId: context.projectId,
        userId: context.userId,
        operation: {
          kind: 'clips.setTimingAndAudioWarp',
          payload: {
            clipId: input.clipId,
            ...normalizeClipTimingPatch(input),
            ...(normalizedAudioWarp ? { audioWarp: normalizedAudioWarp } : {}),
            ...(input.fades ? { fades: normalizeClipFades(input.fades, input.duration) } : {}),
          },
        },
        queuedResult: { status: 'applied' },
      })
      return isRecord(result) && result.status === 'applied'
    }
    const result = await publishDurableSharedTimelineOperation({
      projectId: context.projectId,
      userId: context.userId,
      operation: {
        kind: 'clips.setTiming',
        payload: {
          clipId: input.clipId,
          ...normalizeClipTimingPatch(input),
          ...(input.fades ? { fades: normalizeClipFades(input.fades, input.duration) } : {}),
        },
      },
      queuedResult: { status: 'applied' },
    })
    return isRecord(result) && result.status === 'applied'
  },
})
