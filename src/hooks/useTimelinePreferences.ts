import { createSignal, type Accessor } from 'solid-js'

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
import { TIMELINE_SIDEBAR_MIN_WIDTH } from '~/lib/timeline-layout'
import { isLocalId } from '@daw-browser/shared'
import { loadLocalProjectState, saveLocalProjectState } from '~/lib/local-project-state'

import { useProjectPersistedState } from './useProjectPersistedState'

type UseTimelinePreferencesOptions = {
  projectId: Accessor<string>
  onLocalSaveFailed?: (message: string) => void
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
  const [sidebarWidth, setSidebarWidth] = createSignal(TIMELINE_SIDEBAR_MIN_WIDTH)
  const loadLocalState = async <TValue,>(projectId: string, key: string) => (
    isLocalId('project', projectId) ? await loadLocalProjectState<TValue>(projectId, key) : undefined
  )
  const saveLocalState = async <TValue,>(projectId: string, key: string, value: TValue) => {
    if (isLocalId('project', projectId)) await saveLocalProjectState(projectId, key, value)
  }
  const onLocalSaveError = (error: unknown) => {
    options.onLocalSaveFailed?.(error instanceof Error ? error.message : 'Local project settings could not be saved.')
  }

  const syncMixState = useProjectPersistedState<boolean>({
    projectId: options.projectId,
    createInitial: () => false,
    load: (projectId) => isLocalId('project', projectId) ? false : loadMixSyncFlag(projectId),
    loadAsync: (projectId) => loadLocalState<boolean>(projectId, 'syncMix'),
    save: (projectId, value) => {
      if (!isLocalId('project', projectId)) saveMixSyncFlag(projectId, value)
    },
    saveAsync: (projectId, value) => saveLocalState(projectId, 'syncMix', value),
    onSaveAsyncError: onLocalSaveError,
  })

  const bpmState = useProjectPersistedState<number>({
    projectId: options.projectId,
    createInitial: () => 120,
    load: (projectId) => isLocalId('project', projectId) ? 120 : loadBpm(projectId),
    loadAsync: (projectId) => loadLocalState<number>(projectId, 'bpm'),
    save: (projectId, value) => {
      if (!isLocalId('project', projectId)) saveBpm(projectId, value)
    },
    saveAsync: (projectId, value) => saveLocalState(projectId, 'bpm', value),
    onSaveAsyncError: onLocalSaveError,
  })

  const gridState = useProjectPersistedState<{ enabled: boolean; denominator: number }>({
    projectId: options.projectId,
    createInitial: () => ({ enabled: true, denominator: 4 }),
    load: (projectId) => isLocalId('project', projectId) ? { enabled: true, denominator: 4 } : loadGridSettings(projectId),
    loadAsync: (projectId) => loadLocalState<{ enabled: boolean; denominator: number }>(projectId, 'grid'),
    save: (projectId, value) => {
      if (!isLocalId('project', projectId)) saveGridSettings(projectId, value.enabled, value.denominator)
    },
    saveAsync: (projectId, value) => saveLocalState(projectId, 'grid', value),
    onSaveAsyncError: onLocalSaveError,
  })

  const loopState = useProjectPersistedState<{ enabled: boolean; startSec: number; endSec: number }>({
    projectId: options.projectId,
    createInitial: () => ({ enabled: false, startSec: 0, endSec: 8 }),
    load: (projectId) => isLocalId('project', projectId) ? { enabled: false, startSec: 0, endSec: 8 } : loadLoopSettings(projectId),
    loadAsync: (projectId) => loadLocalState<{ enabled: boolean; startSec: number; endSec: number }>(projectId, 'loop'),
    save: (projectId, value) => {
      if (!isLocalId('project', projectId)) saveLoopSettings(projectId, value)
    },
    saveAsync: (projectId, value) => saveLocalState(projectId, 'loop', value),
    onSaveAsyncError: onLocalSaveError,
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
    const projectId = options.projectId()
    if (!projectId) return
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
