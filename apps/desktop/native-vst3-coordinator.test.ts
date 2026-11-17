import { expect, spyOn, test } from "bun:test"
import type { DesktopVstInstanceEvent } from "@daw-browser/desktop-protocol"
import { createHash } from "node:crypto"
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
import { parsePluginCatalogData, type PluginCatalogData } from "./plugin-catalog"
import { preflightVst3Insertion } from "./vst3-insertion-preflight"
import {
  coordinateNativeVst3Attachments,
  createNativeVst3AttachmentLedger,
  createNativeVst3SessionLedger,
  resolveNativeVst3AttachmentPlan,
  nativeVst3CoordinationFailureReply,
  nativeVst3CoordinatorFailureOrigin,
  nativeVst3InstanceEvent,
  type NativeVst3Defect,
} from "./native-vst3-coordinator"
import { createNativeVst3HostEventHandlers } from "./native-vst3-host-events"

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
    hostingStatus: "ready",
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
  parameterOverrides?: Record<string, number>
}): NativeExternalAttachmentPlan["attachments"][number] => ({
  instanceId: input.instanceId,
  graphNodeId: input.graphNodeId,
  nativeGraphNodeId: input.nativeGraphNodeId,
  stageIndex: 0,
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
  parameterOverrides: input.parameterOverrides,
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
    supportsState: boolean
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
      supportsState: manifest.supportsState ?? false,
    },
  },
})

const plan = (attachments: NativeExternalAttachmentPlan["attachments"]): string => encodeNativeExternalAttachmentPlan({
  version: 1,
  attachments,
})

test("exports stateless VST3 attachments with defaults and persisted parameters", async () => {
  const parameterValue = 0.592999
  const stateless = attachment({
    instanceId: first.instanceId,
    graphNodeId: first.graphNodeId,
    nativeGraphNodeId: first.nativeGraphNodeId,
    classId: first.catalogIdentity.classId,
    parameterOverrides: { "48": parameterValue },
  })
  let stateReaderCalled = false
  const resolved = await resolveNativeVst3AttachmentPlan({
    plan: { version: 1, attachments: [stateless] },
    sampleRateHz: 48_000,
    workerPath: "/Resources/daw-vst3-worker",
    catalogStore: { load: async () => catalog() },
    stateReader: async () => {
      stateReaderCalled = true
      throw new Error("state capture must not be requested")
    },
    preflight: async () => available(stateless),
  })
  expect(stateReaderCalled).toBeFalse()
  expect(resolved[0]).toMatchObject({
    initialParameterValues: [{ id: 48, value: parameterValue }],
  })
  expect(resolved[0]).not.toHaveProperty("initialState")
})

test("requires and validates live state capture for stateful VST3 attachments", async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const stateful = attachment({
    instanceId: first.instanceId,
    graphNodeId: first.graphNodeId,
    nativeGraphNodeId: first.nativeGraphNodeId,
    classId: first.catalogIdentity.classId,
  })
  const calls: string[] = []
  const resolved = await resolveNativeVst3AttachmentPlan({
    plan: { version: 1, attachments: [stateful] },
    sampleRateHz: 48_000,
    workerPath: "/Resources/daw-vst3-worker",
    catalogStore: { load: async () => catalog() },
    stateReader: async (instanceId) => {
      calls.push(instanceId)
      return { bytes, sha256 }
    },
    preflight: async () => available(stateful, { supportsState: true }),
  })
  expect(calls).toEqual([stateful.instanceId])
  expect(resolved[0]).toMatchObject({ initialState: { bytes, sha256 } })
  await expect(resolveNativeVst3AttachmentPlan({
    plan: { version: 1, attachments: [stateful] },
    sampleRateHz: 48_000,
    workerPath: "/Resources/daw-vst3-worker",
    catalogStore: { load: async () => catalog() },
    preflight: async () => available(stateful, { supportsState: true }),
  })).rejects.toThrow("cannot be exported without state capture")
  await expect(resolveNativeVst3AttachmentPlan({
    plan: { version: 1, attachments: [stateful] },
    sampleRateHz: 48_000,
    workerPath: "/Resources/daw-vst3-worker",
    catalogStore: { load: async () => catalog() },
    stateReader: async () => ({ bytes, sha256: "0".repeat(64) }),
    preflight: async () => available(stateful, { supportsState: true }),
  })).rejects.toThrow("captured state is malformed")
  await expect(resolveNativeVst3AttachmentPlan({
    plan: { version: 1, attachments: [stateful] },
    sampleRateHz: 48_000,
    workerPath: "/Resources/daw-vst3-worker",
    catalogStore: { load: async () => catalog() },
    stateReader: async () => { throw new Error("live capture failed") },
    preflight: async () => available(stateful, { supportsState: true }),
  })).rejects.toThrow("state capture failed. live capture failed")
})

