import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import path from "node:path"
import { boundedFixtureStream, browserCommandTimeoutMs, createUploadGate, performanceStreamUploadMaxBytes, resolveContainedPath, withBrowserServer } from "./browser-harness"

test("streamed upload gate accepts v3 archive length but rejects above one GiB", () => {
  const gate = createUploadGate("v3", performanceStreamUploadMaxBytes)
  expect(gate.begin({ method: "POST", token: "v3", contentLength: 800_000_000 })).toEqual({ accepted: true })
  gate.finish(false)
  expect(gate.begin({ method: "POST", token: "v3", contentLength: performanceStreamUploadMaxBytes + 1 }))
    .toEqual({ accepted: false, status: 413 })
})

test("streamed fixture rejects payloads over the fixed byte budget", async () => {
  const input = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Uint8Array.of(1, 2)); controller.enqueue(Uint8Array.of(3)); controller.close() },
  })
  const seen: number[] = []
  await expect((async () => {
    for await (const chunk of boundedFixtureStream(input, 2)) seen.push(chunk.byteLength)
  })()).rejects.toThrow(/limit/)
  expect(seen).toEqual([2])
})

test("browser commands have bounded deadlines without shortening explicit waits", () => {
  expect(browserCommandTimeoutMs(["eval", "document.title"])).toBe(30_000)
  expect(browserCommandTimeoutMs(["wait", "--fn", "true", "--timeout", "60000"])).toBe(70_000)
  expect(browserCommandTimeoutMs(["wait", "--fn", "true", "--timeout", "bad"])).toBe(30_000)
})

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

test("streamed fixture upload passes bounded chunks and rejects a second request", async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'fixture-harness-'))
  const name = path.join(root, 'runtime.js')
  await Bun.write(name, '')
  await withBrowserServer(name, async (server) => {
      const seen: number[] = []
      server.uploadStream = async (source) => {
        for await (const chunk of source) seen.push(chunk.byteLength)
        return new Response('ok')
      }
      const url = new URL('/fixture-stream', server.url)
      url.searchParams.set('token', server.uploadToken)
      const send = () => fetch(url, {
        method: 'POST',
        body: new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(Uint8Array.of(1, 2)); controller.enqueue(Uint8Array.of(3)); controller.close() },
        }),
        duplex: 'half',
      })
      expect((await send()).status).toBe(200)
      expect(seen.reduce((sum, size) => sum + size, 0)).toBe(3)
      expect((await send()).status).toBe(409)
  })
})

test("stream route accepts a body over the legacy 40 MiB budget", async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "fixture-stream-gate-"))
  const name = path.join(root, "runtime.js")
  await Bun.write(name, "")
  await withBrowserServer(name, async (server) => {
    server.uploadStream = async (body) => {
      for await (const _chunk of body) { /* consume the bounded stream */ }
      return new Response("ok")
    }
    const url = new URL("/fixture-stream", server.url)
    url.searchParams.set("token", server.uploadToken)
    const response = await fetch(url, {
      method: "POST",
      body: new Uint8Array(129 * 1024 * 1024),
    })
    expect(response.status).toBe(200)
  })
})
