import { expect, test } from "bun:test"
import { createUploadGate, resolveContainedPath } from "./browser-harness"

test("upload gate requires the one-time token and bounded POST", () => {
  const gate = createUploadGate("token", 10)
  expect(gate.begin({ method: "GET", token: "token", contentLength: 1 })).toEqual({ accepted: false, status: 405 })
  expect(gate.begin({ method: "POST", token: "wrong", contentLength: 1 })).toEqual({ accepted: false, status: 401 })
  expect(gate.begin({ method: "POST", token: "token", contentLength: 11 })).toEqual({ accepted: false, status: 413 })
  expect(gate.begin({ method: "POST", token: "token", contentLength: 10 })).toEqual({ accepted: true })
  expect(gate.begin({ method: "POST", token: "token", contentLength: 1 })).toEqual({ accepted: false, status: 409 })
  gate.finish(false)
  expect(gate.begin({ method: "POST", token: "token", contentLength: 1 })).toEqual({ accepted: true })
  gate.finish(true)
  expect(gate.begin({ method: "POST", token: "token", contentLength: 1 })).toEqual({ accepted: false, status: 409 })
})

test("production file resolution stays within the client directory", () => {
  expect(resolveContainedPath("/tmp/client", "/assets/index.js")).toBe("/tmp/client/assets/index.js")
  expect(resolveContainedPath("/tmp/client", "/%2e%2e/%2e%2e/private")).toBeUndefined()
})
