import { buildClipCreatePayload, buildLocalClip, createLocalAudioClip, createUploadedAudioClip, pushClipCreateHistory, type ClipCreateSnapshot } from '~/lib/clip-create'
import { createAudioAssetKey, getAudioSourceMetadata, type AudioSourceKind } from '~/lib/audio-source'
import { isLocalProjectAssetKey } from '@daw-browser/shared'
import type { ClipBuffers } from '~/lib/clip-buffer-cache'
import { createLocalAsset, deleteLocalAsset, LocalAssetWriteError } from '~/lib/local-assets'
import { isLocalId } from '@daw-browser/shared'
import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { isSharedOutboxQueuedError, publishDurableSharedTimelineOperation } from '~/lib/shared-outbox'
import {
  buildSharedClipCreateOperation,
  publishSharedTimelineOperation,
} from '~/lib/shared-timeline-operations-api'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { buildTrackDeleteMutationInput } from '~/lib/track-mutation-args'
import { getTrackHistoryRef } from '~/lib/undo/refs'
import type { HistoryEntry } from '~/lib/undo/types'
import type { Clip, Track, TrackId } from '@daw-browser/timeline-core/types'

type UploadToR2 = (
  projectId: string,
  assetKey: string,
  file: File,
  durationSec?: number,
) => Promise<string | null>

type ConvexClientType = typeof import('~/lib/convex').convexClient

type ConvexApiType = typeof import('~/lib/convex').convexApi

type ImportProjectContext = {
  projectId: () => string | undefined
  userId: () => string | undefined
  tracks: () => Track[]
  isActiveProjectTrack: (projectId: string, trackId: TrackId) => boolean
}

type ImportClipContext = {
  buffers: ClipBuffers
  insertLocalClip: (trackId: TrackId, clip: Clip) => void
  removeLocalClips?: (clipIds: Iterable<string>) => void
  selectClip: (trackId: TrackId, clipId: string) => void
  historyPush?: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  pushTrackClipCreateHistory: (track: Track, clipId: string, clip: ClipCreateSnapshot) => void
  grantClipWrite?: (clipId: string, scope?: OptimisticGrantScope | null) => void
}

type ImportCloudContext = {
  uploadToR2: UploadToR2
}

type AutoCreatedTrackRollback = {
  removeLocalTrack: (projectId: string, track: Track | undefined) => Promise<void>
  removeCloudTrack: (track: Track | undefined) => Promise<void>
}

type AudioImportTransactionContext = {
  project: ImportProjectContext
  clips: ImportClipContext
  cloud: ImportCloudContext
  rollback: AutoCreatedTrackRollback
  onLocalSaveFailed?: (message: string) => void
}

type AudioSourceClipInput = {
  trackId: TrackId
  startSec: number
  duration: number
  source: {
    durationSec: number
    sampleRate: number
    channelCount: number
  }
  url: string
  name?: string
  assetKey: string
  sourceKind: AudioSourceKind
  autoCreatedTrack?: Track
}

type UploadedFileClipInput = {
  file: File
  decoded: AudioBuffer
  track: Track
  startSec: number
  autoCreatedTrack?: Track
}

type AudioImportResult =
  | { status: 'created' }
  | { status: 'skipped' }
  | { status: 'local-save-failed'; message: string }
  | { status: 'failed'; message: string }

