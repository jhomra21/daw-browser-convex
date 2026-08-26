import { describe, expect, test } from "bun:test"
import { createMidiAccessController, type MidiAccessStatus, type MidiInputDescriptor } from "./midi-access"

type FakeMessage = { data: number[]; timeStamp: number }

const createInput = (
  id: string,
  state: "connected" | "disconnected" = "connected",
  close: () => Promise<object> = async () => ({}),
) => {
  const listeners = new Set<(event: FakeMessage) => void>()
  let closeCount = 0
  return {
    id,
    name: `Name ${id}`,
    manufacturer: `Maker ${id}`,
    state,
    addEventListener: (_type: "midimessage", listener: (event: FakeMessage) => void) => listeners.add(listener),
    removeEventListener: (_type: "midimessage", listener: (event: FakeMessage) => void) => listeners.delete(listener),
    close: () => {
      closeCount += 1
      return close()
    },
    emit: (data: number[]) => {
      for (const listener of listeners) listener({ data, timeStamp: 12 })
    },
    listenerCount: () => listeners.size,
    getCloseCount: () => closeCount,
  }
}

const createAccess = (inputs: ReturnType<typeof createInput>[]) => {
  const listeners = new Set<() => void>()
  return {
    inputs: new Map(inputs.map((input) => [input.id, input])),
    addEventListener: (_type: "statechange", listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: "statechange", listener: () => void) => listeners.delete(listener),
    change: () => {
      for (const listener of listeners) listener()
    }
  }
}

const createController = (
  access: ReturnType<typeof createAccess>,
  initialSelectedInputIds: string[] = [],
) => {
  const statuses: MidiAccessStatus[] = []
  const inputs: MidiInputDescriptor[][] = []
  const persistedIds: string[][] = []
  const controller = createMidiAccessController({
    isSupported: () => true,
    requestAccess: async () => access,
    initialSelectedInputIds,
    onSelectedInputIdsChange: (ids) => persistedIds.push(ids),
    onStatusChange: (status) => statuses.push(status),
    onInputsChange: (nextInputs) => inputs.push(nextInputs),
  })
  return { controller, statuses, inputs, persistedIds }
}

describe("createMidiAccessController", () => {
  test("requests access only explicitly and attaches selected connected ports once", async () => {
    const input = createInput("input-a")
    const access = createAccess([input])
    const { controller, statuses } = createController(access, ["input-a"])

    expect(statuses).toEqual(["idle"])
    expect(input.listenerCount()).toBe(0)
    await controller.requestAccess()
    await controller.requestAccess()

    expect(statuses).toEqual(["idle", "requesting", "ready"])
    expect(input.listenerCount()).toBe(1)
  })

  test("reports unsupported and denied access without attaching inputs", async () => {
    const statuses: MidiAccessStatus[] = []
    const unsupported = createMidiAccessController({
      isSupported: () => false,
      requestAccess: async () => createAccess([]),
      initialSelectedInputIds: [],
      onSelectedInputIdsChange: () => {},
      onStatusChange: (status) => statuses.push(status),
      onInputsChange: () => {},
    })
    await unsupported.requestAccess()
    expect(statuses).toEqual(["unsupported"])

    const deniedStatuses: MidiAccessStatus[] = []
    const denied = createMidiAccessController({
      isSupported: () => true,
      requestAccess: async () => Promise.reject(new DOMException("", "NotAllowedError")),
      initialSelectedInputIds: [],
      onSelectedInputIdsChange: () => {},
      onStatusChange: (status) => deniedStatuses.push(status),
      onInputsChange: () => {},
    })
    await denied.requestAccess()
    expect(deniedStatuses).toEqual(["idle", "requesting", "denied"])
  })

  test("selects, deselects, resets, and isolates subscribers", async () => {
    const input = createInput("input-a")
    const { controller, persistedIds } = createController(createAccess([input]))
    const events: string[] = []
    const resets: string[] = []
    controller.subscribe(() => { throw new Error("isolated") })
    controller.subscribe((event) => events.push(event.kind))
    controller.subscribeSourceReset((event) => resets.push(event.sourceId))

    await controller.requestAccess()
    controller.setInputSelected("input-a", true)
    input.emit([0x90, 60, 100])
    controller.panic()
    controller.setInputSelected("input-a", false)

    expect(events).toEqual(["note-on"])
    expect(resets).toEqual(["input-a", "input-a"])
    expect(persistedIds).toEqual([["input-a"], []])
    expect(input.listenerCount()).toBe(0)
    expect(input.getCloseCount()).toBe(1)
  })

  test("closes disconnected and disposed inputs", async () => {
    const input = createInput("input-a")
    const access = createAccess([input])
    const { controller, inputs } = createController(access, ["input-a"])
    const resets: string[] = []
    controller.subscribeSourceReset((event) => resets.push(event.sourceId))

    await controller.requestAccess()
    input.state = "disconnected"
    access.change()
    expect(input.listenerCount()).toBe(0)
    expect(input.getCloseCount()).toBe(1)
    expect(resets).toEqual(["input-a"])
    expect(inputs.at(-1)).toContainEqual(expect.objectContaining({ id: "input-a", connected: false, selected: true }))

    input.state = "connected"
    access.change()
    expect(input.listenerCount()).toBe(1)
    controller.dispose()
    expect(input.listenerCount()).toBe(0)
    expect(input.getCloseCount()).toBe(2)
    expect(resets).toEqual(["input-a", "input-a"])
  })

  test("closes the exact replaced input without closing its replacement", async () => {
    const original = createInput("input-a")
    const replacement = createInput("input-a")
    const access = createAccess([original])
    const { controller } = createController(access, ["input-a"])

    await controller.requestAccess()
    access.inputs.set("input-a", replacement)
    access.change()

    expect(original.listenerCount()).toBe(0)
    expect(original.getCloseCount()).toBe(1)
    expect(replacement.listenerCount()).toBe(1)
    expect(replacement.getCloseCount()).toBe(0)
  })

  test("handles rejected close promises", async () => {
    const input = createInput("input-a", "connected", async () => {
      throw new Error("close failed")
    })
    const { controller } = createController(createAccess([input]), ["input-a"])

    await controller.requestAccess()
    controller.setInputSelected("input-a", false)
    await Promise.resolve()

    expect(input.listenerCount()).toBe(0)
    expect(input.getCloseCount()).toBe(1)
  })
})
