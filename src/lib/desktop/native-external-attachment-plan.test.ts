import { expect, test } from "bun:test"
import { encodeNativeExternalAttachmentPlan } from "@daw-browser/plugin-host-protocol"
import { externalProcessorSchema, type ExternalProcessor } from "@daw-browser/external-plugins"
import { nativeGraphNodeId } from "@daw-browser/audio-engine/native-host-wire"
import { compileLivePlaybackSnapshot, type LivePlaybackSnapshotInput } from "~/lib/live-playback-snapshot"
import {
  compileNativeExternalAttachmentPlan,
  compileNativeExternalAttachmentSnapshot,
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

const graph = () => {
  const result = compileLivePlaybackSnapshot(snapshotInput)
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

const input = (processors: readonly ExternalProcessor[], target: "native" | "browser" = "native") => ({
  target,
  graph: graph(),
  processors,
  workerTransport: { slotCount: 2, maximumFrames: 512, maximumEventsPerBlock: 128 },
})

test("maps resolved mixer nodes and deterministically orders external chains", () => {
  const first = processor({ chainIndex: 2 })
  const third = processor({ targetId: "track-b", chainIndex: 3 })
  const result = compileNativeExternalAttachmentPlan(input([third, first]))

  expect(result.supported).toBeTrue()
  if (!result.supported) return
  expect(result.plan.attachments.map(({ graphNodeId, nativeGraphNodeId: mappedNodeId, chainIndex }) => ({
    graphNodeId,
    nativeGraphNodeId: mappedNodeId,
    chainIndex,
  }))).toEqual([
    { graphNodeId: "track-a", nativeGraphNodeId: nativeGraphNodeId("track-a").toString(), chainIndex: 2 },
    { graphNodeId: "track-b", nativeGraphNodeId: nativeGraphNodeId("track-b").toString(), chainIndex: 3 },
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

test("rejects duplicate native graph attachments, missing targets, stale identity, unsupported roles, and incompatible layouts", () => {
  const duplicate = processor({ chainIndex: 0 })
  const missingTarget = processor({ targetId: "missing" })
  const staleReference = processor().launchReference
  if (!staleReference) throw new Error("Test processor requires a launch reference.")
  const staleIdentity = processor({
    chainIndex: 2,
    launchReference: { ...staleReference, binaryFingerprint: "c".repeat(64) },
  })
  const instrument = processor({
    chainIndex: 3,
    manifest: { ...processor().manifest, role: "instrument", audioInputs: [] },
  })
  const incompatibleLayout = processor({
    chainIndex: 4,
    manifest: { ...processor().manifest, audioInputs: [{ name: "Main Input", channels: 1, enabled: true }] },
  })
  expect(compileNativeExternalAttachmentSnapshot(input([processor(), duplicate]))).toEqual({
    supported: false,
    reasons: ['Mixer node "track-a" has multiple external processors, but the native graph protocol supports one attachment per node.'],
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
    reasons: ['External processor "' + instrument.instanceId + '" has unsupported role "instrument".'],
  })
  expect(compileNativeExternalAttachmentSnapshot(input([incompatibleLayout]))).toEqual({
    supported: false,
    reasons: ['External processor "' + incompatibleLayout.instanceId + '" has buses incompatible with mixer node "track-a".'],
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

test("encodes equivalent native projections identically regardless of persisted record order", () => {
  const a = processor({ chainIndex: 1 })
  const b = processor({ targetId: "track-b", chainIndex: 0 })
  const first = compileNativeExternalAttachmentPlan(input([b, a]))
  const second = compileNativeExternalAttachmentPlan(input([a, b]))

  expect(first.supported).toBeTrue()
  expect(second.supported).toBeTrue()
  if (!first.supported || !second.supported) return
  expect(encodeNativeExternalAttachmentPlan(first.plan)).toBe(encodeNativeExternalAttachmentPlan(second.plan))
})
