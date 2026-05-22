import { buildClipCreatePayload } from '~/lib/clip-create'
import { convexApi } from '~/lib/convex'
import { buildClipRemoveManyMutationInput } from '~/lib/clip-mutation-args'
import { buildTrackDeleteMutationInput, buildTrackMixMutationInput, buildTrackVolumeMutationInput } from '~/lib/track-mutation-args'
import { buildTrackRoutingMutationInput } from '~/lib/track-routing-state'
import type {
  CreateClipInput,
  CreateTrackInput,
  TimelineClipRow,
  TimelineRepository,
  TimelineSnapshot,
  TimelineTrackRow,
  UpdateClipInput,
  UpdateTrackInput,
} from '~/lib/timeline-repository/types'
import type { ClipCreateSnapshot } from '~/lib/clip-create'
import type { Id } from '../../../convex/_generated/dataModel'

type ConvexClient = {
  query: (fn: unknown, args: unknown) => Promise<unknown>
  mutation: (fn: unknown, args: unknown) => Promise<unknown>
}

const now = () => Date.now()
const toCloudTrackId = (trackId: string): Id<'tracks'> => trackId as Id<'tracks'>
const toCloudClipId = (clipId: string): Id<'clips'> => clipId as Id<'clips'>

const toTrackRow = (track: any, index: number): TimelineTrackRow => ({
  id: String(track._id),
  historyRef: String(track._id),
  name: track.name ?? `Track ${index + 1}`,
  index: typeof track.index === 'number' ? track.index : index,
  volume: typeof track.volume === 'number' ? track.volume : 1,
  muted: track.muted === true,
  soloed: track.soloed === true,
  kind: track.kind === 'instrument' ? 'instrument' : 'audio',
  channelRole: track.channelRole === 'group' || track.channelRole === 'return' ? track.channelRole : 'track',
  outputTargetId: track.outputTargetId ? String(track.outputTargetId) : undefined,
  sends: Array.isArray(track.sends)
    ? track.sends.map((send: any) => ({ targetId: String(send.targetId), amount: Number(send.amount) || 0 }))
    : [],
  createdAt: typeof track.createdAt === 'number' ? track.createdAt : now(),
  updatedAt: typeof track.updatedAt === 'number' ? track.updatedAt : now(),
})

const toClipRow = (clip: any): TimelineClipRow => ({
  id: String(clip._id),
  trackId: String(clip.trackId),
  historyRef: String(clip._id),
  name: clip.name ?? 'Clip',
  startSec: Number(clip.startSec) || 0,
  duration: Number(clip.duration) || 0,
  color: clip.midi ? 'clip-midi' : 'clip-audio',
  sourceAssetKey: clip.sourceAssetKey,
  sourceKind: clip.sourceKind,
  sourceDurationSec: clip.sourceDurationSec,
  sourceSampleRate: clip.sourceSampleRate,
  sourceChannelCount: clip.sourceChannelCount,
  leftPadSec: clip.leftPadSec,
  bufferOffsetSec: clip.bufferOffsetSec,
  sampleUrl: clip.sampleUrl,
  midi: clip.midi,
  midiOffsetBeats: clip.midiOffsetBeats,
  createdAt: typeof clip.createdAt === 'number' ? clip.createdAt : now(),
  updatedAt: typeof clip.updatedAt === 'number' ? clip.updatedAt : now(),
})

const toClipSnapshot = (input: CreateClipInput): ClipCreateSnapshot => ({
  historyRef: input.historyRef,
  startSec: input.startSec,
  duration: input.duration,
  name: input.name,
  sampleUrl: input.sampleUrl,
  sourceAssetKey: input.sourceAssetKey,
  sourceKind: input.sourceKind,
  source: input.sourceDurationSec !== undefined
    && input.sourceSampleRate !== undefined
    && input.sourceChannelCount !== undefined
    ? {
        durationSec: input.sourceDurationSec,
        sampleRate: input.sourceSampleRate,
        channelCount: input.sourceChannelCount,
      }
    : undefined,
  midi: input.midi,
  timing: {
    leftPadSec: input.leftPadSec,
    bufferOffsetSec: input.bufferOffsetSec,
    midiOffsetBeats: input.midiOffsetBeats,
  },
})

