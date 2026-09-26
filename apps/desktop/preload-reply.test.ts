import { expect, test } from "bun:test"
import { desktopReplySchemaV1 } from "@daw-browser/desktop-protocol"
import { safePreloadReply } from "./preload-reply"

test("malformed renderer result returns a bounded internal error rather than hanging", () => {
  const reply = safePreloadReply({ id: "diagnostics-1", result: { scheduler: undefined } })
  expect(desktopReplySchemaV1.parse(reply)).toMatchObject({
    id: "diagnostics-1",
    error: { code: "internal" },
  })
})

test("valid renderer replies retain their result", () => {
  expect(safePreloadReply({ id: "diagnostics-1", result: { scheduler: null } })).toMatchObject({
    id: "diagnostics-1", result: { scheduler: null },
  })
})
