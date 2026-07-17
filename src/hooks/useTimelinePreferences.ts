import { createSignal, type Accessor } from 'solid-js'

import {
  loadGridSettings,
  loadMixSyncFlag,
  loadTimelineScale,
  saveGridSettings,
  saveMixSyncFlag,
  saveTimelineScale,
} from '~/lib/timeline-storage'
import { TIMELINE_SIDEBAR_MIN_WIDTH } from '~/lib/timeline-layout'
import { clampPixelsPerSecond, DEFAULT_PIXELS_PER_SECOND } from '~/lib/timeline-view'
import { isLocalId } from '@daw-browser/shared'
import { loadLocalProjectState, saveLocalProjectState } from '~/lib/local-project-state'

import { useProjectPersistedState } from './useProjectPersistedState'

type UseTimelinePreferencesOptions = {
  projectId: Accessor<string>
  onLocalSaveFailed?: (message: string) => void
  cloudTimelineSettings?: Accessor<{
    tempoBpm: number
    loopEnabled: boolean
    loopStartSec: number
    loopEndSec: number
  } | undefined>
  onCloudTimelineSettingsChange?: (
    projectId: string,
    settings: Partial<{
      tempoBpm: number
      loopEnabled: boolean
      loopStartSec: number
      loopEndSec: number
    }>,
  ) => void
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
  pixelsPerSecond: Accessor<number>
  previewPixelsPerSecond: (value: number) => void
  commitPixelsPerSecond: (value: number) => void
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
    load: () => 120,
    loadAsync: (projectId) => loadLocalState<number>(projectId, 'bpm'),
    save: () => undefined,
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
    load: () => ({ enabled: false, startSec: 0, endSec: 8 }),
    loadAsync: (projectId) => loadLocalState<{ enabled: boolean; startSec: number; endSec: number }>(projectId, 'loop'),
    save: () => undefined,
    saveAsync: (projectId, value) => saveLocalState(projectId, 'loop', value),
    onSaveAsyncError: onLocalSaveError,
  })
  const scaleState = useProjectPersistedState<number>({
    projectId: options.projectId,
    createInitial: () => DEFAULT_PIXELS_PER_SECOND,
    load: (projectId) => {
      if (isLocalId('project', projectId)) return DEFAULT_PIXELS_PER_SECOND
      return loadTimelineScale(projectId)
    },
    loadAsync: (projectId) => loadLocalState<number>(projectId, 'timelineScale'),
    save: (projectId, value) => {
      if (!isLocalId('project', projectId)) saveTimelineScale(projectId, value)
    },
    saveAsync: (projectId, value) => saveLocalState(projectId, 'timelineScale', value),
    onSaveAsyncError: onLocalSaveError,
  })

  const syncMix = syncMixState.value
  const setSyncMix = syncMixState.setValue
  const cloudTimelineSettings = () => options.cloudTimelineSettings?.()
  const isLocalProject = () => isLocalId('project', options.projectId())
  const bpm = () => isLocalProject()
    ? bpmState.value()
    : cloudTimelineSettings()?.tempoBpm ?? 120
  const setBpm = (value: number) => {
    if (isLocalProject()) {
      bpmState.setValue(value)
      return
    }
    const projectId = options.projectId()
    if (projectId) options.onCloudTimelineSettingsChange?.(projectId, { tempoBpm: value })
  }
  const gridEnabled = () => gridState.value().enabled
  const gridDenominator = () => gridState.value().denominator
  const loopEnabled = () => isLocalProject()
    ? loopState.value().enabled
    : cloudTimelineSettings()?.loopEnabled ?? false
  const loopStartSec = () => isLocalProject()
    ? loopState.value().startSec
    : cloudTimelineSettings()?.loopStartSec ?? 0
  const loopEndSec = () => isLocalProject()
    ? loopState.value().endSec
    : cloudTimelineSettings()?.loopEndSec ?? 8
  const pixelsPerSecond = () => clampPixelsPerSecond(scaleState.value())

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
    if (!isLocalProject()) {
      const current = loopEnabled()
      const enabled = typeof value === 'function' ? value(current) : value
      const projectId = options.projectId()
      if (projectId) options.onCloudTimelineSettingsChange?.(projectId, { loopEnabled: enabled })
      return
    }
    loopState.setValue((current) => ({
      ...current,
      enabled: typeof value === 'function' ? value(current.enabled) : value,
    }))
  }

  const setLoopRegion = (start: number, end: number) => {
    const nextStart = Math.max(0, Math.min(start, end - 0.05))
    const nextEnd = Math.max(nextStart + 0.05, end)
    if (!isLocalProject()) {
      const projectId = options.projectId()
      if (projectId) options.onCloudTimelineSettingsChange?.(projectId, {
        loopStartSec: nextStart,
        loopEndSec: nextEnd,
      })
      return
    }
    loopState.setValue((current) => ({
      ...current,
      startSec: nextStart,
      endSec: nextEnd,
    }))
  }
  const previewPixelsPerSecond = (value: number) => {
    scaleState.setValueSilently(clampPixelsPerSecond(value))
  }

  const commitPixelsPerSecond = (value: number) => {
    scaleState.commitValue(clampPixelsPerSecond(value))
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
    pixelsPerSecond,
    previewPixelsPerSecond,
    commitPixelsPerSecond,
  }
}
