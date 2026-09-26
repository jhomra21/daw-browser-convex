#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { Readable, Transform } from "node:stream"
import { browserCommand, buildBrowserRuntime, waitForBrowserValue, withBrowserServer } from "../browser-harness"
import { assertThirtyTrackV3ArchiveBudget, decodeThirtyTrackV3BrowserResult } from "./v3-fixture"

const root = path.resolve(import.meta.dir, "../../..")
const directory = path.join(root, "tools/performance/fixtures")
const archiveName = "30-track-v3-native.dawproject"
const archivePath = path.join(directory, archiveName)

await mkdir(directory, { recursive: true })
const runtime = await buildBrowserRuntime({
  entrypoint: path.join(import.meta.dir, "v3-generator-runtime.ts"),
  name: "30-track-v3-generator",
})
const temporary = path.join(directory, `${archiveName}.${crypto.randomUUID()}.tmp`)
const hash = createHash("sha256")
let received = 0
try {
  const result = await withBrowserServer(runtime, async (server) => {
    const session = `daw-v3-fixture-${crypto.randomUUID()}`
    const uploadUrl = new URL("/fixture-stream", server.url)
    uploadUrl.searchParams.set("token", server.uploadToken)
    server.uploadStream = async (body) => {
      try {
        await pipeline(
          Readable.fromWeb(body),
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              received += chunk.length
              try {
                assertThirtyTrackV3ArchiveBudget(received)
                hash.update(chunk)
                callback(null, chunk)
              } catch (error) {
                callback(error instanceof Error ? error : new Error(String(error)))
              }
            },
          }),
          createWriteStream(temporary, { flags: "wx" }),
        )
        return new Response("ok")
      } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), { status: 500 })
      }
    }
    try {
      await browserCommand(session, ["open", `${server.url}?upload=${encodeURIComponent(uploadUrl.toString())}`])
      const output = await waitForBrowserValue(session, "window.__thirtyTrackV3Result", 600_000)
      const parsed = decodeThirtyTrackV3BrowserResult(output)
      if ("error" in parsed) throw new Error(parsed.error)
      return parsed
    } catch (error) {
      const diagnostics = await Promise.all([
        browserCommand(session, ["eval", "window.__thirtyTrackV3Stage ?? 'stage unavailable'"]).catch(() => "stage unavailable"),
        browserCommand(session, ["console"]).catch(() => "console unavailable"),
        browserCommand(session, ["errors"]).catch(() => "errors unavailable"),
      ])
      throw new Error(`${error instanceof Error ? error.message : String(error)}; ${diagnostics.join(" | ")}`)
    } finally {
      await browserCommand(session, ["close"]).catch(() => undefined)
    }
  })
  if (received !== result.bytes || (await stat(temporary)).size !== received) {
    throw new Error("V3 upload length differs from the exported archive.")
  }
  const digest = hash.digest("hex")
  await rename(temporary, archivePath)
  await writeFile(`${archivePath}.sha256`, `${digest}  ${archiveName}\n`)
  if (!(await readFile(`${archivePath}.sha256`, "utf8")).startsWith(digest)) throw new Error("V3 checksum verification failed.")
  console.log(JSON.stringify({ archive: archivePath, sha256: digest, ...result }, null, 2))
} catch (error) {
  await unlink(temporary).catch(() => undefined)
  throw error
}
