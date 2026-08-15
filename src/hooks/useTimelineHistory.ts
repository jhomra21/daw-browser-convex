import { createEffect, onCleanup, type Accessor } from 'solid-js'

import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import type { convexApi, convexClient } from '~/lib/convex'
import { loadLocalHistory, saveLocalHistory } from '~/lib/local-history'
import { isLocalId } from '@daw-browser/shared'
import { registerPendingLocalProjectWriteFlusher } from '~/lib/local-project-pending-writes'
import {
  buildOptimisticGrantScopeKey,
  readOptimisticGrantScope,
  type OptimisticGrantScope,
} from '~/lib/optimistic-grant-scope'
import { loadHistory, saveHistory, type LocalMixPatch } from '~/lib/timeline-storage'
import { createUndoManager, type UndoManager } from '~/lib/undo/manager'
import type { HistoryEntry, PersistedHistory } from '~/lib/undo/types'
import { execRedo, execUndo } from '~/lib/undo/exec'
import { createProjectControlClient } from '~/lib/project-control-client'
import {
  applyTrackMixStateInHistoryModel,
  applyTrackPatchInHistoryModel,
  applyTrackRoutingInHistoryModel,
  applyTrackVolumeInHistoryModel,
  cloneHistoryTracks,
  commitClipAudioWarpInHistoryModel,
  commitClipFadesInHistoryModel,
  commitClipMovesInHistoryModel,
  commitClipTimingInHistoryModel,
  insertClipIntoHistoryModel,
  insertTrackIntoHistoryModel,
  removeClipsFromHistoryModel,
  removeTrackFromHistoryModel,
} from '~/lib/undo/history-model'
import type { Track } from '@daw-browser/timeline-core/types'
import { createDrumRackBufferSync } from '~/lib/drum-rack-buffer-sync'
import {
  attachClipDeletionRecoveriesToHistory,
  flushPendingSharedOutboxHistoryUpdates,
  registerSharedOutboxHistoryHandler,
} from '~/lib/shared-outbox'

export type TimelineHistoryActions = Parameters<typeof execUndo>[1]['actions']

type UseTimelineHistoryOptions = {
  projectId: Accessor<string>
  userId: Accessor<string>
  getTracks: () => Track[]
  convexClient: typeof convexClient
  convexApi: typeof convexApi
  audioEngine: AudioEngine
  replayInstanceEffectParams?: Parameters<typeof execUndo>[1]['replayInstanceEffectParams']
  ensureClipBuffer?: (clipId: string, sampleUrl?: string) => Promise<void>
  grantTrackWrite: (trackId: Track['id'] | null | undefined, scope?: OptimisticGrantScope | null) => void
  grantClipWrite: (clipId: string | null | undefined, scope?: OptimisticGrantScope | null) => void
  persistLocalMix: (projectId: string, trackId: Track['id'], patch: LocalMixPatch) => void
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
  pendingLocalHistorySave: Promise<void>
  drumRackBufferSync: ReturnType<typeof createDrumRackBufferSync>
  unregisterLocalHistoryFlusher?: () => void
  hydratedFromLocalDb?: boolean
  pendingLocalHistoryState?: PersistedHistory
}