export function createAudioImportTransaction(context: AudioImportTransactionContext) {
  const preloadProjectedClip = (projectId: string, trackId: TrackId, clipId: string, sampleUrl?: string) => {
    queueMicrotask(() => {
      if (!context.project.isActiveProjectTrack(projectId, trackId)) return
      void context.clips.buffers.preload(clipId, sampleUrl)
    })
  }

  const createServerClip = async (trackId: TrackId, clip: ClipCreateSnapshot) => {
    const projectId = context.project.projectId()
    const userId = context.project.userId()
    if (!projectId || !userId) return null
    const operation = buildSharedClipCreateOperation(buildClipCreatePayload({ projectId, trackId, clip }))
    const result = await publishDurableSharedTimelineOperation({ projectId, userId, operation, throwQueued: true })
    return typeof result === 'string' ? result : null
  }

  const trackRefFor = (trackId: TrackId) =>
    getTrackHistoryRef(context.project.tracks().find((entry) => entry.id === trackId))

  const projectCreatedClip = (input: {
    projectId: string
    clipId: string
    clip: ClipCreateSnapshot
    source: AudioSourceClipInput
    sampleUrl?: string
  }) => {
    if (!context.project.isActiveProjectTrack(input.projectId, input.source.trackId)) return
    context.clips.insertLocalClip(input.source.trackId, buildLocalClip({ id: input.clipId, clip: input.clip }))
    preloadProjectedClip(input.projectId, input.source.trackId, input.clipId, input.sampleUrl)
    context.clips.selectClip(input.source.trackId, input.clipId)
    if (input.source.autoCreatedTrack) {
      context.clips.pushTrackClipCreateHistory(input.source.autoCreatedTrack, input.clipId, input.clip)
      return
    }
    pushClipCreateHistory({
      historyPush: context.clips.historyPush,
      projectId: input.projectId,
      trackId: input.source.trackId,
      trackRef: trackRefFor(input.source.trackId),
      clipId: input.clipId,
      clip: input.clip,
    })
  }

  const createAudioSourceClip = async (input: AudioSourceClipInput) => {
    const projectId = context.project.projectId()
    const userId = context.project.userId()
    const grantScope = projectId && userId ? { projectId, userId } : null
    const clipName = input.name?.trim()?.length ? input.name : 'Sample'
    const sampleUrl = projectId && isLocalId('project', projectId) && isLocalProjectAssetKey(input.assetKey)
      ? undefined
      : input.url
    const clipSnapshot: ClipCreateSnapshot = {
      startSec: input.startSec,
      duration: input.duration,
      name: clipName,
      sampleUrl,
      source: input.source,
      sourceAssetKey: input.assetKey,
      sourceKind: input.sourceKind,
    }

    if (projectId && isLocalId('project', projectId)) {
      try {
        const row = await createLocalTimelineRepository(projectId).createClip({
          trackId: input.trackId,
          name: clipName,
          startSec: input.startSec,
          duration: input.duration,
          color: 'clip-audio',
          sourceAssetId: isLocalProjectAssetKey(input.assetKey) ? input.assetKey : undefined,
          sourceAssetKey: input.assetKey,
          sourceKind: input.sourceKind,
          sourceDurationSec: input.source.durationSec,
          sourceSampleRate: input.source.sampleRate,
          sourceChannelCount: input.source.channelCount,
          sampleUrl,
        })
        projectCreatedClip({ projectId, clipId: row.id, clip: clipSnapshot, source: input, sampleUrl })
        return row.id
      } catch (error) {
        if (input.autoCreatedTrack) {
          await context.rollback.removeLocalTrack(projectId, input.autoCreatedTrack)
        }
        throw error
      }
    }

    let createdClipId: string | null
    try {
      createdClipId = await createServerClip(input.trackId, clipSnapshot)
      if (!createdClipId) {
        await context.rollback.removeCloudTrack(input.autoCreatedTrack)
        return null
      }
    } catch (error) {
      if (!isSharedOutboxQueuedError(error)) {
        await context.rollback.removeCloudTrack(input.autoCreatedTrack)
      }
      throw error
    }
    context.clips.grantClipWrite?.(createdClipId, grantScope)

    if (projectId) projectCreatedClip({ projectId, clipId: createdClipId, clip: clipSnapshot, source: input, sampleUrl })

    return createdClipId
  }

  const createUploadedFileClip = async (input: UploadedFileClipInput): Promise<AudioImportResult> => {
    const sourceMetadata = getAudioSourceMetadata(input.decoded)
    const projectId = context.project.projectId()
    if (!projectId) return { status: 'skipped' }

    if (isLocalId('project', projectId)) {
      let asset: Awaited<ReturnType<typeof createLocalAsset>>
      try {
        asset = await createLocalAsset({
          projectId,
          file: input.file,
          metadata: sourceMetadata,
        })
      } catch (error) {
        const message = error instanceof LocalAssetWriteError
          ? error.message
          : 'Audio could not be saved to local project storage.'
        const guidance = `${message} Free browser storage or choose a smaller file, then retry the import.`
        context.onLocalSaveFailed?.(guidance)
        await context.rollback.removeLocalTrack(projectId, input.autoCreatedTrack)
        return { status: 'local-save-failed', message: guidance }
      }
      try {
        const created = await createLocalAudioClip({
          projectId,
          trackId: input.track.id,
          trackRef: trackRefFor(input.track.id),
          startSec: input.startSec,
          fileName: input.file.name,
          decoded: input.decoded,
          source: sourceMetadata,
          sourceAssetKey: asset.id,
          sourceKind: 'upload',
          insertLocalClip: context.clips.insertLocalClip,
          selectClip: context.clips.selectClip,
          historyPush: context.clips.historyPush,
          skipHistory: Boolean(input.autoCreatedTrack),
          audioBufferCache: context.clips.buffers.writer,
          canProject: () => context.project.isActiveProjectTrack(projectId, input.track.id),
        })
        if (input.autoCreatedTrack && context.project.isActiveProjectTrack(projectId, input.track.id)) {
          context.clips.pushTrackClipCreateHistory(input.autoCreatedTrack, created.clipId, created.clip)
        }
      } catch (error) {
        await deleteLocalAsset(projectId, asset.id).catch(() => null)
        await context.rollback.removeLocalTrack(projectId, input.autoCreatedTrack)
        throw error
      }
      return { status: 'created' }
    }

    const userId = context.project.userId()
    if (!userId) return { status: 'skipped' }
    const sourceAssetKey = createAudioAssetKey()

    try {
      const created = await createUploadedAudioClip({
        projectId,
        userId,
        trackId: input.track.id,
        trackRef: trackRefFor(input.track.id),
        startSec: input.startSec,
        file: input.file,
        decoded: input.decoded,
        source: sourceMetadata,
        sourceAssetKey,
        sourceKind: 'upload',
        createServerClip: async (payload) => {
          const result = await publishSharedTimelineOperation(projectId, {
            kind: 'clips.create',
            payload,
          })
          return typeof result === 'string' ? result : null
        },
        insertLocalClip: context.clips.insertLocalClip,
        removeLocalClips: context.clips.removeLocalClips,
        selectClip: context.clips.selectClip,
        historyPush: context.clips.historyPush,
        uploadToR2: context.cloud.uploadToR2,
        audioBufferCache: context.clips.buffers.writer,
        grantClipWrite: context.clips.grantClipWrite,
        grantScope: { projectId, userId },
        pushHistory: !input.autoCreatedTrack,
        canProject: () => context.project.isActiveProjectTrack(projectId, input.track.id),
      })
      if (input.autoCreatedTrack && context.project.isActiveProjectTrack(projectId, input.track.id)) {
        context.clips.pushTrackClipCreateHistory(input.autoCreatedTrack, created.clipId, created.clip)
      }
    } catch (error) {
      if (!isSharedOutboxQueuedError(error)) {
        await context.rollback.removeCloudTrack(input.autoCreatedTrack)
      }
      return { status: 'failed', message: isSharedOutboxQueuedError(error)
        ? 'Audio import was queued and will retry when sync resumes.'
        : 'Audio could not be uploaded. Please retry the import.' }
    }
    return { status: 'created' }
  }

  return {
    createAudioSourceClip,
    createUploadedFileClip,
  }
}

export async function removeAutoCreatedCloudTrack(input: {
  convexClient: ConvexClientType
  convexApi: ConvexApiType
  userId: string | undefined
  track: Track | undefined
  removeLocalTrack: (trackId: TrackId) => void
}) {
  if (!input.track || !input.userId) return
  try {
    const result = await input.convexClient.mutation(
      input.convexApi.tracks.remove,
      buildTrackDeleteMutationInput({ trackId: input.track.id }),
    )
    if (result?.status === 'deleted') input.removeLocalTrack(input.track.id)
  } catch {}
}
