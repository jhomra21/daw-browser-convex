export type TrackTreeNode = {
  id: string
  groupId?: string
}

/** Returns every descendant, excluding the supplied root track. */
export const collectTrackDescendantIds = (
  tracks: readonly TrackTreeNode[],
  rootTrackId: string,
): Set<string> => {
  const childrenByParentId = new Map<string, string[]>()
  for (const track of tracks) {
    if (!track.groupId) continue
    const children = childrenByParentId.get(track.groupId) ?? []
    children.push(track.id)
    childrenByParentId.set(track.groupId, children)
  }

  const descendants = new Set<string>()
  const pending = [...(childrenByParentId.get(rootTrackId) ?? [])]
  while (pending.length > 0) {
    const trackId = pending.pop()
    if (!trackId || descendants.has(trackId)) continue
    descendants.add(trackId)
    pending.push(...(childrenByParentId.get(trackId) ?? []))
  }
  return descendants
}

/** Returns whether any group parent chain loops back to a previously visited track. */
export const hasTrackGroupCycle = (
  tracks: readonly TrackTreeNode[],
): boolean => {
  const parentByTrackId = new Map<string, string>()
  for (const track of tracks) {
    if (track.groupId) parentByTrackId.set(track.id, track.groupId)
  }

  const stateByTrackId = new Map<string, 'visiting' | 'visited'>()
  for (const track of tracks) {
    let currentTrackId: string | undefined = track.id
    const path: string[] = []
    while (currentTrackId) {
      const state = stateByTrackId.get(currentTrackId)
      if (state === 'visiting') return true
      if (state === 'visited') break
      stateByTrackId.set(currentTrackId, 'visiting')
      path.push(currentTrackId)
      currentTrackId = parentByTrackId.get(currentTrackId)
    }
    for (const trackId of path) stateByTrackId.set(trackId, 'visited')
  }
  return false
}
