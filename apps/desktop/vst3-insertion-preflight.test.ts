import { expect, test } from "bun:test"
import type { PluginCatalogData } from "./plugin-catalog"
import { preflightVst3Insertion } from "./vst3-insertion-preflight"

const reference = {
  version: 1 as const,
  classId: "example-effect",
  vendorId: "Example Vendor",
  architecture: "arm64" as const,
  bundleFingerprint: "b".repeat(64),
  binaryFingerprint: "a".repeat(64),
  scannerCatalogVersion: 2 as const,
}

const catalog = (role: "effect" | "instrument" = "effect"): PluginCatalogData => ({
  version: 3,
  directories: ["/Library/Audio/Plug-Ins/VST3"],
  entries: [{
    bundlePath: "/Library/Audio/Plug-Ins/VST3/Example.vst3",
    displayName: "Example",
    configuredDirectory: "/Library/Audio/Plug-Ins/VST3",
    discoveredAtMs: 1,
    architecture: "unknown",
    hostingStatus: "ready",
    classes: [{
      classId: reference.classId,
      vendor: reference.vendorId,
      name: "Example",
      version: "1",
      role,
      source: "factory",
    }],
    scanHealth: "scanned",
    binaryFingerprint: reference.binaryFingerprint,
    launchEligibility: {
      canonicalBundlePath: "/Library/Audio/Plug-Ins/VST3/Example.vst3",
      canonicalExecutablePath: "/Library/Audio/Plug-Ins/VST3/Example.vst3/Contents/MacOS/Example",
      bundleFingerprint: reference.bundleFingerprint,
      binaryFingerprint: reference.binaryFingerprint,
      architecture: "arm64",
      codeSignVerifiedAtMs: 1,
      quarantinePresent: false,
      scannerProtocolVersion: 2,
    },
  }],
  diagnostics: [],
  scannedAtMs: 1,
})

const availablePreflight = async (
  instanceId: string,
  channels = 2,
  role: "effect" | "instrument" = "effect",
) => ({
  version: 1 as const,
  type: "preflight-result" as const,
  requestId: "request-1",
  status: "available" as const,
  requirements: {
    artifact: { id: "daw-vst3-worker" as const, version: "3" as const },
    startupProtocolVersion: 1 as const,
    controlProtocolVersion: 2 as const,
    transportAbiVersion: 5 as const,
    architecture: "arm64" as const,
  },
  hello: {
    version: 1 as const,
    type: "hello" as const,
    instanceId,
    manifest: {
      version: 1 as const,
      artifact: { id: "daw-vst3-worker" as const, version: "3" as const },
      startupProtocolVersion: 1 as const,
      controlProtocolVersion: 2 as const,
      transportAbiVersion: 5 as const,
      architecture: "arm64" as const,
      role,
      inputBuses: role === "instrument" ? [] : [{ name: "Input", channels, enabled: true }],
      outputBuses: [{ name: "Output", channels, enabled: true }],
      transport: {
        slotCount: 2,
        maximumFrames: 512,
        inputChannels: role === "instrument" ? 0 : channels,
        outputChannels: channels,
        maximumEventsPerBlock: 128,
      },
      latencyFrames: 24,
      tailFrames: 48,
      stateRevision: 0,
      parameters: [{
        id: 7,
        title: "Mix",
        unit: "%",
        minimum: 0,
        maximum: 1,
        defaultValue: 0.25,
        stepCount: 100,
        readOnly: false,
        hidden: false,
      }],
      supportsBypass: true,
      supportsEditor: true,
      supportsState: true,
    },
  },
})

test("preflights a trusted effect and returns only path-free persisted manifest fields", async () => {
  const instanceId = crypto.randomUUID()
  const result = await preflightVst3Insertion({
    request: { instanceId, reference },
    catalog: catalog(),
    workerPath: "/Resources/daw-vst3-worker",
    sampleRateHz: 48_000,
    preflight: async () => availablePreflight(instanceId),
  })

  expect(result).toEqual({
    ok: true,
    manifest: {
      role: "effect",
      inputBuses: [{ name: "Input", channels: 2, enabled: true }],
      outputBuses: [{ name: "Output", channels: 2, enabled: true }],
      parameters: [{
        id: 7,
        title: "Mix",
        unit: "%",
        minimum: 0,
        maximum: 1,
        defaultValue: 0.25,
        stepCount: 100,
        readOnly: false,
        hidden: false,
      }],
      latencyFrames: 24,
      tailFrames: 48,
      supportsBypass: true,
      supportsEditor: true,
      supportsState: true,
    },
  })
  expect(JSON.stringify(result)).not.toContain("Example.vst3")
})

test("rejects stale catalog identity before worker preflight", async () => {
  let calls = 0
  const result = await preflightVst3Insertion({
    request: { instanceId: crypto.randomUUID(), reference: { ...reference, binaryFingerprint: "c".repeat(64) } },
    catalog: catalog(),
    workerPath: "/Resources/daw-vst3-worker",
    sampleRateHz: 48_000,
    preflight: async () => {
      calls += 1
      return availablePreflight(crypto.randomUUID())
    },
  })

  expect(result).toMatchObject({ ok: false, code: "stale-catalog" })
  expect(calls).toBe(0)
})

test("rejects unsupported buses without mutating any native transaction", async () => {
  const instanceId = crypto.randomUUID()
  const result = await preflightVst3Insertion({
    request: { instanceId, reference },
    catalog: catalog(),
    workerPath: "/Resources/daw-vst3-worker",
    sampleRateHz: 48_000,
    preflight: async () => availablePreflight(instanceId, 1),
  })

  expect(result).toMatchObject({ ok: false, code: "unsupported-bus" })
})

test("preflights a zero-input instrument with a stereo output", async () => {
  const instanceId = crypto.randomUUID()
  const result = await preflightVst3Insertion({
    request: { instanceId, reference },
    catalog: catalog("instrument"),
    workerPath: "/Resources/daw-vst3-worker",
    sampleRateHz: 48_000,
    preflight: async () => availablePreflight(instanceId, 2, "instrument"),
  })

  expect(result).toMatchObject({
    ok: true,
    manifest: {
      role: "instrument",
      inputBuses: [],
      outputBuses: [{ name: "Output", channels: 2, enabled: true }],
    },
  })
})
