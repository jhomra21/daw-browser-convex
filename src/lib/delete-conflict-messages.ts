type DeleteConflictReason = 'foreign-clips' | 'not-empty' | 'locked'

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
