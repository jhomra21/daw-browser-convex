import { createEffect } from 'solid-js'
import type { Accessor } from 'solid-js'

import type { AudioEngine } from '~/lib/audio-engine'
import {
  buildOptimisticGrantScopeKey,
  readOptimisticGrantScope,
  type OptimisticGrantScope,
} from '~/lib/optimistic-grant-scope'
import { loadHistory, saveHistory, type LocalMixPatch } from '~/lib/timeline-storage'
import { createUndoManager, type UndoManager } from '~/lib/undo/manager'
import type { HistoryEntry } from '~/lib/undo/types'
import { execRedo, execUndo } from '~/lib/undo/exec'
import type { Track, TrackRouting } from '~/types/timeline'

type TimelineHistoryActions = Parameters<typeof execUndo>[1]['actions']

type UseTimelineHistoryOptions = {
  roomId: Accessor<string>
  userId: Accessor<string>
  getTracks: () => Track[]
  convexClient: typeof import('~/lib/convex').convexClient
  convexApi: typeof import('~/lib/convex').convexApi
  audioEngine: AudioEngine
  ensureClipBuffer?: (clipId: string, sampleUrl?: string) => Promise<void>
  grantTrackWrite: (trackId: Track['id'] | null | undefined, scope?: OptimisticGrantScope | null) => void
  grantClipWrite: (clipId: string | null | undefined, scope?: OptimisticGrantScope | null) => void
  persistLocalMix: (roomId: string, trackId: Track['id'], patch: LocalMixPatch) => void
  getActions: () => TimelineHistoryActions
}

type UseTimelineHistoryReturn = {
  pushHistory: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  handleUndo: () => void
  handleRedo: () => void
}

type HistoryScopeContext = {
  manager: UndoManager
  tracks: Track[]
  pendingRun: Promise<void>
}

const cloneClip = (clip: Track['clips'][number]): Track['clips'][number] => ({
  ...clip,
  midi: clip.midi
    ? {
        ...clip.midi,
        notes: clip.midi.notes.map((note) => ({ ...note })),
      }
    : undefined,
})

const cloneTrack = (track: Track): Track => ({
  ...track,
  clips: track.clips.map(cloneClip),
  sends: track.sends?.map((send) => ({ ...send })),
})

const cloneTracks = (tracks: Track[]) => tracks.map(cloneTrack)

const insertTrackIntoModel = (tracks: Track[], track: Track, index: number) => {
  const existingIndex = tracks.findIndex((entry) => entry.id === track.id)
  if (existingIndex >= 0) {
    tracks.splice(existingIndex, 1)
  }
  const insertIndex = Math.max(0, Math.min(index, tracks.length))
  tracks.splice(insertIndex, 0, cloneTrack(track))
}

const removeTrackFromModel = (tracks: Track[], trackId: Track['id']) => {
  const index = tracks.findIndex((track) => track.id === trackId)
  if (index >= 0) {
    tracks.splice(index, 1)
  }
}

const insertClipIntoModel = (tracks: Track[], trackId: string, clip: Track['clips'][number]) => {
  const track = tracks.find((entry) => entry.id === trackId)
  if (!track) return
  const nextClip = cloneClip(clip)
  const existingIndex = track.clips.findIndex((entry) => entry.id === nextClip.id)
  if (existingIndex >= 0) {
    track.clips.splice(existingIndex, 1, nextClip)
    return
  }
  track.clips.push(nextClip)
}

const removeClipsFromModel = (tracks: Track[], clipIds: Iterable<string>) => {
  const removedIds = new Set(clipIds)
  if (removedIds.size === 0) return
  for (const track of tracks) {
    track.clips = track.clips.filter((clip) => !removedIds.has(clip.id))
  }
}

const commitClipMovesInModel = (
  tracks: Track[],
  moves: Array<{ clipId: string; trackId: string; startSec: number }>,
) => {
  const moveByClipId = new Map(moves.map((move) => [move.clipId, move]))
  const movedClips = new Map<string, Track['clips'][number]>()

  for (const track of tracks) {
    const remaining: Track['clips'] = []
    for (const clip of track.clips) {
      const move = moveByClipId.get(clip.id)
      if (!move) {
        remaining.push(clip)
        continue
      }
      movedClips.set(clip.id, {
        ...cloneClip(clip),
        startSec: move.startSec,
      })
    }
    track.clips = remaining
  }

  for (const move of moves) {
    const track = tracks.find((entry) => entry.id === move.trackId)
    const clip = movedClips.get(move.clipId)
    if (!track || !clip) continue
    track.clips.push(clip)
  }
}

