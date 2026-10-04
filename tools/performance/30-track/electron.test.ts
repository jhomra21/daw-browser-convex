import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  cleanupSurvivors,
  createCleanupPlan,
  createNativeDiagnosticDelta,
  createPrivateRunDirectory,
  descendantsOf,
  electronRendererTarget,
  nativeCallbacksIncreased,
  processMetricsAvailability,
  desktopDiagnosticsBoundaryLines,
  desktopDiagnosticsValidationLines,
  verifyElectronLaunchIdentity,
  writePrivateArtifact,
} from "./electron"

test("retains only bounded desktop diagnostics boundary markers", () => {
  expect(desktopDiagnosticsBoundaryLines("[diagnostics-v2-boundary] operation=diagnostics.snapshot.v2 stage=renderer-dispatched elapsedMs=4\nsecret token"))
    .toEqual(["[diagnostics-v2-boundary] operation=diagnostics.snapshot.v2 stage=renderer-dispatched elapsedMs=4"])
})

test("retains only bounded allowlisted validation paths", () => {
  expect(desktopDiagnosticsValidationLines("[diagnostics-v2-validation] paths=result.audio.other\nsecret token"))
    .toEqual(["[diagnostics-v2-validation] paths=result.audio.other"])
})

test("computes native callback and rejection deltas without fabricating timing data", () => {
  const delta = createNativeDiagnosticDelta(
    {
      state: "configured",
      sampleRate: 48_000,
      workletFaultCount: 0,
      inferredApplicationStallCount: 1,
      callbacks: 10,
      rejectedBlocks: 2,
    },
    {
      state: "running",
      sampleRate: 48_000,
      workletFaultCount: 0,
      inferredApplicationStallCount: 1,
      callbacks: 35,
      rejectedBlocks: 2,
    },
  )
  expect(delta.callbackIncrease).toBe(25)
  expect(delta.rejectedBlocksIncrease).toBe(0)
  expect(nativeCallbacksIncreased(delta)).toBe(true)
})

test("returns unavailable when process metrics have no runner-owned samples", () => {
  expect(processMetricsAvailability([])).toEqual({
    available: false,
    reason: "runner-owned process metrics unavailable",
  })
})

test("classifies all descendants of the runner-owned Electron PID", () => {
  expect(descendantsOf([
    { pid: 2, parentPid: 1 },
    { pid: 3, parentPid: 2 },
    { pid: 4, parentPid: 3 },
    { pid: 9, parentPid: 8 },
  ], 2)).toEqual([3, 4])
})

test("creates private benchmark directories and artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "electron-artifact-test-"))
  try {
    const runDirectory = await createPrivateRunDirectory(root)
    const artifactPath = path.join(runDirectory, "result.json")
    await writePrivateArtifact(artifactPath, "{}")
    expect((await stat(runDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(artifactPath)).mode & 0o777).toBe(0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("restricts an existing external result file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "electron-output-test-"))
  try {
    const output = path.join(root, "result.json")
    await mkdir(path.dirname(output), { recursive: true })
    await Bun.write(output, "old")
    await writePrivateArtifact(output, "new")
    expect(await Bun.file(output).text()).toBe("new")
    expect((await stat(output)).mode & 0o777).toBe(0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("verifies runner-owned Electron listener and browser capability", () => {
  expect(verifyElectronLaunchIdentity({
    rootPid: 42,
    executablePath: "/package/App",
    profilePath: "/private/run/profile-capability",
    port: 49152,
    listenerPids: [43],
    processes: [
      {
        pid: 42,
        parentPid: 1,
        processGroupId: 42,
        command: "/package/App --remote-debugging-address=127.0.0.1 --remote-debugging-port=0 --user-data-dir=/private/run/profile-capability",
      },
      { pid: 43, parentPid: 42, processGroupId: 42, command: "/package/App Helper" },
    ],
    websocketUrl: "ws://127.0.0.1:49152/devtools/browser/12345678-1234-1234-1234-123456789abc",
  })).toEqual({ verified: true, processGroupId: 42 })
  expect(electronRendererTarget("[t1] page daw://app/")).toEqual({
    targetId: "t1",
    url: "daw://app/",
  })
  expect(electronRendererTarget("→ [t1] Browser DAW - daw://app/?dashboard=general")).toEqual({
    targetId: "t1",
    url: "daw://app/?dashboard=general",
  })
  expect(electronRendererTarget("→ [t1]  - about:blank")).toBeUndefined()
  expect(electronRendererTarget("  [t1]  - about:blank\n→ [t2] DAW - daw://app/")).toEqual({
    targetId: "t2",
    url: "daw://app/",
  })
})

test("rejects an impersonating CDP listener before renderer interaction", () => {
  expect(verifyElectronLaunchIdentity({
    rootPid: 42,
    executablePath: "/package/App",
    profilePath: "/private/run/profile-capability",
    port: 49152,
    listenerPids: [99],
    processes: [
      {
        pid: 42,
        parentPid: 1,
        processGroupId: 42,
        command: "/package/App --remote-debugging-address=127.0.0.1 --remote-debugging-port=0 --user-data-dir=/private/run/profile-capability",
      },
      { pid: 99, parentPid: 1, processGroupId: 99, command: "/tmp/impostor" },
    ],
    websocketUrl: "ws://127.0.0.1:49152/devtools/browser/12345678-1234-1234-1234-123456789abc",
  })).toEqual({
    verified: false,
    reason: "Electron debugging endpoint is owned by another process.",
  })
})

test("plans cleanup only for recorded runner descendants", () => {
  const before = [
    { pid: 42, parentPid: 1, processGroupId: 42, command: "/package/App" },
    { pid: 43, parentPid: 42, processGroupId: 42, command: "/package/App Helper" },
    { pid: 44, parentPid: 43, processGroupId: 42, command: "/package/App Helper" },
    { pid: 99, parentPid: 1, processGroupId: 99, command: "/package/App" },
  ]
  const plan = createCleanupPlan(before, 42)
  expect(plan).toEqual({
    rootPid: 42,
    processGroupId: 42,
    recordedProcesses: before.slice(0, 3),
  })
  if (!plan) throw new Error("Cleanup plan missing.")
  expect(cleanupSurvivors(plan, [
    { pid: 44, parentPid: 1, processGroupId: 42, command: "/package/App Helper" },
    { pid: 99, parentPid: 1, processGroupId: 99, command: "/package/App" },
  ])).toEqual([44])
})
