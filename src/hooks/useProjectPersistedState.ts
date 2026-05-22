import { createEffect, createSignal, on, type Accessor } from 'solid-js'

type RoomPersistedSetter<TValue> = (value: Exclude<TValue, Function> | ((current: TValue) => TValue)) => TValue

type UseRoomPersistedStateOptions<TValue> = {
  projectId: Accessor<string>
  createInitial: () => TValue
  load: (projectId: string) => TValue
  loadAsync?: (projectId: string) => Promise<TValue | undefined>
  save: (projectId: string, value: TValue) => void
  saveAsync?: (projectId: string, value: TValue) => Promise<void>
}

type UseRoomPersistedStateReturn<TValue> = {
  value: Accessor<TValue>
  setValue: RoomPersistedSetter<TValue>
  setValueSilently: RoomPersistedSetter<TValue>
}

export function useProjectPersistedState<TValue>(
  options: UseRoomPersistedStateOptions<TValue>,
): UseRoomPersistedStateReturn<TValue> {
  const initialProjectId = options.projectId()
  const [currentValue, setCurrentValue] = createSignal(initialProjectId ? options.load(initialProjectId) : options.createInitial())
  let hydratedProjectId = initialProjectId
  let valueRevision = 0

  const syncHydratedValue = () => {
    const projectId = options.projectId()
    if (projectId === hydratedProjectId) return
    hydratedProjectId = projectId
    valueRevision += 1
    if (!projectId) {
      setCurrentValue(() => options.createInitial())
      return
    }
    setCurrentValue(() => options.load(projectId))
  }

  const value: Accessor<TValue> = () => {
    syncHydratedValue()
    return currentValue()
  }

  createEffect(on(options.projectId, (projectId) => {
    if (!projectId || !options.loadAsync) return
    const loadRevision = valueRevision
    void options.loadAsync(projectId).then((loaded) => {
      if (loaded === undefined || options.projectId() !== projectId || valueRevision !== loadRevision) return
      setCurrentValue(() => loaded)
    })
  }, { defer: false }))

  const applyValue: RoomPersistedSetter<TValue> = (next) => {
    syncHydratedValue()
    valueRevision += 1
    return setCurrentValue(next)
  }

  const setPersistedValue: RoomPersistedSetter<TValue> = (next) => {
    syncHydratedValue()
    const previous = currentValue()
    const resolved = setCurrentValue(next)
    const projectId = options.projectId()
    if (projectId && resolved !== previous) {
      valueRevision += 1
      options.save(projectId, resolved)
      if (options.saveAsync) {
        void options.saveAsync(projectId, resolved)
      }
    }
    return resolved
  }

  return {
    value,
    setValue: setPersistedValue,
    setValueSilently: applyValue,
  }
}
