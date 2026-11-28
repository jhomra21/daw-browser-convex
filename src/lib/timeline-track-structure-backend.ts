import { assertDefined, isLocalId } from '@daw-browser/shared'
import type { Track } from '@daw-browser/timeline-core/types'
import { assertAppliedSharedTimelineOperationResult, publishSharedTimelineOperation } from '~/lib/shared-timeline-operations-api'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import type { ReorderAndGroupTrackInput } from '~/lib/timeline-repository/types'

type TrackPatch = Pick<Track, 'groupId' | 'outputTargetId' | 'collapsed' | 'color'>

type TrackStructureBackend = {
  patchTrack: (trackId: Track['id'], patch: TrackPatch, currentSends: Track['sends']) => Promise<void>
  setClipColor: (clipId: string, color: string) => Promise<void>
  reorderAndGroup: (updates: ReorderAndGroupTrackInput[]) => Promise<void>
  // Removes a track that was created for an operation that did not go through.
  discardTrack: (track: Track) => Promise<void>
}

// Local writes are awaited rows in the project's IndexedDB; only the fields present in the patch are written.
const createLocalTrackStructureBackend = (projectId: string): TrackStructureBackend => {
  const repository = createLocalTimelineRepository(projectId)

  return {
    patchTrack: async (trackId, patch) => {
      await repository.updateTrack({
        trackId,
        groupId: Object.hasOwn(patch, 'groupId') ? patch.groupId ?? null : undefined,
        outputTargetId: Object.hasOwn(patch, 'outputTargetId') ? patch.outputTargetId ?? null : undefined,
        collapsed: Object.hasOwn(patch, 'collapsed') ? patch.collapsed : undefined,
        color: Object.hasOwn(patch, 'color') ? patch.color ?? null : undefined,
      })
    },
    setClipColor: async (clipId, color) => {
      assertDefined(await repository.updateClip({ clipId, color }), 'Failed to assign track color to clip')
    },
    reorderAndGroup: (updates) => repository.reorderAndGroup(updates),
    discardTrack: (track) => repository.deleteTrack(track.id),
  }
}

// Cloud writes are direct shared-timeline requests that are awaited (not outbox operations), one request per patched field.
const createCloudTrackStructureBackend = (
  projectId: string,
  removeCloudTrack: (track: Track) => Promise<void>,
): TrackStructureBackend => ({
  patchTrack: async (trackId, patch, currentSends) => {
    if (Object.hasOwn(patch, 'groupId')) {
      await publishSharedTimelineOperation(projectId, { kind: 'tracks.setGroup', payload: { trackId, groupId: patch.groupId ?? null } })
    }

    if (Object.hasOwn(patch, 'outputTargetId')) {
      await publishSharedTimelineOperation(projectId, { kind: 'tracks.setRouting', payload: { trackId, routing: { outputTargetId: patch.outputTargetId, sends: currentSends } } })
    }

    if (Object.hasOwn(patch, 'collapsed') && patch.collapsed !== undefined) {
      await publishSharedTimelineOperation(projectId, { kind: 'tracks.setCollapsed', payload: { trackId, collapsed: patch.collapsed } })
    }

    if (Object.hasOwn(patch, 'color')) {
      await publishSharedTimelineOperation(projectId, { kind: 'tracks.setColor', payload: { trackId, color: patch.color } })
    }
  },
  setClipColor: async (clipId, color) => {
    assertAppliedSharedTimelineOperationResult(await publishSharedTimelineOperation(projectId, { kind: 'clips.setColor', payload: { clipId, color } }))
  },
  reorderAndGroup: async (updates) => {
    assertAppliedSharedTimelineOperationResult(await publishSharedTimelineOperation(projectId, {
      kind: 'tracks.reorderAndGroup',
      payload: { updates },
    }))
  },
  discardTrack: removeCloudTrack,
})

export const createTimelineTrackStructureBackend = (
  projectId: string,
  removeCloudTrack: (track: Track) => Promise<void>,
): TrackStructureBackend => isLocalId('project', projectId)
  ? createLocalTrackStructureBackend(projectId)
  : createCloudTrackStructureBackend(projectId, removeCloudTrack)
