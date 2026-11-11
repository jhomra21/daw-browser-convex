import { describe, expect, test } from "bun:test"
import { createCloseHandler } from "./close-flow"

describe("desktop close flow", () => {
  test("keeps the window open when preparation fails and discard is cancelled", async () => {
    let destroyed = 0
    let quit = 0
    const close = createCloseHandler({
      prepare: async () => false,
      confirmDiscard: async () => false,
      beginQuit: () => {},
      destroy: () => { destroyed += 1 },
      finishQuit: async () => { quit += 1 },
    })

    await close()

    expect(destroyed).toBe(0)
    expect(quit).toBe(0)
  })

  test("destroys only after an explicit discard confirmation when preparation fails", async () => {
    let destroyed = 0
    let quit = 0
    const close = createCloseHandler({
      prepare: async () => false,
      confirmDiscard: async () => true,
      beginQuit: () => {},
      destroy: () => { destroyed += 1 },
      finishQuit: async () => { quit += 1 },
    })

    await close()

    expect(destroyed).toBe(1)
    expect(quit).toBe(1)
  })

  test("begins quitting before destroying the window", async () => {
    const events: string[] = []
    const close = createCloseHandler({
      prepare: async () => true,
      confirmDiscard: async () => false,
      beginQuit: () => { events.push("beginQuit") },
      destroy: () => { events.push("destroy") },
      finishQuit: async () => { events.push("finishQuit") },
    })

    await close()

    expect(events).toEqual(["beginQuit", "destroy", "finishQuit"])
  })
  test("waits for native finalization before preparation or window destruction", async () => {
    const events: string[] = []
    let settle: (ready: boolean) => void = () => {}
    const finishing = new Promise<boolean>((resolve) => { settle = resolve })
    const close = createCloseHandler({
      waitForRecording: () => finishing,
      onError: () => { events.push("error") },
      prepare: async () => { events.push("prepare"); return true },
      confirmDiscard: async () => true,
      beginQuit: () => { events.push("beginQuit") },
      destroy: () => { events.push("destroy") },
      finishQuit: async () => { events.push("finishQuit") },
    })
    const closing = close()
    await Promise.resolve()
    expect(events).toEqual([])
    settle(false) // Keep Open: no preparation/discard/destruction.
    await closing
    expect(events).toEqual([])
    settle = () => {}
  })
  test("keeps window and renderer alive on quit preparation error", async () => {
    const events: string[] = []
    const close = createCloseHandler({
      waitForRecording: async () => true,
      onError: () => { events.push("error") },
      prepare: async () => { throw new Error("save failed") },
      confirmDiscard: async () => { events.push("discard"); return true },
      beginQuit: () => { events.push("beginQuit") },
      destroy: () => { events.push("destroy") },
      finishQuit: async () => { events.push("finishQuit") },
    })
    await close()
    expect(events).toEqual(["error"])
  })
  test("rechecks a newly accepted Finish after renderer close preparation", async () => {
    const events: string[] = []
    let waits = 0
    const close = createCloseHandler({
      waitForRecording: async () => { waits += 1; return waits === 1 },
      onError: () => {},
      prepare: async () => { events.push("prepare"); return true },
      confirmDiscard: async () => true,
      beginQuit: () => { events.push("beginQuit") },
      destroy: () => { events.push("destroy") },
      finishQuit: async () => {},
    })
    await close()
    expect(events).toEqual(["prepare"])
    expect(waits).toBe(2)
  })
  test("a pre-destroy native teardown failure leaves the window open", async () => {
    const events: string[] = []
    const close = createCloseHandler({
      waitForRecording: async () => true,
      prepare: async () => true,
      prepareQuit: async () => { throw new Error("native teardown failed") },
      onError: () => { events.push("error") },
      confirmDiscard: async () => true,
      beginQuit: () => { events.push("begin") },
      destroy: () => { events.push("destroy") },
      finishQuit: async () => { events.push("quit") },
    })
    await close()
    expect(events).toEqual(["error"])
  })
})
