import { expect, test } from "bun:test"
import { externalProcessorSchema, type ExternalProcessor } from "@daw-browser/external-plugins"
import { compileLivePlaybackSnapshot } from "~/lib/live-playback-snapshot"
import { compileNativeExternalAttachmentPlan } from "./native-external-attachment-plan"
import { resolveNativeLivePlaybackProcessors } from "./native-live-playback-processors"

const processor = (instanceId: string): ExternalProcessor => externalProcessorSchema.parse({
  instanceId,
  targetId: "track-2",
  index: 0,
  manifest: {
    identity: {
      format: "vst3",
      classId: "example",
      vendor: "Example",
      name: "Example",
      version: "1",
      architecture: "arm64",
      binaryFingerprint: "a".repeat(64),
    },
    role: "effect",
    audioInputs: [{ name: "Input", channels: 2, enabled: true }],
    audioOutputs: [{ name: "Output", channels: 2, enabled: true }],
    sidechainInputs: [],
    parameters: [],
    latencyFrames: 0,
    tailFrames: 0,
    supportsBypass: false,
    supportsEditor: false,
    supportsState: false,
  },
  parameterOverrides: {},
  latencyFrames: 0,
  tailFrames: 0,
  bypassed: false,
  launchReference: {
    version: 1,
    classId: "example",
    vendorId: "Example",
    architecture: "arm64",
    bundleFingerprint: "b".repeat(64),
    binaryFingerprint: "a".repeat(64),
    scannerCatalogVersion: 2,
  },
  health: { state: "ready", updatedAt: 1 },
  updatedAt: 1,
})

test("keeps the insertion seed when the committed row read briefly lags", async () => {
  const inserted = processor("11111111-1111-4111-8111-111111111111")
  const result = await resolveNativeLivePlaybackProcessors({
    projectId: "project",
    persisted: [],
    seed: { projectId: "project", processor: inserted },
    readPersisted: async () => undefined,
  })
  expect(result).toEqual([inserted])
})

test("uses persisted state when visible and excludes rolled-back seeds", async () => {
  const inserted = processor("22222222-2222-4222-8222-222222222222")
  const persisted = { ...inserted, updatedAt: 2 }
  await expect(resolveNativeLivePlaybackProcessors({
    projectId: "project",
    persisted: [],
    seed: { projectId: "project", processor: inserted },
    readPersisted: async () => persisted,
  })).resolves.toEqual([persisted])
  await expect(resolveNativeLivePlaybackProcessors({
    projectId: "project",
    persisted: [],
    readPersisted: async () => undefined,
  })).resolves.toEqual([])
})

test("compiles the bound processor beside a long metadata-backed clip", async () => {
  const inserted = processor("44444444-4444-4444-8444-444444444444")
  const playback = compileLivePlaybackSnapshot({
    revision: 1,
    bpm: 120,
    transport: { state: "paused", playheadSec: 0, loopEnabled: false, loopStartSec: 0, loopEndSec: 0 },
    tracks: [{
      id: "track-2",
      name: "Track 2",
      volume: 1,
      clips: [{
        id: "long-clip",
        name: "Long clip",
        color: "#fff",
        startSec: 0,
        duration: 7_200,
        sourceAssetKey: "long-source",
        sourceDurationSec: 7_200,
        sourceSampleRate: 48_000,
        sourceChannelCount: 2,
        audioWarp: { enabled: true, mode: "stretch", sourceBpm: 120 },
      }],
    }],
    renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
    sidechainRoutes: [],
  })
  expect(playback.supported).toBeTrue()
  if (!playback.supported) return
  const processors = await resolveNativeLivePlaybackProcessors({
    projectId: "project",
    persisted: [],
    seed: { projectId: "project", processor: inserted },
    readPersisted: async () => undefined,
  })
  const plan = compileNativeExternalAttachmentPlan({
    target: "native",
    graph: playback.snapshot.mixer.graph,
    processors,
    workerTransport: { slotCount: 2, maximumFrames: 8_192, maximumEventsPerBlock: 128 },
  })
  expect(plan.supported).toBeTrue()
  if (plan.supported) expect(plan.plan.attachments[0]?.instanceId).toBe(inserted.instanceId)
})
