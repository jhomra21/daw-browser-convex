import { createEffect, createSignal, on, onCleanup, type Accessor } from 'solid-js'
import { registerPendingLocalProjectWriteFlusher } from '~/lib/local-project-pending-writes'

type RoomPersistedSetter<TValue> = (value: Exclude<TValue, Function> | ((current: TValue) => TValue)) => TValue

type UseRoomPersistedStateOptions<TValue> = {
  projectId: Accessor<string>
  createInitial: () => TValue
  load: (projectId: string) => TValue
  loadAsync?: (projectId: string) => Promise<TValue | undefined>
  save: (projectId: string, value: TValue) => void
  saveAsync?: (projectId: string, value: TValue) => Promise<void>
  onSaveAsyncError?: (error: unknown) => void
}

type UseRoomPersistedStateReturn<TValue> = {
  value: Accessor<TValue>
  isHydrated: Accessor<boolean>
  setValue: RoomPersistedSetter<TValue>
  setValueSilently: RoomPersistedSetter<TValue>
}

export function useProjectPersistedState<TValue>(
  options: UseRoomPersistedStateOptions<TValue>,
): UseRoomPersistedStateReturn<TValue> {
  const initialProjectId = options.projectId()
  const [currentValue, setCurrentValue] = createSignal(initialProjectId ? options.load(initialProjectId) : options.createInitial())
  const [asyncHydrated, setAsyncHydrated] = createSignal(!options.loadAsync || !initialProjectId)
  let hydratedProjectId = initialProjectId
  let valueRevision = 0
  const pendingAsyncSavesByProject = new Map<string, Set<Promise<void>>>()
  const registeredFlushers = new Map<string, () => void>()

  const trackAsyncSave = (projectId: string, save: Promise<void>) => {
    const pendingAsyncSaves = pendingAsyncSavesByProject.get(projectId) ?? new Set<Promise<void>>()
    pendingAsyncSaves.add(save)
    pendingAsyncSavesByProject.set(projectId, pendingAsyncSaves)
    void save.finally(() => {
      pendingAsyncSaves.delete(save)
      if (pendingAsyncSaves.size === 0) pendingAsyncSavesByProject.delete(projectId)
    }).catch(() => undefined)
  }

  const ensureProjectFlusher = (projectId: string) => {
    if (registeredFlushers.has(projectId)) return
    registeredFlushers.set(projectId, registerPendingLocalProjectWriteFlusher('project-state', projectId, async () => {
      await Promise.all(Array.from(pendingAsyncSavesByProject.get(projectId) ?? []))
    }))
  }

  const syncHydratedValue = () => {
    const projectId = options.projectId()
    if (projectId === hydratedProjectId) return
    hydratedProjectId = projectId
    valueRevision += 1
    if (!projectId) {
      setCurrentValue(() => options.createInitial())
      setAsyncHydrated(true)
      return
    }
    setCurrentValue(() => options.load(projectId))
    setAsyncHydrated(!options.loadAsync)
  }

  const value: Accessor<TValue> = () => {
    syncHydratedValue()
    return currentValue()
  }

  createEffect(on(options.projectId, (projectId) => {
    syncHydratedValue()
    if (!projectId || !options.loadAsync) return
    const loadRevision = valueRevision
    setAsyncHydrated(false)
    void options.loadAsync(projectId).then((loaded) => {
      if (options.projectId() !== projectId || valueRevision !== loadRevision) return
      if (loaded !== undefined) setCurrentValue(() => loaded)
      setAsyncHydrated(true)
    }).catch(() => {
      if (options.projectId() === projectId && valueRevision === loadRevision) setAsyncHydrated(true)
    })
  }, { defer: false }))

  const applyValue: RoomPersistedSetter<TValue> = (next) => {
    syncHydratedValue()
    valueRevision += 1
    setAsyncHydrated(true)
    return setCurrentValue(next)
  }

  const setPersistedValue: RoomPersistedSetter<TValue> = (next) => {
    syncHydratedValue()
    const previous = currentValue()
    const resolved = setCurrentValue(next)
    setAsyncHydrated(true)
    const projectId = options.projectId()
    if (projectId && resolved !== previous) {
      valueRevision += 1
      options.save(projectId, resolved)
      if (options.saveAsync) {
        ensureProjectFlusher(projectId)
        const save = options.saveAsync(projectId, resolved)
        void save.catch((error) => {
          options.onSaveAsyncError?.(error)
        })
        trackAsyncSave(projectId, save)
      }
    }
    return resolved
  }

  onCleanup(() => {
    const cleanupEntries = Array.from(registeredFlushers.entries())
    registeredFlushers.clear()
    void Promise.all(cleanupEntries.map(async ([projectId, unregister]) => {
      await Promise.allSettled(Array.from(pendingAsyncSavesByProject.get(projectId) ?? []))
      unregister()
    }))
  })

  return {
    value,
    isHydrated: asyncHydrated,
    setValue: setPersistedValue,
    setValueSilently: applyValue,
  }
}
