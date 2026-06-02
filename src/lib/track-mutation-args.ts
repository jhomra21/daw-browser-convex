import type { FunctionArgs } from 'convex/server'

import { toCloudTrackId } from '~/lib/cloud-id-args'
import { convexApi } from '~/lib/convex'
import type { TrackId } from '~/types/timeline'

export function buildTrackCreateMutationInput(input: {
  projectId: string
  index?: number
  kind?: 'audio' | 'instrument'
  channelRole?: 'track' | 'group' | 'return'
}): FunctionArgs<typeof convexApi.tracks.create> {
  return {
    projectId: input.projectId,
    index: input.index,
    kind: input.kind,
    channelRole: input.channelRole,
  }
}

export function buildTrackDeleteMutationInput(input: {
  trackId: TrackId
}): FunctionArgs<typeof convexApi.tracks.remove> {
  return {
    trackId: toCloudTrackId(input.trackId),
  }
}

export function buildTrackVolumeMutationInput(input: {
  trackId: TrackId
  volume: number
}): FunctionArgs<typeof convexApi.tracks.setVolume> {
  return {
    trackId: toCloudTrackId(input.trackId),
    volume: input.volume,
  }
}

export function buildTrackMixMutationInput(input: {
  trackId: TrackId
  muted?: boolean
  soloed?: boolean
}): FunctionArgs<typeof convexApi.tracks.setMix> {
  return {
    trackId: toCloudTrackId(input.trackId),
    muted: input.muted,
    soloed: input.soloed,
  }
}
