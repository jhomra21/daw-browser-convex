export type DeleteConflictReason = 'foreign-clips' | 'not-empty' | 'locked'

export function getTrackDeleteConflictMessage(reason: DeleteConflictReason) {
  switch (reason) {
    case 'locked':
      return 'This track cannot be deleted while it is currently recording.'
    case 'foreign-clips':
      return 'This track cannot be deleted yet because it still contains clips owned by another collaborator.'
    case 'not-empty':
      return 'This track cannot be deleted while it still contains clips.'
  }
}

export function getProjectDeleteConflictMessage(
  reasons: Iterable<DeleteConflictReason>,
) {
  const reasonSet = new Set(reasons)
  if (reasonSet.has('locked')) {
    return 'This project cannot be deleted while one of its tracks is currently recording.'
  }
  if (reasonSet.has('foreign-clips')) {
    return 'This project cannot be deleted yet because you still own a track that contains another collaborator\'s clips.'
  }
  if (reasonSet.has('not-empty')) {
    return 'This project cannot be deleted while one of its tracks still contains clips.'
  }
  return 'This project could not be deleted.'
}
