import { expect, test } from "bun:test"
import { encodeNativeExternalAttachmentPlan } from "@daw-browser/plugin-host-protocol"
import { externalProcessorSchema, type ExternalProcessor } from "@daw-browser/external-plugins"
import { nativeGraphNodeId } from "@daw-browser/audio-engine/native-host-wire"
import { compileLiveNativeProjection } from "@daw-browser/audio-engine/live-native-projection"
import { createDefaultSynthParams } from "@daw-browser/shared"
import { compileLivePlaybackSnapshot, type LivePlaybackSnapshotInput } from "~/lib/live-playback-snapshot"
import {
  compileNativeExternalAttachmentPlan,
  compileNativeExternalAttachmentSnapshot,
  compileNativeExternalEditorPlan,
} from "./native-external-attachment-plan"

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 1
  readonly length = 48_000
  readonly numberOfChannels = 2
  readonly sampleRate = 48_000
  copyFromChannel(destination: Float32Array) { destination.fill(0) }
  copyToChannel() {}
  getChannelData() { return new Float32Array(this.length) }
}

const snapshotInput: LivePlaybackSnapshotInput = {
  revision: 1,
  bpm: 120,
  transport: { state: "paused", playheadSec: 0, loopEnabled: false, loopStartSec: 0, loopEndSec: 0 },
  tracks: [
    {
      id: "track-a",
      name: "Track A",
      volume: 1,
      clips: [{
        id: "clip-a",
        name: "Clip A",
        color: "#fff",
        startSec: 0,
        duration: 1,
        sourceAssetKey: "asset-a",
        buffer: new TestAudioBuffer(),
      }],
    },
    { id: "track-b", name: "Track B", volume: 1, clips: [] },
  ],
  renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
  sidechainRoutes: [],
}

const graph = (trackKind: "audio" | "instrument" = "audio") => {
  const result = compileLivePlaybackSnapshot({
    ...snapshotInput,
    tracks: snapshotInput.tracks.map((track, index) => index === 0 ? { ...track, kind: trackKind } : track),
  })
  if (!result.supported) throw new Error(result.reasons.join("\n"))
  return result.snapshot.mixer.graph
}

const processor = (overrides: Partial<ExternalProcessor> = {}) => externalProcessorSchema.parse({
  instanceId: crypto.randomUUID(),
  targetId: "track-a",
  chainIndex: 0,
  manifest: {
    identity: {
      format: "vst3",
      classId: "example-effect",
      vendor: "Example Vendor",
      name: "Example Effect",
      version: "1",
      architecture: "arm64",
      discoveredPath: "/Library/Audio/Plug-Ins/VST3/Example.vst3",
      binaryFingerprint: "a".repeat(64),
    },
    role: "effect",
    audioInputs: [{ name: "Main Input", channels: 2, enabled: true }],
    audioOutputs: [{ name: "Main Output", channels: 2, enabled: true }],
    sidechainInputs: [],
    parameters: [],
    latencyFrames: 10,
    tailFrames: 20,
    supportsBypass: true,
    supportsEditor: false,
    supportsState: true,
  },
  parameterOverrides: {},
  latencyFrames: 12,
  tailFrames: 24,
  bypassed: false,
  launchReference: {
    version: 1,
    classId: "example-effect",
    vendorId: "Example Vendor",
    architecture: "arm64",
    bundleFingerprint: "b".repeat(64),
    binaryFingerprint: "a".repeat(64),
    scannerCatalogVersion: 2,
  },
  health: { state: "ready", updatedAt: 7 },
  updatedAt: 7,
  ...overrides,
})

const input = (
  processors: readonly ExternalProcessor[],
  target: "native" | "browser" = "native",
  trackKind: "audio" | "instrument" = "audio",
) => ({
  target,
  graph: graph(trackKind),
  processors,
  workerTransport: { slotCount: 2, maximumFrames: 512, maximumEventsPerBlock: 128 },
})

