import { createEffect, createSignal, onCleanup, type Accessor, untrack } from 'solid-js'
import { registerPendingLocalProjectWriteFlusher } from '~/lib/local-project-pending-writes'

type RoomPersistedSetter<TValue> = (value: Exclude<TValue, Function> | ((current: TValue) => TValue)) => TValue

type UseRoomPersistedStateOptions<TValue> = {
  projectId: Accessor<string>
  createInitial: () => TValue
  load: (projectId: string) => TValue
  loadAsync?: (projectId: string) => Promise<TValue | undefined>
  subscribeToChanges?: (projectId: string, refresh: () => void) => () => void
  save: (projectId: string, value: TValue) => void
  saveAsync?: (projectId: string, value: TValue) => Promise<void>
  onSaveAsyncError?: (projectId: string, error: Error) => void
}

type UseRoomPersistedStateReturn<TValue> = {
  value: Accessor<TValue>
  isHydrated: Accessor<boolean>
  setValue: RoomPersistedSetter<TValue>
  setValueSilently: RoomPersistedSetter<TValue>
  commitValue: (value: TValue) => void
}

export function useProjectPersistedState<TValue>(
  options: UseRoomPersistedStateOptions<TValue>,
): UseRoomPersistedStateReturn<TValue> {
  const initialProjectId = options.projectId()
  const initialValue = initialProjectId ? options.load(initialProjectId) : options.createInitial()
  const [currentValue, setCurrentValue] = createSignal<TValue>(() => initialValue)
  // The latest value and hydration flag are kept here so a read right after a write or a project switch sees them;
  // the signals publish them to subscribers at the next flush.
  let latest = initialValue
  let latestHydrated = !options.loadAsync || !initialProjectId
  const [asyncHydrated, setAsyncHydrated] = createSignal(latestHydrated)
  let hydratedProjectId = initialProjectId
  let unpublishedSwitch = false
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

  // Reads may run in a tracking scope, so a project switch only updates the local state here.
  const syncHydratedValue = () => {
    const projectId = options.projectId()

    if (projectId === hydratedProjectId) return
    hydratedProjectId = projectId
    valueRevision += 1
    latest = projectId ? options.load(projectId) : options.createInitial()
    latestHydrated = !projectId || !options.loadAsync
    unpublishedSwitch = true
  }

  const publishValue = (next: TValue) => {
    latest = next
    setCurrentValue(() => next)
  }

  const publishHydrated = (next: boolean) => {
    latestHydrated = next
    setAsyncHydrated(next)
  }

  // Writers and the project effect run outside tracking scopes, where the switch can reach the signals.
  const publishSwitch = () => {
    syncHydratedValue()

    if (!unpublishedSwitch) return
    unpublishedSwitch = false
    publishValue(latest)
    publishHydrated(latestHydrated)
  }

  const value: Accessor<TValue> = () => {
    syncHydratedValue()
    currentValue()

    return latest
  }

  const isHydrated: Accessor<boolean> = () => {
    syncHydratedValue()
    asyncHydrated()

    return latestHydrated
  }

  createEffect(
    options.projectId,
    (projectId) => untrack(() => {
      publishSwitch()

      if (!projectId || !options.loadAsync) return
      const load = options.loadAsync

      const refresh = () => {
        const loadRevision = ++valueRevision
        void load(projectId).then((loaded) => {
          if (options.projectId() !== projectId || valueRevision !== loadRevision) return

          if (loaded !== undefined) publishValue(loaded)
          publishHydrated(true)
        }).catch(() => {
          if (options.projectId() === projectId && valueRevision === loadRevision) publishHydrated(true)
        })
      }

      publishHydrated(false)
      const unsubscribe = options.subscribeToChanges?.(projectId, refresh)

      if (unsubscribe) onCleanup(unsubscribe)
      refresh()
    }),
  )

  const applyValue: RoomPersistedSetter<TValue> = (next) => {
    publishSwitch()
    valueRevision += 1
    publishHydrated(true)
    latest = setCurrentValue(next)

    return latest
  }

  const persistValue = (projectId: string, value: TValue) => {
    options.save(projectId, value)

    if (!options.saveAsync) return
    ensureProjectFlusher(projectId)
    const save = options.saveAsync(projectId, value)
    void save.catch((error) => {
      options.onSaveAsyncError?.(projectId, error instanceof Error ? error : new Error('Project state save failed.'))
    })
    trackAsyncSave(projectId, save)
  }

  const setPersistedValue: RoomPersistedSetter<TValue> = (next) => {
    publishSwitch()
    const previous = latest
    const resolved = setCurrentValue(next)
    latest = resolved
    publishHydrated(true)
    const projectId = options.projectId()

    if (projectId && resolved !== previous) {
      valueRevision += 1
      persistValue(projectId, resolved)
    }

    return resolved
  }

  const commitValue = (value: TValue) => {
    publishSwitch()
    const projectId = options.projectId()

    if (!projectId) return
    valueRevision += 1
    publishHydrated(true)
    publishValue(value)
    persistValue(projectId, value)
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
    isHydrated,
    setValue: setPersistedValue,
    setValueSilently: applyValue,
    commitValue,
  }
}
