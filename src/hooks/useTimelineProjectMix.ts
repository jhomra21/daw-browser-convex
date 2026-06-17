import { type Accessor } from 'solid-js'
import { normalizeMasterVolume } from '@daw-browser/shared'
import { loadLocalProjectState, saveLocalProjectState } from '~/lib/local-project-state'
import {
  defaultProjectMixState,
  normalizeProjectMixState,
  type ProjectMixState,
} from '~/lib/project-mix-state'
import { useProjectPersistedState } from './useProjectPersistedState'

type UseTimelineProjectMixOptions = {
  projectId: Accessor<string>
  onLocalSaveFailed?: (message: string) => void
}

const loadProjectMixState = async (projectId: string): Promise<ProjectMixState | undefined> => {
  const loaded = await loadLocalProjectState<ProjectMixState>(projectId, 'projectMix')
  return loaded ? normalizeProjectMixState(loaded) : undefined
}

const saveProjectMixState = async (projectId: string, value: ProjectMixState): Promise<void> => {
  await saveLocalProjectState(projectId, 'projectMix', normalizeProjectMixState(value))
}

export function useTimelineProjectMix(options: UseTimelineProjectMixOptions) {
  const persistedState = useProjectPersistedState<ProjectMixState>({
    projectId: options.projectId,
    createInitial: defaultProjectMixState,
    load: defaultProjectMixState,
    loadAsync: loadProjectMixState,
    save: () => undefined,
    saveAsync: saveProjectMixState,
    onSaveAsyncError: (error) => {
      options.onLocalSaveFailed?.(error instanceof Error ? error.message : 'Project mix could not be saved.')
    },
  })

  return {
    state: persistedState.value,
    isHydrated: persistedState.isHydrated,
    setMasterVolume: (volume: number) => {
      const masterVolume = normalizeMasterVolume(volume)
      persistedState.setValue((current) => {
        if (normalizeMasterVolume(current.masterVolume) === masterVolume) return current
        return { ...current, masterVolume }
      })
    },
  }
}
