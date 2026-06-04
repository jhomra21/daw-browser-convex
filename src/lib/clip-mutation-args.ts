import type { FunctionArgs } from 'convex/server'

import { normalizeClipStartSec } from '~/lib/clip-timing'
import { toCloudClipId, toCloudTrackIdOptional } from '~/lib/cloud-id-args'
import { convexApi } from '~/lib/convex'

export function buildClipMoveMutationInput(input: {
  clipId: string
  startSec: number
  toTrackId?: string
}): FunctionArgs<typeof convexApi.clips.move> {
  return {
    clipId: toCloudClipId(input.clipId),
    startSec: normalizeClipStartSec(input.startSec),
    toTrackId: toCloudTrackIdOptional(input.toTrackId),
  }
}

export function buildClipMoveManyMutationInput(input: {
  moves: Array<{
    clipId: string
    startSec: number
    toTrackId?: string
  }>
}): FunctionArgs<typeof convexApi.clips.moveMany> {
  return {
    moves: input.moves.map((move) => ({
      clipId: toCloudClipId(move.clipId),
      startSec: normalizeClipStartSec(move.startSec),
      toTrackId: toCloudTrackIdOptional(move.toTrackId),
    })),
  }
}

export function buildClipRemoveManyMutationInput(input: {
  clipIds: string[]
}): FunctionArgs<typeof convexApi.clips.removeMany> {
  return {
    clipIds: input.clipIds.map(toCloudClipId),
  }
}
