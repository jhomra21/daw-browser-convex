import type { FunctionArgs } from 'convex/server'

import { normalizeClipStartSec } from '~/lib/clip-timing'
import { convexApi } from '~/lib/convex'

export function buildClipMoveMutationInput(input: {
  clipId: string
  userId: string
  startSec: number
  toTrackId?: string
}): FunctionArgs<typeof convexApi.clips.move> {
  return {
    clipId: input.clipId as any,
    userId: input.userId,
    startSec: normalizeClipStartSec(input.startSec),
    toTrackId: input.toTrackId as any,
  }
}

export function buildClipRemoveManyMutationInput(input: {
  clipIds: string[]
  userId: string
}): FunctionArgs<typeof convexApi.clips.removeMany> {
  return {
    clipIds: input.clipIds as any,
    userId: input.userId,
  }
}
