import { isLocalId, type AutomationEnvelope } from '@daw-browser/shared'
import { deleteLocalAutomationEnvelope, setLocalAutomationEnvelope } from '~/lib/local-automation'
import { publishDurableSharedTimelineOperation } from '~/lib/shared-outbox-publishers'

type AutomationWrites = {
  setEnvelope: (envelope: AutomationEnvelope) => Promise<boolean>
  deleteEnvelope: (envelope: AutomationEnvelope) => Promise<boolean>
}

// Local writes go straight to the local automation rows.
const createLocalAutomationWrites = (projectId: string): AutomationWrites => ({
  setEnvelope: async (envelope) => {
    await setLocalAutomationEnvelope(projectId, envelope)

    return true
  },
  deleteEnvelope: async (envelope) => {
    await deleteLocalAutomationEnvelope(projectId, envelope.targetKey)

    return true
  },
})

// A signed-out user on a cloud project drops the write.
const signedOutAutomationWrites: AutomationWrites = {
  setEnvelope: async () => false,
  deleteEnvelope: async () => false,
}

// Cloud writes are durable shared-outbox operations, replayed until the server accepts them.
const createCloudAutomationWrites = (projectId: string, userId: string): AutomationWrites => ({
  setEnvelope: async (envelope) => {
    await publishDurableSharedTimelineOperation({
      projectId,
      userId,
      operation: {
        kind: 'automation.setEnvelope',
        payload: {
          targetKind: envelope.target.kind,
          trackId: envelope.target.kind === 'track' ? envelope.target.trackId : undefined,
          effectInstanceId: envelope.target.effectInstanceId,
          parameterId: envelope.parameterId,
          enabled: envelope.enabled,
          points: envelope.points,
          updatedAt: envelope.updatedAt,
        },
      },
    })

    return true
  },
  deleteEnvelope: async (envelope) => {
    await publishDurableSharedTimelineOperation({
      projectId,
      userId,
      operation: {
        kind: 'automation.deleteEnvelope',
        payload: {
          targetKind: envelope.target.kind,
          trackId: envelope.target.kind === 'track' ? envelope.target.trackId : undefined,
          effectInstanceId: envelope.target.effectInstanceId,
          parameterId: envelope.parameterId,
        },
      },
    })

    return true
  },
})

export const createTimelineAutomationWriteAdapter = (context: {
  projectId: string
  userId: string | undefined
}): AutomationWrites => {
  if (isLocalId('project', context.projectId)) return createLocalAutomationWrites(context.projectId)

  return context.userId ? createCloudAutomationWrites(context.projectId, context.userId) : signedOutAutomationWrites
}
