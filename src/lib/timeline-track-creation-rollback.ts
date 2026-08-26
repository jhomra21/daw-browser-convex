import type { Track } from '@daw-browser/timeline-core/types'
import { isLocalId } from '@daw-browser/shared'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'

type CreatedTrackInsertionInput = {
  projectId: string
  track: Track
  apply: () => Promise<boolean> | boolean
  removeLocalTrack: (trackId: Track['id']) => void
  removeCloudTrack: (track: Track) => Promise<void>
}

export async function applyCreatedTrackInsertion(
  input: CreatedTrackInsertionInput,
): Promise<boolean> {
  let applied = false
  try {
    applied = await input.apply()
  } catch {
    applied = false
  }
  if (applied) return true

  if (isLocalId('project', input.projectId)) {
    await createLocalTimelineRepository(input.projectId).deleteTrack(input.track.id)
    input.removeLocalTrack(input.track.id)
  } else {
    await input.removeCloudTrack(input.track)
  }
  return false
}
