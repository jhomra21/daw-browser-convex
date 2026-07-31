import { expect, test } from "bun:test"
import {
  encodeNativeExternalAttachmentPlan,
  nativeVst3PreflightProtocolVersion,
  nativeVst3WorkerArtifactId,
  nativeVst3WorkerArtifactVersion,
  nativeVst3WorkerControlProtocolVersion,
  nativeVst3WorkerStartupProtocolVersion,
  nativeVst3WorkerTransportAbiVersion,
  type NativeExternalAttachmentPlan,
  type NativeVst3PreflightRequest,
  type NativeVst3PreflightResult,
} from "@daw-browser/plugin-host-protocol"
import type { AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import { portableGraphContractHash } from "@daw-browser/audio-core-contract/generated"
import { parsePluginCatalogData, type PluginCatalogData } from "./plugin-catalog"
import {
  coordinateNativeVst3Attachments,
  createNativeVst3RevisionCoordinator,
  nativeVst3PlaybackDefaultStatus,
  type NativeVst3RevisionHost,
  type NativeVst3WorkerRevisionNotification,
} from "./native-vst3-coordinator"

const requirements: NativeVst3PreflightRequest["requirements"] = {
  artifact: { id: nativeVst3WorkerArtifactId, version: nativeVst3WorkerArtifactVersion },
  startupProtocolVersion: nativeVst3WorkerStartupProtocolVersion,
  controlProtocolVersion: nativeVst3WorkerControlProtocolVersion,
  transportAbiVersion: nativeVst3WorkerTransportAbiVersion,
  architecture: "arm64",
}

const catalog = (): PluginCatalogData => ({
  version: 3,
  directories: ["/Library/Audio/Plug-Ins/VST3"],
  entries: [{
    bundlePath: "/Library/Audio/Plug-Ins/VST3/Example.vst3",
    displayName: "Example",
    configuredDirectory: "/Library/Audio/Plug-Ins/VST3",
    discoveredAtMs: 1,
    architecture: "unknown",
    hostingStatus: "unavailable",
    unavailableReason: "VST3 discovery is available, but native VST3 audio hosting is not active.",
    classes: [
      {
        classId: "0123456789abcdef0123456789abcdef",
        vendor: "Example Vendor",
        name: "Example A",
        version: "1",
        role: "effect",
        source: "factory",
      },
      {
        classId: "fedcba9876543210fedcba9876543210",
        vendor: "Example Vendor",
        name: "Example B",
        version: "1",
        role: "effect",
        source: "factory",
      },
    ],
    scanHealth: "scanned",
    binaryFingerprint: "a".repeat(64),
    launchEligibility: {
      canonicalBundlePath: "/Library/Audio/Plug-Ins/VST3/Example.vst3",
      canonicalExecutablePath: "/Library/Audio/Plug-Ins/VST3/Example.vst3/Contents/MacOS/Example",
      bundleFingerprint: "b".repeat(64),
      binaryFingerprint: "a".repeat(64),
      architecture: "arm64",
      codeSignVerifiedAtMs: 1,
      quarantinePresent: false,
      scannerProtocolVersion: 2,
    },
  }],
  diagnostics: [],
  scannedAtMs: 1,
})

const attachment = (input: {
  instanceId: string
  graphNodeId: string
  nativeGraphNodeId: string
  classId: string
}): NativeExternalAttachmentPlan["attachments"][number] => ({
  instanceId: input.instanceId,
  graphNodeId: input.graphNodeId,
  nativeGraphNodeId: input.nativeGraphNodeId,
  chainIndex: 0,
  catalogIdentity: {
    format: "vst3",
    classId: input.classId,
    vendorId: "Example Vendor",
    architecture: "arm64",
    scannerCatalogVersion: 2,
  },
  bundleFingerprint: "b".repeat(64),
  binaryFingerprint: "a".repeat(64),
  role: "effect",
  inputBuses: [{ name: "Main Input", channels: 2, enabled: true }],
  outputBuses: [{ name: "Main Output", channels: 2, enabled: true }],
  workerTransport: {
    slotCount: 2,
    maximumFrames: 512,
    inputChannels: 2,
    outputChannels: 2,
    maximumEventsPerBlock: 128,
  },
  declaredLatencyFrames: 32,
  declaredTailFrames: 480,
  bypassed: false,
  stateRevision: 7,
})

const first = attachment({
  instanceId: "11111111-1111-4111-8111-111111111111",
  graphNodeId: "track-a",
  nativeGraphNodeId: "1",
  classId: "0123456789abcdef0123456789abcdef",
})
const second = attachment({
  instanceId: "22222222-2222-4222-8222-222222222222",
  graphNodeId: "track-b",
  nativeGraphNodeId: "2",
  classId: "fedcba9876543210fedcba9876543210",
})

const available = (
  source: NativeExternalAttachmentPlan["attachments"][number],
  manifest: Partial<{
    role: "effect" | "instrument"
    inputBuses: typeof source.inputBuses
    outputBuses: typeof source.outputBuses
  }> = {},
): NativeVst3PreflightResult => ({
  version: nativeVst3PreflightProtocolVersion,
  type: "preflight-result",
  requestId: `preflight-${source.instanceId}`,
  status: "available",
  requirements,
  hello: {
    version: 1,
    type: "hello",
    instanceId: source.instanceId,
    manifest: {
      version: 1,
      artifact: requirements.artifact,
      startupProtocolVersion: requirements.startupProtocolVersion,
      controlProtocolVersion: requirements.controlProtocolVersion,
      transportAbiVersion: requirements.transportAbiVersion,
      architecture: "arm64",
      role: manifest.role ?? source.role,
      inputBuses: manifest.inputBuses ?? source.inputBuses,
      outputBuses: manifest.outputBuses ?? source.outputBuses,
      transport: source.workerTransport,
      latencyFrames: source.declaredLatencyFrames,
      tailFrames: source.declaredTailFrames,
      stateRevision: source.stateRevision,
    },
  },
})

const plan = (attachments: NativeExternalAttachmentPlan["attachments"]): string => encodeNativeExternalAttachmentPlan({
  version: 1,
  attachments,
})

const host = (calls: string[]) => ({
  attachVst: async (input: { instanceId: string }) => {
    calls.push(`attach:${input.instanceId}`)
  },
})

test("preflights every attachment before attaching to the active native transaction", async () => {
  const calls: string[] = []
  const attachments = new Map([[first.instanceId, first], [second.instanceId, second]])
  const result = await coordinateNativeVst3Attachments({
    serializedPlan: plan([second, first]),
    sampleRateHz: 48_000,
    workerPath: "/Resources/daw-vst3-worker",
    catalogStore: { reload: async () => catalog() },
    audioHost: host(calls),
    preflight: async ({ attachment: input }) => {
      calls.push(`preflight:${input.instanceId}`)
      const source = attachments.get(input.instanceId)
      if (!source) throw new Error("missing fixture attachment")
      return available(source)
    },
  })
  expect(result).toEqual({ ok: true, attached: 2 })
  expect(calls).toEqual([
    `preflight:${first.instanceId}`,
    `preflight:${second.instanceId}`,
    `attach:${first.instanceId}`,
    `attach:${second.instanceId}`,
  ])
})

test("fails before native transaction for stale, unsigned, and quarantined catalog data", async () => {
  const stale = catalog()
  stale.entries[0]!.scanHealth = "scan-failed"
  const unsigned = catalog()
  unsigned.entries[0]!.launchEligibility = undefined
  const quarantinedValue = JSON.parse(JSON.stringify(catalog()))
  quarantinedValue.entries[0].launchEligibility.quarantinePresent = true
  expect(parsePluginCatalogData(quarantinedValue)).toBeUndefined()
  const quarantined: PluginCatalogData = { ...catalog(), entries: [] }
  for (const untrusted of [stale, unsigned, quarantined]) {
    const calls: string[] = []
    const result = await coordinateNativeVst3Attachments({
      serializedPlan: plan([first]),
      sampleRateHz: 48_000,
      workerPath: "/Resources/daw-vst3-worker",
      catalogStore: { reload: async () => untrusted },
      audioHost: host(calls),
      preflight: async () => available(first),
    })
    expect(result).toMatchObject({ ok: false, code: "attachment-unresolved", instanceId: first.instanceId })
    expect(calls).toEqual([])
  }
})

test("reports a failure when an active native transaction rejects an attachment", async () => {
  const calls: string[] = []
  const result = await coordinateNativeVst3Attachments({
    serializedPlan: plan([first]),
    sampleRateHz: 48_000,
    workerPath: "/Resources/daw-vst3-worker",
    catalogStore: { reload: async () => catalog() },
    audioHost: {
      attachVst: async () => {
        calls.push("attach")
        throw new Error("fixture attach failure")
      },
    },
    preflight: async () => available(first),
  })
  expect(result).toEqual({
    ok: false,
    code: "native-transaction-failed",
    message: "The native VST3 attachment transaction failed.",
  })
  expect(calls).toEqual(["attach"])
})

test("rejects worker role and bus manifest drift before attachment", async () => {
  for (const result of [
    available(first, { role: "instrument", inputBuses: [] }),
    available(first, { inputBuses: [{ name: "Main Input", channels: 1, enabled: true }] }),
  ]) {
    const calls: string[] = []
    const outcome = await coordinateNativeVst3Attachments({
      serializedPlan: plan([first]),
      sampleRateHz: 48_000,
      workerPath: "/Resources/daw-vst3-worker",
      catalogStore: { reload: async () => catalog() },
      audioHost: host(calls),
      preflight: async () => result,
    })
    expect(outcome).toMatchObject({ ok: false, code: "manifest-mismatch", instanceId: first.instanceId })
    expect(calls).toEqual([])
  }
})

test("does not begin attachment when any worker preflight times out or crashes", async () => {
  const failureCodes: Array<Extract<NativeVst3PreflightResult, { status: "unavailable" }>["code"]> = [
    "worker-timeout",
    "worker-crashed",
  ]
  for (const code of failureCodes) {
    const calls: string[] = []
    const outcome = await coordinateNativeVst3Attachments({
      serializedPlan: plan([first, second]),
      sampleRateHz: 48_000,
      workerPath: "/Resources/daw-vst3-worker",
      catalogStore: { reload: async () => catalog() },
      audioHost: host(calls),
      preflight: async ({ attachment: input }) => {
        calls.push(`preflight:${input.instanceId}`)
        return input.instanceId === first.instanceId
          ? available(first)
          : {
            version: 1,
            type: "preflight-result",
            requestId: "failed-preflight",
            status: "unavailable",
            code,
            message: "Worker preflight failed.",
            requirements,
          }
      },
    })
    expect(outcome).toMatchObject({ ok: false, code, instanceId: second.instanceId })
    expect(calls).toEqual([`preflight:${first.instanceId}`, `preflight:${second.instanceId}`])
  }
})

const nativeGraph = (): AudioCoreGraphSnapshot => ({
  version: 1,
  revision: 10,
  contractHash: portableGraphContractHash,
  nodes: [
    {
      id: first.graphNodeId,
      kind: "source",
      inputLayout: "stereo",
      outputLayout: "stereo",
      processorOrder: [],
      externalLatencyFrames: 544,
      latencyFrames: 0,
    },
    {
      id: second.graphNodeId,
      kind: "source",
      inputLayout: "stereo",
      outputLayout: "stereo",
      processorOrder: [],
      externalLatencyFrames: 544,
      latencyFrames: 0,
    },
    {
      id: "master",
      kind: "master",
      inputLayout: "stereo",
      outputLayout: "stereo",
      processorOrder: [],
      latencyFrames: 0,
    },
  ],
  edges: [
    {
      version: 1,
      id: "track-a:master",
      fromNodeId: first.graphNodeId,
      toNodeId: "master",
      gain: 1,
      kind: "output",
      tap: "post-fader",
      sidechain: false,
      pdcDelayFrames: 0,
    },
    {
      version: 1,
      id: "track-b:master",
      fromNodeId: second.graphNodeId,
      toNodeId: "master",
      gain: 1,
      kind: "output",
      tap: "post-fader",
      sidechain: false,
      pdcDelayFrames: 0,
    },
  ],
  masterNodeId: "master",
  assets: [],
})

const revisionHost = (input: {
  calls: string[]
  prepared: Array<Parameters<NativeVst3RevisionHost["prepareRevision"]>[0]>
  fail?: "prepare" | "publish" | "retire" | "stop"
}): NativeVst3RevisionHost => ({
  async prepareRevision(value) {
    input.calls.push(`prepare:${value.snapshot.revision}`)
    input.prepared.push(value)
    if (input.fail === "prepare") throw new Error("prepare failed")
  },
  async publishRevision(revision) {
    input.calls.push(`publish:${revision}`)
    if (input.fail === "publish") throw new Error("publish failed")
  },
  async rollbackRevision(revision) {
    input.calls.push(`rollback:${revision}`)
  },
  async retireRevision(revision) {
    input.calls.push(`retire:${revision}`)
    if (input.fail === "retire") throw new Error("retire failed")
  },
  async stopAudio(reason) {
    input.calls.push(`stop:${reason}`)
    if (input.fail === "stop") throw new Error("stop failed")
  },
})

const revisionCoordinator = (input: {
  calls: string[]
  prepared: Array<Parameters<NativeVst3RevisionHost["prepareRevision"]>[0]>
  fail?: "prepare" | "publish" | "retire" | "stop"
}) => createNativeVst3RevisionCoordinator({
  snapshot: nativeGraph(),
  attachments: [first, second],
  attachmentHandshakeAcknowledged: true,
  graphRevisionAcknowledged: true,
  browserPlaybackActive: false,
  host: revisionHost(input),
})

test("activates production native VST playback after graph and attachment acknowledgement", () => {
  expect(nativeVst3PlaybackDefaultStatus(10)).toEqual({
    active: false,
    revision: 10,
    reason: "deterministic-vst3-fixture-unavailable",
  })
  expect(createNativeVst3RevisionCoordinator({
    snapshot: nativeGraph(),
    attachments: [first, second],
    attachmentHandshakeAcknowledged: true,
    graphRevisionAcknowledged: true,
    browserPlaybackActive: false,
    host: revisionHost({ calls: [], prepared: [] }),
  })).toMatchObject({ ok: true, coordinator: { status: expect.any(Function) } })
})

test("accepts serial attachments that share one native graph node", () => {
  const chained = {
    ...second,
    instanceId: "33333333-3333-4333-8333-333333333333",
    graphNodeId: first.graphNodeId,
    nativeGraphNodeId: first.nativeGraphNodeId,
    chainIndex: 1,
  }
  const snapshot = nativeGraph()
  const chainedSnapshot = {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => node.id === first.graphNodeId
      ? {
        ...node,
        externalLatencyFrames: first.declaredLatencyFrames + first.workerTransport.maximumFrames
          + chained.declaredLatencyFrames + chained.workerTransport.maximumFrames,
      }
      : node),
  }
  expect(createNativeVst3RevisionCoordinator({
    snapshot: chainedSnapshot,
    attachments: [first, chained, second],
    attachmentHandshakeAcknowledged: true,
    graphRevisionAcknowledged: true,
    browserPlaybackActive: false,
    host: revisionHost({ calls: [], prepared: [] }),
  })).toMatchObject({ ok: true, coordinator: { status: expect.any(Function) } })
})

