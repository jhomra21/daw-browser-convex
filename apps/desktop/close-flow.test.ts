import { describe, expect, test } from "bun:test"
import { createCloseHandler } from "./close-flow"

describe("desktop close flow", () => {
  test("keeps the window open when preparation fails and discard is cancelled", async () => {
    let destroyed = 0
    let quit = 0
    const close = createCloseHandler({
      prepare: async () => false,
      confirmDiscard: async () => false,
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
      destroy: () => { destroyed += 1 },
      finishQuit: async () => { quit += 1 },
    })

    await close()

    expect(destroyed).toBe(1)
    expect(quit).toBe(1)
  })
})
