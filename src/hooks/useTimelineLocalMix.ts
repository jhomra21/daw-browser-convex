import { createEffect, type Accessor } from 'solid-js'

import { projectPreferenceStorage } from '~/lib/project-preference-storage'
import {
  loadLocalMixMap,
  saveLocalMixMap,
  stripSharedTrackLocalOverrides,
  type LocalMixMap,
  type LocalMixPatch,
} from '~/lib/timeline-storage'
import type { Track } from '@daw-browser/timeline-core/types'

import { useProjectPersistedState } from './useProjectPersistedState'

type UseTimelineLocalMixOptions = {
  projectId: Accessor<string>
  writableTrackIds: Accessor<Set<Track['id']>>
  onLocalSaveFailed?: (projectId: string, message: string) => void
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

export function useTimelineLocalMix(
  options: UseTimelineLocalMixOptions,
): UseTimelineLocalMixReturn {
  const persistedState = useProjectPersistedState<LocalMixMap>({
    projectId: options.projectId,
    ...projectPreferenceStorage<LocalMixMap>('localMix', () => ({}), { load: loadLocalMixMap, save: saveLocalMixMap }),
    onSaveAsyncError: (projectId, error) => {
      options.onLocalSaveFailed?.(projectId, error instanceof Error ? error.message : 'Local mix could not be saved.')
    },
  })

  createEffect(
    () => ({
      writableTrackIds: options.writableTrackIds(),
      localMix: persistedState.value(),
    }),
    ({ writableTrackIds }) => {
      persistedState.setValue((current) => stripSharedTrackLocalOverrides(current, writableTrackIds))
    },
  )

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