export function createCloudTimelineRepository(input: {
  projectId: string
  userId: string
  convexClient: ConvexClient
}): TimelineRepository {
  const { projectId, userId, convexClient } = input

  const loadSnapshot = async (): Promise<TimelineSnapshot> => {
    const data = await convexClient.query(convexApi.timeline.fullView, { projectId, userId }) as any
    return {
      projectId,
      tracks: Array.isArray(data?.tracks) ? data.tracks.map(toTrackRow) : [],
      clips: Array.isArray(data?.clips) ? data.clips.map(toClipRow) : [],
    }
  }

  return {
    loadSnapshot,
    createTrack: async (trackInput) => {
      const trackId = await convexClient.mutation(convexApi.tracks.create, {
        projectId,
        userId,
        index: trackInput.index,
        kind: trackInput.kind,
        channelRole: trackInput.channelRole,
      })
      const snapshot = await loadSnapshot()
      const row = snapshot.tracks.find((track) => track.id === String(trackId))
      if (!row) throw new Error('Created cloud track was not found in snapshot.')
      return row
    },
    updateTrack: async (trackInput: UpdateTrackInput) => {
      if (trackInput.volume !== undefined) {
        await convexClient.mutation(convexApi.tracks.setVolume, buildTrackVolumeMutationInput({
          trackId: trackInput.trackId,
          volume: trackInput.volume,
          userId,
        }))
      }
      if (trackInput.muted !== undefined || trackInput.soloed !== undefined) {
        await convexClient.mutation(convexApi.tracks.setMix, buildTrackMixMutationInput({
          trackId: trackInput.trackId,
          userId,
          muted: trackInput.muted,
          soloed: trackInput.soloed,
        }))
      }
      if (trackInput.outputTargetId !== undefined || trackInput.sends !== undefined) {
        await convexClient.mutation(convexApi.tracks.setRouting, buildTrackRoutingMutationInput({
          trackId: trackInput.trackId,
          userId,
          routing: {
            outputTargetId: trackInput.outputTargetId ?? undefined,
            sends: trackInput.sends ?? [],
          },
        }))
      }
      const snapshot = await loadSnapshot()
      return snapshot.tracks.find((track) => track.id === trackInput.trackId) ?? null
    },
    createClip: async (clipInput) => {
      const clipId = await convexClient.mutation(convexApi.clips.create, buildClipCreatePayload({
        projectId,
        userId,
        trackId: clipInput.trackId,
        clip: toClipSnapshot(clipInput),
      }))
      const snapshot = await loadSnapshot()
      const row = snapshot.clips.find((clip) => clip.id === String(clipId))
      if (!row) throw new Error('Created cloud clip was not found in snapshot.')
      return row
    },
    updateClip: async (clipInput: UpdateClipInput) => {
      const needsCurrentTiming = clipInput.trackId !== undefined
        || clipInput.duration !== undefined
        || clipInput.leftPadSec !== undefined
        || clipInput.bufferOffsetSec !== undefined
        || clipInput.midiOffsetBeats !== undefined
      const currentClip = needsCurrentTiming
        ? (await loadSnapshot()).clips.find((clip) => clip.id === clipInput.clipId)
        : null
      if (needsCurrentTiming && !currentClip) return null
      const currentStartSec = currentClip?.startSec ?? clipInput.startSec ?? 0
      const currentDuration = currentClip?.duration ?? clipInput.duration ?? 0
      if (clipInput.trackId !== undefined || clipInput.startSec !== undefined) {
        await convexClient.mutation(convexApi.clips.move, {
          clipId: toCloudClipId(clipInput.clipId),
          userId,
          startSec: clipInput.startSec ?? currentStartSec,
          toTrackId: clipInput.trackId ? toCloudTrackId(clipInput.trackId) : undefined,
        })
      }
      if (clipInput.duration !== undefined || clipInput.leftPadSec !== undefined || clipInput.bufferOffsetSec !== undefined || clipInput.midiOffsetBeats !== undefined) {
        await convexClient.mutation(convexApi.clips.setTiming, {
          clipId: toCloudClipId(clipInput.clipId),
          userId,
          startSec: clipInput.startSec ?? currentStartSec,
          duration: clipInput.duration ?? currentDuration,
          leftPadSec: clipInput.leftPadSec,
          bufferOffsetSec: clipInput.bufferOffsetSec,
          midiOffsetBeats: clipInput.midiOffsetBeats,
        })
      }
      if (clipInput.midi !== undefined) {
        await convexClient.mutation(convexApi.clips.setMidi, {
          clipId: toCloudClipId(clipInput.clipId),
          userId,
          midi: clipInput.midi,
        })
      }
      const snapshot = await loadSnapshot()
      return snapshot.clips.find((clip) => clip.id === clipInput.clipId) ?? null
    },
    moveClips: async (moves) => {
      await Promise.all(moves.map((move) => convexClient.mutation(convexApi.clips.move, {
        clipId: toCloudClipId(move.clipId),
        userId,
        startSec: move.startSec,
        toTrackId: toCloudTrackId(move.trackId),
      })))
    },
    deleteTrack: async (trackId) => {
      await convexClient.mutation(convexApi.tracks.remove, buildTrackDeleteMutationInput({ trackId, userId }))
    },
    deleteClip: async (clipId) => {
      await convexClient.mutation(convexApi.clips.remove, { clipId: toCloudClipId(clipId), userId })
    },
    deleteClips: async (clipIds) => {
      await convexClient.mutation(convexApi.clips.removeMany, buildClipRemoveManyMutationInput({ clipIds, userId }))
    },
  }
}