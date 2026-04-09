import { createEffect, on, type Accessor } from 'solid-js'

import { loadLocalMixMap, saveLocalMix, saveLocalMixMap, stripSharedTrackBooleanOverrides, type LocalMixMap, type LocalMixPatch } from '~/lib/timeline-storage'
import type { Track } from '~/types/timeline'

import { useRoomPersistedState } from './useRoomPersistedState'

type UseTimelineLocalMixOptions = {
  roomId: Accessor<string>
  writableTrackIds: Accessor<Set<Track['id']>>
}

type UseTimelineLocalMixReturn = {
  byTrackId: Accessor<LocalMixMap>
  apply: (trackId: Track['id'], patch: LocalMixPatch) => void
  persist: (trackId: Track['id'], patch: LocalMixPatch) => void
}

function mergeLocalMixPatch(current: LocalMixMap, trackId: Track['id'], patch: LocalMixPatch): LocalMixMap {
  const previousEntry = current[trackId] ?? {}
  const nextEntry = { ...previousEntry, ...patch }
  const isEmpty = nextEntry.volume === undefined && nextEntry.muted === undefined && nextEntry.soloed === undefined

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
  const persistedState = useRoomPersistedState<LocalMixMap>({
    roomId: options.roomId,
    createInitial: () => ({}),
    load: (roomId) => loadLocalMixMap(roomId),
    save: (roomId, value) => saveLocalMixMap(roomId, value),
  })

  createEffect(on(options.writableTrackIds, (writableTrackIds) => {
    persistedState.setValue((current) => stripSharedTrackBooleanOverrides(current, writableTrackIds))
  }))

  return {
    byTrackId: persistedState.value,
    apply: (trackId, patch) => {
      persistedState.setValueSilently((current) => mergeLocalMixPatch(current, trackId, patch))
    },
    persist: (trackId, patch) => {
      saveLocalMix(options.roomId(), trackId, patch)
    },
  }
}