test("maps resolved mixer nodes and deterministically orders external chains", () => {
  const first = processor({ chainIndex: 0 })
  const third = processor({ targetId: "track-b", chainIndex: 0 })
  const result = compileNativeExternalAttachmentPlan(input([third, first]))

  expect(result.supported).toBeTrue()
  if (!result.supported) return
  expect(result.plan.attachments.map(({ graphNodeId, nativeGraphNodeId: mappedNodeId, chainIndex }) => ({
    graphNodeId,
    nativeGraphNodeId: mappedNodeId,
    chainIndex,
  }))).toEqual([
    { graphNodeId: "track-a", nativeGraphNodeId: nativeGraphNodeId("track-a").toString(), chainIndex: 0 },
    { graphNodeId: "track-b", nativeGraphNodeId: nativeGraphNodeId("track-b").toString(), chainIndex: 0 },
  ])
  expect(result.plan.attachments[0]).toMatchObject({
    instanceId: first.instanceId,
    catalogIdentity: { classId: "example-effect", vendorId: "Example Vendor", scannerCatalogVersion: 2 },
    bundleFingerprint: "b".repeat(64),
    binaryFingerprint: "a".repeat(64),
    inputBuses: [{ name: "Main Input", channels: 2, enabled: true }],
    outputBuses: [{ name: "Main Output", channels: 2, enabled: true }],
    workerTransport: { slotCount: 2, maximumFrames: 512, inputChannels: 2, outputChannels: 2, maximumEventsPerBlock: 128 },
    declaredLatencyFrames: 12,
    declaredTailFrames: 24,
    stateRevision: 7,
  })
  expect(encodeNativeExternalAttachmentPlan(result.plan)).not.toContain("discoveredPath")
})

test("keeps an empty VST target beside a built-in instrument in the native graph projection", () => {
  const tracks = [
    { ...snapshotInput.tracks[0]!, id: "synth", name: "Synth", kind: "instrument" as const, clips: [] },
    { ...snapshotInput.tracks[1]!, id: "vst-target", name: "VST Target", kind: "audio" as const, clips: [] },
  ]
  const instrument = {
    kind: "synth" as const,
    instanceId: "instrument:1",
    params: createDefaultSynthParams(),
  }
  const projection = compileLiveNativeProjection({
    tracks,
    bpm: 120,
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
    fx: {
      masterFxInstances: [],
      trackFx: { synth: { instances: [], instrument } },
    },
  })
  expect(projection.supported).toBeTrue()
  if (!projection.supported) return
  expect(projection.graph.nodes.map((node) => node.id)).toEqual(["synth", "vst-target", "$master"])
  expect(projection.events).toHaveLength(0)

  const snapshot = compileLivePlaybackSnapshot({
    ...snapshotInput,
    tracks,
    renderState: {
      fx: {
        masterFxInstances: [],
        trackFx: { synth: { instances: [], instrument } },
      },
      automationEnvelopes: [],
    },
  })
  expect(snapshot.supported).toBeTrue()
  if (!snapshot.supported) return
  const result = compileNativeExternalAttachmentPlan({
    target: "native",
    graph: snapshot.snapshot.mixer.graph,
    processors: [processor({ targetId: "vst-target" })],
    workerTransport: { slotCount: 2, maximumFrames: 512, maximumEventsPerBlock: 128 },
  })
  expect(result.supported).toBeTrue()
  if (!result.supported) return
  expect(result.plan.attachments[0]?.graphNodeId).toBe("vst-target")
})

