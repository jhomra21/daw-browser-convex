import { expect, test } from "bun:test"
import type { ExternalProcessor } from "@daw-browser/external-plugins"
import { LocalExternalProcessorPersistenceError } from "~/lib/external-plugins"
import {
  insertNativeVst3Effect,
  nativeVst3InsertionAvailability,
  type NativeVst3CatalogSelection,
} from "./native-vst3-insertion"

const selection = (role: "effect" | "instrument" = "effect"): NativeVst3CatalogSelection => ({
  entry: {
    displayName: "Example",
    discoveredAtMs: 1,
    architecture: "unknown",
    hostingStatus: "unavailable",
    unavailableReason: "Native graph activation is available after preflight.",
    classes: [{
      classId: `example-${role}`,
      vendor: "Example Vendor",
      name: role === "effect" ? "Example Effect" : "Example Instrument",
      version: "1",
      role,
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
    classId: `example-${role}`,
    vendor: "Example Vendor",
    name: role === "effect" ? "Example Effect" : "Example Instrument",
    version: "1",
    role,
    source: "factory",
  },
})

const audioTrack = (overrides: {
  kind?: "audio" | "instrument"
  channelRole?: "track" | "group" | "return"
  groupId?: string
  outputTargetId?: string
  sends?: Array<{ targetId: string; amount: number }>
} = {}) => ({
  id: "track-1",
  kind: "audio" as const,
  ...overrides,
})

test("reports browser absence and stale catalog state with typed reasons", () => {
  expect(nativeVst3InsertionAvailability({
    selection: selection(),
    projectId: "project:00000000-0000-4000-8000-000000000000",
    targetId: "track-1",
    targetTrack: audioTrack(),
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
    targetTrack: audioTrack(),
    canWrite: true,
    bridgeAvailable: true,
    busy: false,
  })).toMatchObject({ enabled: false, code: "stale-catalog" })
})

test("accepts instrument tracks but rejects routed targets before native preflight", async () => {
  expect(nativeVst3InsertionAvailability({
    selection: selection(),
    projectId: "project:00000000-0000-4000-8000-000000000000",
    targetId: "track-1",
    targetTrack: audioTrack({ kind: "instrument" }),
    canWrite: true,
    bridgeAvailable: true,
    busy: false,
  })).toMatchObject({ enabled: true })

  expect(nativeVst3InsertionAvailability({
    selection: selection(),
    projectId: "project:00000000-0000-4000-8000-000000000000",
    targetId: "track-1",
    targetTrack: audioTrack({ outputTargetId: "group-1" }),
    canWrite: true,
    bridgeAvailable: true,
    busy: false,
  })).toMatchObject({ enabled: false, code: "unsupported-bus" })

  let preflightCalls = 0
  const result = await insertNativeVst3Effect({
    projectId: "project:00000000-0000-4000-8000-000000000000",
    targetId: "track-1",
    targetTrack: audioTrack({ kind: "instrument" }),
    selection: selection(),
    bridge: {
      preflightInsertion: async () => {
        preflightCalls += 1
        return { ok: false, code: "worker-timeout", message: "preflight failed" }
      },
    },
  })
  expect(result).toMatchObject({ ok: false, code: "worker-timeout" })
  expect(preflightCalls).toBe(1)
})

test("preflights and persists an external VST instrument on an instrument track", async () => {
  let persistedRole: string | undefined
  const result = await insertNativeVst3Effect({
    projectId: "project:00000000-0000-4000-8000-000000000000",
    targetId: "track-1",
    targetTrack: audioTrack({ kind: "instrument" }),
    selection: selection("instrument"),
    bridge: {
      preflightInsertion: async () => ({
        ok: true,
        manifest: {
          role: "instrument",
          inputBuses: [{ name: "Input", channels: 2, enabled: true }],
          outputBuses: [{ name: "Output", channels: 2, enabled: true }],
          parameters: [],
          latencyFrames: 0,
          tailFrames: 0,
          supportsBypass: false,
          supportsEditor: false,
          supportsState: false,
        },
      }),
    },
    createInstanceId: () => "a7a0b9ac-7884-492c-8b68-80f15802442c",
    persist: async (_projectId, processor) => {
      persistedRole = processor.manifest.role
      return { ...processor, index: 0 }
    },
  })
  expect(result).toMatchObject({ ok: true })
  expect(persistedRole).toBe("instrument")
})

test("persists only path-free identity after successful preflight", async () => {
  let persisted: Omit<ExternalProcessor, "index"> | undefined
  const result = await insertNativeVst3Effect({
    projectId: "project:00000000-0000-4000-8000-000000000000",
    targetId: "track-1",
    targetTrack: audioTrack(),
    selection: selection(),
    bridge: {
      preflightInsertion: async () => ({
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
          supportsEditor: false,
          supportsState: true,
        },
      }),
    },
    now: () => 7,
    createInstanceId: () => "a7a0b9ac-7884-492c-8b68-80f15802442c",
    persist: async (_projectId, processor) => {
      persisted = processor
      return { ...processor, index: 0 }
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
    bypassed: false,
    health: {
      state: "ready",
      reason: "Native VST3 preflight passed; playback uses the native graph on compatible directly routed stereo tracks, including synth MIDI tracks.",
      updatedAt: 7,
    },
    latencyFrames: 24,
    tailFrames: 48,
    parameterOverrides: {},
    manifest: {
      parameters: [{
        id: 7,
        title: "Mix",
      }],
      supportsBypass: true,
      supportsState: true,
    },
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
    targetTrack: audioTrack(),
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
    targetTrack: audioTrack(),
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
          parameters: [],
          supportsBypass: false,
          supportsEditor: false,
          supportsState: false,
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

test("distinguishes persistence failure after successful native preflight", async () => {
  const result = await insertNativeVst3Effect({
    projectId: "project:00000000-0000-4000-8000-000000000000",
    targetId: "track-1",
    targetTrack: audioTrack(),
    selection: selection(),
    bridge: {
      preflightInsertion: async () => ({
        ok: true,
        manifest: {
          role: "effect",
          inputBuses: [{ name: "Input", channels: 2, enabled: true }],
          outputBuses: [{ name: "Output", channels: 2, enabled: true }],
          parameters: [],
          latencyFrames: 0,
          tailFrames: 0,
          supportsBypass: false,
          supportsEditor: false,
          supportsState: false,
        },
      }),
    },
    persist: async () => {
      throw new Error("local project write failed")
    },
  })
  expect(result).toMatchObject({
    ok: false,
    code: "project-unavailable",
    message: "Native VST3 passed preflight but local persistence failed (write-failed): the local project write failed.",
  })
})

test("sanitizes local persistence reasons while preserving their safe code", async () => {
  const result = await insertNativeVst3Effect({
    projectId: "project:00000000-0000-4000-8000-000000000000",
    targetId: "track-1",
    targetTrack: audioTrack(),
    selection: selection(),
    bridge: {
      preflightInsertion: async () => ({
        ok: true,
        manifest: {
          role: "effect",
          inputBuses: [{ name: "Input", channels: 2, enabled: true }],
          outputBuses: [{ name: "Output", channels: 2, enabled: true }],
          parameters: [],
          latencyFrames: 0,
          tailFrames: 0,
          supportsBypass: false,
          supportsEditor: false,
          supportsState: false,
        },
      }),
    },
    persist: async () => {
      throw new LocalExternalProcessorPersistenceError(
        "corrupt-row",
        'External plugin row "external-plugin:private" contains /private/Plugin.vst3.',
      )
    },
  })
  expect(result).toEqual({
    ok: false,
    code: "project-unavailable",
    message: "Native VST3 passed preflight but local persistence failed (corrupt-row): an existing external plugin row is corrupt or incompatible.",
  })
  expect(JSON.stringify(result)).not.toContain("/private/")
})
