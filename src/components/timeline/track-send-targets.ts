import { getTrackChannelRole } from '@daw-browser/timeline-core/track-routing'
import type { Track } from '@daw-browser/timeline-core/types'

export const getReturnSendTargets = (tracks: readonly Track[]) =>
  tracks.filter((track) => getTrackChannelRole(track) === 'return')

export const resolveSendTargetId = (
  actualTargetId: string,
  selectedTargetId: string | undefined,
  returnTargets: readonly Track[],
) => {
  const returnTargetIds = new Set(returnTargets.map((track) => track.id))
  if (selectedTargetId && returnTargetIds.has(selectedTargetId)) {
    return selectedTargetId
  }
  return returnTargetIds.has(actualTargetId) ? actualTargetId : ''
}
