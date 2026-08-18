import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { localControlCapabilitiesV1, localControlCapabilitiesV2 } from "@daw-browser/control"
import {
  assertDesktopReplyAggregateByteLength,
  createDesktopReplyReassembler,
  maxDesktopReplyFrameBytes,
  serializeDesktopReply,
  type DesktopReplyChunkV1,
} from "./reply-chunks"
import {
  desktopReplyChunkSchemaV1,
  desktopReplySchemaV1,
  desktopProtocolVersionV2,
  maxDesktopFrameBytes,
  maxDesktopReplyBytes,
  maxDesktopReplyChunks,
  maxDesktopReplyPayloadBase64Characters,
  maxDesktopReplyPayloadBytes,
  type DesktopOperationV1,
  type DesktopJsonValue,
} from "./index"
import { encodeDesktopFrame } from "./socket"

const status = { project: null, ready: true, transport: "stopped", capabilities: { playback: true, diagnostics: true } }
const encoder = new TextEncoder()
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

const chunkForBytes = (
  bytes: Uint8Array,
  operation: DesktopOperationV1 = "host.status",
  overrides: Partial<DesktopReplyChunkV1> = {},
) => desktopReplyChunkSchemaV1.parse({
  version: "v1",
  type: "replyChunk",
  id: "reply-1",
  operation,
  index: 0,
  total: 1,
  byteLength: bytes.byteLength,
  sha256: sha256(bytes),
  payload: Buffer.from(bytes).toString("base64"),
  ...overrides,
})

const chunkForReply = (reply: DesktopJsonValue, operation: DesktopOperationV1 = "host.status") => (
  chunkForBytes(encoder.encode(JSON.stringify(reply)), operation)
)

const expectRejectedAndCleared = (
  reassembler: ReturnType<typeof createDesktopReplyReassembler>,
  value: DesktopJsonValue,
) => {
  expect(() => reassembler.push(value)).toThrow()
  expect(reassembler.pending()).toBe(0)
}

const largeControlReply = (actionCount = 60_000) => ({
  version: "v1",
  type: "reply",
  id: "control-1",
  result: {
    ...localControlCapabilitiesV1,
    actionKinds: Array.from({ length: actionCount }, (_, index) => `軌道-${index}`),
  },
})
const controlReplyWithPayload = (size: number) => ({
  version: "v1",
  type: "reply",
  id: "control-1",
  result: {
    ...localControlCapabilitiesV1,
    actionKinds: ["x".repeat(size)],
  },
})
const controlV2Reply = (actionCount = 1) => ({
  version: "v1" as const,
  type: "reply" as const,
  id: "control-v2",
  result: {
    ...localControlCapabilitiesV2,
    actionKinds: Array.from({ length: actionCount }, (_, index) => `v2-action-${index}`),
  },
})

