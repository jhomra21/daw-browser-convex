import type { FunctionArgs } from 'convex/server'

import { convexApi } from '~/lib/convex'
import type { TrackId } from '~/types/timeline'

export function buildTrackCreateMutationInput(input: {
  roomId: string
  userId: string
  index?: number
  kind?: 'audio' | 'instrument'
  channelRole?: 'track' | 'group' | 'return'
}): FunctionArgs<typeof convexApi.tracks.create> {
  return {
    roomId: input.roomId,
    userId: input.userId,
    index: input.index,
    kind: input.kind,
    channelRole: input.channelRole,
  }
}

export function buildTrackDeleteMutationInput(input: {
  trackId: TrackId
  userId: string
}): FunctionArgs<typeof convexApi.tracks.remove> {
  return {
    trackId: input.trackId,
    userId: input.userId,
  }
}

export function buildTrackLockMutationInput(input: {
  trackId: TrackId
  userId: string
}): FunctionArgs<typeof convexApi.tracks.lock> {
  return {
    trackId: input.trackId,
    userId: input.userId,
  }
}

export function buildTrackUnlockMutationInput(input: {
  trackId: TrackId
  userId: string
}): FunctionArgs<typeof convexApi.tracks.unlock> {
  return {
    trackId: input.trackId,
    userId: input.userId,
  }
}

export function buildTrackVolumeMutationInput(input: {
  trackId: TrackId
  volume: number
  userId: string
}): FunctionArgs<typeof convexApi.tracks.setVolume> {
  return {
    trackId: input.trackId,
    volume: input.volume,
    userId: input.userId,
  }
}

export function buildTrackMixMutationInput(input: {
  trackId: TrackId
  userId: string
  muted?: boolean
  soloed?: boolean
}): FunctionArgs<typeof convexApi.tracks.setMix> {
  return {
    trackId: input.trackId,
    userId: input.userId,
    muted: input.muted,
    soloed: input.soloed,
  }
}