const commitClipTimingInModel = (
  tracks: Track[],
  clipId: string,
  patch: { startSec: number; duration: number; leftPadSec?: number; bufferOffsetSec?: number; midiOffsetBeats?: number },
) => {
  for (const track of tracks) {
    const clip = track.clips.find((entry) => entry.id === clipId)
    if (!clip) continue
    clip.startSec = patch.startSec
    clip.duration = patch.duration
    clip.leftPadSec = patch.leftPadSec
    clip.bufferOffsetSec = patch.bufferOffsetSec
    clip.midiOffsetBeats = patch.midiOffsetBeats
    return
  }
}

const applyTrackVolumeInModel = (tracks: Track[], trackId: string, volume: number) => {
  const track = tracks.find((entry) => entry.id === trackId)
  if (track) {
    track.volume = volume
  }
}

const applyTrackMixStateInModel = (
  tracks: Track[],
  trackId: string,
  patch: { muted?: boolean; soloed?: boolean },
) => {
  const track = tracks.find((entry) => entry.id === trackId)
  if (!track) return
  if (typeof patch.muted === 'boolean') {
    track.muted = patch.muted
  }
  if (typeof patch.soloed === 'boolean') {
    track.soloed = patch.soloed
  }
}

const applyTrackRoutingInModel = (tracks: Track[], trackId: string, routing: TrackRouting) => {
  const track = tracks.find((entry) => entry.id === trackId)
  if (!track) return
  track.sends = routing.sends?.map((send) => ({ ...send })) ?? []
  track.outputTargetId = routing.outputTargetId
}

