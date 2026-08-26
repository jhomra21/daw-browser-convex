import { describe, expect, test } from "bun:test"
import { createNativeVstParameterQueue } from "./native-vst-parameter-queue"

const decodePayload = (payload: Uint8Array) => {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const instanceLength = view.getUint32(0, true)
  const instanceId = new TextDecoder().decode(payload.subarray(4, 4 + instanceLength))
  const countOffset = 4 + instanceLength
  const count = view.getUint32(countOffset, true)
  return {
    instanceId,
    events: Array.from({ length: count }, (_, index) => ({
      id: view.getUint32(countOffset + 4 + index * 16, true),
      value: view.getFloat64(countOffset + 12 + index * 16, true),
    })),
  }
}

describe("native VST parameter queue", () => {
  test("sends the latest value after an in-flight request", async () => {
    const payloads: Uint8Array[] = []
    let release: (() => void) | undefined
    let sends = 0
    const queue = createNativeVstParameterQueue(async (payload) => {
      payloads.push(payload)
      sends += 1
      if (sends === 1) {
        await new Promise<void>((resolve) => { release = resolve })
      }
      return { ok: true as const }
    })

    const first = queue.enqueue({ instanceId: "one", id: 7, value: 0.1 })
    await Promise.resolve()
    const second = queue.enqueue({ instanceId: "one", id: 7, value: 0.9 })
    release?.()
    expect(await first).toBe("superseded")
    expect(await second).toBe("delivered")

    expect(payloads).toHaveLength(2)
    expect(decodePayload(payloads[0] ?? new Uint8Array()).events[0]?.value).toBe(0.1)
    expect(decodePayload(payloads[1] ?? new Uint8Array()).events[0]?.value).toBe(0.9)
  })

  test("groups multiple parameters for one instance into one payload", async () => {
    const payloads: Uint8Array[] = []
    const queue = createNativeVstParameterQueue(async (payload) => {
      payloads.push(payload)
      return { ok: true as const }
    })

    const first = queue.enqueue({ instanceId: "one", id: 7, value: 0.5 })
    const second = queue.enqueue({ instanceId: "one", id: 8, value: 0.75 })
    expect(await first).toBe("delivered")
    expect(await second).toBe("delivered")

    expect(payloads).toHaveLength(1)
    expect(decodePayload(payloads[0] ?? new Uint8Array())).toEqual({
      instanceId: "one",
      events: [
        { id: 7, value: 0.5 },
        { id: 8, value: 0.75 },
      ],
    })
  })

  test("serializes different instances into separate payloads", async () => {
    const payloads: Uint8Array[] = []
    const queue = createNativeVstParameterQueue(async (payload) => {
      payloads.push(payload)
      return { ok: true as const }
    })

    const first = queue.enqueue({ instanceId: "one", id: 7, value: 0.5 })
    const second = queue.enqueue({ instanceId: "two", id: 8, value: 0.75 })
    expect(await first).toBe("delivered")
    expect(await second).toBe("delivered")

    expect(payloads.map((payload) => decodePayload(payload).instanceId)).toEqual(["one", "two"])
  })

  test("does not self-sustain rejected payloads and recovers after fresh input", async () => {
    let attempts = 0
    let accept = false
    const queue = createNativeVstParameterQueue(async () => {
      attempts += 1
      return accept ? { ok: true } : { ok: false, error: "unavailable" }
    })

    expect(await queue.enqueue({ instanceId: "one", id: 7, value: 0.5 })).toBe("rejected")
    await Promise.resolve()
    expect(attempts).toBe(1)

    accept = true
    expect(await queue.enqueue({ instanceId: "one", id: 7, value: 0.75 })).toBe("delivered")
    expect(attempts).toBe(2)
  })

  test("does not self-sustain thrown rejections and recovers after fresh input", async () => {
    let attempts = 0
    let accept = false
    const queue = createNativeVstParameterQueue(async () => {
      attempts += 1
      if (!accept) throw new Error("native host rejected")
      return { ok: true }
    })

    expect(await queue.enqueue({ instanceId: "one", id: 7, value: 0.5 })).toBe("rejected")
    expect(attempts).toBe(1)
    accept = true
    expect(await queue.enqueue({ instanceId: "one", id: 7, value: 0.75 })).toBe("delivered")
    expect(attempts).toBe(2)
  })

  test("disposal prevents sends and resolves active and pending waiters", async () => {
    let release: (() => void) | undefined
    let sends = 0
    const queue = createNativeVstParameterQueue(async () => {
      sends += 1
      await new Promise<void>((resolve) => { release = resolve })
      return { ok: true as const }
    })

    const active = queue.enqueue({ instanceId: "one", id: 7, value: 0.5 })
    await Promise.resolve()
    const pending = queue.enqueue({ instanceId: "one", id: 8, value: 0.75 })
    queue.dispose()

    expect(await active).toBe("rejected")
    expect(await pending).toBe("rejected")
    release?.()
    await Promise.resolve()
    expect(sends).toBe(1)
    expect(await queue.enqueue({ instanceId: "one", id: 9, value: 1 })).toBe("rejected")
  })

  test("keeps at most one native request active", async () => {
    let active = 0
    let maximumActive = 0
    let release: (() => void) | undefined
    const queue = createNativeVstParameterQueue(async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise<void>((resolve) => { release = resolve })
      active -= 1
      return { ok: true as const }
    })

    const first = queue.enqueue({ instanceId: "one", id: 7, value: 0.5 })
    await Promise.resolve()
    const second = queue.enqueue({ instanceId: "two", id: 8, value: 0.75 })
    release?.()
    await first
    release?.()
    await second

    expect(maximumActive).toBe(1)
  })
})