test("supports serial chains and rejects missing targets, stale identity, unsupported roles, and incompatible layouts", () => {
  const duplicate = processor({ chainIndex: 1 })
  const missingTarget = processor({ targetId: "missing" })
  const staleReference = processor().launchReference
  if (!staleReference) throw new Error("Test processor requires a launch reference.")
  const staleIdentity = processor({
    chainIndex: 0,
    launchReference: { ...staleReference, binaryFingerprint: "c".repeat(64) },
  })
  const instrument = processor({
    chainIndex: 0,
    manifest: { ...processor().manifest, role: "instrument", audioInputs: [] },
  })
  const incompatibleLayout = processor({
    chainIndex: 0,
    manifest: { ...processor().manifest, audioInputs: [{ name: "Main Input", channels: 1, enabled: true }] },
  })
  const chain = compileNativeExternalAttachmentSnapshot(input([processor(), duplicate]))
  expect(chain.supported).toBeTrue()
  if (chain.supported) expect(chain.attachments).toHaveLength(2)
  expect(compileNativeExternalAttachmentSnapshot(input([processor({ chainIndex: 2 })]))).toMatchObject({
    supported: true,
    attachments: [{ chainIndex: 0 }],
  })
  expect(compileNativeExternalAttachmentSnapshot(input([missingTarget]))).toEqual({
    supported: false,
    reasons: ['External processor "' + missingTarget.instanceId + '" targets missing mixer node "missing".'],
  })
  expect(compileNativeExternalAttachmentSnapshot(input([staleIdentity]))).toEqual({
    supported: false,
    reasons: ['External processor "' + staleIdentity.instanceId + '" has stale native catalog identity.'],
  })
  expect(compileNativeExternalAttachmentSnapshot(input([instrument]))).toEqual({
    supported: false,
    reasons: [`External instrument "${instrument.instanceId}" requires an instrument mixer node and exactly one enabled output bus.`],
  })
  expect(compileNativeExternalAttachmentSnapshot(input([incompatibleLayout]))).toEqual({
    supported: false,
    reasons: ['External processor "' + incompatibleLayout.instanceId + '" has buses incompatible with mixer node "track-a".'],
  })
})

test("projects sparse active chains contiguously after persisted deletion and bypass gaps", () => {
  const first = processor({ chainIndex: 0 })
  const bypassed = processor({ chainIndex: 1, bypassed: true })
  const third = processor({ chainIndex: 4 })
  const result = compileNativeExternalAttachmentSnapshot(input([third, bypassed, first]))

  expect(result.supported).toBeTrue()
  if (!result.supported) return
  expect(result.attachments.map(({ instanceId, chainIndex }) => ({ instanceId, chainIndex }))).toEqual([
    { instanceId: first.instanceId, chainIndex: 0 },
    { instanceId: third.instanceId, chainIndex: 1 },
  ])
  expect(third.chainIndex).toBe(4)
})

test("orders equal persisted chain indexes by instance ID", () => {
  const lower = processor({ chainIndex: 3, instanceId: "00000000-0000-4000-8000-000000000001" })
  const higher = processor({ chainIndex: 3, instanceId: "00000000-0000-4000-8000-000000000002" })
  const result = compileNativeExternalAttachmentSnapshot(input([higher, lower]))

  expect(result.supported).toBeTrue()
  if (!result.supported) return
  expect(result.attachments.map(({ instanceId, chainIndex }) => ({ instanceId, chainIndex }))).toEqual([
    { instanceId: lower.instanceId, chainIndex: 0 },
    { instanceId: higher.instanceId, chainIndex: 1 },
  ])
})

test("projects a zero-input instrument onto an instrument mixer node", () => {
  const instrument = processor({
    manifest: {
      ...processor().manifest,
      role: "instrument",
      audioInputs: [],
    },
  })
  const result = compileNativeExternalAttachmentSnapshot(input([instrument], "native", "instrument"))

  expect(result.supported).toBeTrue()
  if (!result.supported) return
  expect(result.attachments[0]).toMatchObject({
    instanceId: instrument.instanceId,
    role: "instrument",
    inputBuses: [],
    outputBuses: [{ name: "Main Output", channels: 2, enabled: true }],
    workerTransport: { inputChannels: 0, outputChannels: 2 },
  })
})

test("rejects live processors for browser playback and projects frozen processors as no attachments", () => {
  const live = processor()
  expect(compileNativeExternalAttachmentSnapshot(input([live], "browser"))).toEqual({
    supported: false,
    reasons: [`External plugin ${live.instanceId} must be frozen or bypassed before browser playback.`],
  })
  expect(compileNativeExternalAttachmentSnapshot(input([{ ...live, bypassed: true }], "browser"))).toEqual({
    supported: true,
    attachments: [],
  })
})

