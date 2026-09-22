#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { browserCommand, buildBrowserRuntime, waitForBrowserValue, withBrowserServer } from "../browser-harness"
import {
  assertThirtyTrackSemanticManifest,
  thirtyTrackFixtureBrowserOutputSchema,
  thirtyTrackSemanticManifest,
} from "./spec"

const root = path.resolve(import.meta.dir, "../../..")
const fixtureDirectory = path.join(root, "tools/performance/fixtures")
const archivePath = path.join(fixtureDirectory, "30-track-v1.dawproject")
const hashPath = `${archivePath}.sha256`

const main = async () => {
  await mkdir(fixtureDirectory, { recursive: true })
  const runtimePath = await buildBrowserRuntime({
    entrypoint: path.join(import.meta.dir, "generator-runtime.ts"),
    name: "30-track-generator",
  })
  let archive = new Uint8Array()
  const result = await withBrowserServer(runtimePath, async (server) => {
    const session = `daw-30-track-fixture-${crypto.randomUUID()}`
    const uploadUrl = new URL("/fixture", server.url)
    uploadUrl.searchParams.set("token", server.uploadToken)
    server.upload = async (body) => {
      archive = body
      return new Response("ok")
    }
    try {
      await browserCommand(session, ["open", `${server.url}?upload=${encodeURIComponent(uploadUrl.toString())}`])
      const output = await waitForBrowserValue(session, "window.__thirtyTrackFixtureResult", 30_000)
      const encoded = z.union([z.string(), z.null()]).or(thirtyTrackFixtureBrowserOutputSchema).parse(JSON.parse(output))
      const encodedString = z.string().safeParse(encoded)
      const decoded = encodedString.success ? JSON.parse(encodedString.data) : encoded
      if (decoded === null) throw new Error("Timed out waiting for the 30-track fixture generator.")
      const parsed = thirtyTrackFixtureBrowserOutputSchema.parse(decoded)
      if ("error" in parsed) throw new Error(parsed.error)
      return parsed
    } finally {
      await browserCommand(session, ["close"]).catch(() => undefined)
    }
  })
  assertThirtyTrackSemanticManifest(result.semanticManifest)
  if (archive.byteLength === 0) throw new Error("Fixture generator returned an empty archive.")
  await writeFile(archivePath, archive)
  const hash = createHash("sha256").update(archive).digest("hex")
  await writeFile(hashPath, `${hash}  30-track-v1.dawproject\n`)
  const checkedHash = (await readFile(hashPath, "utf8")).trim()
  if (!checkedHash.startsWith(hash)) throw new Error("Fixture SHA-256 verification failed.")
  console.log(JSON.stringify({
    archive: archivePath,
    bytes: archive.byteLength,
    sha256: hash,
    semanticManifest: thirtyTrackSemanticManifest,
  }, null, 2))
}

await main()
