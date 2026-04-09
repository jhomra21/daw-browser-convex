import { createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'

import {
  loadBpm,
  loadGridSettings,
  loadLoopSettings,
  loadMixSyncFlag,
  saveBpm,
  saveGridSettings,
  saveLoopSettings,
  saveMixSyncFlag,
} from '~/lib/timeline-storage'

import { useRoomPersistedState } from './useRoomPersistedState'

type UseTimelinePreferencesOptions = {
  roomId: Accessor<string>
}

type UseTimelinePreferencesReturn = {
  sidebarWidth: Accessor<number>
  setSidebarWidth: (value: number) => void
  syncMix: Accessor<boolean>
  toggleSyncMix: () => void
  bpm: Accessor<number>
  setBpm: (value: number) => void
  clampBpm: (value: number) => number
  gridEnabled: Accessor<boolean>
  setGridEnabled: (value: boolean | ((current: boolean) => boolean)) => void
  gridDenominator: Accessor<number>
  setGridDenominator: (value: number) => void
  loopEnabled: Accessor<boolean>
  setLoopEnabled: (value: boolean | ((current: boolean) => boolean)) => void
  loopStartSec: Accessor<number>
  loopEndSec: Accessor<number>
  setLoopRegion: (start: number, end: number) => void
}

export function useTimelinePreferences(
  options: UseTimelinePreferencesOptions,
): UseTimelinePreferencesReturn {
  const [sidebarWidth, setSidebarWidth] = createSignal(260)

  const syncMixState = useRoomPersistedState<boolean>({
    roomId: options.roomId,
    createInitial: () => false,
    load: (roomId) => loadMixSyncFlag(roomId),
    save: (roomId, value) => saveMixSyncFlag(roomId, value),
  })

  const bpmState = useRoomPersistedState<number>({
    roomId: options.roomId,
    createInitial: () => 120,
    load: (roomId) => loadBpm(roomId),
    save: (roomId, value) => saveBpm(roomId, value),
  })

  const gridState = useRoomPersistedState<{ enabled: boolean; denominator: number }>({
    roomId: options.roomId,
    createInitial: () => ({ enabled: true, denominator: 4 }),
    load: (roomId) => loadGridSettings(roomId),
    save: (roomId, value) => saveGridSettings(roomId, value.enabled, value.denominator),
  })

  const loopState = useRoomPersistedState<{ enabled: boolean; startSec: number; endSec: number }>({
    roomId: options.roomId,
    createInitial: () => ({ enabled: false, startSec: 0, endSec: 8 }),
    load: (roomId) => loadLoopSettings(roomId),
    save: (roomId, value) => saveLoopSettings(roomId, value),
  })

  const syncMix = syncMixState.value
  const setSyncMix = syncMixState.setValue
  const bpm = bpmState.value
  const setBpm = bpmState.setValue
  const gridEnabled = () => gridState.value().enabled
  const gridDenominator = () => gridState.value().denominator
  const loopEnabled = () => loopState.value().enabled
  const loopStartSec = () => loopState.value().startSec
  const loopEndSec = () => loopState.value().endSec

  const clampBpm = (value: number) => {
    if (!Number.isFinite(value)) return bpm()
    return Math.min(300, Math.max(30, Math.round(value)))
  }

  const toggleSyncMix = () => {
    const roomId = options.roomId()
    if (!roomId) return
    setSyncMix((current) => !current)
  }

  const setGridEnabled = (value: boolean | ((current: boolean) => boolean)) => {
    gridState.setValue((current) => ({
      ...current,
      enabled: typeof value === 'function' ? value(current.enabled) : value,
    }))
  }

  const setGridDenominator = (value: number) => {
    gridState.setValue((current) => ({ ...current, denominator: value }))
  }

  const setLoopEnabled = (value: boolean | ((current: boolean) => boolean)) => {
    loopState.setValue((current) => ({
      ...current,
      enabled: typeof value === 'function' ? value(current.enabled) : value,
    }))
  }

  const setLoopRegion = (start: number, end: number) => {
    const nextStart = Math.max(0, Math.min(start, end - 0.05))
    const nextEnd = Math.max(nextStart + 0.05, end)
    loopState.setValue((current) => ({
      ...current,
      startSec: nextStart,
      endSec: nextEnd,
    }))
  }

  return {
    sidebarWidth,
    setSidebarWidth,
    syncMix,
    toggleSyncMix,
    bpm,
    setBpm,
    clampBpm,
    gridEnabled,
    setGridEnabled,
    gridDenominator,
    setGridDenominator,
    loopEnabled,
    setLoopEnabled,
    loopStartSec,
    loopEndSec,
    setLoopRegion,
  }
}
