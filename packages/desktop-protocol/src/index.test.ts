import { describe, expect, test } from "bun:test"
import {
  desktopHelloSchemaV1,
  desktopRendererExportInputSchemaV1,
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

  test("validates bounded host media requests", () => {
    const exportRequest = {
      version: "v1",
      type: "request",
      id: "request-1",
      operation: "host.export.run",
      input: {
        mode: "mixdown",
        format: "wav",
        destination: { kind: "file", path: "/tmp/output.wav" },
        range: { mode: "custom", startSec: 0, endSec: 1 },
        render: {
          sampleRate: 44100,
          channels: 2,
          normalization: { mode: "none" },
          tail: { mode: "none" },
        },
        encoding: { wav: { codec: "pcm-s16", dither: "none" } },
      },
    }
    expect(desktopRequestSchemaV1.safeParse(exportRequest).success).toBe(true)
    expect(desktopRequestSchemaV1.safeParse({
      ...exportRequest,
      input: { ...exportRequest.input, range: { mode: "loop", startSec: 1, endSec: 1 } },
    }).success).toBe(false)
    expect(desktopRequestSchemaV1.safeParse({
      ...exportRequest,
      input: { ...exportRequest.input, format: "flac" },
    }).success).toBe(false)
  })

  test("accepts renderer-only export preflight metadata without exposing it externally", () => {
    const input = {
      mode: "mixdown",
      format: "wav",
      destination: {
        kind: "capability-file",
        token: "0".repeat(64),
        basename: "preflight.wav",
      },
      range: { mode: "whole" },
      render: {
        sampleRate: 44100,
        channels: 2,
        normalization: { mode: "none" },
        tail: { mode: "none" },
      },
      encoding: { wav: { codec: "pcm-s16", dither: "none" } },
      canceled: false,
      preflightOnly: true,
    }
    expect(desktopRendererExportInputSchemaV1.safeParse(input).success).toBe(true)
    expect(desktopRequestSchemaV1.safeParse({
      version: "v1",
      type: "request",
      id: "request-1",
      operation: "host.export.run",
      input,
    }).success).toBe(false)
  })

  test("strictly validates canceled renderer exports", () => {
    for (const mode of ["mixdown", "stems"]) {
      expect(desktopRendererExportInputSchemaV1.safeParse({ canceled: true, mode }).success).toBe(true)
      expect(desktopRendererExportInputSchemaV1.safeParse({
        canceled: true,
        mode,
        destination: { kind: "capability-file", token: "0".repeat(64), basename: "output.wav" },
      }).success).toBe(false)
      expect(desktopRendererExportInputSchemaV1.safeParse({ canceled: true, mode, preflightOnly: true }).success).toBe(false)
    }
  })

  test("requires matching renderer mixdown capability extensions", () => {
    for (const [format, basename] of [
      ["wav", "output.wav"],
      ["mp3", "output.mp3"],
      ["flac", "output.flac"],
      ["ogg-opus", "output.ogg"],
    ]) {
      const input = {
        mode: "mixdown",
        format,
        destination: { kind: "capability-file", token: "0".repeat(64), basename },
        range: { mode: "whole" },
        render: { sampleRate: 44100, channels: 2, normalization: { mode: "none" }, tail: { mode: "none" } },
        encoding: { wav: { codec: "pcm-s16", dither: "none" } },
        canceled: false,
      }
      expect(desktopRendererExportInputSchemaV1.safeParse(input).success).toBe(true)
      expect(desktopRendererExportInputSchemaV1.safeParse({
        ...input,
        destination: { ...input.destination, basename: "output.mp3" },
      }).success).toBe(format === "mp3")
    }
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
