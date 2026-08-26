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
})
