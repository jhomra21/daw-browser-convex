import { getTrackHistoryRef } from './refs'
import type { HistoryEntry, TrackRef, TrackRoutingHistorySnapshot } from './types'

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

// The entries a history entry applies, in execution order: undo runs a section's children last to first.
export const planStructuralTransition = (entry: HistoryEntry, direction: Direction): readonly HistoryEntry[] => {
  if (entry.type !== 'section-edit') return [entry]

  return direction === 'undo' ? [...entry.data.entries].reverse() : entry.data.entries
}

// The structural operations a history entry applies, by history ref and in execution order. Undo execution and the
// recording guard's projection both interpret this one list; each resolves refs to ids its own way. A patch carries only
// the fields it touches: an absent key leaves the field alone, an undefined value clears it.
type StructuralOp =
  | { kind: 'remove-track'; trackRef: TrackRef | undefined; currentId: string | undefined }
  | {
    kind: 'add-track'
    trackRef: TrackRef | undefined
    currentId: string | undefined
    groupRef?: TrackRef | undefined
    // The track's own output and sends, applied once it exists.
    routing?: TrackRoutingHistorySnapshot
  }
  | {
    kind: 'patch-track'
    trackRef: TrackRef
    groupRef?: TrackRef | undefined
    outputTargetRef?: TrackRef | undefined
    // Applies when outputTargetRef is absent or no longer exists.
    outputFallbackRef?: TrackRef
    sends?: TrackRoutingHistorySnapshot['sends']
    index?: number
  }
  | { kind: 'merge-routing'; trackRef: TrackRef; routing: TrackRoutingHistorySnapshot }

export const structuralOpsOfKind = <Kind extends StructuralOp['kind']>(ops: readonly StructuralOp[], kind: Kind) => (
  ops.filter((op): op is Extract<StructuralOp, { kind: Kind }> => op.kind === kind)
)

export const planStructuralOps = (entry: HistoryEntry, direction: Direction): readonly StructuralOp[] => {
  const undo = direction === 'undo'

  switch (entry.type) {
    case 'section-edit':
      return planStructuralTransition(entry, direction).flatMap((child) => planStructuralOps(child, direction))
    case 'track-create':
      return [{ kind: undo ? 'remove-track' : 'add-track', trackRef: entry.data.trackRef, currentId: entry.data.currentTrackId }]
    case 'track-clip-create': {
      const { trackRef, currentTrackId } = entry.data.track

      return [{ kind: undo ? 'remove-track' : 'add-track', trackRef, currentId: currentTrackId }]
    }

    case 'track-routing': {
      const routing = undo ? entry.data.from : entry.data.to

      return [{ kind: 'patch-track', trackRef: entry.data.trackRef, outputTargetRef: routing.outputTargetRef, sends: routing.sends }]
    }

    case 'track-delete': {
      const { track, inboundRouting = [], recreatedTrackId } = entry.data

      if (!undo) return [{ kind: 'remove-track', trackRef: track.trackRef, currentId: recreatedTrackId }]

      return [
        { kind: 'add-track', trackRef: track.trackRef, currentId: recreatedTrackId, groupRef: track.groupRef, routing: track.routing },
        ...inboundRouting.map((inbound): StructuralOp => ({ kind: 'merge-routing', trackRef: inbound.sourceTrackRef, routing: inbound })),
      ]
    }

    case 'track-group': {
      const { groupTrackRef, currentGroupTrackId, childUpdates } = entry.data

      if (undo) {
        return [
          ...childUpdates.map((child): StructuralOp => ({
            kind: 'patch-track',
            trackRef: child.trackRef,
            groupRef: child.previousGroupRef,
            outputTargetRef: child.previousOutputTargetRef,
          })),
          { kind: 'remove-track', trackRef: groupTrackRef, currentId: currentGroupTrackId },
        ]
      }

      return [
        { kind: 'add-track', trackRef: groupTrackRef, currentId: currentGroupTrackId },
        ...childUpdates.map((child): StructuralOp => ({
          kind: 'patch-track',
          trackRef: child.trackRef,
          groupRef: groupTrackRef,
          outputTargetRef: child.nextOutputTargetRef,
          outputFallbackRef: groupTrackRef,
        })),
      ]
    }

    case 'track-ungroup': {
      const { groupTrackRef, groupTrack, childSnapshots } = entry.data

      if (undo) {
        return [
          { kind: 'add-track', trackRef: groupTrackRef, currentId: entry.data.sourceGroupTrackId, groupRef: groupTrack?.groupRef, routing: groupTrack?.routing },
          ...childSnapshots.map((child): StructuralOp => ({
            kind: 'patch-track',
            trackRef: child.trackRef,
            groupRef: groupTrackRef,
            outputTargetRef: child.previousOutputTargetRef,
          })),
        ]
      }

      return [
        ...childSnapshots.map((child): StructuralOp => ({
          kind: 'patch-track',
          trackRef: child.trackRef,
          groupRef: groupTrack?.groupRef,
          outputTargetRef: child.nextOutputTargetRef,
        })),
        { kind: 'remove-track', trackRef: groupTrackRef, currentId: entry.data.currentGroupTrackId },
      ]
    }

    case 'track-reorder':
      return entry.data.patches.map((patch): StructuralOp => ({
        kind: 'patch-track',
        trackRef: patch.trackRef,
        groupRef: undo ? patch.fromGroupRef : patch.toGroupRef,
        outputTargetRef: undo ? patch.fromOutputTargetRef : patch.toOutputTargetRef,
        index: undo ? patch.fromIndex : patch.toIndex,
      }))
    default:
      return []
  }
}