test("production coordinator validates exact subset and acknowledgement gates", () => {
  const browserActive = createNativeVst3RevisionCoordinator({
    snapshot: nativeGraph(),
    attachments: [first, second],
    attachmentHandshakeAcknowledged: true,
    graphRevisionAcknowledged: true,
    browserPlaybackActive: true,
    host: revisionHost({ calls: [], prepared: [] }),
  })
  expect(browserActive).toEqual({
    ok: false,
    status: { active: false, revision: 10, reason: "browser-playback-active" },
  })
  const unacknowledged = createNativeVst3RevisionCoordinator({
    snapshot: nativeGraph(),
    attachments: [first, second],
    attachmentHandshakeAcknowledged: true,
    graphRevisionAcknowledged: false,
    browserPlaybackActive: false,
    host: revisionHost({ calls: [], prepared: [] }),
  })
  expect(unacknowledged).toEqual({
    ok: false,
    status: { active: false, revision: 10, reason: "graph-revision-unacknowledged" },
  })
  const invalidRevision = createNativeVst3RevisionCoordinator({
    snapshot: { ...nativeGraph(), revision: 0 },
    attachments: [first, second],
    attachmentHandshakeAcknowledged: true,
    graphRevisionAcknowledged: true,
    browserPlaybackActive: false,
    host: revisionHost({ calls: [], prepared: [] }),
  })
  expect(invalidRevision).toEqual({
    ok: false,
    status: { active: false, revision: 0, reason: "graph-revision-invalid" },
  })
  const duplicateSubset = createNativeVst3RevisionCoordinator({
    snapshot: nativeGraph(),
    attachments: [first, { ...second, graphNodeId: first.graphNodeId }],
    attachmentHandshakeAcknowledged: true,
    graphRevisionAcknowledged: true,
    browserPlaybackActive: false,
    host: revisionHost({ calls: [], prepared: [] }),
  })
  expect(duplicateSubset).toEqual({
    ok: false,
    status: { active: false, revision: 10, reason: "attachment-subset-unproven" },
  })
})

