import { normalizeClipTimingPatch } from '~/lib/clip-timing'
import { toCloudClipId } from '~/lib/cloud-id-args'

type ConvexClientType = typeof import('~/lib/convex').convexClient

type ConvexApiType = typeof import('~/lib/convex').convexApi

type PersistClipTimingInput = {
  clipId: string
  startSec: number
  duration: number
  leftPadSec?: number
  bufferOffsetSec?: number
  midiOffsetBeats?: number
}

export async function persistClipTiming(
  convexClient: ConvexClientType,
  convexApi: ConvexApiType,
  userId: string,
  input: PersistClipTimingInput,
) {
  const timing = normalizeClipTimingPatch(input)
  const result = await convexClient.mutation(convexApi.clips.setTiming, {
    clipId: toCloudClipId(input.clipId),
    userId,
    startSec: timing.startSec,
    duration: timing.duration,
    leftPadSec: timing.leftPadSec,
    bufferOffsetSec: timing.bufferOffsetSec,
    midiOffsetBeats: timing.midiOffsetBeats,
  })
  return result?.status === 'applied'
}
