import { expect, test } from "bun:test"
import { Readable } from "node:stream"
import {
  createJsonlRpcAdapter,
  decodeJsonlLines,
  maxJsonlLineBytes,
  processJsonlLines,
} from "@daw-browser/control-sdk"
import {
  canonicalControlCapabilities,
  createDirectControlInvoker,
  type ControlOperationHandlers,
} from "@daw-browser/control"
import { readStdinChunks } from "./input"

test("backpressures stdin while a JSONL invocation is pending", async () => {
  const validRequest = (id: number) => Buffer.from(
    `{"jsonrpc":"2.0","id":${id},"method":"project.list","params":{}}\n`,
  )
  const oversizedRequest = Buffer.from(
    `{"jsonrpc":"2.0","id":2,"method":"project.list","params":{"value":"${"x".repeat(maxJsonlLineBytes)}"}}\n`,
  )
  const notification = Buffer.from('{"jsonrpc":"2.0","method":"project.list","params":{}}\n')
  const splitRequest = Buffer.from('{"jsonrpc":"2.0","id":"café","method":"project.list","params":{}}\n')
  const splitOffset = splitRequest.indexOf(Buffer.from("é")) + 1
  const chunks = [
    Buffer.from("{\n"),
    validRequest(1),
    oversizedRequest,
    validRequest(3),
    notification,
    splitRequest.subarray(0, splitOffset),
    splitRequest.subarray(splitOffset),
    validRequest(5),
  ]
  const stdin = Readable.from(chunks)
  const invocations: string[] = []
  let firstInvocationStarted: (() => void) | undefined
  const firstInvocationStartedPromise = new Promise<void>((resolve) => { firstInvocationStarted = resolve })
  let releaseFirst: (() => void) | undefined
  const firstInvocation = new Promise<void>((resolve) => { releaseFirst = resolve })
  const handlers: ControlOperationHandlers<"desktop"> = {
    "project.list": async () => {
      invocations.push("project.list")
      firstInvocationStarted?.()
      if (invocations.length === 1) await firstInvocation
      return { projects: [] }
    },
    "project.current": async () => ({ status: "absent" }),
    "control.capabilities": async () => canonicalControlCapabilities,
    "control.snapshot": async () => { throw new Error("not used") },
    "control.preview": async () => { throw new Error("not used") },
    "control.requestApproval": async () => { throw new Error("not used") },
    "control.commit": async () => { throw new Error("not used") },
    "control.history": async () => { throw new Error("not used") },
    "control.recoveries": async () => { throw new Error("not used") },
  }
  const invoker = createDirectControlInvoker({
    handlers,
    context: { target: "desktop", principal: { subject: "test" } },
  })
  const output: string[] = []
  const processing = processJsonlLines(
    decodeJsonlLines(readStdinChunks(stdin)),
    createJsonlRpcAdapter({ invoker }),
    (line) => { output.push(line) },
  )

  await firstInvocationStartedPromise
  expect(invocations).toEqual(["project.list"])
  releaseFirst?.()
  await processing

  expect(invocations).toHaveLength(5)
  expect(output.map((line) => JSON.parse(line).id)).toEqual([null, 1, null, 3, "café", 5])
})
