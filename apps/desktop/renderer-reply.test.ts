import { describe, expect, test } from "bun:test"
import {
  desktopReplySchemaV1,
  desktopReplySchemaV2,
  hostError,
} from "@daw-browser/desktop-protocol"
import { controlErrorSchemaV1 } from "@daw-browser/control"
import { serializeDesktopReply } from "@daw-browser/desktop-protocol/reply-chunks"
import { prepareDesktopReply } from "./renderer-reply"

const hostStatus = {
  project: null,
  ready: true,
  transport: "stopped",
  capabilities: { playback: true, diagnostics: true },
}

describe("desktop renderer reply boundary", () => {
  test("omits an undefined error from successful replies", () => {
    const reply = prepareDesktopReply(
      "host.status",
      { version: "v1", type: "reply", id: "renderer-1", result: hostStatus, error: undefined },
      "external-1",
      "v1",
    )

    expect(reply).toEqual({
      version: "v1",
      type: "reply",
      id: "external-1",
      result: hostStatus,
    })
    expect(serializeDesktopReply("host.status", {}, reply)).toEqual([
      desktopReplySchemaV1.parse({
        version: "v1",
        type: "reply",
        id: "external-1",
        result: hostStatus,
      }),
    ])
  })

  test("preserves and translates renderer errors without adding an undefined result", () => {
    const reply = prepareDesktopReply(
      "host.status",
      { version: "v1", type: "reply", id: "renderer-1", result: undefined, error: hostError("unavailable", "Not ready.") },
      "external-1",
      "v2",
    )

    expect(desktopReplySchemaV2.parse(reply)).toEqual({
      version: "v2",
      type: "reply",
      id: "external-1",
      error: { version: "v2", code: "unavailable", message: "Not ready." },
    })
  })

  test("preserves canonical idempotency conflicts through V1 and V2", () => {
    const error = {
      ...controlErrorSchemaV1.parse({
        version: "v1",
        code: "idempotency-conflict",
        message: "Idempotency key was already used for a different request.",
      }),
      actionIndex: undefined,
      details: undefined,
    }
    const normalizedError = {
      version: error.version,
      code: error.code,
      message: error.message,
    }

    expect(controlErrorSchemaV1.safeParse(error).success).toBe(true)

    const v1Reply = prepareDesktopReply(
      "control.commit",
      { version: "v1", type: "reply", id: "renderer-1", result: undefined, error },
      "external-1",
      "v1",
    )
    expect(desktopReplySchemaV1.parse(v1Reply)).toEqual({
      version: "v1",
      type: "reply",
      id: "external-1",
      error: normalizedError,
    })
    expect(serializeDesktopReply("control.commit", {}, v1Reply, "v1")).toEqual([desktopReplySchemaV1.parse(v1Reply)])

    const v2Reply = prepareDesktopReply(
      "control.commit",
      { version: "v1", type: "reply", id: "renderer-1", result: undefined, error },
      "external-1",
      "v2",
    )
    expect(desktopReplySchemaV2.parse(v2Reply)).toEqual({
      version: "v2",
      type: "reply",
      id: "external-1",
      error: normalizedError,
    })
    expect(serializeDesktopReply("control.commit", {}, v2Reply, "v2")).toEqual([desktopReplySchemaV2.parse(v2Reply)])
  })
})
