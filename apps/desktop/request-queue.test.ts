import { describe, expect, test } from "bun:test"
import { createRequestQueue, type PreloadHostResponse } from "./request-queue"

describe("desktop preload request queue", () => {
  test("does not dispatch a queued play after cancellation", () => {
    const replies: PreloadHostResponse[] = []
    const queue = createRequestQueue({ reply: (_generation, response) => replies.push(response), queueLimit: 32 })
    let calls = 0

    queue.dispatch(1, { version: "v1", type: "request", id: "play-1", operation: "transport.play", input: {}, deadlineMs: 1_000 })
    queue.cancel("play-1")
    queue.setRequestHandler(async () => {
      calls += 1
      return { id: "play-1", result: { state: "playing", playheadSec: 0 } }
    })

    expect(calls).toBe(0)
    expect(replies).toEqual([{ id: "play-1", error: { version: "v1", code: "cancelled", message: "The request was cancelled." } }])
  })

  test("does not dispatch a queued seek after its deadline", () => {
    let now = 0
    const replies: PreloadHostResponse[] = []
    const queue = createRequestQueue({ reply: (_generation, response) => replies.push(response), now: () => now, queueLimit: 32 })
    let calls = 0

    queue.dispatch(1, { version: "v1", type: "request", id: "seek-1", operation: "transport.seek", input: { seconds: 12 }, deadlineMs: 10 })
    now = 10
    queue.setRequestHandler(async () => {
      calls += 1
      return { id: "seek-1", result: { state: "paused", playheadSec: 12 } }
    })

    expect(calls).toBe(0)
    expect(replies).toEqual([{ id: "seek-1", error: { version: "v1", code: "deadline-exceeded", message: "The request deadline elapsed." } }])
  })

  test("dispatches a queued request once after controller registration", () => {
    const queue = createRequestQueue({ reply: () => undefined, queueLimit: 32 })
    let calls = 0

    queue.dispatch(1, { version: "v1", type: "request", id: "status-1", operation: "transport.status", input: {}, deadlineMs: 1_000 })
    queue.setRequestHandler(async () => {
      calls += 1
      return { id: "status-1", result: { state: "stopped", playheadSec: 0 } }
    })

    expect(calls).toBe(1)
  })
})
