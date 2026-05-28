import { createEffect, on, type Accessor } from 'solid-js'

import { isLocalId } from '~/lib/local-ids'
import { loadLocalProjectState, saveLocalProjectState } from '~/lib/local-project-state'
import {
  loadLocalMixMap,
  loadLocalRoutingMap,
  saveLocalMixMap,
  saveLocalRoutingMap,
  stripSharedTrackLocalOverrides,
  type LocalMixMap,
  type LocalMixPatch,
} from '~/lib/timeline-storage'
import type { Track } from '~/types/timeline'

import { useProjectPersistedState } from './useProjectPersistedState'

type UseTimelineLocalMixOptions = {
  projectId: Accessor<string>
  writableTrackIds: Accessor<Set<Track['id']>>
  onLocalSaveFailed?: (message: string) => void
}

type UseTimelineLocalMixReturn = {
  byTrackId: Accessor<LocalMixMap>
  apply: (trackId: Track['id'], patch: LocalMixPatch) => void
  persist: (trackId: Track['id'], patch: LocalMixPatch) => void
}

function mergeLocalMixPatch(current: LocalMixMap, trackId: Track['id'], patch: LocalMixPatch): LocalMixMap {
  const previousEntry = current[trackId] ?? {}
  const nextEntry = { ...previousEntry, ...patch }
  const isEmpty = nextEntry.volume === undefined
    && nextEntry.muted === undefined
    && nextEntry.soloed === undefined
    && nextEntry.sends === undefined
    && nextEntry.outputTargetId === undefined

  if (isEmpty) {
    if (!(trackId in current)) return current
    const next = { ...current }
    delete next[trackId]
    return next
  }

  if (
    previousEntry.volume === nextEntry.volume
    && previousEntry.muted === nextEntry.muted
    && previousEntry.soloed === nextEntry.soloed
    && previousEntry.sends === nextEntry.sends
    && previousEntry.outputTargetId === nextEntry.outputTargetId
  ) {
    return current
  }

  return {
    ...current,
    [trackId]: nextEntry,
  }
}

const loadLocalTrackState = (projectId: string): LocalMixMap => {
  if (isLocalId('project', projectId)) return {}
  const mix = loadLocalMixMap(projectId)
  const routing = loadLocalRoutingMap(projectId)
  let next: LocalMixMap | null = null
  for (const [trackId, patch] of Object.entries(routing)) {
    if (patch.sends === undefined && patch.outputTargetId === undefined) continue
    if (!next) next = { ...mix }
    next[trackId] = {
      ...(next[trackId] ?? {}),
      sends: patch.sends,
      outputTargetId: patch.outputTargetId,
    }
  }
  return next ?? mix
}

const saveLocalTrackState = (projectId: string, value: LocalMixMap) => {
  if (isLocalId('project', projectId)) return
  saveLocalMixMap(projectId, value)
  const routing = Object.fromEntries(
    Object.entries(value)
      .filter(([, patch]) => patch.sends !== undefined || patch.outputTargetId !== undefined)
      .map(([trackId, patch]) => [
        trackId,
        {
          sends: patch.sends,
          outputTargetId: patch.outputTargetId,
        },
      ]),
  )
  saveLocalRoutingMap(projectId, routing)
}

const loadProjectTrackState = async (projectId: string): Promise<LocalMixMap | undefined> => {
  if (!isLocalId('project', projectId)) return undefined
  return await loadLocalProjectState<LocalMixMap>(projectId, 'localMix')
}

const saveProjectTrackState = async (projectId: string, value: LocalMixMap): Promise<void> => {
  if (!isLocalId('project', projectId)) return
  await saveLocalProjectState(projectId, 'localMix', value)
}

export function useTimelineLocalMix(
  options: UseTimelineLocalMixOptions,
): UseTimelineLocalMixReturn {
  const persistedState = useProjectPersistedState<LocalMixMap>({
    projectId: options.projectId,
    createInitial: () => ({}),
    load: (projectId) => loadLocalTrackState(projectId),
    loadAsync: loadProjectTrackState,
    save: (projectId, value) => saveLocalTrackState(projectId, value),
    saveAsync: saveProjectTrackState,
    onSaveAsyncError: (error) => {
      options.onLocalSaveFailed?.(error instanceof Error ? error.message : 'Local mix could not be saved.')
    },
  })

  createEffect(on(options.writableTrackIds, (writableTrackIds) => {
    persistedState.setValue((current) => stripSharedTrackLocalOverrides(current, writableTrackIds))
  }))

  return {
    byTrackId: persistedState.value,
    apply: (trackId, patch) => {
      persistedState.setValueSilently((current) => mergeLocalMixPatch(current, trackId, patch))
    },
    persist: (trackId, patch) => {
      persistedState.setValue((current) => mergeLocalMixPatch(current, trackId, patch))
    },
  }
}
