import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import { z } from 'zod'

const OUTBOX_SETTLEMENT_CHANNEL = 'shared-outbox-settlement:'

const settlementWakeSchema = z.object({ projectId: z.string(), userId: z.string() })
const settlementListeners = new Map<string, Set<() => void>>()
const settlementChannels = new Map<string, BroadcastChannel>()

const settlementScope = (projectId: string, userId: string) => `${projectId}\u0000${userId}`

export const subscribeToSharedOutboxSettlements = (
  projectId: string,
  userId: string,
  listener: () => void,
) => {
  const scope = settlementScope(projectId, userId)
  const listeners = settlementListeners.get(scope) ?? new Set<() => void>()
  listeners.add(listener)
  settlementListeners.set(scope, listeners)
  let channel = settlementChannels.get(scope)

  if (!channel) {
    channel = new BroadcastChannel(`${OUTBOX_SETTLEMENT_CHANNEL}${encodeURIComponent(projectId)}:${encodeURIComponent(userId)}`)
    channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      const wake = settlementWakeSchema.safeParse(event.data)

      if (wake.success && wake.data.projectId === projectId && wake.data.userId === userId) {
        for (const observer of settlementListeners.get(scope) ?? []) observer()
      }
    })
    settlementChannels.set(scope, channel)
  }

  return () => {
    listeners.delete(listener)

    if (listeners.size > 0) return
    settlementListeners.delete(scope)
    settlementChannels.get(scope)?.close()
    settlementChannels.delete(scope)
  }
}

export const wakeSettlementObservers = (projectId: string, userId: string) => {
  for (const listener of settlementListeners.get(settlementScope(projectId, userId)) ?? []) listener()
  notifyLocalProjectChanged(projectId)
  const message = { projectId, userId }
  const channelName = `${OUTBOX_SETTLEMENT_CHANNEL}${encodeURIComponent(projectId)}:${encodeURIComponent(userId)}`
  const channel = settlementChannels.get(settlementScope(projectId, userId))

  if (channel) channel.postMessage(message)
  else {
    const transientChannel = new BroadcastChannel(channelName)
    transientChannel.postMessage(message)
    transientChannel.close()
  }
}
