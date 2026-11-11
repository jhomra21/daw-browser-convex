import { getTrackHistoryRef } from './refs'
import type { HistoryEntry, TrackRef } from './types'

export type ClosureTrack = {
  id: string
  historyRef?: string
  groupId?: string | null
  outputTargetId?: string | null
  sends?: readonly { targetId: string }[]
}

export type RoutingPatch = {
  trackId: string
  groupId?: string | null
  outputTargetId?: string | null
  sends?: readonly { targetId: string }[]
}

type Direction = 'undo' | 'redo'

export const applyRoutingPatches = (tracks: readonly ClosureTrack[], patches: readonly RoutingPatch[]): ClosureTrack[] => {
  const patchByTrackId = new Map(patches.map((patch) => [patch.trackId, patch]))
  return tracks.map((track) => {
    const patch = patchByTrackId.get(track.id)
    if (!patch) return track
    return {
      ...track,
      groupId: Object.hasOwn(patch, 'groupId') ? patch.groupId : track.groupId,
      outputTargetId: Object.hasOwn(patch, 'outputTargetId') ? patch.outputTargetId : track.outputTargetId,
      sends: Object.hasOwn(patch, 'sends') ? patch.sends : track.sends,
    }
  })
}

// The track list a history entry leaves behind, limited to what a take binds: existence, group, output and sends.
// It mirrors what `exec.ts` applies for each structural entry. Ids a replay would mint are stood in for by their history ref.
export const projectTrackStructure = (
  entry: HistoryEntry,
  direction: Direction,
  tracks: readonly ClosureTrack[],
): readonly ClosureTrack[] => {
  const idByRef = new Map(tracks.map((track) => [getTrackHistoryRef(track), track.id]))
  const resolve = (ref: TrackRef | undefined) => ref ? idByRef.get(ref) : undefined
  const without = (id: string | undefined) => tracks.filter((track) => track.id !== id)
  const undo = direction === 'undo'

  switch (entry.type) {
    case 'section-edit': {
      const children = undo ? [...entry.data.entries].reverse() : entry.data.entries
      return children.reduce<readonly ClosureTrack[]>((current, child) => projectTrackStructure(child, direction, current), tracks)
    }
    case 'track-create':
      return undo ? without(resolve(entry.data.trackRef) ?? entry.data.currentTrackId) : tracks
    case 'track-clip-create':
      return undo ? without(resolve(entry.data.track.trackRef) ?? entry.data.track.currentTrackId) : tracks
    case 'track-routing': {
      const trackId = resolve(entry.data.trackRef)
      if (!trackId) return tracks
      const routing = undo ? entry.data.from : entry.data.to
      return applyRoutingPatches(tracks, [{
        trackId,
        outputTargetId: resolve(routing.outputTargetRef),
        sends: routing.sends.flatMap((send) => {
          const targetId = resolve(send.targetTrackRef)
          return targetId ? [{ targetId }] : []
        }),
      }])
    }
    case 'track-delete': {
      const { track, inboundRouting = [], recreatedTrackId } = entry.data
      if (!undo) return without(resolve(track.trackRef) ?? recreatedTrackId)
      const restoredId = recreatedTrackId ?? track.trackRef ?? ''
      const resolveRestored = (ref: TrackRef | undefined) => ref === track.trackRef ? restoredId : resolve(ref)
      const bySource = new Map(tracks.map((candidate) => [candidate.id, candidate]))
      const patches = inboundRouting.flatMap((inbound): RoutingPatch[] => {
        const source = bySource.get(resolve(inbound.sourceTrackRef) ?? '')
        if (!source) return []
        const sends = new Map((source.sends ?? []).map((send) => [send.targetId, send]))
        for (const send of inbound.sends) {
          const targetId = resolveRestored(send.targetTrackRef)
          if (targetId) sends.set(targetId, { targetId })
        }
        return [{
          trackId: source.id,
          outputTargetId: resolveRestored(inbound.outputTargetRef) ?? source.outputTargetId,
          sends: [...sends.values()],
        }]
      })
      return [...applyRoutingPatches(tracks, patches), { id: restoredId, historyRef: track.trackRef }]
    }
    case 'track-group': {
      const groupId = resolve(entry.data.groupTrackRef) ?? entry.data.currentGroupTrackId ?? entry.data.groupTrackRef
      const patches = entry.data.childUpdates.flatMap((child): RoutingPatch[] => {
        const trackId = resolve(child.trackRef)
        if (!trackId) return []
        return undo
          ? [{ trackId, groupId: resolve(child.previousGroupRef), outputTargetId: resolve(child.previousOutputTargetRef) }]
          : [{ trackId, groupId, outputTargetId: resolve(child.nextOutputTargetRef) ?? groupId }]
      })
      const patched = applyRoutingPatches(tracks, patches)
      return undo
        ? patched.filter((track) => track.id !== groupId)
        : [...patched, { id: groupId, historyRef: entry.data.groupTrackRef }]
    }
    case 'track-ungroup': {
      const groupId = (undo ? entry.data.sourceGroupTrackId : resolve(entry.data.groupTrackRef) ?? entry.data.currentGroupTrackId) ?? entry.data.groupTrackRef
      const parentGroupId = resolve(entry.data.groupTrack?.groupRef)
      const patches = entry.data.childSnapshots.flatMap((child): RoutingPatch[] => {
        const trackId = resolve(child.trackRef)
        if (!trackId) return []
        return undo
          ? [{
            trackId,
            groupId,
            outputTargetId: child.previousOutputTargetRef === entry.data.groupTrackRef ? groupId : resolve(child.previousOutputTargetRef),
          }]
          : [{ trackId, groupId: parentGroupId, outputTargetId: resolve(child.nextOutputTargetRef) }]
      })
      const patched = applyRoutingPatches(tracks, patches)
      return undo
        ? [...patched, { id: groupId, historyRef: entry.data.groupTrackRef, groupId: parentGroupId }]
        : patched.filter((track) => track.id !== groupId)
    }
    case 'track-reorder':
      return applyRoutingPatches(tracks, entry.data.patches.flatMap((patch): RoutingPatch[] => {
        const trackId = resolve(patch.trackRef)
        if (!trackId) return []
        return [{
          trackId,
          groupId: resolve(undo ? patch.fromGroupRef : patch.toGroupRef) ?? null,
          outputTargetId: resolve(undo ? patch.fromOutputTargetRef : patch.toOutputTargetRef) ?? null,
        }]
      }))
    default:
      return tracks
  }
}