// Ids a replay would mint are stood in for by their history ref.
const applyStructuralOp = (tracks: readonly ClosureTrack[], op: StructuralOp): readonly ClosureTrack[] => {
  const idByRef = new Map(tracks.map((track) => [getTrackHistoryRef(track), track.id]))
  const resolve = (ref: TrackRef | undefined) => ref ? idByRef.get(ref) : undefined

  switch (op.kind) {
    case 'remove-track': {
      const removedId = resolve(op.trackRef) ?? op.currentId ?? op.trackRef

      return tracks.filter((track) => track.id !== removedId)
    }

    case 'add-track': {
      if (resolve(op.trackRef)) return tracks
      const added = [...tracks, { id: op.currentId ?? op.trackRef ?? '', historyRef: op.trackRef, groupId: resolve(op.groupRef) }]

      if (!op.routing || !op.trackRef) return added

      return applyStructuralOp(added, { kind: 'patch-track', trackRef: op.trackRef, outputTargetRef: op.routing.outputTargetRef, sends: op.routing.sends })
    }

    case 'patch-track': {
      const trackId = resolve(op.trackRef)

      if (!trackId) return tracks
      const patch: RoutingPatch = { trackId }

      if (Object.hasOwn(op, 'groupRef')) patch.groupId = resolve(op.groupRef) ?? null

      if (Object.hasOwn(op, 'outputTargetRef')) patch.outputTargetId = resolve(op.outputTargetRef) ?? resolve(op.outputFallbackRef) ?? null

      if (op.sends) {
        patch.sends = op.sends.flatMap((send) => {
          const targetId = resolve(send.targetTrackRef)

          return targetId ? [{ targetId }] : []
        })
      }

      return applyRoutingPatches(tracks, [patch])
    }

    case 'merge-routing': {
      const source = tracks.find((track) => track.id === resolve(op.trackRef))

      if (!source) return tracks
      const sends = new Map((source.sends ?? []).map((send) => [send.targetId, send]))

      for (const send of op.routing.sends) {
        const targetId = resolve(send.targetTrackRef)

        if (targetId) sends.set(targetId, { targetId })
      }

      return applyRoutingPatches(tracks, [{
        trackId: source.id,
        outputTargetId: resolve(op.routing.outputTargetRef) ?? source.outputTargetId,
        sends: [...sends.values()],
      }])
    }
  }
}

// The track list a history entry leaves behind, limited to what a take binds: existence, group, output and sends.
export const projectTrackStructure = (
  entry: HistoryEntry,
  direction: Direction,
  tracks: readonly ClosureTrack[],
): readonly ClosureTrack[] => planStructuralOps(entry, direction).reduce(applyStructuralOp, tracks)
