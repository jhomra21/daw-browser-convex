import { expect, test } from "bun:test"
import type { ExternalProcessor } from "@daw-browser/external-plugins"
import {
  insertNativeVst3Effect,
  nativeVst3InsertionAvailability,
  type NativeVst3CatalogSelection,
} from "./native-vst3-insertion"

const selection = (): NativeVst3CatalogSelection => ({
  entry: {
    displayName: "Example",
    discoveredAtMs: 1,
    architecture: "unknown",
    hostingStatus: "unavailable",
    unavailableReason: "Native graph activation is gated.",
    classes: [{
      classId: "example-effect",
      vendor: "Example Vendor",
      name: "Example Effect",
      version: "1",
      role: "effect",
      source: "factory",
    }],
    scanHealth: "scanned",
    binaryFingerprint: "a".repeat(64),
    catalogReference: {
      version: 1,
      architecture: "arm64",
      bundleFingerprint: "b".repeat(64),
      binaryFingerprint: "a".repeat(64),
      scannerCatalogVersion: 2,
    },
  },
  pluginClass: {
    classId: "example-effect",
    vendor: "Example Vendor",
    name: "Example Effect",
    version: "1",
    role: "effect",
    source: "factory",
  },
})

test("reports browser absence and stale catalog state with typed reasons", () => {
  expect(nativeVst3InsertionAvailability({
    selection: selection(),
    projectId: "project:00000000-0000-4000-8000-000000000000",
    targetId: "track-1",
    canWrite: true,
    bridgeAvailable: false,
    busy: false,
  })).toMatchObject({ enabled: false, code: "browser" })

  const stale = selection()
  stale.entry.scanHealth = "scan-failed"
  expect(nativeVst3InsertionAvailability({
    selection: stale,
    projectId: "project:00000000-0000-4000-8000-000000000000",
    targetId: "track-1",
    canWrite: true,
    bridgeAvailable: true,
    busy: false,
  })).toMatchObject({ enabled: false, code: "stale-catalog" })
})

test("persists only path-free identity after successful preflight", async () => {
  let persisted: Omit<ExternalProcessor, "chainIndex"> | undefined
  const result = await insertNativeVst3Effect({
    projectId: "project:00000000-0000-4000-8000-000000000000",
    targetId: "track-1",
    selection: selection(),
    bridge: {
      preflightInsertion: async () => ({
        ok: true,
        manifest: {
          role: "effect",
          inputBuses: [{ name: "Input", channels: 2, enabled: true }],
          outputBuses: [{ name: "Output", channels: 2, enabled: true }],
          latencyFrames: 24,
          tailFrames: 48,
        },
      }),
    },
    now: () => 7,
    createInstanceId: () => "a7a0b9ac-7884-492c-8b68-80f15802442c",
    persist: async (_projectId, processor) => {
      persisted = processor
      return { ...processor, chainIndex: 0 }
    },
  })

  expect(result.ok).toBeTrue()
  expect(persisted?.manifest.identity).toEqual({
    format: "vst3",
    classId: "example-effect",
    vendor: "Example Vendor",
    name: "Example Effect",
    version: "1",
    architecture: "arm64",
    binaryFingerprint: "a".repeat(64),
  })
  expect(persisted).toMatchObject({
    targetId: "track-1",
    bypassed: true,
    latencyFrames: 24,
    tailFrames: 48,
    launchReference: {
      classId: "example-effect",
      vendorId: "Example Vendor",
      bundleFingerprint: "b".repeat(64),
    },
  })
  expect(JSON.stringify(persisted)).not.toContain("/")
})

test("does not persist when native worker preflight fails", async () => {
  let persistCalls = 0
  const result = await insertNativeVst3Effect({
    projectId: "project:00000000-0000-4000-8000-000000000000",
    targetId: "track-1",
    selection: selection(),
    bridge: {
      preflightInsertion: async () => ({
        ok: false,
        code: "worker-timeout",
        message: "The native VST3 worker preflight timed out.",
      }),
    },
    persist: async () => {
      persistCalls += 1
      throw new Error("must not persist")
    },
  })

  expect(result).toMatchObject({ ok: false, code: "worker-timeout" })
  expect(persistCalls).toBe(0)
})

test("does not persist when the selected project or track changes during preflight", async () => {
  let persistCalls = 0
  const result = await insertNativeVst3Effect({
    projectId: "project:00000000-0000-4000-8000-000000000000",
    targetId: "track-1",
    selection: selection(),
    bridge: {
      preflightInsertion: async () => ({
        ok: true,
        manifest: {
          role: "effect",
          inputBuses: [{ name: "Input", channels: 2, enabled: true }],
          outputBuses: [{ name: "Output", channels: 2, enabled: true }],
          latencyFrames: 0,
          tailFrames: 0,
        },
      }),
    },
    validateBeforePersist: () => false,
    persist: async () => {
      persistCalls += 1
      throw new Error("must not persist")
    },
  })

  expect(result).toMatchObject({ ok: false, code: "project-unavailable" })
  expect(persistCalls).toBe(0)
})
