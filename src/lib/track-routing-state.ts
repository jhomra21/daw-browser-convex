import type { FunctionArgs } from 'convex/server'
import { toCloudTrackId } from '~/lib/cloud-id-args'
import { convexApi } from '~/lib/convex'
import type { TrackRoutingSnapshot } from '~/lib/undo/types'
import type { TrackId } from '@daw-browser/timeline-core/types'

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
  trackId: TrackId
  routing: TrackRoutingSnapshot
}): FunctionArgs<typeof convexApi.tracks.setRouting> {
  return {
    trackId: toCloudTrackId(input.trackId),
    outputTargetId: input.routing.outputTargetId ? toCloudTrackId(input.routing.outputTargetId) : null,
    sends: input.routing.sends.map(send => ({
      targetId: toCloudTrackId(send.targetId),
      amount: send.amount,
    })),
  }
}
