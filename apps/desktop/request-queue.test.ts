import { describe, expect, test } from "bun:test"
import { parseDesktopReplyError } from "@daw-browser/desktop-protocol"
import { createRequestQueue, type PreloadHostRequest, type PreloadHostResponse } from "./request-queue"

type Reply = {
  generation: number
  response: PreloadHostResponse
}

const flushPromises = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe("desktop preload request queue", () => {
  test("propagates the exact trusted actor subject", async () => {
    const actorSubject = "local:123e4567-e89b-42d3-a456-426614174000"
    let received: PreloadHostRequest | undefined
    const queue = createRequestQueue({ reply: () => undefined, queueLimit: 32 })
    queue.setRequestHandler(async (request) => {
      received = request
      return { id: request.id, result: {} }
    })

    queue.dispatch(1, {
      version: "v1",
      type: "request",
      id: "control-1",
      operation: "control.capabilities",
      input: {},
      actorSubject,
    })
    await flushPromises()

    expect(received?.actorSubject).toBe(actorSubject)
  })

  test("ignores dispatches from an older generation", () => {
    const requests: string[] = []
    const queue = createRequestQueue({ reply: () => undefined, queueLimit: 32 })

    queue.dispatch(2, { version: "v1", type: "request", id: "new", operation: "transport.status", input: {} })
    queue.dispatch(1, { version: "v1", type: "request", id: "stale", operation: "transport.status", input: {} })
    queue.setRequestHandler(async (request) => {
      requests.push(request.id)
      return { id: request.id, result: {} }
    })

    expect(requests).toEqual(["new"])
  })

  test("a newer generation cancels queued work once before accepting new work", () => {
    const replies: Reply[] = []
    const requests: string[] = []
    const queue = createRequestQueue({
      reply: (generation, response) => replies.push({ generation, response }),
      queueLimit: 32,
    })

    queue.dispatch(1, { version: "v1", type: "request", id: "old", operation: "transport.play", input: {} })
    queue.dispatch(2, { version: "v1", type: "request", id: "new", operation: "transport.status", input: {} })
    queue.setRequestHandler(async (request) => {
      requests.push(request.id)
      return { id: request.id, result: {} }
    })

    expect(requests).toEqual(["new"])
    expect(replies).toEqual([{
      generation: 1,
      response: { id: "old", error: { version: "v1", code: "cancelled", message: "The request was cancelled." } },
    }])
  })

  test("a newer generation aborts active work once and suppresses its late resolution", async () => {
    const replies: Reply[] = []
    const oldRequest = Promise.withResolvers<PreloadHostResponse>()
    const newRequest = Promise.withResolvers<PreloadHostResponse>()
    let oldSignal: AbortSignal | undefined
    const queue = createRequestQueue({
      reply: (generation, response) => replies.push({ generation, response }),
      queueLimit: 32,
    })
    queue.setRequestHandler((request) => {
      if (request.id === "old") {
        oldSignal = request.signal
        return oldRequest.promise
      }
      return newRequest.promise
    })

    queue.dispatch(1, { version: "v1", type: "request", id: "old", operation: "transport.play", input: {} })
    queue.dispatch(2, { version: "v1", type: "request", id: "new", operation: "transport.status", input: {} })
    oldRequest.resolve({ id: "old", result: {} })
    newRequest.resolve({ id: "new", result: {} })
    await flushPromises()

    expect(oldSignal?.aborted).toBe(true)
    expect(replies).toEqual([
      {
        generation: 1,
        response: { id: "old", error: { version: "v1", code: "cancelled", message: "The request was cancelled." } },
      },
      { generation: 2, response: { id: "new", result: {} } },
    ])
  })

  test("reset only advances the generation", async () => {
    const replies: Reply[] = []
    const pending = Promise.withResolvers<PreloadHostResponse>()
    let signal: AbortSignal | undefined
    const queue = createRequestQueue({
      reply: (generation, response) => replies.push({ generation, response }),
      queueLimit: 32,
    })
    queue.setRequestHandler((request) => {
      signal = request.signal
      return pending.promise
    })

    queue.dispatch(2, { version: "v1", type: "request", id: "active", operation: "transport.status", input: {} })
    queue.reset(1)
    queue.reset(2)
    expect(signal?.aborted).toBe(false)
    expect(replies).toEqual([])

    queue.reset(3)
    queue.reset(3)
    pending.resolve({ id: "active", result: {} })
    await flushPromises()

    expect(signal?.aborted).toBe(true)
    expect(replies).toEqual([{
      generation: 2,
      response: { id: "active", error: { version: "v1", code: "cancelled", message: "The request was cancelled." } },
    }])
  })

  test("removing the handler cancels queued and active requests exactly once", () => {
    const queuedReplies: PreloadHostResponse[] = []
    const queuedQueue = createRequestQueue({
      reply: (_generation, response) => queuedReplies.push(response),
      queueLimit: 32,
    })
    queuedQueue.dispatch(1, { version: "v1", type: "request", id: "queued", operation: "transport.play", input: {} })
    queuedQueue.setRequestHandler(undefined)
    queuedQueue.setRequestHandler(undefined)

    const activeReplies: PreloadHostResponse[] = []
    const pending = Promise.withResolvers<PreloadHostResponse>()
    let activeSignal: AbortSignal | undefined
    const activeQueue = createRequestQueue({
      reply: (_generation, response) => activeReplies.push(response),
      queueLimit: 32,
    })
    activeQueue.setRequestHandler((request) => {
      activeSignal = request.signal
      return pending.promise
    })
    activeQueue.dispatch(1, { version: "v1", type: "request", id: "active", operation: "transport.play", input: {} })
    activeQueue.setRequestHandler(undefined)
    activeQueue.setRequestHandler(undefined)

    expect(activeSignal?.aborted).toBe(true)
    expect(queuedReplies).toHaveLength(1)
    expect(activeReplies).toHaveLength(1)
    expect(queuedReplies[0]?.error?.code).toBe("cancelled")
    expect(activeReplies[0]?.error?.code).toBe("cancelled")
  })

  test("explicit cancellation settles queued and active requests exactly once", () => {
    const replies: PreloadHostResponse[] = []
    const queue = createRequestQueue({
      reply: (_generation, response) => replies.push(response),
      queueLimit: 32,
    })
    queue.dispatch(1, { version: "v1", type: "request", id: "queued", operation: "transport.play", input: {} })
    queue.cancel("queued")
    queue.cancel("queued")

    const pending = Promise.withResolvers<PreloadHostResponse>()
    let signal: AbortSignal | undefined
    queue.setRequestHandler((request) => {
      signal = request.signal
      return pending.promise
    })
    queue.dispatch(1, { version: "v1", type: "request", id: "active", operation: "transport.play", input: {} })
    queue.cancel("active")
    queue.cancel("active")

    expect(signal?.aborted).toBe(true)
    expect(replies).toHaveLength(2)
    expect(replies.map((reply) => reply.id)).toEqual(["queued", "active"])
    expect(replies.every((reply) => reply.error?.code === "cancelled")).toBe(true)
  })

  test("late resolution and rejection after abort emit no second reply", async () => {
    const replies: PreloadHostResponse[] = []
    const resolved = Promise.withResolvers<PreloadHostResponse>()
    const rejected = Promise.withResolvers<PreloadHostResponse>()
    const queue = createRequestQueue({
      reply: (_generation, response) => replies.push(response),
      queueLimit: 32,
    })
    queue.setRequestHandler((request) => request.id === "resolve" ? resolved.promise : rejected.promise)

    queue.dispatch(1, { version: "v1", type: "request", id: "resolve", operation: "transport.play", input: {} })
    queue.dispatch(1, { version: "v1", type: "request", id: "reject", operation: "transport.play", input: {} })
    queue.cancel("resolve")
    queue.cancel("reject")
    resolved.resolve({ id: "resolve", result: {} })
    rejected.reject(new Error("late failure"))
    await flushPromises()

    expect(replies).toHaveLength(2)
    expect(replies.every((reply) => reply.error?.code === "cancelled")).toBe(true)
  })

  test("expires queued requests before dispatching them", () => {
    let now = 0
    const replies: PreloadHostResponse[] = []
    let calls = 0
    const queue = createRequestQueue({
      reply: (_generation, response) => replies.push(response),
      now: () => now,
      queueLimit: 32,
    })

    queue.dispatch(1, { version: "v1", type: "request", id: "seek", operation: "transport.seek", input: { seconds: 12 }, deadlineMs: 10 })
    now = 10
    queue.setRequestHandler(async () => {
      calls += 1
      return { id: "seek", result: {} }
    })

    expect(calls).toBe(0)
    expect(replies).toEqual([{
      id: "seek",
      error: { version: "v1", code: "deadline-exceeded", message: "The request deadline elapsed." },
    }])
  })

  test("rejects requests beyond the queue limit without replacing queued work", () => {
    const replies: PreloadHostResponse[] = []
    const requests: string[] = []
    const queue = createRequestQueue({
      reply: (_generation, response) => replies.push(response),
      queueLimit: 1,
    })

    queue.dispatch(1, { version: "v1", type: "request", id: "first", operation: "transport.status", input: {} })
    queue.dispatch(1, { version: "v1", type: "request", id: "second", operation: "transport.status", input: {} })
    queue.setRequestHandler(async (request) => {
      requests.push(request.id)
      return { id: request.id, result: {} }
    })

    expect(requests).toEqual(["first"])
    expect(replies).toEqual([{
      id: "second",
      error: { version: "v1", code: "unavailable", message: "The timeline controller is not ready." },
    }])
  })

  test("rejects duplicate queued and active request ids without overwriting originals", async () => {
    const replies: PreloadHostResponse[] = []
    const requests: PreloadHostRequest[] = []
    const pending = Promise.withResolvers<PreloadHostResponse>()
    const queue = createRequestQueue({
      reply: (_generation, response) => replies.push(response),
      queueLimit: 32,
    })

    queue.dispatch(1, { version: "v1", type: "request", id: "duplicate", operation: "transport.seek", input: { seconds: 1 } })
    queue.dispatch(1, { version: "v1", type: "request", id: "duplicate", operation: "transport.seek", input: { seconds: 2 } })
    queue.setRequestHandler((request) => {
      requests.push(request)
      return pending.promise
    })
    queue.dispatch(1, { version: "v1", type: "request", id: "duplicate", operation: "transport.seek", input: { seconds: 3 } })
    pending.resolve({ id: "duplicate", result: {} })
    await flushPromises()

    expect(requests).toHaveLength(1)
    expect(requests[0]?.input).toEqual({ seconds: 1 })
    expect(replies).toEqual([
      {
        id: "duplicate",
        error: { version: "v1", code: "invalid-request", message: "A request with this id is already pending." },
      },
      {
        id: "duplicate",
        error: { version: "v1", code: "invalid-request", message: "A request with this id is already pending." },
      },
      { id: "duplicate", result: {} },
    ])
  })

  test("emits host transport errors for control queue failures", async () => {
    const replies: PreloadHostResponse[] = []
    let now = 0
    const deadlineQueue = createRequestQueue({
      reply: (_generation, response) => replies.push(response),
      now: () => now,
      queueLimit: 32,
    })
    deadlineQueue.dispatch(1, {
      version: "v1",
      type: "request",
      id: "deadline",
      operation: "control.capabilities",
      input: {},
      actorSubject: "local:123e4567-e89b-42d3-a456-426614174000",
      deadlineMs: 1,
    })
    now = 1
    deadlineQueue.setRequestHandler(async (request) => ({ id: request.id, result: {} }))

    const cancelQueue = createRequestQueue({
      reply: (_generation, response) => replies.push(response),
      queueLimit: 32,
    })
    cancelQueue.dispatch(1, {
      version: "v1",
      type: "request",
      id: "cancel",
      operation: "control.capabilities",
      input: {},
      actorSubject: "local:123e4567-e89b-42d3-a456-426614174000",
    })
    cancelQueue.cancel("cancel")

    const unavailableQueue = createRequestQueue({
      reply: (_generation, response) => replies.push(response),
      queueLimit: 0,
    })
    unavailableQueue.dispatch(1, {
      version: "v1",
      type: "request",
      id: "unavailable",
      operation: "control.capabilities",
      input: {},
      actorSubject: "local:123e4567-e89b-42d3-a456-426614174000",
    })

    const failedQueue = createRequestQueue({
      reply: (_generation, response) => replies.push(response),
      queueLimit: 32,
    })
    failedQueue.setRequestHandler(async () => {
      throw new Error("host failure")
    })
    failedQueue.dispatch(1, {
      version: "v1",
      type: "request",
      id: "failed",
      operation: "control.capabilities",
      input: {},
      actorSubject: "local:123e4567-e89b-42d3-a456-426614174000",
    })
    await flushPromises()

    expect(replies).toHaveLength(4)
    for (const reply of replies) {
      expect(() => parseDesktopReplyError("control.capabilities", reply.error)).not.toThrow()
      if (!reply.error) throw new Error("Expected a queue failure reply.")
      expect(["deadline-exceeded", "cancelled", "unavailable", "internal"]).toContain(reply.error.code)
    }
    expect(replies.map((reply) => reply.error?.message)).toEqual([
      "The request deadline elapsed.",
      "The request was cancelled.",
      "The timeline controller is not ready.",
      "The timeline operation failed.",
    ])
  })

  test("retains host error codes for queue failures", async () => {
    const replies: PreloadHostResponse[] = []
    let now = 0
    const deadlineQueue = createRequestQueue({
      reply: (_generation, response) => replies.push(response),
      now: () => now,
      queueLimit: 32,
    })
    deadlineQueue.dispatch(1, {
      version: "v1",
      type: "request",
      id: "deadline",
      operation: "transport.status",
      input: {},
      deadlineMs: 1,
    })
    now = 1
    deadlineQueue.setRequestHandler(async (request) => ({ id: request.id, result: {} }))

    const cancelQueue = createRequestQueue({
      reply: (_generation, response) => replies.push(response),
      queueLimit: 32,
    })
    cancelQueue.dispatch(1, { version: "v1", type: "request", id: "cancel", operation: "transport.status", input: {} })
    cancelQueue.cancel("cancel")

    const unavailableQueue = createRequestQueue({
      reply: (_generation, response) => replies.push(response),
      queueLimit: 0,
    })
    unavailableQueue.dispatch(1, { version: "v1", type: "request", id: "unavailable", operation: "transport.status", input: {} })

    const failedQueue = createRequestQueue({
      reply: (_generation, response) => replies.push(response),
      queueLimit: 32,
    })
    failedQueue.setRequestHandler(async () => {
      throw new Error("host failure")
    })
    failedQueue.dispatch(1, { version: "v1", type: "request", id: "failed", operation: "transport.status", input: {} })
    await flushPromises()

    expect(replies.map((reply) => reply.error?.code)).toEqual([
      "deadline-exceeded",
      "cancelled",
      "unavailable",
      "internal",
    ])
    for (const reply of replies) {
      expect(() => parseDesktopReplyError("transport.status", reply.error)).not.toThrow()
    }
  })
})
