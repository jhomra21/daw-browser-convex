import type { FunctionArgs } from 'convex/server'

import { convexApi } from '~/lib/convex'
import type { TrackId } from '~/types/timeline'

type TrackEffectMutationInput =
  | FunctionArgs<typeof convexApi.effects.setEqParams>
  | FunctionArgs<typeof convexApi.effects.setReverbParams>
  | FunctionArgs<typeof convexApi.effects.setSynthParams>
  | FunctionArgs<typeof convexApi.effects.setArpeggiatorParams>

export function buildTrackEffectQueryArgs(trackId: TrackId) {
  return { trackId }
}

export function buildTrackEffectMutationInput<TInput extends TrackEffectMutationInput>(input: TInput): TInput {
  return input
}