const mergeLocalHistoryState = (
  persisted: PersistedHistory,
  pending: PersistedHistory,
): PersistedHistory => {
  const seen = new Set(persisted.undo.map((entry) => JSON.stringify(entry)))
  const pendingUndo = pending.undo.filter((entry) => {
    const key = JSON.stringify(entry)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return {
    undo: [...persisted.undo, ...pendingUndo].slice(-50),
    redo: pending.redo,
  }
}

export function useTimelineHistory(
  options: UseTimelineHistoryOptions,
): UseTimelineHistoryReturn {
  const scopeContexts = new Map<string, HistoryScopeContext>()

  const readCurrentScope = () => readOptimisticGrantScope({
    projectId: options.projectId(),
    userId: isLocalId('project', options.projectId()) ? 'local' : options.userId(),
  })

  const readCurrentScopeKey = () => {
    const scope = readCurrentScope()
    return scope ? buildOptimisticGrantScopeKey(scope) : null
  }

  const saveLocalHistoryInOrder = (context: HistoryScopeContext, projectId: string, state: PersistedHistory) => {
    context.pendingLocalHistorySave = context.pendingLocalHistorySave
      .catch(() => undefined)
      .then(() => saveLocalHistory(projectId, state))
    void context.pendingLocalHistorySave.catch(() => undefined)
  }

  const getScopeContext = (scope: OptimisticGrantScope) => {
    const scopeKey = buildOptimisticGrantScopeKey(scope)
    const existing = scopeContexts.get(scopeKey)
    if (existing) return existing

    const localProject = isLocalId('project', scope.projectId)
    let hydrating = false
    const manager = createUndoManager({
      onChange: (state) => {
        if (hydrating) return
        if (localProject) {
          const context = scopeContexts.get(scopeKey)
          if (context && !context.hydratedFromLocalDb) {
            context.pendingLocalHistoryState = state
            return
          }
          if (!context) {
            void saveLocalHistory(scope.projectId, state)
            return
          }
          saveLocalHistoryInOrder(context, scope.projectId, state)
          return
        }
        saveHistory(scope, state)
      },
    })
    if (!localProject) {
      try {
        hydrating = true
        manager.hydrate(loadHistory(scope))
      } catch {}
    }
    hydrating = false

    const context: HistoryScopeContext = {
      manager,
      tracks: [],
      pendingRun: Promise.resolve(),
      pendingLocalHistorySave: Promise.resolve(),
      drumRackBufferSync: createDrumRackBufferSync({
        projectId: () => scope.projectId,
        isCurrentProject: () => readCurrentScopeKey() === scopeKey,
      }),
    }
    scopeContexts.set(scopeKey, context)
    if (localProject) {
      context.unregisterLocalHistoryFlusher = registerPendingLocalProjectWriteFlusher(
        'history',
        scope.projectId,
        () => context.pendingLocalHistorySave,
      )
      void loadLocalHistory(scope.projectId)
        .then((state) => {
          if (context.hydratedFromLocalDb) return
          const pendingState = context.pendingLocalHistoryState
          hydrating = true
          if (state && pendingState) {
            const merged = mergeLocalHistoryState(state, pendingState)
            manager.hydrate(merged)
            saveLocalHistoryInOrder(context, scope.projectId, merged)
          } else if (state) {
            manager.hydrate(state)
          } else if (pendingState) {
            manager.hydrate(pendingState)
            saveLocalHistoryInOrder(context, scope.projectId, pendingState)
          }
          context.pendingLocalHistoryState = undefined
          hydrating = false
          context.hydratedFromLocalDb = true
        })
        .catch(() => {
          const pendingState = context.pendingLocalHistoryState
          if (pendingState) saveLocalHistoryInOrder(context, scope.projectId, pendingState)
          context.pendingLocalHistoryState = undefined
          context.hydratedFromLocalDb = true
        })
    }
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
    if (!scope || scope.projectId !== entry.projectId) return
    getScopeContext(scope).manager.push(entry, mergeKey, mergeWindowMs)
    flushPendingSharedOutboxHistoryUpdates()
  }

  const unregisterSharedOutboxHistory = registerSharedOutboxHistoryHandler((update) => {
    if (update.kind === 'entry') {
      if (update.entry.projectId !== options.projectId()) return false
      pushHistory(update.entry)
      return true
    }
    if (update.projectId !== options.projectId()) return false
    const scope = readCurrentScope()
    if (!scope || scope.projectId !== update.projectId || scope.userId !== update.userId) return false
    return getScopeContext(scope).manager.mutate((history) => (
      attachClipDeletionRecoveriesToHistory(
        history,
        update.operationId,
        update.recoveryIdsBySourceClipId,
      )
    ))
  })
  onCleanup(unregisterSharedOutboxHistory)

  const runHistoryAction = (
    mode: 'undo' | 'redo',
    executor: typeof execUndo | typeof execRedo,
  ) => {
    const scope = readCurrentScope()
    if (!scope) return
    const context = getScopeContext(scope)
    const scopeKey = buildOptimisticGrantScopeKey(scope)
    const run = async () => {
      const manager = context.manager
      if (mode === 'undo' && !manager.canUndo()) return
      if (mode === 'redo' && !manager.canRedo()) return

      const entry = mode === 'undo' ? manager.reserveUndo() : manager.reserveRedo()
      if (!entry) return
      const initializeDeleteOperationId = (candidate: HistoryEntry): boolean => {
        if (candidate.type === 'section-edit') {
          return candidate.data.entries.reduce(
            (changed, child) => initializeDeleteOperationId(child) || changed,
            false,
          )
        }
        if (candidate.type === 'control-range-delete') {
          if (mode === 'undo' && !candidate.data.restoreOperationId) {
            candidate.data.restoreOperationId = crypto.randomUUID()
            return true
          }
          if (mode === 'redo' && !candidate.data.deleteOperationId) {
            candidate.data.deleteOperationId = crypto.randomUUID()
            return true
          }
          return false
        }
        if (isLocalId('project', scope.projectId)) return false
        if (mode === 'undo' && candidate.type === 'clip-create' && !candidate.data.clip.deleteOperationId) {
          candidate.data.clip.deleteOperationId = crypto.randomUUID()
          return true
        }
        if (mode === 'redo' && candidate.type === 'clip-delete' && !candidate.data.deleteOperationId) {
          candidate.data.deleteOperationId = crypto.randomUUID()
          return true
        }
        return false
      }
      manager.mutate(() => initializeDeleteOperationId(entry))

      const sourceActions = options.getActions()
      const workingTracks = cloneHistoryTracks(context.tracks)
      const actions: TimelineHistoryActions = {
        insertLocalTrack: (track, index) => {
          insertTrackIntoHistoryModel(workingTracks, track, index)
          runVisibleAction(scopeKey, () => sourceActions.insertLocalTrack(track, index))
        },
        removeLocalTrack: (trackId) => {
          removeTrackFromHistoryModel(workingTracks, trackId)
          runVisibleAction(scopeKey, () => sourceActions.removeLocalTrack(trackId))
        },
        insertLocalClip: (trackId, clip) => {
          insertClipIntoHistoryModel(workingTracks, trackId, clip)
          runVisibleAction(scopeKey, () => sourceActions.insertLocalClip(trackId, clip))
        },
        replaceLocalClip: (trackId, clip) => {
          insertClipIntoHistoryModel(workingTracks, trackId, clip)
          runVisibleAction(scopeKey, () => sourceActions.replaceLocalClip(trackId, clip))
        },
        removeLocalClips: (clipIds) => {
          removeClipsFromHistoryModel(workingTracks, clipIds)
          runVisibleAction(scopeKey, () => sourceActions.removeLocalClips(clipIds))
        },
        commitClipMoves: (moves) => {
          commitClipMovesInHistoryModel(workingTracks, moves)
          runVisibleAction(scopeKey, () => sourceActions.commitClipMoves(moves))
        },
        commitClipTiming: (clipId, patch) => {
          commitClipTimingInHistoryModel(workingTracks, clipId, patch)
          runVisibleAction(scopeKey, () => sourceActions.commitClipTiming(clipId, patch))
        },
        commitClipAudioWarp: (clipId, audioWarp) => {
          commitClipAudioWarpInHistoryModel(workingTracks, clipId, audioWarp)
          runVisibleAction(scopeKey, () => sourceActions.commitClipAudioWarp(clipId, audioWarp))
        },
        commitClipFades: (clipId, fades) => {
          commitClipFadesInHistoryModel(workingTracks, clipId, fades)
          runVisibleAction(scopeKey, () => sourceActions.commitClipFades(clipId, fades))
        },
        rescheduleChangedClips: (clipIds) => {
          runVisibleAction(scopeKey, () => sourceActions.rescheduleChangedClips(clipIds))
        },
        rescheduleTimeline: () => {
          runVisibleAction(scopeKey, () => sourceActions.rescheduleTimeline?.())
        },
        refreshLocalTimeline: () => (
          readCurrentScopeKey() === scopeKey
            ? sourceActions.refreshLocalTimeline?.() ?? Promise.resolve()
            : Promise.resolve()
        ),
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
          applyTrackVolumeInHistoryModel(workingTracks, trackId, volume)
          runVisibleAction(scopeKey, () => sourceActions.applyTrackVolume(trackId, volume, scopeValue))
        },
        applyTrackMixState: (trackId, patch, scopeValue) => {
          applyTrackMixStateInHistoryModel(workingTracks, trackId, patch)
          runVisibleAction(scopeKey, () => sourceActions.applyTrackMixState(trackId, patch, scopeValue))
        },
        applyTrackRouting: (trackId, routing) => {
          applyTrackRoutingInHistoryModel(workingTracks, trackId, routing)
          runVisibleAction(scopeKey, () => sourceActions.applyTrackRouting(trackId, routing))
        },
        applyTrackPatch: (trackId, patch) => {
          applyTrackPatchInHistoryModel(workingTracks, trackId, patch)
          runVisibleAction(scopeKey, () => sourceActions.applyTrackPatch(trackId, patch))
        },
        applyAutomationEnvelope: (envelope, targetKey) => {
          runVisibleAction(scopeKey, () => sourceActions.applyAutomationEnvelope(envelope, targetKey))
        },
      }

      try {
        await executor(entry, {
          convexClient: options.convexClient,
          convexApi: options.convexApi,
          getTracks: () => workingTracks,
          getHistoryEntries: () => {
            const currentSnapshot = manager.snapshot()
            return [...currentSnapshot.undo, ...currentSnapshot.redo]
          },
          projectId: scope.projectId,
          userId: scope.userId,
          persistLocalMix: options.persistLocalMix,
          audioEngine: options.audioEngine,
          isCurrentScope: () => readCurrentScopeKey() === scopeKey,
          replayInstanceEffectParams: options.replayInstanceEffectParams,
          drumRackBufferSync: context.drumRackBufferSync,
          ensureClipBuffer: options.ensureClipBuffer,
          grantTrackWrite: options.grantTrackWrite,
          grantClipWrite: options.grantClipWrite,
          persistHistory: () => { manager.mutate(() => true) },
          controlClient: createProjectControlClient({
            projectId: scope.projectId,
            userId: scope.userId,
            convexClient: options.convexClient,
            convexApi: options.convexApi,
          }),
          actions,
        })
        context.tracks = workingTracks
        if (mode === 'undo') manager.completeUndo(entry)
        else manager.completeRedo(entry)
      } catch (error) {
        if (mode === 'undo') manager.restoreUndo(entry)
        else manager.restoreRedo(entry)
        console.error(`[Timeline] ${mode} failed`, error)
      }
    }

    const nextRun = context.pendingRun
      .catch(() => {})
      .then(run)

    context.pendingRun = nextRun
  }

  const handleUndo = () => {
    runHistoryAction('undo', execUndo)
  }

  const handleRedo = () => {
    runHistoryAction('redo', execRedo)
  }

  createEffect(() => {
    const scope = readCurrentScope()
    const tracks = options.getTracks()
    if (!scope) return
    getScopeContext(scope).tracks = cloneHistoryTracks(tracks)
  })

  onCleanup(() => {
    for (const context of scopeContexts.values()) {
      context.unregisterLocalHistoryFlusher?.()
      context.drumRackBufferSync.dispose()
    }
  })

  return {
    pushHistory,
    handleUndo,
    handleRedo,
  }
}
