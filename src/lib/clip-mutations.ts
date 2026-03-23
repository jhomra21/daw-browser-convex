type ConvexClientType = typeof import('~/lib/convex').convexClient

type ConvexApiType = typeof import('~/lib/convex').convexApi

export type PersistClipTimingInput = {
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
  await convexClient.mutation(convexApi.clips.setTiming, {
    clipId: input.clipId as any,
    userId,
    startSec: input.startSec,
    duration: input.duration,
    leftPadSec: input.leftPadSec,
    bufferOffsetSec: input.bufferOffsetSec,
    midiOffsetBeats: input.midiOffsetBeats,
  })
}