test("bootstraps a new stateful attachment when no persisted state is required", async () => {
  const calls: string[] = []
  const result = await coordinateNativeVst3Attachments({
    serializedPlan: plan([first]),
    sampleRateHz: 48_000,
    workerPath: "/Resources/daw-vst3-worker",
    catalogStore: { load: async () => catalog() },
    audioHost: {
      attachVst: async (input) => {
        calls.push(input.initialState ? "attach-with-state" : "attach-default")
      },
    },
    capturedVstStates: new Map(),
    requiredVstStateInstanceIds: new Set(),
    preflight: async () => available(first, { supportsState: true }),
  })
  expect(result).toEqual({ ok: true, attached: 1 })
  expect(calls).toEqual(["attach-default"])
})

test("fails closed when an existing stateful attachment has no captured state", async () => {
  const calls: string[] = []
  const result = await coordinateNativeVst3Attachments({
    serializedPlan: plan([first]),
    sampleRateHz: 48_000,
    workerPath: "/Resources/daw-vst3-worker",
    catalogStore: { load: async () => catalog() },
    audioHost: {
      attachVst: async () => {
        calls.push("attach")
      },
    },
    requiredVstStateInstanceIds: new Set([first.instanceId]),
    preflight: async () => available(first, { supportsState: true }),
  })
  expect(result).toEqual({
    ok: false,
    code: "state-invalid",
    message: "The captured VST3 state is missing.",
    instanceId: first.instanceId,
  })
  expect(calls).toEqual([])
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
    catalogStore: { load: async () => catalog() },
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

test("uses the trusted same-session catalog without reloading persisted data", async () => {
  let loadCalls = 0
  let reloadCalls = 0
  const calls: string[] = []
  const catalogStore = {
    load: async () => {
      loadCalls += 1
      return catalog()
    },
    reload: async () => {
      reloadCalls += 1
      return { ...catalog(), entries: [] }
    },
  }
  const result = await coordinateNativeVst3Attachments({
    serializedPlan: plan([first]),
    sampleRateHz: 48_000,
    workerPath: "/Resources/daw-vst3-worker",
    catalogStore,
    audioHost: host(calls),
    preflight: async () => available(first),
  })
  expect(result).toEqual({ ok: true, attached: 1 })
  expect(loadCalls).toBe(1)
  expect(reloadCalls).toBe(0)
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
      catalogStore: { load: async () => untrusted },
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
    catalogStore: { load: async () => catalog() },
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
      catalogStore: { load: async () => catalog() },
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
      catalogStore: { load: async () => catalog() },
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

const ledgerHarness = (
  stateful: boolean,
  clock = { now: 0 },
  refused: ReadonlySet<string> = new Set(),
  retired: ReadonlySet<string> = new Set(),
  parkingLimits = { maximumParkedInstances: 4, parkedAgeMs: 60_000 },
) => {
  const calls: string[] = []
  const ledger = createNativeVst3AttachmentLedger({
    detachVst: async (instanceId) => {
      calls.push(`detach:${instanceId}`)
      if (retired.has(instanceId)) return { status: "refused" }
      return { status: "detached" }
    },
  }, () => clock.now, new Map(), parkingLimits)
  const stateBytes = new Uint8Array([1, 2, 3])
  const state = { bytes: stateBytes, sha256: createHash("sha256").update(stateBytes).digest("hex") }
  const run = (
    attachments: NativeExternalAttachmentPlan["attachments"],
    options: { sampleRateHz?: number; catalog?: PluginCatalogData; state?: { bytes: Uint8Array; sha256: string } } = {},
  ) => coordinateNativeVst3Attachments({
    serializedPlan: plan(attachments),
    sampleRateHz: options.sampleRateHz ?? 48_000,
    workerPath: "/Resources/daw-vst3-worker",
    catalogStore: { load: async () => options.catalog ?? catalog() },
    audioHost: host(calls),
    ledger,
    capturedVstStates: new Map(stateful ? attachments.map((entry) => [entry.instanceId, options.state ?? state]) : []),
    requiredVstStateInstanceIds: new Set(),
    preflight: async ({ attachment: input }) => {
      calls.push(`preflight:${input.instanceId}`)
      const source = attachments.find((candidate) => candidate.instanceId === input.instanceId)
      if (!source) throw new Error("missing fixture attachment")
      if (refused.has(input.instanceId)) {
        return {
          version: 1,
          type: "preflight-result",
          requestId: "refused-preflight",
          status: "unavailable",
          code: "worker-crashed",
          message: "Worker preflight failed.",
          requirements,
        }
      }
      return available(source, { supportsState: stateful })
    },
  })
  return { calls, ledger, run, clock }
}

test("a later plan attaches only the instances it adds", async () => {
  const { calls, ledger, run } = ledgerHarness(true)
  expect(await run([first])).toEqual({ ok: true, attached: 1 })
  ledger.published()
  calls.length = 0
  expect(await run([first, second])).toEqual({ ok: true, attached: 1 })
  expect(calls).toEqual([`preflight:${second.instanceId}`, `attach:${second.instanceId}`])
})

test("a rolled back revision attaches its staged instances again", async () => {
  const { calls, ledger, run } = ledgerHarness(true)
  await run([first])
  ledger.rolledBack()
  await run([first])
  expect(calls.filter((call) => call.startsWith("attach:"))).toEqual([
    `attach:${first.instanceId}`,
    `attach:${first.instanceId}`,
  ])
})

// The host binds every instance it still holds into the graph it prepares, and rejects one the graph no longer declares.
test("a changed instance is detached before it is attached and a removed one before the plan that drops it is prepared", async () => {
  const { calls, ledger, run } = ledgerHarness(true)
  await run([first, second])
  ledger.published()
  calls.length = 0
  const moved = { ...first, stageIndex: 1 }
  await run([moved])
  expect(calls).toEqual([
    `detach:${second.instanceId}`,
    `detach:${first.instanceId}`,
    `attach:${first.instanceId}`,
  ])
  calls.length = 0
  ledger.published()
  expect(calls).toEqual([])
})

test("a replaced instance that rolls back is attached again when its original binding returns", async () => {
  const { calls, ledger, run } = ledgerHarness(true)
  await run([first, second])
  ledger.published()
  calls.length = 0

  await run([{ ...first, stageIndex: 1 }, second])
  ledger.rolledBack()
  calls.length = 0

  await run([first, second])
  expect(calls).toEqual([`attach:${first.instanceId}`])
})

test("an undo state change replaces the running VST instance", async () => {
  const { calls, ledger, run } = ledgerHarness(true)
  await run([first])
  ledger.published()
  calls.length = 0
  const restoredBytes = new Uint8Array([4, 5, 6])
  const restoredState = {
    bytes: restoredBytes,
    sha256: createHash("sha256").update(restoredBytes).digest("hex"),
  }

  await run([first], { state: restoredState })

  expect(calls).toEqual([`detach:${first.instanceId}`, `attach:${first.instanceId}`])
})

test("a state just captured from the running instance does not replace it", async () => {
  const { calls, ledger, run } = ledgerHarness(true)
  await run([first])
  ledger.published()
  calls.length = 0
  const capturedBytes = new Uint8Array([7, 8, 9])
  const capturedState = {
    bytes: capturedBytes,
    sha256: createHash("sha256").update(capturedBytes).digest("hex"),
  }
  ledger.capturedFromLive(first.instanceId, capturedState.sha256)

  await run([first], { state: capturedState })
  expect(calls).toEqual([])

  // The running instance now holds the captured state, so an undo back to the earlier state reloads it.
  await run([first])
  expect(calls).toEqual([`detach:${first.instanceId}`, `attach:${first.instanceId}`])
})

test("a removal whose revision was rolled back is neither detached twice nor lost when the plug-in comes back", async () => {
  const { calls, ledger, run } = ledgerHarness(true)
  await run([first, second])
  ledger.published()
  calls.length = 0
  await run([first])
  ledger.rolledBack()
  await run([first])
  expect(calls).toEqual([`detach:${second.instanceId}`])
  calls.length = 0
  await run([first, second])
  expect(calls).toEqual([`attach:${second.instanceId}`])
})

test("a removal of an instance the host already retired is not refused, and the plug-in loads anew when it comes back", async () => {
  const { calls, ledger, run } = ledgerHarness(true, { now: 0 }, new Set(), new Set([second.instanceId]))
  await run([first, second])
  ledger.published()
  calls.length = 0
  expect(await run([first])).toEqual({ ok: true, attached: 0 })
  ledger.published()
  expect(calls).toEqual([`detach:${second.instanceId}`])
  calls.length = 0
  await run([first, second])
  expect(calls).toEqual([`attach:${second.instanceId}`])
})

const extraInstance = (index: number) => attachment({
  instanceId: `5555555${index}-5555-4555-8555-555555555555`,
  graphNodeId: `track-${index}`,
  nativeGraphNodeId: String(10 + index),
  classId: first.catalogIdentity.classId,
})

test("a removed instance that comes back within the parking bounds skips its preflight", async () => {
  const { calls, ledger, run, clock } = ledgerHarness(true)
  await run([first, second])
  ledger.published()
  await run([second])
  ledger.published()
  calls.length = 0
  clock.now = 59_999
  // Another sample rate has no cached verdict, so a preflight shows the parking is what skipped it.
  await run([first, second], { sampleRateHz: 44_100 })
  expect(calls).toEqual([`attach:${first.instanceId}`])
  ledger.published()
  await run([second])
  ledger.published()
  calls.length = 0
  clock.now += 60_000
  await run([first, second], { sampleRateHz: 32_000 })
  expect(calls).toEqual([`preflight:${first.instanceId}`, `attach:${first.instanceId}`])
})

test("only the four newest removed instances stay parked", async () => {
  const { calls, ledger, run } = ledgerHarness(true)
  const extras = [1, 2, 3, 4, 5].map(extraInstance)
  await run([second, ...extras])
  ledger.published()
  await run([second])
  ledger.published()
  calls.length = 0
  await run([second, ...extras], { sampleRateHz: 44_100 })
  expect(calls.filter((call) => call.startsWith("preflight:"))).toEqual([`preflight:${extras[0]!.instanceId}`])
})

test("the ledger uses parking limits reported by the native host", async () => {
  const { calls, ledger, run, clock } = ledgerHarness(true, { now: 0 }, new Set(), new Set(), {
    maximumParkedInstances: 2,
    parkedAgeMs: 1_000,
  })
  const extras = [1, 2, 3].map(extraInstance)
  await run([second, ...extras])
  ledger.published()
  await run([second])
  ledger.published()
  calls.length = 0
  await run([second, ...extras], { sampleRateHz: 44_100 })
  expect(calls.filter((call) => call.startsWith("preflight:"))).toEqual([
    `preflight:${extras[0]!.instanceId}`,
  ])
  ledger.published()
  await run([second])
  ledger.published()
  calls.length = 0
  clock.now = 1_000
  await run([second, ...extras], { sampleRateHz: 32_000 })
  expect(calls.filter((call) => call.startsWith("preflight:"))).toEqual([`preflight:${extras[0]!.instanceId}`])
})

test("a second default insert of a plug-in reuses the verdict of the first", async () => {
  const { calls, run } = ledgerHarness(false)
  await run([first])
  calls.length = 0
  await run([first, extraInstance(1)])
  expect(calls).toEqual([`attach:${extraInstance(1).instanceId}`])
})

test("a refused plan keeps the staged instance it would have dropped, so the next plan does not attach it twice", async () => {
  const refused = new Set<string>()
  const { calls, run } = ledgerHarness(true, { now: 0 }, refused)
  await run([first, second])
  refused.add(extraInstance(1).instanceId)
  expect(await run([second, extraInstance(1)], { sampleRateHz: 44_100 })).toMatchObject({ ok: false, code: "worker-crashed" })
  calls.length = 0
  expect(await run([first, second])).toEqual({ ok: true, attached: 0 })
  expect(calls).toEqual([])
})

test("a dropped staged instance is detached once the plan that drops it is accepted", async () => {
  const { calls, run } = ledgerHarness(true)
  await run([first, second])
  calls.length = 0
  expect(await run([second])).toEqual({ ok: true, attached: 0 })
  expect(calls).toEqual([`detach:${first.instanceId}`])
  calls.length = 0
  expect(await run([first, second])).toEqual({ ok: true, attached: 1 })
  expect(calls).toEqual([`attach:${first.instanceId}`])
})

test("a cached verdict is not reused when the sample rate or the fingerprints differ, and a state revision only echoes", async () => {
  const { calls, run } = ledgerHarness(false)
  await run([first])
  const sibling = extraInstance(1)
  calls.length = 0
  await run([first, sibling], { sampleRateHz: 44_100 })
  expect(calls).toEqual([`preflight:${sibling.instanceId}`, `attach:${sibling.instanceId}`])
  const later = extraInstance(2)
  calls.length = 0
  await run([first, sibling, { ...later, stateRevision: 8 }], { sampleRateHz: 44_100 })
  expect(calls).toEqual([`attach:${later.instanceId}`])
  const refingerprinted = { ...extraInstance(3), bundleFingerprint: "c".repeat(64) }
  const moved = catalog()
  const { launchEligibility } = moved.entries[0]
  if (!launchEligibility) throw new Error("Missing launch eligibility")
  launchEligibility.bundleFingerprint = "c".repeat(64)
  calls.length = 0
  await run([refingerprinted], { sampleRateHz: 44_100, catalog: moved })
  expect(calls).toContain(`preflight:${refingerprinted.instanceId}`)
})

test("a captured state does not defeat the cached verdict", async () => {
  const { calls, run } = ledgerHarness(true)
  await run([first])
  calls.length = 0
  await run([first, extraInstance(1)])
  expect(calls).toEqual([`attach:${extraInstance(1).instanceId}`])
})

// The insertion preflight runs the worker with the transport and sample rate staging will use, so what it learned is the verdict staging
// would learn. The worker only echoes the state revision (native/plugin-host vst3-worker.cpp), and the preflight is given no state.
const insertPlugin = async (session: ReturnType<typeof createNativeVst3SessionLedger>, source: typeof first, sampleRateHz = 48_000) => {
  const spawned: string[] = []
  const inserted = await preflightVst3Insertion({
    request: { instanceId: source.instanceId, reference: {
      version: 1, classId: source.catalogIdentity.classId, vendorId: source.catalogIdentity.vendorId, architecture: "arm64",
      bundleFingerprint: source.bundleFingerprint, binaryFingerprint: source.binaryFingerprint, scannerCatalogVersion: 2 } },
    catalog: catalog(),
    workerPath: "/Resources/daw-vst3-worker",
    sampleRateHz,
    maximumFramesPerBlock: source.workerTransport.maximumFrames,
    rememberVerdict: (attachment, result) => session.rememberVerdict(attachment, sampleRateHz, result),
    preflight: async ({ attachment: input }) => {
      spawned.push(`preflight:${input.instanceId}`)
      return available({ ...source, stateRevision: input.stateRevision })
    },
  })
  return { inserted, spawned }
}

test("an inserted plug-in stages with no second preflight, and a changed fingerprint still preflights", async () => {
  const session = createNativeVst3SessionLedger()
  const calls: string[] = []
  const stage = (candidate: typeof first, trusted = catalog()) => coordinateNativeVst3Attachments({
    serializedPlan: plan([candidate]),
    sampleRateHz: 48_000,
    workerPath: "/Resources/daw-vst3-worker",
    catalogStore: { load: async () => trusted },
    audioHost: host(calls),
    ledger: session.forHost({ detachVst: async () => ({ status: "detached" }) }, { maximumParkedInstances: 4, parkedAgeMs: 60_000 }),
    capturedVstStates: new Map(),
    requiredVstStateInstanceIds: new Set(),
    preflight: async ({ attachment: input }) => {
      calls.push(`preflight:${input.instanceId}`)
      return available(candidate)
    },
  })
  const { inserted, spawned } = await insertPlugin(session, first)
  expect(inserted.ok).toBe(true)
  expect(spawned).toEqual([`preflight:${first.instanceId}`])
  // The processor row's state revision (7) is not the insertion's (0).
  expect(await stage(first)).toEqual({ ok: true, attached: 1 })
  expect(calls).toEqual([`attach:${first.instanceId}`])

  const moved = catalog()
  const { launchEligibility } = moved.entries[0]
  if (!launchEligibility) throw new Error("Missing launch eligibility")
  launchEligibility.bundleFingerprint = "c".repeat(64)
  calls.length = 0
  expect(await stage({ ...first, bundleFingerprint: "c".repeat(64) }, moved)).toEqual({ ok: true, attached: 1 })
  expect(calls).toEqual([`preflight:${first.instanceId}`, `attach:${first.instanceId}`])

  // A new transaction is a new session: nothing inserted before it is taken on trust.
  await insertPlugin(session, first)
  session.begin()
  calls.length = 0
  await stage(first)
  expect(calls).toEqual([`preflight:${first.instanceId}`, `attach:${first.instanceId}`])
})

test("a plug-in whose trust was revoked is unresolved even when its verdict was cached", async () => {
  const { calls, run } = ledgerHarness(false)
  await run([first])
  const revoked = { ...catalog(), entries: [] }
  calls.length = 0
  expect(await run([first, extraInstance(1)], { catalog: revoked }))
    .toMatchObject({ ok: false, code: "attachment-unresolved" })
  expect(calls).toEqual([])
})

// native/plugin-host/src/worker-supervisor.h WorkerFaultOrigin, in bits 0..7 of a fault value.
const faultOrigin = {
  childExit: 1,
  childSignal: 2,
  transportFault: 3,
  dispatchFailure: 4,
  callbackMissTermination: 5,
  startupFailure: 6,
  configureFailure: 8,
  processException: 11,
  workerNotification: 12,
  unknownWorkerNotification: 13,
  controlIoFailure: 15,
} as const

test("only a crashed plug-in preflight is a plug-in failure; timeouts and staging errors are ours", async () => {
  expect(nativeVst3CoordinatorFailureOrigin("worker-crashed")).toBe("plugin")
  for (const code of [
    "worker-timeout", "worker-unavailable", "worker-invalid-response", "manifest-mismatch",
    "native-transaction-failed", "state-invalid", "attachment-unresolved", "invalid-plan", "catalog-unavailable",
  ] as const) expect(nativeVst3CoordinatorFailureOrigin(code)).toBe("host")
  const defects: NativeVst3Defect[] = []
  for (const code of ["worker-crashed", "worker-timeout"] as const) {
    const outcome = await coordinateNativeVst3Attachments({
      serializedPlan: plan([first]),
      sampleRateHz: 48_000,
      workerPath: "/Resources/daw-vst3-worker",
      catalogStore: { load: async () => catalog() },
      audioHost: host([]),
      reportDefect: (defect) => { defects.push(defect) },
      preflight: async () => ({
        version: 1, type: "preflight-result", requestId: "failed", status: "unavailable", code,
        message: "Worker preflight failed.", requirements,
      }),
    })
    expect(outcome).toMatchObject({ ok: false, code, instanceId: first.instanceId })
  }
  expect(defects).toEqual([{ source: "attachment-worker-timeout", instanceId: first.instanceId, detail: "Worker preflight failed." }])
  const staging = await coordinateNativeVst3Attachments({
    serializedPlan: plan([first]),
    sampleRateHz: 48_000,
    workerPath: "/Resources/daw-vst3-worker",
    catalogStore: { load: async () => catalog() },
    audioHost: { attachVst: async () => { throw new Error("staging failed") } },
    reportDefect: (defect) => { defects.push(defect) },
    preflight: async () => available(first),
  })
  expect(staging).toMatchObject({ ok: false, code: "native-transaction-failed" })
  expect(defects.at(-1)).toEqual({
    source: "attachment-native-transaction-failed",
    instanceId: undefined,
    detail: "The native VST3 attachment transaction failed.",
  })
})

// UD 11: the reply to the renderer carries the failing code, its origin and the instance, so a staging crash is not
// indistinguishable from a transient refusal there.
test("a refused coordination reaches the renderer with its code, origin and instance", async () => {
  const crashed = await coordinateNativeVst3Attachments({
    serializedPlan: plan([first]), sampleRateHz: 48_000, workerPath: "/Resources/daw-vst3-worker",
    catalogStore: { load: async () => catalog() }, audioHost: host([]), reportDefect: () => undefined,
    preflight: async () => ({ version: 1, type: "preflight-result", requestId: "crashed", status: "unavailable",
      code: "worker-crashed", message: "The native VST3 worker preflight failed.", requirements }),
  })
  if (crashed.ok) throw new Error("A crashed preflight must be refused")
  expect(nativeVst3CoordinationFailureReply(crashed)).toEqual({
    ok: false, error: "The native VST3 worker preflight failed.",
    failure: { code: "worker-crashed", origin: "plugin", instanceId: first.instanceId },
  })
  expect(nativeVst3CoordinationFailureReply({ ok: false, code: "native-transaction-failed", message: "The native VST3 attachment transaction failed." }))
    .toEqual({ ok: false, error: "The native VST3 attachment transaction failed.", failure: { code: "native-transaction-failed", origin: "host" } })
})

test("host notifications reach the renderer as typed instance events and never end the session", () => {
  const defects: NativeVst3Defect[] = []
  const notify = (kind: "latency" | "fault" | "miss" | "restart" | "buses", value: number) => nativeVst3InstanceEvent({
    kind, value, graphRevision: 10, graphNodeId: 1n, instanceId: first.instanceId,
  }, (defect) => { defects.push(defect) })
  expect(notify("latency", 4096)).toEqual({ kind: "latency", instanceId: first.instanceId, latencyFrames: 4096 })
  expect(notify("fault", faultOrigin.childSignal | (11 << 8))).toEqual({ kind: "failed", instanceId: first.instanceId })
  expect(notify("restart", 1)).toBeUndefined()
  expect(notify("buses", 0)).toBeUndefined()
  expect(defects).toEqual([])
  expect(notify("fault", faultOrigin.transportFault)).toBeUndefined()
  expect(notify("miss", 0)).toBeUndefined()
  expect(defects.map((defect) => defect.source)).toEqual(["worker-fault", "worker-miss"])
})

// The worker's refusal of its launch record is our trust gate, not a crash: it reaches the renderer's trust flow.
test("a refused worker launch record is its own event, not a plug-in failure and not a defect", () => {
  const defects: NativeVst3Defect[] = []
  const event = nativeVst3InstanceEvent({
    kind: "fault", value: 16, graphRevision: 10, graphNodeId: 1n, instanceId: first.instanceId,
  }, (defect) => { defects.push(defect) })
  expect(event).toEqual({ kind: "launch-not-trusted", instanceId: first.instanceId })
  expect(defects).toEqual([])
})

const hostEventFixture = () => {
  const sent: DesktopVstInstanceEvent[] = []
  const edits: unknown[] = []
  const editorStates: unknown[] = []
  const ended: Error[] = []
  const defects: NativeVst3Defect[] = []
  const handlers = createNativeVst3HostEventHandlers({
    sendInstanceEvent: (event) => { sent.push(event) },
    sendParameterEdit: (input) => { edits.push(input) },
    sendEditorState: (input) => { editorStates.push(input) },
    projectFor: (instanceId) => instanceId === first.instanceId ? "project-1" : undefined,
    endSession: (error) => { ended.push(error) },
    reportDefect: (defect) => { defects.push(defect) },
  })
  const notify = (kind: "latency" | "fault" | "miss" | "restart", value: number, instanceId = first.instanceId) =>
    handlers.onNotification({ kind, value, graphRevision: 10, graphNodeId: 1n, instanceId })
  return { sent, edits, editorStates, ended, defects, handlers, notify }
}

test("main host events: an editor the playback worker hosts reports open and close for an instance a project owns", () => {
  const { editorStates, handlers } = hostEventFixture()
  const editorState = (instanceId: string, value: number) => handlers.onNotification({
    kind: "editor-state", graphRevision: 10, graphNodeId: 1n, instanceId, value,
  })
  editorState(first.instanceId, 1)
  editorState(first.instanceId, 0)
  editorState("unowned", 0)
  expect(editorStates).toEqual([
    { projectId: "project-1", instanceId: first.instanceId, open: true },
    { projectId: "project-1", instanceId: first.instanceId, open: false },
  ])
})

test("main host events: a latency notification reaches the renderer channel with the instance and value", () => {
  const { sent, ended, notify } = hostEventFixture()
  notify("latency", 512)
  expect(sent).toEqual([{ kind: "latency", instanceId: first.instanceId, latencyFrames: 512 }])
  expect(ended).toEqual([])
})

test("main host events: a plug-in fault marks only that instance and does not end the session", () => {
  const { sent, ended, notify } = hostEventFixture()
  const logged = spyOn(console, "error").mockImplementation(() => undefined)
  try { notify("fault", faultOrigin.childSignal | (11 << 8), "other-instance") } finally { logged.mockRestore() }
  expect(sent).toEqual([{ kind: "failed", instanceId: "other-instance" }])
  expect(ended).toEqual([])
})

test("main host events: our-side failures are logged as defects and never surfaced as a plug-in fault", () => {
  const { sent, ended, defects, notify } = hostEventFixture()
  const logged = spyOn(console, "error").mockImplementation(() => undefined)
  try {
    notify("fault", faultOrigin.transportFault)
    notify("miss", 0)
    notify("restart", 1)
  } finally { logged.mockRestore() }
  expect(sent).toEqual([])
  expect(ended).toEqual([])
  expect(defects.map((defect) => defect.source)).toEqual(["worker-fault", "worker-miss"])
})

test("main host events: a parameter edit goes out only for an instance a project owns", () => {
  const { edits, handlers } = hostEventFixture()
  const edit = (instanceId: string) => handlers.onNotification({
    kind: "parameter-edit", graphRevision: 10, graphNodeId: 1n, instanceId, parameterId: 7, normalizedValue: 0.25,
  })
  edit("unowned")
  edit(first.instanceId)
  expect(edits).toEqual([{ projectId: "project-1", instanceId: first.instanceId, parameterId: 7, normalizedValue: 0.25 }])
})

test("main host events: a lost host ends the session", () => {
  const { ended, handlers } = hostEventFixture()
  const lost = new Error("host lost")
  handlers.onLoss(lost)
  expect(ended).toEqual([lost])
})

test("the session ledger reuses attachments across plans and starts clean for a new transaction", async () => {
  const session = createNativeVst3SessionLedger()
  const calls: string[] = []
  const coordinate = () => coordinateNativeVst3Attachments({
    serializedPlan: plan([first]),
    sampleRateHz: 48_000,
    workerPath: "/Resources/daw-vst3-worker",
    catalogStore: { load: async () => catalog() },
    audioHost: host(calls),
    ledger: session.forHost({ detachVst: async () => ({ status: "detached" }) }, { maximumParkedInstances: 4, parkedAgeMs: 60_000 }),
    capturedVstStates: new Map(),
    requiredVstStateInstanceIds: new Set(),
    preflight: async () => available(first),
  })
  expect(await coordinate()).toEqual({ ok: true, attached: 1 })
  session.published()
  calls.length = 0
  expect(await coordinate()).toEqual({ ok: true, attached: 0 })
  expect(calls).toEqual([])
  session.begin()
  calls.length = 0
  expect(await coordinate()).toEqual({ ok: true, attached: 1 })
  expect(calls).toEqual([`attach:${first.instanceId}`])
})
