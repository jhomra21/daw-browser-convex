import { isLocalId } from '@daw-browser/shared'
import { loadLocalProjectState, saveLocalProjectState } from '~/lib/local-project-state'

type CloudPreferenceStorage<TValue> = {
  load: (projectId: string) => TValue
  save: (projectId: string, value: TValue) => void
}

// The storage of one per-project preference, chosen by the project id. A local project keeps it as a row in its own
// IndexedDB (loaded and saved asynchronously); a cloud project keeps it in browser localStorage (synchronously), or
// not at all when the preference has no cloud storage (its value then lives in the project's cloud settings).
export const projectPreferenceStorage = <TValue>(
  key: string,
  initial: () => TValue,
  cloud?: CloudPreferenceStorage<TValue>,
) => ({
  createInitial: initial,
  load: (projectId: string): TValue => isLocalId('project', projectId) || !cloud ? initial() : cloud.load(projectId),
  loadAsync: async (projectId: string): Promise<TValue | undefined> => (
    isLocalId('project', projectId) ? await loadLocalProjectState<TValue>(projectId, key) : undefined
  ),
  save: (projectId: string, value: TValue) => {
    if (!isLocalId('project', projectId)) cloud?.save(projectId, value)
  },
  saveAsync: async (projectId: string, value: TValue) => {
    if (isLocalId('project', projectId)) await saveLocalProjectState(projectId, key, value)
  },
})
