import { createHash } from "node:crypto"
import type { z } from "zod"
import {
  desktopProtocolVersion, desktopProtocolVersionV2, desktopReplySchemaV1, desktopReplySchemaV2,
  desktopReplyChunkSchemaV1, desktopReplyChunkSchemaV2,
  maxDesktopReplyBytes, maxDesktopReplyFrameBytes, maxDesktopReplyPayloadBytes,
  maxDesktopReplyChunks,
  parseDesktopReplyError, parseDesktopResult, type DesktopOperationV1, type DesktopProtocolVersion,
} from "./index"
import { desktopFrameHeaderBytes, encodeDesktopFrame } from "./socket"

export { maxDesktopReplyFrameBytes, maxDesktopReplyBytes }
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export type DesktopReplyChunkV1 = z.infer<typeof desktopReplyChunkSchemaV1>
export type DesktopReplyChunkV2 = z.infer<typeof desktopReplyChunkSchemaV2>
type DesktopReplyChunk = DesktopReplyChunkV1 | DesktopReplyChunkV2
type DesktopReply = z.infer<typeof desktopReplySchemaV1> | z.infer<typeof desktopReplySchemaV2>

export const assertDesktopReplyAggregateByteLength = (
  value: number | { byteLength: number },
  limit = maxDesktopReplyBytes,
): number => {
  const byteLength = typeof value === "number" ? value : value.byteLength
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > limit) {
    throw new Error("Desktop reply exceeds aggregate size limit.")
  }
  return byteLength
}

const assertReply = (operation: DesktopOperationV1, input: unknown, reply: unknown, protocolVersion: DesktopProtocolVersion) => {
  const parsed = (protocolVersion === desktopProtocolVersionV2 ? desktopReplySchemaV2 : desktopReplySchemaV1).parse(reply)
  if (parsed.error !== undefined) parseDesktopReplyError(operation, parsed.error, protocolVersion)
  else parseDesktopResult(operation, parsed.result, input, protocolVersion)
  return parsed
}

export const serializeDesktopReply = (
  operation: DesktopOperationV1,
  input: unknown,
  reply?: unknown,
  protocolVersion: DesktopProtocolVersion = desktopProtocolVersion,
): Array<DesktopReply | DesktopReplyChunk> => {
  const parsed = assertReply(operation, reply === undefined ? {} : input, reply ?? input, protocolVersion)
  const bytes = encoder.encode(JSON.stringify(parsed))
  assertDesktopReplyAggregateByteLength(bytes)
  if (bytes.byteLength + desktopFrameHeaderBytes <= maxDesktopReplyFrameBytes) return [parsed]
  const digest = hash(bytes)
  const payloads: string[] = []
  let offset = 0
  while (offset < bytes.byteLength) {
    let lower = 1
    let upper = Math.min(maxDesktopReplyPayloadBytes, bytes.byteLength - offset)
    while (lower < upper) {
      const length = Math.ceil((lower + upper) / 2)
      const frame = (protocolVersion === desktopProtocolVersionV2 ? desktopReplyChunkSchemaV2 : desktopReplyChunkSchemaV1).parse({
        version: protocolVersion,
        type: "replyChunk",
        id: parsed.id,
        operation,
        index: payloads.length,
        total: maxDesktopReplyChunks,
        byteLength: bytes.byteLength,
        sha256: digest,
        payload: Buffer.from(bytes.subarray(offset, offset + length)).toString("base64"),
      })
      if (encodeDesktopFrame(frame).byteLength <= maxDesktopReplyFrameBytes) lower = length
      else upper = length - 1
    }
    payloads.push(Buffer.from(bytes.subarray(offset, offset + lower)).toString("base64"))
    offset += lower
  }
  return payloads.map((payload, index) => (protocolVersion === desktopProtocolVersionV2 ? desktopReplyChunkSchemaV2 : desktopReplyChunkSchemaV1).parse({
    version: protocolVersion,
    type: "replyChunk",
    id: parsed.id,
    operation,
    index,
    total: payloads.length,
    byteLength: bytes.byteLength,
    sha256: digest,
    payload,
  }))
}

export const createDesktopReplyReassembler = (
  id: string,
  operation: DesktopOperationV1,
  input: unknown = {},
  protocolVersion: DesktopProtocolVersion = desktopProtocolVersion,
) => {
  let next = 0
  let metadata: DesktopReplyChunk | undefined
  const parts: Uint8Array[] = []
  let received = 0
  const clear = () => { next = 0; metadata = undefined; parts.length = 0; received = 0 }
  return {
    push(value: unknown, encodedFrameByteLength?: number) {
      try {
        const frame = (protocolVersion === desktopProtocolVersionV2 ? desktopReplyChunkSchemaV2 : desktopReplyChunkSchemaV1).parse(value)
        const frameByteLength = encodedFrameByteLength ?? encodeDesktopFrame(frame).byteLength
        if (!Number.isSafeInteger(frameByteLength) || frameByteLength < 0) {
          throw new Error("Invalid desktop reply chunk.")
        }
        if (frameByteLength > maxDesktopReplyFrameBytes) {
          throw new Error("Desktop reply chunk exceeds frame size limit.")
        }
        if (frame.id !== id || frame.operation !== operation || frame.index !== next) {
          throw new Error("Unexpected desktop reply chunk.")
        }
        if (metadata && (
          frame.total !== metadata.total
          || frame.byteLength !== metadata.byteLength
          || frame.sha256 !== metadata.sha256
        )) {
          throw new Error("Inconsistent desktop reply chunk metadata.")
        }
        const payload = Buffer.from(frame.payload, "base64")
        if (payload.toString("base64") !== frame.payload) {
          throw new Error("Invalid desktop reply chunk base64.")
        }
        if (
          payload.byteLength === 0
          || payload.byteLength > maxDesktopReplyPayloadBytes
          || received + payload.byteLength > frame.byteLength
        ) {
          throw new Error("Invalid desktop reply chunk payload.")
        }
        metadata ??= frame
        parts.push(payload)
        received += payload.byteLength
        next += 1
        if (next !== frame.total) return undefined

        if (received !== frame.byteLength) throw new Error("Invalid desktop reply chunk length.")
        const result = new Uint8Array(received)
        let offset = 0
        for (const part of parts) {
          result.set(part, offset)
          offset += part.byteLength
        }
        if (hash(result) !== frame.sha256) throw new Error("Invalid desktop reply chunk hash.")
        const parsed = assertReply(operation, input, JSON.parse(decoder.decode(result)), protocolVersion)
        if (parsed.id !== id) throw new Error("Invalid desktop reply ID.")
        clear()
        return parsed
      } catch (error) { clear(); throw error }
    },
    dispose: clear,
    pending: () => received,
  }
}
