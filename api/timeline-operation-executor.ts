import { api as convexApi } from '../convex/_generated/api'
import { readSharedTimelineOperationTargets, type SharedTimelineOperation } from '@daw-browser/shared'
import { readControlErrorV1 } from '@daw-browser/control'
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
  name: payload.name,
  index: payload.index,
  kind: payload.kind,
  channelRole: payload.channelRole,
  collapsed: payload.collapsed,
  color: payload.color,
  operationId: payload.operationId,
})

export const buildClipFadesMutationArgs = (
  payload: Extract<SharedTimelineOperation, { kind: 'clips.setFades' }>['payload'],
) => ({
  clipId: payload.clipId,
  fades: payload.fades,
})

export const buildClipMidiMutationArgs = (
  projectId: string,
  payload: Extract<SharedTimelineOperation, { kind: 'clips.setMidi' }>['payload'],
) => ({
  projectId,
  clipId: payload.clipId,
  midi: payload.midi,
  operationId: payload.operationId,
})

export class TimelineOperationTargetError extends Error {
  readonly status: 400 | 403

  constructor(message: string, status: 400 | 403 = 400) {
    super(message)
    this.name = 'TimelineOperationTargetError'
    this.status = status
  }
}

export const classifyBulkClipDeleteError = <Failure>(error: Failure): TimelineOperationTargetError | undefined => {
  const typed = readControlErrorV1(error)

  if (!typed) return undefined

  if (typed.code === 'forbidden' || typed.code === 'authorization') return new TimelineOperationTargetError(typed.message, 403)

  if (typed.code === 'validation' || typed.code === 'not-found' || typed.code === 'limit-exceeded') {
    return new TimelineOperationTargetError(typed.message)
  }

  return undefined
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

// The processor operations that share one convex mutation, which takes the kind as an argument.
const processorEffectByOperation = {
  'effects.setUtilityParams': 'utility',
  'effects.setGateParams': 'gate',
  'effects.setLimiterParams': 'limiter',
  'effects.setSpectralParams': 'spectral',
  'effects.setMasterUtilityParams': 'utility',
  'effects.setMasterGateParams': 'gate',
  'effects.setMasterLimiterParams': 'limiter',
  'effects.setMasterSpectralParams': 'spectral',
} as const

export const executeTimelineOperation = async (
  context: TimelineOperationContext,
  operation: SharedTimelineOperation,
) => {
  if (operation.kind !== 'clips.removeMany') {
    await verifyTimelineOperationTargets(context, operation)
  }

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
      try {
        return await context.convex.mutation(convexApi.clips.serverRemoveMany, {
          projectId: context.projectId,
          clipIds: operation.payload.clipIds,
          operationId: operation.payload.operationId,
        })
      } catch (error) {
        throw classifyBulkClipDeleteError(error) ?? error
      }

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
    case 'clips.setFades':
      return await context.convex.mutation(
        convexApi.clips.serverSetFades,
        buildClipFadesMutationArgs(operation.payload),
      )
    case 'clips.setColor':
      return await context.convex.mutation(convexApi.clips.serverSetColor, operation.payload)
    case 'clips.setMidi':
      return await context.convex.mutation(convexApi.clips.serverSetMidi, {
        ...buildClipMidiMutationArgs(context.projectId, operation.payload),
      })
    case 'clips.setMidiAndTiming':
      return await context.convex.mutation(convexApi.clips.serverSetMidiAndTiming, {
        projectId: context.projectId,
        ...operation.payload,
      })
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
...operation.payload,
      })
    case 'effects.setUtilityParams':
    case 'effects.setGateParams':
    case 'effects.setLimiterParams':
    case 'effects.setSpectralParams':
      return await context.convex.mutation(convexApi.effects.serverSetProcessorParams, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        effect: processorEffectByOperation[operation.kind],
        instanceId: operation.payload.instanceId,
        params: operation.payload.params,
        paramsVersion: operation.payload.paramsVersion,
      })
    case 'effects.setModulationParams':
      return await context.convex.mutation(convexApi.effects.serverSetModulationParams, {
        projectId: context.projectId,
        ...operation.payload,
      })
    case 'effects.setReverbParams':
      return await context.convex.mutation(convexApi.effects.serverSetReverbParams, {
        projectId: context.projectId,
...operation.payload,
      })
    case 'effects.setCompressorParams':
      return await context.convex.mutation(convexApi.effects.serverSetCompressorParams, {
        projectId: context.projectId,
...operation.payload,
      })
    case 'effects.setSaturatorParams':
      return await context.convex.mutation(convexApi.effects.serverSetSaturatorParams, {
        projectId: context.projectId,
...operation.payload,
      })
    case 'effects.setDelayParams':
      return await context.convex.mutation(convexApi.effects.serverSetDelayParams, {
        projectId: context.projectId,
...operation.payload,
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
...operation.payload,
      })
    case 'instruments.setTrackInstrument':
      return await context.convex.mutation(convexApi.effects.serverSetTrackInstrument, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        instrument: operation.payload.instrument,
      })
    case 'instruments.removeTrackInstrument':
      return await context.convex.mutation(convexApi.effects.serverRemoveTrackInstrument, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        operationId: operation.payload.operationId,
      })
    case 'effects.setArpeggiatorParams':
      return await context.convex.mutation(convexApi.effects.serverSetArpeggiatorParams, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        params: operation.payload.params,
      })
    case 'effects.removeArpeggiator':
      return await context.convex.mutation(convexApi.effects.serverRemoveArpeggiator, {
        projectId: context.projectId,
        trackId: operation.payload.trackId,
        operationId: operation.payload.operationId,
      })
    case 'effects.setMasterEqParams':
      return await context.convex.mutation(convexApi.effects.serverSetMasterEqParams, {
        projectId: context.projectId,
...operation.payload,
      })
    case 'effects.setMasterUtilityParams':
    case 'effects.setMasterGateParams':
    case 'effects.setMasterLimiterParams':
    case 'effects.setMasterSpectralParams':
      return await context.convex.mutation(convexApi.effects.serverSetMasterProcessorParams, {
        projectId: context.projectId,
        effect: processorEffectByOperation[operation.kind],
        instanceId: operation.payload.instanceId,
        params: operation.payload.params,
        paramsVersion: operation.payload.paramsVersion,
      })
    case 'effects.setMasterModulationParams':
      return await context.convex.mutation(convexApi.effects.serverSetMasterModulationParams, {
        projectId: context.projectId,
        ...operation.payload,
      })
    case 'effects.setMasterReverbParams':
      return await context.convex.mutation(convexApi.effects.serverSetMasterReverbParams, {
        projectId: context.projectId,
...operation.payload,
      })
    case 'effects.setMasterCompressorParams':
      return await context.convex.mutation(convexApi.effects.serverSetMasterCompressorParams, {
        projectId: context.projectId,
...operation.payload,
      })
    case 'effects.setMasterSaturatorParams':
      return await context.convex.mutation(convexApi.effects.serverSetMasterSaturatorParams, {
        projectId: context.projectId,
...operation.payload,
      })
    case 'effects.setMasterDelayParams':
      return await context.convex.mutation(convexApi.effects.serverSetMasterDelayParams, {
        projectId: context.projectId,
...operation.payload,
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