export function useTimelineHistory(
  options: UseTimelineHistoryOptions,
): UseTimelineHistoryReturn {
  const scopeContexts = new Map<string, HistoryScopeContext>()

  const readCurrentScope = () => readOptimisticGrantScope({
    roomId: options.roomId(),
    userId: options.userId(),
  })

  const readCurrentScopeKey = () => {
    const scope = readCurrentScope()
    return scope ? buildOptimisticGrantScopeKey(scope) : null
  }

  const getScopeContext = (scope: OptimisticGrantScope) => {
    const scopeKey = buildOptimisticGrantScopeKey(scope)
    const existing = scopeContexts.get(scopeKey)
    if (existing) return existing

    const manager = createUndoManager({
      onChange: (state) => saveHistory(scope, state),
    })
    try {
      manager.hydrate(loadHistory(scope))
    } catch {}

    const context: HistoryScopeContext = {
      manager,
      tracks: [],
      pendingRun: Promise.resolve(),
    }
    scopeContexts.set(scopeKey, context)
    return context
  }

  const runVisibleAction = (
    scopeKey: string,
    callback: () => void,
  ) => {
    if (readCurrentScopeKey() !== scopeKey) return
    callback()
  }

  const pushHistory = (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => {
    const scope = readCurrentScope()
    if (!scope || scope.roomId !== entry.roomId) return
    getScopeContext(scope).manager.push(entry, mergeKey, mergeWindowMs)
  }

  const runHistoryAction = (
    mode: 'undo' | 'redo',
    executor: typeof execUndo | typeof execRedo,
    onSuccess: (manager: UndoManager, entry: HistoryEntry) => void,
  ) => {
    const scope = readCurrentScope()
    if (!scope) return
    const context = getScopeContext(scope)
    const scopeKey = buildOptimisticGrantScopeKey(scope)
    const run = async () => {
      const manager = context.manager
      if (mode === 'undo' && !manager.canUndo()) return
      if (mode === 'redo' && !manager.canRedo()) return

      const snapshot = manager.snapshot()
      const entry = mode === 'undo' ? manager.popUndo() : manager.popRedo()
      if (!entry) return

      const sourceActions = options.getActions()
      let workingTracks = cloneTracks(context.tracks)
      const actions: TimelineHistoryActions = {
        insertLocalTrack: (track, index) => {
          insertTrackIntoModel(workingTracks, track, index)
          runVisibleAction(scopeKey, () => sourceActions.insertLocalTrack(track, index))
        },
        removeLocalTrack: (trackId) => {
          removeTrackFromModel(workingTracks, trackId)
          runVisibleAction(scopeKey, () => sourceActions.removeLocalTrack(trackId))
        },
        insertLocalClip: (trackId, clip) => {
          insertClipIntoModel(workingTracks, trackId, clip)
          runVisibleAction(scopeKey, () => sourceActions.insertLocalClip(trackId, clip))
        },
        removeLocalClips: (clipIds) => {
          removeClipsFromModel(workingTracks, clipIds)
          runVisibleAction(scopeKey, () => sourceActions.removeLocalClips(clipIds))
        },
        commitClipMoves: (moves) => {
          commitClipMovesInModel(workingTracks, moves)
          runVisibleAction(scopeKey, () => sourceActions.commitClipMoves(moves))
        },
        commitClipTiming: (clipId, patch) => {
          commitClipTimingInModel(workingTracks, clipId, patch)
          runVisibleAction(scopeKey, () => sourceActions.commitClipTiming(clipId, patch))
        },
        rescheduleChangedClips: (clipIds) => {
          runVisibleAction(scopeKey, () => sourceActions.rescheduleChangedClips(clipIds))
        },
        cancelTrackVolumeWrite: (trackId) => {
          runVisibleAction(scopeKey, () => sourceActions.cancelTrackVolumeWrite(trackId))
        },
        cancelTrackRoutingWrite: (trackId) => {
          runVisibleAction(scopeKey, () => sourceActions.cancelTrackRoutingWrite(trackId))
        },
        cancelTrackMixWrite: (trackId) => {
          runVisibleAction(scopeKey, () => sourceActions.cancelTrackMixWrite(trackId))
        },
        applyTrackVolume: (trackId, volume, scopeValue) => {
          applyTrackVolumeInModel(workingTracks, trackId, volume)
          runVisibleAction(scopeKey, () => sourceActions.applyTrackVolume(trackId, volume, scopeValue))
        },
        applyTrackMixState: (trackId, patch, scopeValue) => {
          applyTrackMixStateInModel(workingTracks, trackId, patch)
          runVisibleAction(scopeKey, () => sourceActions.applyTrackMixState(trackId, patch, scopeValue))
        },
        applyTrackRouting: (trackId, routing) => {
          applyTrackRoutingInModel(workingTracks, trackId, routing)
          runVisibleAction(scopeKey, () => sourceActions.applyTrackRouting(trackId, routing))
        },
      }

      try {
        await executor(entry, {
          convexClient: options.convexClient,
          convexApi: options.convexApi,
          getTracks: () => workingTracks,
          getHistoryEntries: () => {
            const currentSnapshot = manager.snapshot()
            return [...currentSnapshot.undo, ...currentSnapshot.redo, entry]
          },
          roomId: scope.roomId,
          userId: scope.userId,
          persistLocalMix: options.persistLocalMix,
          audioEngine: options.audioEngine,
          ensureClipBuffer: options.ensureClipBuffer,
          grantTrackWrite: options.grantTrackWrite,
          grantClipWrite: options.grantClipWrite,
          actions,
        })
        context.tracks = workingTracks
        onSuccess(manager, entry)
      } catch (error) {
        console.error(`[Timeline] ${mode} failed`, error)
        manager.hydrate(snapshot)
      }
    }

    const nextRun = context.pendingRun
      .catch(() => {})
      .then(run)

    context.pendingRun = nextRun
  }

  const handleUndo = () => {
    runHistoryAction('undo', execUndo, (manager, entry) => {
      manager.pushRedo(entry)
    })
  }

  const handleRedo = () => {
    runHistoryAction('redo', execRedo, (manager, entry) => {
      manager.pushUndoEntry(entry)
    })
  }

  createEffect(() => {
    const scope = readCurrentScope()
    const tracks = options.getTracks()
    if (!scope) return
    getScopeContext(scope).tracks = cloneTracks(tracks)
  })

  return {
    pushHistory,
    handleUndo,
    handleRedo,
  }
}
