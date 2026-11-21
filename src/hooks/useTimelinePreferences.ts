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
import { clampBpm as clampBpmValue, DEFAULT_BPM, DEFAULT_GRID, DEFAULT_LOOP } from '@daw-browser/timeline-core/project-defaults'
import { projectPreferenceStorage } from '~/lib/project-preference-storage'
import { subscribeToLocalProjectChanges } from '~/lib/local-project-changes'

import { useProjectPersistedState } from './useProjectPersistedState'

type UseTimelinePreferencesOptions = {
  projectId: Accessor<string>
  onLocalSaveFailed?: (projectId: string, message: string) => void
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

  const onLocalSaveError = (projectId: string, cause: unknown) => {
    options.onLocalSaveFailed?.(projectId, cause instanceof Error ? cause.message : 'Local project settings could not be saved.')
  }

  const syncMixState = useProjectPersistedState<boolean>({
    projectId: options.projectId,
    ...projectPreferenceStorage('syncMix', () => false, { load: loadMixSyncFlag, save: saveMixSyncFlag }),
    onSaveAsyncError: onLocalSaveError,
  })

  const bpmState = useProjectPersistedState<number>({
    projectId: options.projectId,
    ...projectPreferenceStorage('bpm', () => DEFAULT_BPM),
    subscribeToChanges: subscribeToLocalProjectChanges,
    onSaveAsyncError: onLocalSaveError,
  })

  const gridState = useProjectPersistedState<{ enabled: boolean; denominator: number }>({
    projectId: options.projectId,
    ...projectPreferenceStorage('grid', () => ({ ...DEFAULT_GRID }), {
      load: loadGridSettings,
      save: (projectId, value) => saveGridSettings(projectId, value.enabled, value.denominator),
    }),
    onSaveAsyncError: onLocalSaveError,
  })

  const loopState = useProjectPersistedState<{ enabled: boolean; startSec: number; endSec: number }>({
    projectId: options.projectId,
    ...projectPreferenceStorage('loop', () => ({ ...DEFAULT_LOOP })),
    subscribeToChanges: subscribeToLocalProjectChanges,
    onSaveAsyncError: onLocalSaveError,
  })

  const scaleState = useProjectPersistedState<number>({
    projectId: options.projectId,
    ...projectPreferenceStorage('timelineScale', () => DEFAULT_PIXELS_PER_SECOND, { load: loadTimelineScale, save: saveTimelineScale }),
    onSaveAsyncError: onLocalSaveError,
  })

  const syncMix = syncMixState.value
  const setSyncMix = syncMixState.setValue
  const cloudTimelineSettings = () => options.cloudTimelineSettings?.()
  const isLocalProject = () => isLocalId('project', options.projectId())

  const bpm = () => isLocalProject()
    ? bpmState.value()
    : cloudTimelineSettings()?.tempoBpm ?? DEFAULT_BPM

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
    : cloudTimelineSettings()?.loopEnabled ?? DEFAULT_LOOP.enabled

  const loopStartSec = () => isLocalProject()
    ? loopState.value().startSec
    : cloudTimelineSettings()?.loopStartSec ?? DEFAULT_LOOP.startSec

  const loopEndSec = () => isLocalProject()
    ? loopState.value().endSec
    : cloudTimelineSettings()?.loopEndSec ?? DEFAULT_LOOP.endSec

  const pixelsPerSecond = () => clampPixelsPerSecond(scaleState.value())

  const isBooleanUpdater = (
    value: boolean | ((current: boolean) => boolean),
  ): value is (current: boolean) => boolean => typeof value === 'function'

  const clampBpm = (value: number) => {
    if (!Number.isFinite(value)) return bpm()

    return clampBpmValue(value)
  }

  const toggleSyncMix = () => {
    const projectId = options.projectId()

    if (!projectId) return
    setSyncMix((current) => !current)
  }

  const setGridEnabled = (value: boolean | ((current: boolean) => boolean)) => {
    gridState.setValue((current) => ({
      ...current,
      enabled: isBooleanUpdater(value) ? value(current.enabled) : value,
    }))
  }

  const setGridDenominator = (value: number) => {
    gridState.setValue((current) => ({ ...current, denominator: value }))
  }

  const setLoopEnabled = (value: boolean | ((current: boolean) => boolean)) => {
    if (!isLocalProject()) {
      const current = loopEnabled()
      const enabled = isBooleanUpdater(value) ? value(current) : value
      const projectId = options.projectId()

      if (projectId) options.onCloudTimelineSettingsChange?.(projectId, { loopEnabled: enabled })

      return
    }

    loopState.setValue((current) => ({
      ...current,
      enabled: isBooleanUpdater(value) ? value(current.enabled) : value,
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
