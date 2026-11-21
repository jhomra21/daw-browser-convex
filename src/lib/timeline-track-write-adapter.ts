import { isJsonObject, isLocalId, type JsonValue } from '@daw-browser/shared'
import { publishDurableSharedTimelineOperation } from '~/lib/shared-outbox-publishers'
import type { UpdateTrackInput } from '~/lib/timeline-repository/types'
import type { TrackRouting } from '@daw-browser/timeline-core/types'
import { z } from 'zod'

type TrackWriteContext = {
  projectId: string
  userId: string
  writeLocalTrack: (input: UpdateTrackInput) => Promise<void>
}

type TrackMixWriteResult = { status?: 'access-denied' | 'applied' | 'noop' | 'not-found' }

const readTrackMixWriteResult = (value: JsonValue): TrackMixWriteResult => {
  if (!isJsonObject(value)) return { status: 'applied' }
  const status = value.status

  if (status === 'access-denied' || status === 'applied' || status === 'noop' || status === 'not-found') {
    return { status }
  }

  return { status: 'applied' }
}

type TrackWrites = {
  setRouting: (trackId: string, routing: TrackRouting) => Promise<void | JsonValue>
  setVolume: (trackId: string, volume: number) => Promise<void | JsonValue>
  setMix: (trackId: string, patch: { muted?: boolean; soloed?: boolean }) => Promise<TrackMixWriteResult | undefined>
}

// Local writes are handed to the caller's local write queue (batched and flushed with the project's pending writes).
const createLocalTrackWrites = (writeLocalTrack: TrackWriteContext['writeLocalTrack']): TrackWrites => ({
  setRouting: (trackId, routing) => writeLocalTrack({
    trackId,
    outputTargetId: routing.outputTargetId ?? null,
    sends: routing.sends ?? [],
  }),
  setVolume: (trackId, volume) => writeLocalTrack({ trackId, volume }),
  setMix: async (trackId, patch) => {
    await writeLocalTrack({ trackId, muted: patch.muted, soloed: patch.soloed })

    return { status: 'applied' }
  },
})

// A signed-out user on a cloud project drops the write.
const signedOutTrackWrites: TrackWrites = {
  setRouting: async () => undefined,
  setVolume: async () => undefined,
  setMix: async () => undefined,
}

// Cloud writes are durable shared-outbox operations, replayed until the server accepts them.
const createCloudTrackWrites = (projectId: string, userId: string): TrackWrites => {
  const publish = async (operation: Parameters<typeof publishDurableSharedTimelineOperation>[0]['operation']) =>
    z.json().parse(await publishDurableSharedTimelineOperation({
      projectId,
      userId,
      operation,
      queuedResult: { status: 'applied' },
    }))

  return {
    setRouting: (trackId, routing) => publish({
      kind: 'tracks.setRouting',
      payload: {
        trackId,
        routing: {
          sends: routing.sends ?? [],
          outputTargetId: routing.outputTargetId,
        },
      },
    }),
    setVolume: (trackId, volume) => publish({ kind: 'tracks.setVolume', payload: { trackId, volume } }),
    setMix: async (trackId, patch) => readTrackMixWriteResult(await publish({
      kind: 'tracks.setMix',
      payload: { trackId, muted: patch.muted, soloed: patch.soloed },
    })),
  }
}

// The backend is chosen once here; the no-op mix patch check is shared.
export const createTimelineTrackWriteAdapter = (context: TrackWriteContext): TrackWrites => {
  const writes = isLocalId('project', context.projectId)
    ? createLocalTrackWrites(context.writeLocalTrack)
    : context.userId ? createCloudTrackWrites(context.projectId, context.userId) : signedOutTrackWrites

  return {
    ...writes,
    setMix: async (trackId, patch) => patch.muted === undefined && patch.soloed === undefined
      ? undefined
      : await writes.setMix(trackId, patch),
  }
}
