import { isLocalId, isV2AutomationTargetKey, type AutomationEnvelope } from '@daw-browser/shared'
import { deleteLocalAutomationEnvelope, setLocalAutomationEnvelope } from '~/lib/local-automation'
import { publishDurableSharedTimelineOperation } from '~/lib/shared-outbox'

export const createTimelineAutomationWriteAdapter = (context: {
  projectId: string
  userId: string | undefined
}) => ({
  setEnvelope: async (envelope: AutomationEnvelope) => {
    if (isLocalId('project', context.projectId)) {
      await setLocalAutomationEnvelope(context.projectId, envelope)
      return true
    }

    if (!context.userId) return false

    await publishDurableSharedTimelineOperation({
      projectId: context.projectId,
      userId: context.userId,
      operation: {
        kind: 'automation.setEnvelope',
        payload: {
          targetKind: envelope.target.kind,
          trackId: envelope.target.kind === 'track' ? envelope.target.trackId : undefined,
          effectInstanceId: envelope.target.effectInstanceId,
          existingEnvelopeId: isV2AutomationTargetKey(envelope.targetKey) ? undefined : envelope.id,
          existingOpaqueIdentity: isV2AutomationTargetKey(envelope.targetKey) ? undefined : envelope.targetKey,
          parameterId: envelope.parameterId,
          enabled: envelope.enabled,
          points: envelope.points,
          updatedAt: envelope.updatedAt,
        },
      },
    })

    return true
  },

  deleteEnvelope: async (envelope: AutomationEnvelope) => {
    if (isLocalId('project', context.projectId)) {
      await deleteLocalAutomationEnvelope(context.projectId, envelope.targetKey)
      return true
    }

    if (!context.userId) return false

    await publishDurableSharedTimelineOperation({
      projectId: context.projectId,
      userId: context.userId,
      operation: {
        kind: 'automation.deleteEnvelope',
        payload: {
          targetKind: envelope.target.kind,
          trackId: envelope.target.kind === 'track' ? envelope.target.trackId : undefined,
          effectInstanceId: envelope.target.effectInstanceId,
          existingEnvelopeId: isV2AutomationTargetKey(envelope.targetKey) ? undefined : envelope.id,
          existingOpaqueIdentity: isV2AutomationTargetKey(envelope.targetKey) ? undefined : envelope.targetKey,
          parameterId: envelope.parameterId,
        },
      },
    })

    return true
  },
})
