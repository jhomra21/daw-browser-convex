import { describe, expect, test } from "bun:test"
import {
  desktopHelloSchemaV1,
  desktopRequestSchemaV1,
  maxDesktopFrameBytes,
} from "./index"
import { createDesktopFrameDecoder as createDecoder, encodeDesktopFrame as encodeFrame } from "./socket"

describe("desktop protocol v1", () => {
  test("accepts only declared operations and bounded correlation IDs", () => {
    expect(desktopRequestSchemaV1.safeParse({ version: "v1", type: "request", id: "request-1", operation: "transport.seek", input: { seconds: 1 } }).success).toBe(true)
    expect(desktopRequestSchemaV1.safeParse({ version: "v1", type: "request", id: "request-1", operation: "transport.seek", input: { seconds: 86_401 } }).success).toBe(false)
    expect(desktopRequestSchemaV1.safeParse({ version: "v1", type: "request", id: "request-1", operation: "filesystem.read", input: {} }).success).toBe(false)
    expect(desktopRequestSchemaV1.safeParse({ version: "v1", type: "request", id: "request-1", operation: "lifecycle.prepareToClose", input: {} }).success).toBe(false)
    expect(desktopRequestSchemaV1.safeParse({ version: "v1", type: "request", id: "x".repeat(97), operation: "host.status", input: {} }).success).toBe(false)
  })

  test("requires protocol version and validates hello secrets", () => {
    expect(desktopHelloSchemaV1.safeParse({ version: "v1", type: "hello", secret: "a".repeat(64), client: "test" }).success).toBe(true)
    expect(desktopHelloSchemaV1.safeParse({ version: "v2", type: "hello", secret: "a".repeat(64), client: "test" }).success).toBe(false)
  })

  test("bounds framed payloads before parsing", () => {
    const frames: unknown[] = []
    const decode = createDecoder((frame) => frames.push(frame))
    const encoded = encodeFrame({ version: "v1", type: "cancel", id: "request-1" })
    decode(encoded.slice(0, 2))
    decode(encoded.slice(2))
    expect(frames).toHaveLength(1)
    const oversized = new Uint8Array(4)
    new DataView(oversized.buffer).setUint32(0, maxDesktopFrameBytes + 1)
    expect(() => decode(oversized)).toThrow("size limit")
  })
})
