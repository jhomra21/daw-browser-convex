import { expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const desktopDirectory = import.meta.dirname
const repositoryRoot = path.resolve(desktopDirectory, "../..")
const artifactDirectory = path.join(repositoryRoot, "public/audio-core")
const electronPath = path.join(repositoryRoot, "node_modules/.bin/electron")
const artifactName = "daw-audio-core.wasm"
const manifestName = "daw-audio-core.manifest.json"

type WorkletDiagnostics = {
  framesProcessed: number
  maximumAbsoluteSample: number
  maximumAbsoluteSampleAfterDisconnect: number
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
  && "framesProcessed" in value && typeof value.framesProcessed === "number"
  && "maximumAbsoluteSample" in value && typeof value.maximumAbsoluteSample === "number"
  && "maximumAbsoluteSampleAfterDisconnect" in value && typeof value.maximumAbsoluteSampleAfterDisconnect === "number"
  && "memoryBytes" in value && typeof value.memoryBytes === "number"
  && "graphPrepare" in value

test.skipIf(process.env.DAW_ELECTRON_AUDIO_WORKLET_TEST !== "1")("runs the portable Wasm AudioWorklet against static assets in Electron", async () => {
  const artifactPath = path.join(artifactDirectory, artifactName)
  const manifestPath = path.join(artifactDirectory, manifestName)
  if (!existsSync(artifactPath) || !existsSync(manifestPath)) {
    throw new Error("Build the portable Wasm production assets with sh native/audio-core/scripts/build-wasm.sh before running this integration test.")
  }

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "daw-portable-wasm-worklet-"))
  try {
    await mkdir(path.join(fixtureRoot, "audio-worklets"), { recursive: true })
    await mkdir(path.join(fixtureRoot, "audio-core"), { recursive: true })
    await copyFile(
      path.join(repositoryRoot, "public/audio-worklets/daw-portable-audio-core-processor-v1.js"),
      path.join(fixtureRoot, "audio-worklets/daw-portable-audio-core-processor-v1.js"),
    )
    await copyFile(
      path.join(repositoryRoot, "public/audio-worklets/daw-portable-audio-core-host-v1.js"),
      path.join(fixtureRoot, "audio-worklets/daw-portable-audio-core-host-v1.js"),
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

    const result = Bun.spawnSync({
      cmd: [electronPath, path.join(desktopDirectory, "portable-wasm-worklet-electron.cjs"), fixtureRoot],
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = new TextDecoder().decode(result.stderr)
    if (result.exitCode !== 0) throw new Error(stderr)
    expect(stderr).toBe("")
    const output = JSON.parse(new TextDecoder().decode(result.stdout))
    if (!isWorkletDiagnostics(output)) throw new Error("Electron did not return diagnostics.")
    expect(output.framesProcessed).toBeGreaterThanOrEqual(130)
    expect(output.maximumAbsoluteSample).toBeCloseTo(0.25, 4)
    expect(output.maximumAbsoluteSampleAfterDisconnect).toBeLessThan(0.0001)
    expect(output.memoryBytes).toBe(184_549_376)
    expect(output.graphPrepare).toEqual({
      byteLength: 336,
      byteHash: 3_749_636_927,
      header: [3, 1, 2, 1, 0, 0],
      allocation: expect.any(Number),
      nodeOffset: 24,
      edgeOffset: 288,
      firstEdgeTargetProcessorIdPresent: false,
      result: 0,
    })
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
}, 45_000)
