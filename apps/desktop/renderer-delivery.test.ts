import { describe, expect, test } from "bun:test"
import { deliverToRenderer, type RendererDeliveryTarget } from "./renderer-delivery"

const createTarget = (send: RendererDeliveryTarget["send"]) => {
  let destroyed = false
  return {
    target: {
      isDestroyed: () => destroyed,
      getURL: () => "daw://app/",
      send,
    },
    destroy: () => { destroyed = true },
  }
}

describe("renderer delivery", () => {
  test("sends to a current trusted target", () => {
    let sent = 0
    const { target } = createTarget(() => { sent += 1 })

    expect(deliverToRenderer({
      getTarget: () => target,
      channel: "channel",
      args: [{ value: 1 }],
      sameOrigin: (url) => url === "daw://app/",
    })).toBe(true)
    expect(sent).toBe(1)
  })

  test("does not send to a destroyed target", () => {
    const { target, destroy } = createTarget(() => {
      throw new Error("send should not be called")
    })
    destroy()

    expect(deliverToRenderer({
      getTarget: () => target,
      channel: "channel",
      args: [],
      sameOrigin: () => true,
    })).toBe(false)
  })

  test("handles destruction between readiness check and send", () => {
    let destroyed = false
    let checks = 0
    const target = {
      isDestroyed: () => {
        checks += 1
        if (checks === 2) destroyed = true
        return destroyed
      },
      getURL: () => "daw://app/",
      send: () => { throw new Error("send should not be called") },
    }

    expect(deliverToRenderer({
      getTarget: () => target,
      channel: "channel",
      args: [],
      sameOrigin: () => true,
    })).toBe(false)
  })

  test("handles Electron destruction during send", () => {
    const { target, destroy } = createTarget(() => {
      destroy()
      throw new Error("Object has been destroyed")
    })

    expect(deliverToRenderer({
      getTarget: () => target,
      channel: "channel",
      args: [],
      sameOrigin: () => true,
    })).toBe(false)
  })

  test("only suppresses Electron destruction errors", () => {
    const { target } = createTarget(() => {
      throw new Error("unexpected send failure")
    })

    expect(() => deliverToRenderer({
      getTarget: () => target,
      channel: "channel",
      args: [],
      sameOrigin: () => true,
    })).toThrow("unexpected send failure")
  })

  test("does not send while quit is finishing", () => {
    let sent = 0
    const { target } = createTarget(() => { sent += 1 })

    expect(deliverToRenderer({
      getTarget: () => target,
      channel: "channel",
      args: [],
      sameOrigin: () => true,
      isFinishingQuit: () => true,
    })).toBe(false)
    expect(sent).toBe(0)
  })

  test("does not send to an untrusted origin", () => {
    let sent = 0
    const { target } = createTarget(() => { sent += 1 })

    expect(deliverToRenderer({
      getTarget: () => target,
      channel: "channel",
      args: [],
      sameOrigin: () => false,
    })).toBe(false)
    expect(sent).toBe(0)
  })

  test("rechecks current target identity before sending", () => {
    let sent = 0
    const first = createTarget(() => { sent += 1 })
    const second = createTarget(() => { sent += 1 })
    let current: RendererDeliveryTarget | undefined = first.target

    expect(deliverToRenderer({
      getTarget: () => {
        const target = current
        current = second.target
        return target
      },
      channel: "channel",
      args: [],
      sameOrigin: () => true,
    })).toBe(false)
    expect(sent).toBe(0)
  })
})