test("publishes latency changes as revision plus one with recomputed PDC metadata", async () => {
  const calls: string[] = []
  const prepared: Array<Parameters<NativeVst3RevisionHost["prepareRevision"]>[0]> = []
  const creation = revisionCoordinator({ calls, prepared })
  if (!creation.ok) throw new Error(creation.status.reason)
  await expect(creation.coordinator.handleNotification({
    kind: "latency",
    instanceId: first.instanceId,
    revision: 10,
    frames: 64,
  })).resolves.toEqual({ ok: true, status: "published", revision: 11 })
  expect(calls).toEqual(["prepare:11", "publish:11", "retire:10"])
  expect(prepared).toHaveLength(1)
  expect(prepared[0]?.snapshot.nodes.find((node) => node.id === first.graphNodeId)?.externalLatencyFrames).toBe(576)
  expect(prepared[0]?.snapshot.nodes.find((node) => node.id === first.graphNodeId)?.latencyFrames).toBe(0)
  expect(prepared[0]?.snapshot.edges).toEqual([
    expect.objectContaining({ id: "track-a:master", pdcDelayFrames: 0 }),
    expect.objectContaining({ id: "track-b:master", pdcDelayFrames: 32 }),
  ])
  expect(prepared[0]?.attachments.find((candidate) => candidate.instanceId === first.instanceId)?.declaredLatencyFrames).toBe(64)
  const preparedRevision = prepared[0]
  if (!preparedRevision) throw new Error("missing prepared revision")
  expect(new DataView(preparedRevision.serializedGraph.buffer).getBigUint64(0, false)).toBe(11n)
  expect(creation.coordinator.status()).toEqual({ active: true, revision: 11 })
})

