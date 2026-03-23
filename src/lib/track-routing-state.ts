import type { TrackRoutingSnapshot } from '~/lib/undo/types'

export function isTrackRoutingEqual(left: TrackRoutingSnapshot, right: TrackRoutingSnapshot) {
  if (left.outputTargetId !== right.outputTargetId) return false
  if (left.sends.length !== right.sends.length) return false
  for (let index = 0; index < left.sends.length; index++) {
    const leftSend = left.sends[index]
    const rightSend = right.sends[index]
    if (!rightSend) return false
    if (leftSend.targetId !== rightSend.targetId) return false
    if (Math.abs(leftSend.amount - rightSend.amount) > 1e-6) return false
  }
  return true
}

export function buildTrackRoutingMutationInput(input: {
  trackId: string
  userId: string
  routing: TrackRoutingSnapshot
}) {
  return {
    trackId: input.trackId as any,
    userId: input.userId,
    outputTargetId: input.routing.outputTargetId ?? null,
    sends: input.routing.sends.map(send => ({
      targetId: send.targetId as any,
      amount: send.amount,
    })),
  }
}
