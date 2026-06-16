import { api as convexApi } from '../convex/_generated/api'
import { readSharedTimelineOperationTargets, type SharedTimelineOperation } from '@daw-browser/shared'
import type { createAuthenticatedConvexClient } from './convex-auth'

type AuthenticatedConvexClient = Awaited<ReturnType<typeof createAuthenticatedConvexClient>>

type TimelineOperationContext = {
  convex: AuthenticatedConvexClient
  projectId: string
}

export class TimelineOperationTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimelineOperationTargetError'
  }
}

const verifyTimelineOperationTargets = async (
  context: TimelineOperationContext,
  operation: SharedTimelineOperation,
) => {
  const targets = readSharedTimelineOperationTargets(operation)
  const { trackIds, clipIds } = targets

  if (trackIds.size === 0 && clipIds.size === 0) return

  const timeline = await context.convex.query(convexApi.timeline.fullViewAuthed, {
    projectId: context.projectId,
  })
  const projectTrackIds = new Set(timeline.tracks.map((track) => String(track._id)))
  const projectClipIds = new Set(timeline.clips.map((clip) => String(clip._id)))

  for (const trackId of trackIds) {
    if (!projectTrackIds.has(trackId)) {
      throw new TimelineOperationTargetError('Timeline operation references a track outside this project.')
    }
  }
  for (const clipId of clipIds) {
    if (!projectClipIds.has(clipId)) {
      throw new TimelineOperationTargetError('Timeline operation references a clip outside this project.')
    }
  }
}

export const executeTimelineOperation = async (
  context: TimelineOperationContext,
  operation: SharedTimelineOperation,
): Promise<unknown> => {
  await verifyTimelineOperationTargets(context, operation)

  switch (operation.kind) {
    case 'tracks.create':
      return await context.convex.mutation(convexApi.tracks.serverCreate, {
        projectId: context.projectId,
        index: operation.payload.index,
        kind: operation.payload.kind,
        channelRole: operation.payload.channelRole,
        operationId: operation.payload.operationId,
      })
    case 'tracks.lock':
      return await context.convex.mutation(convexApi.tracks.serverLock, {
        trackId: operation.payload.trackId,
      })
    case 'tracks.unlock':
      return await context.convex.mutation(convexApi.tracks.serverUnlock, {
        trackId: operation.payload.trackId,
      })
    case 'clips.create':
      return await context.convex.mutation(convexApi.clips.serverCreate, {
        ...operation.payload,
        projectId: context.projectId,
      })
    case 'clips.createMany':
      return await context.convex.mutation(convexApi.clips.serverCreateMany, {
        items: operation.payload.items.map((item) => ({
          ...item,
          projectId: context.projectId,
        })),
        operationId: operation.payload.operationId,
      })
    case 'clips.removeMany':
      return await context.convex.mutation(convexApi.clips.serverRemoveMany, {
        clipIds: operation.payload.clipIds,
      })
    case 'clips.moveMany':
      return await context.convex.mutation(convexApi.clips.serverMoveMany, {
        moves: operation.payload.moves.map((move) => ({
          clipId: move.clipId,
          startSec: move.startSec,
          toTrackId: move.trackId,
        })),
      })
    case 'clips.setAudioWarp':
      return await context.convex.mutation(convexApi.clips.serverSetAudioWarp, {
        clipId: operation.payload.clipId,
        audioWarp: operation.payload.audioWarp,
      })
    case 'clips.setGain':
      return await context.convex.mutation(convexApi.clips.serverSetGain, {
        clipId: operation.payload.clipId,
        gain: operation.payload.gain,
      })
    case 'tracks.setRouting':
      await context.convex.mutation(convexApi.tracks.serverSetRouting, {
        trackId: operation.payload.trackId,
        outputTargetId: operation.payload.routing.outputTargetId ?? null,
        sends: operation.payload.routing.sends,
      })
      return { status: 'applied' }
    case 'tracks.setVolume':
      await context.convex.mutation(convexApi.tracks.serverSetVolume, {
        trackId: operation.payload.trackId,
        volume: operation.payload.volume,
      })
      return { status: 'applied' }
    case 'tracks.setMix':
      return await context.convex.mutation(convexApi.tracks.serverSetMix, {
        trackId: operation.payload.trackId,
        muted: operation.payload.muted,
        soloed: operation.payload.soloed,
      })
    case 'effects.setEqParams':
      return await context.convex.mutation(convexApi.effects.serverSetEqParams, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        params: operation.payload.params,
      })
    case 'effects.setReverbParams':
      return await context.convex.mutation(convexApi.effects.serverSetReverbParams, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        params: operation.payload.params,
      })
    case 'effects.setSynthParams':
      return await context.convex.mutation(convexApi.effects.serverSetSynthParams, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        params: operation.payload.params,
      })
    case 'effects.setArpeggiatorParams':
      return await context.convex.mutation(convexApi.effects.serverSetArpeggiatorParams, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        params: operation.payload.params,
      })
    case 'effects.setMasterEqParams':
      return await context.convex.mutation(convexApi.effects.serverSetMasterEqParams, {
        projectId: context.projectId,
        params: operation.payload.params,
      })
    case 'effects.setMasterReverbParams':
      return await context.convex.mutation(convexApi.effects.serverSetMasterReverbParams, {
        projectId: context.projectId,
        params: operation.payload.params,
      })
  }
}
