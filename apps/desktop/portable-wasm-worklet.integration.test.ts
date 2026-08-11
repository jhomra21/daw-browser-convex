import { expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { computePortableWasmSourceHash } from "../../native/audio-core/scripts/portable-wasm-source-hash"

const desktopDirectory = import.meta.dirname
const repositoryRoot = path.resolve(desktopDirectory, "../..")
const artifactDirectory = path.join(repositoryRoot, "public/audio-core")
const electronPath = path.join(repositoryRoot, "node_modules/.bin/electron")
const artifactName = "daw-audio-core.wasm"
const manifestName = "daw-audio-core.manifest.json"

type WorkletDiagnostics = {
  requestedSampleRate: number
  actualSampleRate: number
  framesProcessed: number
  channels: {
    left: {
      finite: boolean
      maximumAbsolute: number
      maximumAbsoluteAfterDispose: number
    }
    right: {
      finite: boolean
      maximumAbsolute: number
      maximumAbsoluteAfterDispose: number
    }
  }
  maximumAbsoluteLiveBefore: number
  maximumAbsoluteLiveAfterUtility: number
  maximumAbsoluteLiveAfter: number
  maximumAbsoluteSynthTailSample: number
  memoryBytes: number
  graphPrepare: {
    byteLength: number
    byteHash: number
    header: number[]
    allocation: number
    nodeOffset: number
    edgeOffset: number
    firstEdgeTargetProcessorIdPresent: boolean
    result: number
  } | null
}

const isWorkletDiagnostics = (value: unknown): value is WorkletDiagnostics =>
  typeof value === "object"
  && value !== null
  && "requestedSampleRate" in value && typeof value.requestedSampleRate === "number"
  && "actualSampleRate" in value && typeof value.actualSampleRate === "number"
  && "framesProcessed" in value && typeof value.framesProcessed === "number"
  && "channels" in value && typeof value.channels === "object" && value.channels !== null
  && "left" in value.channels && typeof value.channels.left === "object" && value.channels.left !== null
  && "right" in value.channels && typeof value.channels.right === "object" && value.channels.right !== null
  && "finite" in value.channels.left && typeof value.channels.left.finite === "boolean"
  && "finite" in value.channels.right && typeof value.channels.right.finite === "boolean"
  && "maximumAbsolute" in value.channels.left && typeof value.channels.left.maximumAbsolute === "number"
  && "maximumAbsolute" in value.channels.right && typeof value.channels.right.maximumAbsolute === "number"
  && "maximumAbsoluteAfterDispose" in value.channels.left && typeof value.channels.left.maximumAbsoluteAfterDispose === "number"
  && "maximumAbsoluteAfterDispose" in value.channels.right && typeof value.channels.right.maximumAbsoluteAfterDispose === "number"
  && "maximumAbsoluteLiveBefore" in value && typeof value.maximumAbsoluteLiveBefore === "number"
  && "maximumAbsoluteLiveAfterUtility" in value && typeof value.maximumAbsoluteLiveAfterUtility === "number"
  && "maximumAbsoluteLiveAfter" in value && typeof value.maximumAbsoluteLiveAfter === "number"
  && "maximumAbsoluteSynthTailSample" in value && typeof value.maximumAbsoluteSynthTailSample === "number"
  && "memoryBytes" in value && typeof value.memoryBytes === "number"
  && "graphPrepare" in value

test.skipIf(process.env.DAW_ELECTRON_AUDIO_WORKLET_TEST !== "1")("runs the portable Wasm AudioWorklet against static assets in Electron", async () => {
  const artifactPath = path.join(artifactDirectory, artifactName)
  const manifestPath = path.join(artifactDirectory, manifestName)
  if (!existsSync(artifactPath) || !existsSync(manifestPath)) {
    throw new Error("Build the portable Wasm production assets with sh native/audio-core/scripts/build-wasm.sh before running this integration test.")
  }
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"))
  const sourceHash = typeof manifest === "object"
    && manifest !== null
    && "sourceHash" in manifest
    && typeof manifest.sourceHash === "string"
    ? manifest.sourceHash
    : undefined
  if (sourceHash !== await computePortableWasmSourceHash(repositoryRoot)) {
    throw new Error("Portable Wasm manifest is stale for the current audio-core build inputs.")
  }

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "daw-portable-wasm-worklet-"))
  try {
    await mkdir(path.join(fixtureRoot, "audio-worklets"), { recursive: true })
    await mkdir(path.join(fixtureRoot, "audio-core"), { recursive: true })
    await copyFile(
      path.join(repositoryRoot, "public/audio-worklets/daw-portable-audio-core-processor-v2.js"),
      path.join(fixtureRoot, "audio-worklets/daw-portable-audio-core-processor-v2.js"),
    )
    await copyFile(
      path.join(repositoryRoot, "public/audio-worklets/daw-portable-audio-core-host-v2.js"),
      path.join(fixtureRoot, "audio-worklets/daw-portable-audio-core-host-v2.js"),
    )
    await copyFile(
      path.join(repositoryRoot, "public/audio-worklets/daw-portable-graph-envelope-v3.js"),
      path.join(fixtureRoot, "audio-worklets/daw-portable-graph-envelope-v3.js"),
    )
    await copyFile(
      path.join(desktopDirectory, "portable-wasm-worklet-fixture.mjs"),
      path.join(fixtureRoot, "portable-wasm-worklet-fixture.mjs"),
    )
    await copyFile(artifactPath, path.join(fixtureRoot, "audio-core", artifactName))
    await copyFile(manifestPath, path.join(fixtureRoot, "audio-core", manifestName))
    await writeFile(
      path.join(fixtureRoot, "index.html"),
      "<!doctype html><meta charset=\"utf-8\"><script type=\"module\" src=\"./portable-wasm-worklet-fixture.mjs\"></script>",
    )

    const diagnosticsByRate = new Map<number, WorkletDiagnostics>()
    for (const sampleRate of [44_100, 48_000, 96_000]) {
      const result = Bun.spawnSync({
        cmd: [electronPath, path.join(desktopDirectory, "portable-wasm-worklet-electron.cjs"), fixtureRoot, String(sampleRate)],
        cwd: repositoryRoot,
        stdout: "pipe",
        stderr: "pipe",
      })
      const stderr = new TextDecoder().decode(result.stderr)
      if (result.exitCode !== 0) throw new Error(stderr)
      expect(stderr).toBe("")
      const output = JSON.parse(new TextDecoder().decode(result.stdout))
      if (!isWorkletDiagnostics(output)) throw new Error(`Electron did not return diagnostics for ${sampleRate} Hz.`)
      expect(output.requestedSampleRate).toBe(sampleRate)
      expect(output.actualSampleRate).toBe(sampleRate)
      expect(output.framesProcessed).toBeGreaterThanOrEqual(130)
      expect(output.channels.left.finite).toBeTrue()
      expect(output.channels.right.finite).toBeTrue()
      expect(output.channels.left.maximumAbsolute).toBeCloseTo(0.25, 4)
      expect(output.channels.right.maximumAbsolute).toBeCloseTo(0.125, 4)
      expect(output.channels.left.maximumAbsoluteAfterDispose).toBeLessThan(0.0001)
      expect(output.channels.right.maximumAbsoluteAfterDispose).toBeLessThan(0.0001)
      expect(output.maximumAbsoluteSynthTailSample).toBeGreaterThan(0.0001)
      expect(output.maximumAbsoluteLiveAfterUtility).toBeGreaterThan(0.01)
      expect(output.maximumAbsoluteLiveAfterUtility).toBeLessThan(output.maximumAbsoluteLiveBefore * 0.95)
      expect(output.maximumAbsoluteLiveAfter).toBeGreaterThan(0.01)
      expect(output.maximumAbsoluteLiveAfter).toBeLessThan(output.maximumAbsoluteLiveAfterUtility * 0.5)
      expect(output.memoryBytes).toBe(184_549_376)
      diagnosticsByRate.set(sampleRate, output)
    }
    const exact48 = diagnosticsByRate.get(48_000)
    if (!exact48) throw new Error("Missing 48 kHz diagnostics.")
    expect(exact48.graphPrepare).toEqual({
      byteLength: 336,
      byteHash: 3_749_636_927,
      header: [3, 1, 2, 1, 0, 0],
      allocation: expect.any(Number),
      nodeOffset: 24,
      edgeOffset: 288,
      firstEdgeTargetProcessorIdPresent: false,
      result: 0,
    })
    for (const sampleRate of [44_100, 96_000]) {
      expect(diagnosticsByRate.get(sampleRate)?.graphPrepare).toMatchObject({
        byteLength: 336,
        header: [3, 1, 2, 1, 0, 0],
        nodeOffset: 24,
        edgeOffset: 288,
        firstEdgeTargetProcessorIdPresent: false,
        result: 0,
      })
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
}, 45_000)