test("ignores stale worker notifications without touching the active graph", async () => {
  const calls: string[] = []
  const creation = revisionCoordinator({ calls, prepared: [] })
  if (!creation.ok) throw new Error(creation.status.reason)
  await expect(creation.coordinator.handleNotification({
    kind: "latency",
    instanceId: first.instanceId,
    revision: 9,
    frames: 64,
  })).resolves.toEqual({ ok: true, status: "stale", revision: 10 })
  expect(calls).toEqual([])
  expect(creation.coordinator.status()).toEqual({ active: true, revision: 10 })
})

test("safely stops bus changes, worker misses, and faults", async () => {
  const unchangedCalls: string[] = []
  const unchanged = revisionCoordinator({ calls: unchangedCalls, prepared: [] })
  if (!unchanged.ok) throw new Error(unchanged.status.reason)
  await expect(unchanged.coordinator.handleNotification({
    kind: "buses",
    instanceId: first.instanceId,
    revision: 10,
  })).resolves.toMatchObject({
    ok: false,
    reason: "dynamic-bus-layout-unsupported",
    revision: 10,
  })
  expect(unchangedCalls).toEqual(["stop:dynamic-bus-layout-unsupported"])

  const notifications: NativeVst3WorkerRevisionNotification[] = [
    {
      kind: "buses",
      instanceId: first.instanceId,
      revision: 10,
    },
    { kind: "miss", instanceId: first.instanceId, revision: 10 },
    { kind: "fault", instanceId: first.instanceId, revision: 10 },
  ]
  for (const notification of notifications) {
    const calls: string[] = []
    const creation = revisionCoordinator({ calls, prepared: [] })
    if (!creation.ok) throw new Error(creation.status.reason)
    const result = await creation.coordinator.handleNotification(notification)
    expect(result).toMatchObject({
      ok: false,
      reason: notification.kind === "buses"
        ? "dynamic-bus-layout-unsupported"
        : notification.kind === "miss" ? "worker-missed-deadline" : "worker-faulted",
      revision: 10,
      instanceId: first.instanceId,
    })
    expect(calls).toEqual([`stop:${result.ok ? "" : result.reason}`])
    expect(creation.coordinator.status()).toMatchObject({ active: false, revision: 10 })
  }
})

