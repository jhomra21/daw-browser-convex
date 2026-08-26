import {
  normalizeMidiSelectedInputIds,
  parseMidiInputMessage,
  type MidiInputEvent,
  type MidiSourceReset,
} from "./midi-input"

export type MidiAccessStatus = "unsupported" | "idle" | "requesting" | "denied" | "ready" | "error"

export type MidiInputDescriptor = {
  id: string
  name: string | null
  manufacturer: string | null
  connected: boolean
  selected: boolean
}

type MidiMessage = {
  data: ReadonlyArray<number>
  timeStamp: number
}

type MidiInputPort = {
  id: string
  name: string | null
  manufacturer: string | null
  state: "connected" | "disconnected"
  addEventListener: (type: "midimessage", listener: (event: MidiMessage) => void) => void
  removeEventListener: (type: "midimessage", listener: (event: MidiMessage) => void) => void
  close: () => Promise<object>
}

type MidiAccess = {
  inputs: Iterable<[string, MidiInputPort]>
  addEventListener: (type: "statechange", listener: () => void) => void
  removeEventListener: (type: "statechange", listener: () => void) => void
}

type CreateMidiAccessControllerOptions = {
  isSupported: () => boolean
  requestAccess: () => Promise<MidiAccess>
  initialSelectedInputIds: readonly string[]
  onSelectedInputIdsChange: (ids: string[]) => void
  onStatusChange: (status: MidiAccessStatus) => void
  onInputsChange: (inputs: MidiInputDescriptor[]) => void
}

const isolateSubscribers = <T>(subscribers: ReadonlySet<(value: T) => void>, value: T) => {
  for (const subscriber of subscribers) {
    try {
      subscriber(value)
    } catch {
      // Subscribers are independent local consumers.
    }
  }
}

type MidiAccessController = {
  requestAccess: () => Promise<void>
  setSelectedInputIds: (ids: readonly string[]) => void
  setInputSelected: (id: string, selected: boolean) => void
  subscribe: (subscriber: (event: MidiInputEvent) => void) => () => void
  subscribeSourceReset: (subscriber: (event: MidiSourceReset) => void) => () => void
  panic: () => void
  dispose: () => void
}

export const createMidiAccessController = (
  options: CreateMidiAccessControllerOptions,
): MidiAccessController => {
  const selectedIds = new Set(normalizeMidiSelectedInputIds(options.initialSelectedInputIds))
  const inputSubscribers = new Set<(event: MidiInputEvent) => void>()
  const resetSubscribers = new Set<(event: MidiSourceReset) => void>()
  const listeners = new Map<string, { input: MidiInputPort; listener: (event: MidiMessage) => void }>()
  let access: MidiAccess | undefined
  let disposed = false
  let status: MidiAccessStatus = options.isSupported() ? "idle" : "unsupported"

  const setStatus = (next: MidiAccessStatus) => {
    if (status === next) return
    status = next
    options.onStatusChange(next)
  }

  const emitReset = (sourceId: string) => {
    const reset: MidiSourceReset = { sourceId, kind: "source-reset" }
    isolateSubscribers(resetSubscribers, reset)
  }

  const detachInput = (sourceId: string, reset: boolean) => {
    const attached = listeners.get(sourceId)
    if (!attached) return
    attached.input.removeEventListener("midimessage", attached.listener)
    listeners.delete(sourceId)
    if (reset) emitReset(sourceId)
    void attached.input.close().catch(() => {
      // Detachment is complete even when the browser cannot close the port.
    })
  }

  const inputEntries = () => access ? [...access.inputs] : []

  const publishInputs = () => {
    const currentInputs = new Map(inputEntries())
    const descriptors = [...currentInputs.values()].map((input) => ({
      id: input.id,
      name: input.name,
      manufacturer: input.manufacturer,
      connected: input.state === "connected",
      selected: selectedIds.has(input.id),
    }))
    for (const id of selectedIds) {
      if (!currentInputs.has(id)) {
        descriptors.push({ id, name: null, manufacturer: null, connected: false, selected: true })
      }
    }
    options.onInputsChange(descriptors)
  }

  const refreshInputs = () => {
    if (!access || disposed) return
    const currentInputs = new Map(inputEntries())
    for (const [id, attached] of listeners) {
      const input = currentInputs.get(id)
      if (!selectedIds.has(id) || input !== attached.input || input.state !== "connected") {
        detachInput(id, true)
      }
    }
    for (const [id, input] of currentInputs) {
      if (!selectedIds.has(id) || input.state !== "connected" || listeners.has(id)) continue
      const listener = (event: MidiMessage) => {
        const normalized = parseMidiInputMessage(id, event.data, event.timeStamp)
        if (normalized) isolateSubscribers(inputSubscribers, normalized)
      }
      input.addEventListener("midimessage", listener)
      listeners.set(id, { input, listener })
    }
    publishInputs()
  }

  const handleStateChange = () => refreshInputs()

  const requestAccess = async () => {
    if (disposed || status === "unsupported" || status === "requesting" || access) return
    setStatus("requesting")
    try {
      access = await options.requestAccess()
      if (disposed) {
        access.removeEventListener("statechange", handleStateChange)
        return
      }
      access.addEventListener("statechange", handleStateChange)
      setStatus("ready")
      refreshInputs()
    } catch (error: unknown) {
      setStatus(error instanceof DOMException && error.name === "NotAllowedError" ? "denied" : "error")
    }
  }

  const setSelectedInputIds = (ids: readonly string[]) => {
    if (disposed) return
    const normalized = normalizeMidiSelectedInputIds(ids)
    if (normalized.length === selectedIds.size && normalized.every((value) => selectedIds.has(value))) return
    selectedIds.clear()
    for (const value of normalized) selectedIds.add(value)
    options.onSelectedInputIdsChange(normalized)
    refreshInputs()
  }

  const setInputSelected = (id: string, selected: boolean) => {
    if (id.length === 0) return
    const nextIds = new Set(selectedIds)
    if (selected) nextIds.add(id)
    else nextIds.delete(id)
    setSelectedInputIds([...nextIds])
  }

  const panic = () => {
    for (const sourceId of listeners.keys()) emitReset(sourceId)
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    access?.removeEventListener("statechange", handleStateChange)
    for (const sourceId of listeners.keys()) detachInput(sourceId, true)
    inputSubscribers.clear()
    resetSubscribers.clear()
  }

  options.onStatusChange(status)
  options.onInputsChange([])

  return {
    requestAccess,
    setSelectedInputIds,
    setInputSelected,
    subscribe: (subscriber) => {
      inputSubscribers.add(subscriber)
      return () => inputSubscribers.delete(subscriber)
    },
    subscribeSourceReset: (subscriber) => {
      resetSubscribers.add(subscriber)
      return () => resetSubscribers.delete(subscriber)
    },
    panic,
    dispose,
  }
}