test("excludes persisted degraded processors from native and browser attachment candidates", () => {
  const degraded = processor({
    health: { state: "degraded", reason: "Native playback failed.", updatedAt: 8 },
  })
  const ready = processor({ targetId: "track-b", chainIndex: 1 })

  const native = compileNativeExternalAttachmentSnapshot(input([degraded, ready]))
  expect(native.supported).toBeTrue()
  if (!native.supported) return
  expect(native.attachments.map(({ instanceId }) => instanceId)).toEqual([ready.instanceId])

  expect(compileNativeExternalAttachmentSnapshot(input([degraded], "browser"))).toEqual({
    supported: true,
    attachments: [],
  })
})

test("encodes equivalent native projections identically regardless of persisted record order", () => {
  const a = processor({ chainIndex: 0 })
  const b = processor({ targetId: "track-b", chainIndex: 0 })
  const first = compileNativeExternalAttachmentPlan(input([b, a]))
  const second = compileNativeExternalAttachmentPlan(input([a, b]))

  expect(first.supported).toBeTrue()
  expect(second.supported).toBeTrue()
  if (!first.supported || !second.supported) return
  expect(encodeNativeExternalAttachmentPlan(first.plan)).toBe(encodeNativeExternalAttachmentPlan(second.plan))
})

test("compiles a path-free editor plan without resolving a playback graph", () => {
  const result = compileNativeExternalEditorPlan({
    processor: processor({ bypassed: true }),
    targetId: "track-a",
  })

  expect(result.supported).toBeTrue()
  if (!result.supported) return
  expect(result.plan.attachments).toHaveLength(1)
  expect(result.plan.attachments[0]).toMatchObject({
    graphNodeId: "track-a",
    nativeGraphNodeId: nativeGraphNodeId("track-a").toString(),
    bypassed: true,
    workerTransport: {
      slotCount: 2,
      maximumFrames: 8_192,
      maximumEventsPerBlock: 128,
      inputChannels: 2,
      outputChannels: 2,
    },
  })
  expect(encodeNativeExternalAttachmentPlan(result.plan)).not.toContain("discoveredPath")
})

test("compiles a zero-input instrument editor plan", () => {
  const instrument = processor({
    manifest: {
      ...processor().manifest,
      role: "instrument",
      audioInputs: [],
    },
  })
  const result = compileNativeExternalEditorPlan({
    processor: instrument,
    targetId: "track-a",
  })

  expect(result.supported).toBeTrue()
  if (!result.supported) return
  expect(result.plan.attachments[0]).toMatchObject({
    role: "instrument",
    chainIndex: 0,
    inputBuses: [],
    workerTransport: { inputChannels: 0, outputChannels: 2 },
  })
})

test("rejects stale editor identity and unsupported enabled bus layouts", () => {
  const reference = processor().launchReference
  if (!reference) throw new Error("Test processor requires a launch reference.")
  const stale = compileNativeExternalEditorPlan({
    processor: processor({ launchReference: { ...reference, binaryFingerprint: "c".repeat(64) } }),
    targetId: "track-a",
  })
  expect(stale.supported).toBeFalse()
  if (stale.supported) return
  expect(stale.reasons[0]).toContain("stale native catalog identity")
  const unsupportedBus = processor({
      manifest: {
        ...processor().manifest,
        audioInputs: [
          { name: "Main Input", channels: 2, enabled: true },
          { name: "Extra Input", channels: 2, enabled: true },
        ],
      },
    })
  expect(compileNativeExternalEditorPlan({
    processor: unsupportedBus,
    targetId: "track-a",
  })).toEqual({
    supported: false,
    reasons: [`External processor "${unsupportedBus.instanceId}" must have exactly one enabled mono or stereo input and output bus.`],
  })
})
