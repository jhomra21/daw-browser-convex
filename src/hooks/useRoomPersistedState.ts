import { createSignal, type Accessor } from 'solid-js'

type RoomPersistedSetter<TValue> = (value: Exclude<TValue, Function> | ((current: TValue) => TValue)) => TValue

type UseRoomPersistedStateOptions<TValue> = {
  roomId: Accessor<string>
  createInitial: () => TValue
  load: (roomId: string) => TValue
  save: (roomId: string, value: TValue) => void
}

type UseRoomPersistedStateReturn<TValue> = {
  value: Accessor<TValue>
  setValue: RoomPersistedSetter<TValue>
  setValueSilently: RoomPersistedSetter<TValue>
}

export function useRoomPersistedState<TValue>(
  options: UseRoomPersistedStateOptions<TValue>,
): UseRoomPersistedStateReturn<TValue> {
  const initialRoomId = options.roomId()
  const [currentValue, setCurrentValue] = createSignal(initialRoomId ? options.load(initialRoomId) : options.createInitial())
  let hydratedRoomId = initialRoomId

  const syncHydratedValue = () => {
    const roomId = options.roomId()
    if (roomId === hydratedRoomId) return
    hydratedRoomId = roomId
    if (!roomId) {
      setCurrentValue(() => options.createInitial())
      return
    }
    setCurrentValue(() => options.load(roomId))
  }

  const value: Accessor<TValue> = () => {
    syncHydratedValue()
    return currentValue()
  }

  const applyValue: RoomPersistedSetter<TValue> = (next) => {
    syncHydratedValue()
    return setCurrentValue(next)
  }

  const setPersistedValue: RoomPersistedSetter<TValue> = (next) => {
    syncHydratedValue()
    const previous = currentValue()
    const resolved = setCurrentValue(next)
    const roomId = options.roomId()
    if (roomId && resolved !== previous) {
      options.save(roomId, resolved)
    }
    return resolved
  }

  return {
    value,
    setValue: setPersistedValue,
    setValueSilently: applyValue,
  }
}
