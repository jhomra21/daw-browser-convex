#!/usr/bin/env bun
import { mkdir, readFile, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { $ } from "bun"
import path from "node:path"
import { browserCommand, buildBrowserRuntime, waitForBrowserValue, withProductionBrowserServer } from "../browser-harness"
import { browserProbeOutputSchema, browserProbeResultSchema, type BrowserProbeResult } from "./probe"
import { deriveProbeErrors, deriveUnavailable, type SourceIdentity } from "./run-result"
import { z } from "zod"
import { assertThirtyTrackSemanticManifest, thirtyTrackSemanticManifest, thirtyTrackFixtureVersion } from "./spec"

type Surface = "browser" | "electron"
type CliOptions = {
  readonly surface: Surface
  readonly out: string
}
export type BaselineRunResult = {
  version: "30-track-baseline-v1"
  runId: string
  startedAt: string
  surface: Surface
  fixtureVersion: string
  source: SourceIdentity
  build: { mode: "production"; identity: "vite-production"; status: "not-run" | "verified" }
  fixture: {
    semanticManifest: typeof thirtyTrackSemanticManifest
    archive: { status: "not-checked" | "verified"; path: string; bytes?: number }
    integrity: { status: "not-checked" | "verified"; sha256: string | null }
  }
  phases: { fixtureIntegrity: "pending" | "complete" | "failed"; probeCollection: "pending" | "complete" | "failed" | "skipped" | "unsupported" }
  probe: BrowserProbeResult | null
  unavailable: string[]
  errors: string[]
}

const parseOptions = (arguments_: readonly string[]): CliOptions => {
  let surface: Surface | undefined
  let out: string | undefined
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === "--surface") {
      const value = arguments_[index + 1]
      if (surface !== undefined || (value !== "browser" && value !== "electron")) throw new Error("Invalid --surface.")
      surface = value
      index += 1
      continue
    }
    if (argument === "--out") {
      const value = arguments_[index + 1]
      if (out !== undefined || value === undefined || !path.isAbsolute(value)) throw new Error("--out must be an absolute path.")
      out = value
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  if (surface === undefined || out === undefined) throw new Error("Usage: run.ts --surface browser|electron --out <absolute-path>.")
  return { surface, out }
}

const main = async () => {
  const options = parseOptions(Bun.argv.slice(2))
  const root = path.resolve(import.meta.dir, "../../..")
  const commit = (await $`git -C ${root} rev-parse HEAD`.text()).trim()
  const status = await $`git -C ${root} status --porcelain --untracked-files=all`.text()
  const runId = crypto.randomUUID()
  const startedAt = new Date().toISOString()
  const result: BaselineRunResult = {
    version: "30-track-baseline-v1",
    runId,
    startedAt,
    surface: options.surface,
    fixtureVersion: thirtyTrackFixtureVersion,
    source: { commit, dirty: status.trim().length > 0 },
    build: {
      mode: "production",
      identity: "vite-production",
      status: "not-run",
    },
    fixture: {
      semanticManifest: thirtyTrackSemanticManifest,
      archive: { status: "not-checked", path: path.join(root, "tools/performance/fixtures/30-track-v1.dawproject") },
      integrity: { status: "not-checked", sha256: null },
    },
    phases: {
      fixtureIntegrity: "pending",
      probeCollection: "pending",
    },
    probe: null,
    unavailable: deriveUnavailable(options.surface, null),
    errors: [],
  }
  assertThirtyTrackSemanticManifest(thirtyTrackSemanticManifest)
  const archivePath = path.join(root, "tools/performance/fixtures/30-track-v1.dawproject")
  const hashPath = `${archivePath}.sha256`
  try {
    const archive = await readFile(archivePath)
    const hashLine = (await readFile(hashPath, "utf8")).trim()
    const actualHash = createHash("sha256").update(archive).digest("hex")
    if (!hashLine.startsWith(actualHash)) throw new Error("Fixture archive SHA-256 does not match.")
    result.fixture = {
      semanticManifest: thirtyTrackSemanticManifest,
      archive: { status: "verified", path: archivePath, bytes: archive.byteLength },
      integrity: { status: "verified", sha256: actualHash },
    }
    result.phases = { fixtureIntegrity: "complete", probeCollection: "pending" }
  } catch (error) {
    result.phases = { fixtureIntegrity: "failed", probeCollection: "skipped" }
    result.errors = [error instanceof Error ? error.message : String(error)]
    await mkdir(path.dirname(options.out), { recursive: true })
    await Bun.write(options.out, JSON.stringify(result, null, 2))
    throw error
  }
  if (options.surface === "browser") {
    try {
      await $`bun run build`
      result.build = { mode: "production", identity: "vite-production", status: "verified" }
    } catch (error) {
      result.build = { mode: "production", identity: "vite-production", status: "not-run" }
      result.phases = { fixtureIntegrity: "complete", probeCollection: "skipped" }
      result.errors = [error instanceof Error ? error.message : String(error)]
      await mkdir(path.dirname(options.out), { recursive: true })
      await Bun.write(options.out, JSON.stringify(result, null, 2))
      throw error
    }
    const runtimePath = await buildBrowserRuntime({
      entrypoint: path.join(import.meta.dir, "run-runtime.ts"),
      name: "30-track-probe",
    })
    try {
      const probe = await withProductionBrowserServer(path.join(root, "dist/client"), runtimePath, async (server) => {
        const session = `daw-30-track-probe-${runId}`
        try {
          await browserCommand(session, ["open", server.url.toString()])
          const output = await waitForBrowserValue(session, "window.__thirtyTrackProbeResult", 30_000)
          const encoded = z.union([z.string(), z.null()]).or(browserProbeOutputSchema).parse(JSON.parse(output))
          const encodedString = z.string().safeParse(encoded)
          const decoded = encodedString.success ? JSON.parse(encodedString.data) : encoded
          if (decoded === null) throw new Error("Timed out waiting for browser probe.")
          const parsed = browserProbeOutputSchema.parse(decoded)
          if ("error" in parsed) throw new Error(parsed.error)
          return browserProbeResultSchema.parse(parsed)
        } finally {
          await browserCommand(session, ["close"]).catch(() => undefined)
        }
      })
      result.phases = { fixtureIntegrity: "complete", probeCollection: "complete" }
      result.probe = probe
      result.unavailable = deriveUnavailable(options.surface, probe)
      result.errors = deriveProbeErrors(probe)
      if (result.errors.length > 0) result.phases = { fixtureIntegrity: "complete", probeCollection: "failed" }
    } catch (error) {
      result.phases = { fixtureIntegrity: "complete", probeCollection: "failed" }
      result.errors = [error instanceof Error ? error.message : String(error)]
    } finally {
      await rm(path.dirname(runtimePath), { recursive: true, force: true }).catch(() => undefined)
    }
  } else {
    result.phases = { fixtureIntegrity: "complete", probeCollection: "unsupported" }
  }
  await mkdir(path.dirname(options.out), { recursive: true })
  await Bun.write(options.out, JSON.stringify(result, null, 2))
  if (result.errors.length > 0) {
    throw new Error(`Browser probe reported errors: ${result.errors.join("; ")}`)
  }
  console.log(JSON.stringify({ runId, out: options.out, surface: options.surface }, null, 2))
}

await main()