describe("desktop reply chunks", () => {
  test("returns a regular validated reply within one frame", () => {
    const reply = desktopReplySchemaV1.parse({ version: "v1", type: "reply", id: "reply-1", result: status })
    const frames = serializeDesktopReply("host.status", reply)
    expect(frames).toEqual([reply])
    expect(encodeDesktopFrame(frames[0]).byteLength).toBeLessThanOrEqual(maxDesktopReplyFrameBytes)
  })

  test("round trips a large multibyte reply with bounded JSON frames", () => {
    const chunks = serializeDesktopReply("control.capabilities", largeControlReply())
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(desktopReplyChunkSchemaV1.safeParse(chunk).success).toBe(true)
      expect(encodeDesktopFrame(chunk).byteLength).toBeLessThanOrEqual(maxDesktopReplyFrameBytes)
    }
    const reassembler = createDesktopReplyReassembler("control-1", "control.capabilities")
    let assembled: unknown
    for (const chunk of chunks) assembled = reassembler.push(chunk)
    expect(assembled).toEqual(desktopReplySchemaV1.parse(largeControlReply()))
    expect(reassembler.pending()).toBe(0)
  })

  test("round trips V2 control capabilities only with an explicit V2 read input", () => {
    const v1 = serializeDesktopReply("control.capabilities", {}, {
      version: "v1", type: "reply", id: "control-1", result: localControlCapabilitiesV1,
    })
    expect(v1).toHaveLength(1)

    for (const actionCount of [1, 60_000]) {
      const reply = { ...controlV2Reply(actionCount), version: desktopProtocolVersionV2 }
      const input = { readVersion: "v2" }
      const frames = serializeDesktopReply("control.capabilities", input, reply, "v2")
      if (frames.length === 1) {
        expect(frames[0]).toEqual(reply)
        continue
      }
      const reassembler = createDesktopReplyReassembler("control-v2", "control.capabilities", input, "v2")
      let assembled: unknown
      for (const frame of frames) assembled = reassembler.push(frame)
      expect(assembled).toEqual(reply)
    }
  })

  test("chunks valid replies larger than the general frame encoder limit", () => {
    const reply = desktopReplySchemaV1.parse(largeControlReply(200_000))
    expect(encoder.encode(JSON.stringify(reply)).byteLength).toBeGreaterThan(maxDesktopFrameBytes)
    const chunks = serializeDesktopReply("control.capabilities", reply)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => encodeDesktopFrame(chunk).byteLength <= maxDesktopReplyFrameBytes)).toBeTrue()
  })

  test("chunks valid 4 MiB and near-64 MiB replies within the 512 KiB frame limit", () => {
    for (const payloadBytes of [
      4 * 1024 * 1024,
      maxDesktopReplyBytes - (2 * maxDesktopReplyFrameBytes),
    ]) {
      const chunks = serializeDesktopReply("control.capabilities", controlReplyWithPayload(payloadBytes))
      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks.every((chunk) => encodeDesktopFrame(chunk).byteLength <= maxDesktopReplyFrameBytes)).toBeTrue()
    }
  })

  test("rejects replies larger than 64 MiB", () => {
    expect(() => serializeDesktopReply(
      "control.capabilities",
      controlReplyWithPayload(maxDesktopReplyBytes + 1),
    )).toThrow("aggregate size limit")
  })

  test("uses the encoded-frame boundary for unchunked replies and chunks", () => {
    const base = {
      version: "v1",
      type: "reply" as const,
      id: "boundary-1",
      result: { ...localControlCapabilitiesV1, actionKinds: [""] },
    }
    const emptyBytes = encodeDesktopFrame(desktopReplySchemaV1.parse(base)).byteLength
    const exact = {
      ...base,
      result: { ...base.result, actionKinds: ["x".repeat(maxDesktopReplyFrameBytes - emptyBytes)] },
    }
    const exactFrames = serializeDesktopReply("control.capabilities", exact)
    expect(exactFrames).toHaveLength(1)
    expect(encodeDesktopFrame(exactFrames[0]).byteLength).toBe(maxDesktopReplyFrameBytes)

    const over = {
      ...base,
      result: { ...base.result, actionKinds: ["x".repeat(maxDesktopReplyFrameBytes - emptyBytes + 1)] },
    }
    const chunks = serializeDesktopReply("control.capabilities", over)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(encodeDesktopFrame(chunk).byteLength).toBeLessThanOrEqual(maxDesktopReplyFrameBytes)
    }
  })

  test("asserts the aggregate byte limit without allocating aggregate payloads", () => {
    expect(assertDesktopReplyAggregateByteLength(maxDesktopReplyBytes)).toBe(maxDesktopReplyBytes)
    expect(assertDesktopReplyAggregateByteLength({ byteLength: maxDesktopReplyBytes })).toBe(maxDesktopReplyBytes)
    expect(() => assertDesktopReplyAggregateByteLength(maxDesktopReplyBytes + 1)).toThrow("aggregate size limit")
    expect(() => assertDesktopReplyAggregateByteLength({ byteLength: maxDesktopReplyBytes + 1 })).toThrow("aggregate size limit")
    expect(assertDesktopReplyAggregateByteLength({ byteLength: 16 }, 16)).toBe(16)
    expect(() => assertDesktopReplyAggregateByteLength({ byteLength: 17 }, 16)).toThrow("aggregate size limit")
  })

  test("clears malformed, over-count, over-aggregate, and oversized JSON frames", () => {
    const reassembler = createDesktopReplyReassembler("reply-1", "host.status")
    expectRejectedAndCleared(reassembler, { type: "replyChunk" })
    expectRejectedAndCleared(reassembler, {
      version: "v1",
      type: "replyChunk",
      id: "reply-1",
      operation: "host.status",
      index: 0,
      total: maxDesktopReplyChunks + 1,
      byteLength: 1,
      sha256: "a".repeat(64),
      payload: "AA==",
    })
    expectRejectedAndCleared(reassembler, {
      version: "v1",
      type: "replyChunk",
      id: "reply-1",
      operation: "host.status",
      index: 0,
      total: 1,
      byteLength: maxDesktopReplyBytes + 1,
      sha256: "a".repeat(64),
      payload: "AA==",
    })
    expectRejectedAndCleared(reassembler, {
      version: "v1",
      type: "replyChunk",
      id: "reply-1",
      operation: "host.status",
      index: 0,
      total: 1,
      byteLength: 1,
      sha256: "a".repeat(64),
      payload: "a".repeat(maxDesktopReplyFrameBytes),
    })
    const validChunk = chunkForReply({ version: "v1", type: "reply", id: "reply-1", result: status })
    expect(() => reassembler.push(validChunk, maxDesktopReplyFrameBytes + 1)).toThrow("frame size limit")
    expect(reassembler.pending()).toBe(0)
  })

  test("rejects duplicate, skipped, and reordered chunk indices", () => {
    const chunks = serializeDesktopReply("control.capabilities", largeControlReply())
      .map((value) => desktopReplyChunkSchemaV1.parse(value))
    expect(chunks.length).toBeGreaterThan(2)

    const duplicate = createDesktopReplyReassembler("control-1", "control.capabilities")
    expect(duplicate.push(chunks[0])).toBeUndefined()
    expectRejectedAndCleared(duplicate, chunks[0])

    const skipped = createDesktopReplyReassembler("control-1", "control.capabilities")
    expect(skipped.push(chunks[0])).toBeUndefined()
    expectRejectedAndCleared(skipped, chunks[2])

    const reordered = createDesktopReplyReassembler("control-1", "control.capabilities")
    expectRejectedAndCleared(reordered, chunks[1])
  })

  test("rejects wrong IDs and operations", () => {
    const chunk = chunkForReply({ version: "v1", type: "reply", id: "reply-1", result: status })
    expectRejectedAndCleared(
      createDesktopReplyReassembler("other-reply", "host.status"),
      chunk,
    )
    expectRejectedAndCleared(
      createDesktopReplyReassembler("reply-1", "transport.status"),
      chunk,
    )
  })

  test("rejects changing total, byte length, and hash metadata", () => {
    const chunks = serializeDesktopReply("control.capabilities", largeControlReply())
      .map((value) => desktopReplyChunkSchemaV1.parse(value))

    for (const changed of [
      { ...chunks[1], total: chunks[1].total + 1 },
      { ...chunks[1], byteLength: chunks[1].byteLength + 1 },
      { ...chunks[1], sha256: `${chunks[1].sha256 === "0".repeat(64) ? "1" : "0"}${chunks[1].sha256.slice(1)}` },
    ]) {
      const reassembler = createDesktopReplyReassembler("control-1", "control.capabilities")
      expect(reassembler.push(chunks[0])).toBeUndefined()
      expectRejectedAndCleared(reassembler, changed)
    }
  })

  test("rejects noncanonical base64 and decoded payloads over 380 KiB", () => {
    const noncanonical = {
      version: "v1",
      type: "replyChunk",
      id: "reply-1",
      operation: "host.status",
      index: 0,
      total: 1,
      byteLength: 1,
      sha256: sha256(new Uint8Array([0])),
      payload: "AB==",
    }
    expectRejectedAndCleared(
      createDesktopReplyReassembler("reply-1", "host.status"),
      noncanonical,
    )

    const oversizedPayload = new Uint8Array(maxDesktopReplyPayloadBytes + 1)
    const oversizedPayloadBase64 = Buffer.from(oversizedPayload).toString("base64")
    expect(oversizedPayloadBase64).toHaveLength(maxDesktopReplyPayloadBase64Characters)
    expect(encoder.encode(JSON.stringify({ payload: oversizedPayloadBase64 })).byteLength)
      .toBeLessThan(maxDesktopReplyFrameBytes)
    expectRejectedAndCleared(
      createDesktopReplyReassembler("reply-1", "host.status"),
      chunkForBytes(oversizedPayload),
    )
  })

  test("rejects declared length and hash mismatches", () => {
    const replyBytes = encoder.encode(JSON.stringify({
      version: "v1",
      type: "reply",
      id: "reply-1",
      result: status,
    }))
    expectRejectedAndCleared(
      createDesktopReplyReassembler("reply-1", "host.status"),
      chunkForBytes(replyBytes, "host.status", { byteLength: replyBytes.byteLength + 1 }),
    )
    expectRejectedAndCleared(
      createDesktopReplyReassembler("reply-1", "host.status"),
      chunkForBytes(replyBytes, "host.status", { sha256: "0".repeat(64) }),
    )
  })

  test("rejects invalid UTF-8, invalid JSON, and a reply ID mismatch", () => {
    expectRejectedAndCleared(
      createDesktopReplyReassembler("reply-1", "host.status"),
      chunkForBytes(new Uint8Array([0xff])),
    )
    expectRejectedAndCleared(
      createDesktopReplyReassembler("reply-1", "host.status"),
      chunkForBytes(encoder.encode("{")),
    )
    expectRejectedAndCleared(
      createDesktopReplyReassembler("reply-1", "host.status"),
      chunkForReply({ version: "v1", type: "reply", id: "other-reply", result: status }),
    )
  })

  test("rejects operation-invalid results and cross-family errors", () => {
    const badResult = { version: "v1", type: "reply", id: "reply-1", result: {} }
    const badError = {
      version: "v1",
      type: "reply",
      id: "reply-1",
      error: { version: "v1", code: "validation", message: "Invalid." },
    }
    expect(() => serializeDesktopReply("host.status", badResult)).toThrow()
    expect(() => serializeDesktopReply("host.status", badError)).toThrow()
    expectRejectedAndCleared(
      createDesktopReplyReassembler("reply-1", "host.status"),
      chunkForReply(badResult),
    )
    expectRejectedAndCleared(
      createDesktopReplyReassembler("reply-1", "host.status"),
      chunkForReply(badError),
    )
  })

  test("dispose clears pending state", () => {
    const chunks = serializeDesktopReply("control.capabilities", largeControlReply())
      .map((value) => desktopReplyChunkSchemaV1.parse(value))
    const reassembler = createDesktopReplyReassembler("control-1", "control.capabilities")
    expect(reassembler.push(chunks[0])).toBeUndefined()
    expect(reassembler.pending()).toBeGreaterThan(0)
    reassembler.dispose()
    expect(reassembler.pending()).toBe(0)
  })
})
