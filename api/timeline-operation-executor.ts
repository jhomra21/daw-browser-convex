import { api as convexApi } from '../convex/_generated/api'
import { readSharedTimelineOperationTargets, type SharedTimelineOperation } from '@daw-browser/shared'
import type { createAuthenticatedConvexClient } from './convex-auth'

type AuthenticatedConvexClient = Awaited<ReturnType<typeof createAuthenticatedConvexClient>>

type TimelineOperationContext = {
  convex: AuthenticatedConvexClient
  projectId: string
}

export const buildRestoreChainMutationArgs = (
  projectId: string,
  payload: Extract<SharedTimelineOperation, { kind: 'effects.restoreChain' }>['payload'],
) => ({
  projectId,
  ...payload,
})

export const buildTrackCreateMutationArgs = (
  projectId: string,
  payload: Extract<SharedTimelineOperation, { kind: 'tracks.create' }>['payload'],
) => ({
  projectId,
  index: payload.index,
  kind: payload.kind,
  channelRole: payload.channelRole,
  collapsed: payload.collapsed,
  color: payload.color,
  operationId: payload.operationId,
})

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
      return await context.convex.mutation(
        convexApi.tracks.serverCreate,
        buildTrackCreateMutationArgs(context.projectId, operation.payload),
      )
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
    case 'clips.setTiming':
      return await context.convex.mutation(convexApi.clips.serverSetTiming, operation.payload)
    case 'clips.setTimingAndAudioWarp':
      return await context.convex.mutation(convexApi.clips.serverSetTimingAndAudioWarp, operation.payload)
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
    case 'clips.setColor':
      return await context.convex.mutation(convexApi.clips.serverSetColor, operation.payload)
    case 'tracks.setRouting':
      await context.convex.mutation(convexApi.tracks.serverSetRouting, {
        trackId: operation.payload.trackId,
        outputTargetId: operation.payload.routing.outputTargetId ?? null,
        sends: operation.payload.routing.sends,
      })
      return { status: 'applied' }
    case 'sidechains.setRoute':
      await context.convex.mutation(convexApi.tracks.serverSetSidechainRoute, operation.payload)
      return { status: 'applied' }
    case 'sidechains.removeRoute':
      await context.convex.mutation(convexApi.tracks.serverRemoveSidechainRoute, operation.payload)
      return { status: 'applied' }
    case 'tracks.setGroup':
      await context.convex.mutation(convexApi.tracks.serverSetGroup, {
        trackId: operation.payload.trackId,
        groupId: operation.payload.groupId ?? null,
      })
      return { status: 'applied' }
    case 'tracks.reorderAndGroup':
      return await context.convex.mutation(convexApi.tracks.serverReorderAndGroup, operation.payload)
    case 'tracks.ungroup':
      return await context.convex.mutation(convexApi.tracks.serverUngroup, {
        projectId: context.projectId,
        ...operation.payload,
      })
    case 'tracks.restoreUngroup':
      return await context.convex.mutation(convexApi.tracks.serverRestoreUngroup, {
        projectId: context.projectId,
        ...operation.payload,
      })
    case 'tracks.setCollapsed':
      await context.convex.mutation(convexApi.tracks.serverSetCollapsed, operation.payload)
      return { status: 'applied' }
    case 'tracks.setColor':
      await context.convex.mutation(convexApi.tracks.serverSetColor, {
        trackId: operation.payload.trackId,
        color: operation.payload.color ?? null,
      })
      return { status: 'applied' }
    case 'tracks.setColorCascade':
      return await context.convex.mutation(convexApi.tracks.serverSetColorCascade, operation.payload)
    case 'tracks.applyColorBatch':
      return await context.convex.mutation(convexApi.tracks.serverApplyColorBatch, operation.payload)
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
    case 'mixer.setMasterVolume':
      return await context.convex.mutation(convexApi.projectMixerSettings.setMasterVolume, {
        projectId: context.projectId,
        volume: operation.payload.volume,
      })
    case 'effects.setEqParams':
      return await context.convex.mutation(convexApi.effects.serverSetEqParams, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        instanceId: operation.payload.instanceId,
        params: operation.payload.params,
      })
    case 'effects.setUtilityParams':
    case 'effects.setGateParams':
    case 'effects.setLimiterParams':
      return await context.convex.mutation(convexApi.effects.serverSetProcessorParams, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        effect: operation.kind === 'effects.setUtilityParams' ? 'utility' : operation.kind === 'effects.setGateParams' ? 'gate' : 'limiter',
        instanceId: operation.payload.instanceId,
        params: operation.payload.params,
      })
    case 'effects.setModulationParams':
      return await context.convex.mutation(convexApi.effects.serverSetModulationParams, {
        projectId: context.projectId,
        ...operation.payload,
      })
    case 'effects.setReverbParams':
      return await context.convex.mutation(convexApi.effects.serverSetReverbParams, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        instanceId: operation.payload.instanceId,
        params: operation.payload.params,
      })
    case 'effects.setCompressorParams':
      return await context.convex.mutation(convexApi.effects.serverSetCompressorParams, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        instanceId: operation.payload.instanceId,
        params: operation.payload.params,
      })
    case 'effects.setSaturatorParams':
      return await context.convex.mutation(convexApi.effects.serverSetSaturatorParams, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        instanceId: operation.payload.instanceId,
        params: operation.payload.params,
      })
    case 'effects.setSpectralParams':
      return await context.convex.mutation(convexApi.effects.serverSetProcessorParams, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        effect: 'spectral',
        instanceId: operation.payload.instanceId,
        params: operation.payload.params,
      })
    case 'effects.setDelayParams':
      return await context.convex.mutation(convexApi.effects.serverSetDelayParams, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        instanceId: operation.payload.instanceId,
        params: operation.payload.params,
      })
    case 'effects.reorderAudioChain':
      return await context.convex.mutation(convexApi.effects.serverReorderAudioEffects, {
        projectId: context.projectId,
        targetType: 'track',
        trackId: operation.payload.trackId,
        order: operation.payload.order,
      })
    case 'effects.restoreChain':
      return await context.convex.mutation(
        convexApi.effects.serverRestoreChain,
        buildRestoreChainMutationArgs(context.projectId, operation.payload),
      )
    case 'effects.removeAudioEffect':
      return await context.convex.mutation(convexApi.effects.serverRemoveAudioEffect, {
        projectId: context.projectId,
        targetType: operation.payload.targetType,
        trackId: operation.payload.targetType === 'track' ? operation.payload.trackId : undefined,
        effect: operation.payload.effect,
        instanceId: operation.payload.instanceId,
      })
    case 'effects.setSynthParams':
      return await context.convex.mutation(convexApi.effects.serverSetSynthParams, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        instanceId: operation.payload.instanceId,
        params: operation.payload.params,
      })
    case 'instruments.setTrackInstrument':
      return await context.convex.mutation(convexApi.effects.serverSetTrackInstrument, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        instrument: operation.payload.instrument,
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
        instanceId: operation.payload.instanceId,
        params: operation.payload.params,
      })
    case 'effects.setMasterUtilityParams':
    case 'effects.setMasterGateParams':
    case 'effects.setMasterLimiterParams':
      return await context.convex.mutation(convexApi.effects.serverSetMasterProcessorParams, {
        projectId: context.projectId,
        effect: operation.kind === 'effects.setMasterUtilityParams' ? 'utility' : operation.kind === 'effects.setMasterGateParams' ? 'gate' : 'limiter',
        instanceId: operation.payload.instanceId,
        params: operation.payload.params,
      })
    case 'effects.setMasterModulationParams':
      return await context.convex.mutation(convexApi.effects.serverSetMasterModulationParams, {
        projectId: context.projectId,
        ...operation.payload,
      })
    case 'effects.setMasterReverbParams':
      return await context.convex.mutation(convexApi.effects.serverSetMasterReverbParams, {
        projectId: context.projectId,
        instanceId: operation.payload.instanceId,
        params: operation.payload.params,
      })
    case 'effects.setMasterCompressorParams':
      return await context.convex.mutation(convexApi.effects.serverSetMasterCompressorParams, {
        projectId: context.projectId,
        instanceId: operation.payload.instanceId,
        params: operation.payload.params,
      })
    case 'effects.setMasterSaturatorParams':
      return await context.convex.mutation(convexApi.effects.serverSetMasterSaturatorParams, {
        projectId: context.projectId,
        instanceId: operation.payload.instanceId,
        params: operation.payload.params,
      })
    case 'effects.setMasterDelayParams':
      return await context.convex.mutation(convexApi.effects.serverSetMasterDelayParams, {
        projectId: context.projectId,
        instanceId: operation.payload.instanceId,
        params: operation.payload.params,
      })
    case 'effects.setMasterSpectralParams':
      return await context.convex.mutation(convexApi.effects.serverSetMasterProcessorParams, {
        projectId: context.projectId,
        effect: 'spectral',
        instanceId: operation.payload.instanceId,
        params: operation.payload.params,
      })
    case 'effects.reorderMasterAudioChain':
      return await context.convex.mutation(convexApi.effects.serverReorderAudioEffects, {
        projectId: context.projectId,
        targetType: 'master',
        order: operation.payload.order,
      })
    case 'automation.setEnvelope':
      return await context.convex.mutation(convexApi.automation.serverSetEnvelope, {
        projectId: context.projectId,
        targetKind: operation.payload.targetKind,
        trackId: operation.payload.trackId,
        effectInstanceId: operation.payload.effectInstanceId,
        parameterId: operation.payload.parameterId,
        enabled: operation.payload.enabled,
        points: operation.payload.points,
        updatedAt: operation.payload.updatedAt,
      })
    case 'automation.deleteEnvelope':
      return await context.convex.mutation(convexApi.automation.serverDeleteEnvelope, {
        projectId: context.projectId,
        targetKind: operation.payload.targetKind,
        trackId: operation.payload.trackId,
        effectInstanceId: operation.payload.effectInstanceId,
        parameterId: operation.payload.parameterId,
      })
  }
}
