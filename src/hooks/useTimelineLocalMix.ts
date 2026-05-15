import { createEffect, on, type Accessor } from 'solid-js'

import {
  loadLocalMixMap,
  loadLocalRoutingMap,
  saveLocalMixMap,
  saveLocalRoutingMap,
  stripSharedTrackBooleanOverrides,
  type LocalMixMap,
  type LocalMixPatch,
} from '~/lib/timeline-storage'
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

const loadLocalTrackState = (roomId: string): LocalMixMap => {
  const mix = loadLocalMixMap(roomId)
  const routing = loadLocalRoutingMap(roomId)
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

const saveLocalTrackState = (roomId: string, value: LocalMixMap) => {
  saveLocalMixMap(roomId, value)
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
  saveLocalRoutingMap(roomId, routing)
}

export function useTimelineLocalMix(
  options: UseTimelineLocalMixOptions,
): UseTimelineLocalMixReturn {
  const persistedState = useRoomPersistedState<LocalMixMap>({
    roomId: options.roomId,
    createInitial: () => ({}),
    load: (roomId) => loadLocalTrackState(roomId),
    save: (roomId, value) => saveLocalTrackState(roomId, value),
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
      const next = persistedState.setValueSilently((current) => mergeLocalMixPatch(current, trackId, patch))
      saveLocalTrackState(options.roomId(), next)
    },
  }
}