test("fails closed if the native stop operation fails", async () => {
  const calls: string[] = []
  const creation = revisionCoordinator({ calls, prepared: [], fail: "stop" })
  if (!creation.ok) throw new Error(creation.status.reason)
  await expect(creation.coordinator.handleNotification({
    kind: "fault",
    instanceId: first.instanceId,
    revision: 10,
  })).resolves.toEqual({
    ok: false,
    reason: "safe-stop-failed",
    revision: 10,
    instanceId: first.instanceId,
  })
  expect(calls).toEqual(["stop:worker-faulted"])
  expect(creation.coordinator.status()).toEqual({
    active: false,
    revision: 10,
    reason: "safe-stop-failed",
  })
})

test("rolls back failed revisions, stops playback, and never advances the acknowledged snapshot", async () => {
  const failures: Array<"prepare" | "publish"> = ["prepare", "publish"]
  for (const fail of failures) {
    const calls: string[] = []
    const creation = revisionCoordinator({ calls, prepared: [], fail })
    if (!creation.ok) throw new Error(creation.status.reason)
    const result = await creation.coordinator.handleNotification({
      kind: "latency",
      instanceId: first.instanceId,
      revision: 10,
      frames: 64,
    })
    expect(result).toMatchObject({
      ok: false,
      reason: fail === "prepare" ? "revision-prepare-failed" : "revision-publish-failed",
      revision: 10,
    })
    expect(calls).toEqual(fail === "prepare"
      ? ["prepare:11", "stop:revision-prepare-failed", "rollback:11"]
      : ["prepare:11", "publish:11", "stop:revision-publish-failed", "rollback:11"])
    expect(creation.coordinator.snapshot().revision).toBe(10)
    expect(creation.coordinator.status()).toMatchObject({ active: false, revision: 10 })
  }
})

test("stops on retirement failure after retaining the newly published revision", async () => {
  const calls: string[] = []
  const creation = revisionCoordinator({ calls, prepared: [], fail: "retire" })
  if (!creation.ok) throw new Error(creation.status.reason)
  await expect(creation.coordinator.handleNotification({
    kind: "latency",
    instanceId: first.instanceId,
    revision: 10,
    frames: 64,
  })).resolves.toEqual({
    ok: false,
    reason: "revision-retire-failed",
    revision: 11,
    instanceId: first.instanceId,
  })
  expect(calls).toEqual([
    "prepare:11",
    "publish:11",
    "retire:10",
    "stop:revision-retire-failed",
  ])
  expect(creation.coordinator.snapshot().revision).toBe(11)
})
