import { collectTrackDescendantIds } from '@daw-browser/shared'

type TrackDeletionTrackV1 = {
  id: string
  index: number
  groupId?: string
  outputTargetId?: string
  sends: readonly { targetTrackId: string }[]
}

type TrackDeletionSidechainV1 = {
  sourceTrackId: string
  targetTrackId: string
}

export const collectDeletedTrackIdsV1 = (
  tracks: readonly TrackDeletionTrackV1[],
  rootTrackId: string,
) => new Set([
  rootTrackId,
  ...collectTrackDescendantIds(tracks, rootTrackId),
])

export const collectTrackDeletionAffectedIdsV1 = (
  tracks: readonly TrackDeletionTrackV1[],
  sidechains: readonly TrackDeletionSidechainV1[],
  rootTrackId: string,
) => {
  const deletedTrackIds = collectDeletedTrackIdsV1(tracks, rootTrackId)
  const affectedTrackIds = new Set(deletedTrackIds)
  const survivors = tracks
    .filter((track) => !deletedTrackIds.has(track.id))
    .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))

  for (const [index, track] of survivors.entries()) {
    if (
      track.index !== index
      || deletedTrackIds.has(track.groupId ?? '')
      || deletedTrackIds.has(track.outputTargetId ?? '')
      || track.sends.some((send) => deletedTrackIds.has(send.targetTrackId))
    ) {
      affectedTrackIds.add(track.id)
    }
  }
  for (const sidechain of sidechains) {
    if (!deletedTrackIds.has(sidechain.sourceTrackId) && deletedTrackIds.has(sidechain.targetTrackId)) {
      affectedTrackIds.add(sidechain.sourceTrackId)
    }
    if (!deletedTrackIds.has(sidechain.targetTrackId) && deletedTrackIds.has(sidechain.sourceTrackId)) {
      affectedTrackIds.add(sidechain.targetTrackId)
    }
  }
  return affectedTrackIds
}
