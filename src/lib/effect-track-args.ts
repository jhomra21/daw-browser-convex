import type { FunctionArgs } from 'convex/server'

import { convexApi } from '~/lib/convex'
import type { Id } from '../../convex/_generated/dataModel'
import type { TrackId } from '~/types/timeline'

type TrackEffectMutationInput =
  | FunctionArgs<typeof convexApi.effects.setEqParams>
  | FunctionArgs<typeof convexApi.effects.setReverbParams>
  | FunctionArgs<typeof convexApi.effects.setSynthParams>
  | FunctionArgs<typeof convexApi.effects.setArpeggiatorParams>

export function buildTrackEffectQueryArgs(trackId: TrackId) {
  return { trackId: trackId as Id<'tracks'> }
}

export function buildTrackEffectMutationInput(input: {
  projectId: string
  userId: string
  trackId: TrackId
  params: unknown
}): any {
  return {
    ...input,
    trackId: input.trackId as Id<'tracks'>,
  }
}
