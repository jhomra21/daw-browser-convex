import { createHash } from "node:crypto"
import {
  decodeNativeExternalAttachmentPlan,
  maxVst3WorkerStateBytes,
  type NativeExternalAttachmentPlan,
  type NativeVst3PreflightResult,
} from "@daw-browser/plugin-host-protocol"
import type { DesktopVstInstanceEvent } from "@daw-browser/desktop-protocol"
import type { NativeAudioHostParkingLimits } from "@daw-browser/desktop-protocol/native-audio-host"
import {
  NativeAudioHostCommandError,
  type NativeAudioHostSupervisor,
  type NativeWorkerNotification,
  type ResolvedVst3Attachment,
} from "./audio-host"
import type { PluginCatalogData } from "./plugin-catalog"
import { resolveVst3Attachment } from "./vst3-attachment"
import { preflightNativeVst3Worker } from "./vst3-preflight"

type Attachment = NativeExternalAttachmentPlan["attachments"][number]
export type PreflightAttachment = ResolvedVst3Attachment & { stateRevision: number }
type CapturedVst3State = { bytes: Uint8Array; sha256: string }
type ReleaseResult = { status: "parked" | "refused" }

export type NativeVst3CoordinatorFailureCode =
  | "invalid-plan"
  | "catalog-unavailable"
  | "attachment-unresolved"
  | "worker-unavailable"
  | "worker-timeout"
  | "worker-crashed"
  | "worker-invalid-response"
  | "manifest-mismatch"
  | "state-invalid"
  | "native-transaction-failed"

export type NativeVst3CoordinatorResult =
  | { ok: true; attached: number }
  | { ok: false; code: NativeVst3CoordinatorFailureCode; message: string; instanceId?: string }

export type NativeVst3Defect = { source: string; instanceId?: string; detail: string }

const canonicalAttachments = (attachments: readonly Attachment[]) => [...attachments].sort((left, right) => (
  left.graphNodeId.localeCompare(right.graphNodeId)
  || left.stageIndex - right.stageIndex
  || left.catalogIdentity.classId.localeCompare(right.catalogIdentity.classId)
  || left.instanceId.localeCompare(right.instanceId)
))

const sha256Pattern = /^[a-f0-9]{64}$/

const decodeCapturedVst3State = (value: CapturedVst3State): CapturedVst3State | undefined => {
  if (value.bytes.byteLength > maxVst3WorkerStateBytes
    || !sha256Pattern.test(value.sha256)
    || createHash("sha256").update(value.bytes).digest("hex") !== value.sha256) return undefined
  return value
}

const sameBuses = (left: Attachment["inputBuses"], right: Attachment["inputBuses"]) => (
  left.length === right.length
  && left.every((bus, index) => {
    const candidate = right[index]
    return candidate !== undefined
      && bus.name === candidate.name
      && bus.channels === candidate.channels
      && bus.enabled === candidate.enabled
  })
)

const sameParameters = (
  left: NonNullable<Attachment["parameters"]>,
  right: NonNullable<Extract<NativeVst3PreflightResult, { status: "available" }>["hello"]["manifest"]["parameters"]>,
) => (
  left.length === right.length
  && left.every((parameter, index) => {
    const candidate = right[index]
    return candidate !== undefined
      && parameter.id === candidate.id
      && parameter.title === candidate.title
      && parameter.unit === candidate.unit
      && parameter.minimum === candidate.minimum
      && parameter.maximum === candidate.maximum
      && parameter.defaultValue === candidate.defaultValue
      && parameter.stepCount === candidate.stepCount
      && parameter.readOnly === candidate.readOnly
      && parameter.hidden === candidate.hidden
  })
)

const layoutFor = (buses: readonly { enabled: boolean; channels: number }[]): "mono" | "stereo" | undefined => {
  const enabled = buses.filter((bus) => bus.enabled)
  if (enabled.length !== 1) return undefined
  return enabled[0].channels === 1 ? "mono" : enabled[0].channels === 2 ? "stereo" : undefined
}

const matchesManifest = (attachment: Attachment, result: Extract<NativeVst3PreflightResult, { status: "available" }>) => {
  const manifest = result.hello.manifest
  return result.hello.instanceId === attachment.instanceId
    && manifest.role === attachment.role
    && sameBuses(manifest.inputBuses, attachment.inputBuses)
    && sameBuses(manifest.outputBuses, attachment.outputBuses)
    && manifest.transport.slotCount === attachment.workerTransport.slotCount
    && manifest.transport.maximumFrames === attachment.workerTransport.maximumFrames
    && manifest.transport.inputChannels === attachment.workerTransport.inputChannels
    && manifest.transport.outputChannels === attachment.workerTransport.outputChannels
    && manifest.transport.maximumEventsPerBlock === attachment.workerTransport.maximumEventsPerBlock
    && manifest.latencyFrames === attachment.declaredLatencyFrames
    && manifest.tailFrames === attachment.declaredTailFrames
    && manifest.stateRevision === attachment.stateRevision
    && sameParameters(attachment.parameters ?? [], manifest.parameters ?? [])
}

const resolveAttachment = (
  catalog: PluginCatalogData,
  attachment: Attachment,
): PreflightAttachment | undefined => {
  const eligibility = resolveVst3Attachment(catalog, {
    version: 1,
    classId: attachment.catalogIdentity.classId,
    vendorId: attachment.catalogIdentity.vendorId,
    architecture: attachment.catalogIdentity.architecture,
    bundleFingerprint: attachment.bundleFingerprint,
    binaryFingerprint: attachment.binaryFingerprint,
    scannerCatalogVersion: attachment.catalogIdentity.scannerCatalogVersion,
  })
  const inputLayout = attachment.role === "instrument"
    ? attachment.inputBuses.some((bus) => bus.enabled) ? undefined : "none"
    : layoutFor(attachment.inputBuses)
  const outputLayout = layoutFor(attachment.outputBuses)
  const expectedInputChannels = inputLayout === "none"
    ? 0
    : inputLayout === "mono" ? 1 : inputLayout === "stereo" ? 2 : undefined
  const expectedOutputChannels = outputLayout === "mono" ? 1 : outputLayout === "stereo" ? 2 : undefined
  if (!eligibility || eligibility.role !== attachment.role
    || !inputLayout || !outputLayout
    || expectedInputChannels !== attachment.workerTransport.inputChannels
    || expectedOutputChannels !== attachment.workerTransport.outputChannels) return undefined
  return {
    graphNodeId: BigInt(attachment.nativeGraphNodeId),
    stageIndex: attachment.role === "instrument" ? 0 : attachment.stageIndex,
    sourceIndex: attachment.role === "instrument" ? attachment.sourceIndex ?? 0 : undefined,
    instanceId: attachment.instanceId,
    classId: eligibility.classId,
    vendorId: eligibility.vendorId,
    canonicalBundlePath: eligibility.canonicalBundlePath,
    canonicalExecutablePath: eligibility.canonicalExecutablePath,
    bundleFingerprint: eligibility.bundleFingerprint,
    binaryFingerprint: eligibility.binaryFingerprint,
    scannerProtocolVersion: eligibility.scannerProtocolVersion,
    role: eligibility.role,
    inputLayout,
    outputLayout,
    declaredLatencyFrames: attachment.declaredLatencyFrames,
    declaredTailFrames: attachment.declaredTailFrames,
    transportLatencyFrames: attachment.workerTransport.maximumFrames,
    workerTransport: attachment.workerTransport,
    stateRevision: attachment.stateRevision,
    renderEnabled: !attachment.bypassed,
    workerEnabled: true,
    parameterIds: (attachment.parameters ?? [])
      .filter((parameter) => !parameter.readOnly)
      .map((parameter) => parameter.id),
    initialParameterValues: Object.entries(attachment.parameterOverrides ?? {}).map(([id, value]) => ({
      id: Number(id),
      value,
    })),
  }
}

// Bits 0..7 of a fault value are the native WorkerFaultOrigin (native/plugin-host/src/worker-supervisor.h).
// Only the plug-in's own process or API is the plug-in's fault: the child exiting or being killed (1, 2),
// setup failing (8, 9), processing failing (10, 11) and a failed component restart (12). Transport,
// dispatch, callback-miss, startup, control IO and unknown-notification origins are ours, and a refused launch
// record (16) is the trust gate's: it goes to the trust flow, never to the device as a crash.
const pluginFaultOrigins: ReadonlySet<number> = new Set([1, 2, 8, 9, 10, 11, 12])
const launchNotTrustedOrigin = 16

export const nativeVst3CoordinatorFailureOrigin = (
  code: NativeVst3CoordinatorFailureCode,
): "plugin" | "host" => code === "worker-crashed" ? "plugin" : "host"

// A refused coordination as the renderer receives it: the origin tells it whether to retry (ours) or to mark the
// instance failed (the plug-in's).
export const nativeVst3CoordinationFailureReply = (
  result: Extract<NativeVst3CoordinatorResult, { ok: false }>,
) => ({
  ok: false,
  error: result.message,
  failure: {
    code: result.code,
    origin: nativeVst3CoordinatorFailureOrigin(result.code),
    ...(result.instanceId !== undefined && { instanceId: result.instanceId }),
  },
} satisfies {
  ok: false
  error: string
  failure: { code: NativeVst3CoordinatorFailureCode; origin: "plugin" | "host"; instanceId?: string }
})

const reportDefectToConsole = (defect: NativeVst3Defect) => {
  console.error("[native-vst3] defect", JSON.stringify(defect))
}

// The one place a host notification becomes something the renderer sees. A latency report is a live
// publication; only the plug-in's own fault is a failed instance. A miss, any other fault origin and a
// component restart never end the session: ours are logged as defects, a restart is the worker's own business.
export const nativeVst3InstanceEvent = (
  notification: NativeWorkerNotification,
  reportDefect: (defect: NativeVst3Defect) => void = reportDefectToConsole,
): DesktopVstInstanceEvent | undefined => {
  const { instanceId } = notification
  switch (notification.kind) {
    case "latency":
      return { kind: "latency", instanceId, latencyFrames: notification.value }
    case "fault":
      if (pluginFaultOrigins.has(notification.value & 0xff)) return { kind: "failed", instanceId }
      if ((notification.value & 0xff) === launchNotTrustedOrigin) return { kind: "launch-not-trusted", instanceId }
      reportDefect({ source: "worker-fault", instanceId, detail: `origin ${notification.value & 0xff}` })
      return undefined
    case "miss":
      reportDefect({ source: "worker-miss", instanceId, detail: "deadline miss" })
      return undefined
    default:
      return undefined
  }
}

type AvailablePreflight = Extract<NativeVst3PreflightResult, { status: "available" }>
type LedgerEntry = {
  plugin: string
  binding: string
  stateSha256: string | undefined
}

// What a preflight can learn: the worker loads this binary with this transport at this rate. It is given no state, and it only
// echoes the state revision (a cached verdict takes the attachment's own), so neither is part of the key.
const verdictKey = (native: PreflightAttachment, sampleRateHz: number) => JSON.stringify([
  native.classId, native.vendorId, native.bundleFingerprint, native.binaryFingerprint, native.role,
  native.workerTransport.slotCount, native.workerTransport.maximumFrames, native.workerTransport.inputChannels,
  native.workerTransport.outputChannels, native.workerTransport.maximumEventsPerBlock, sampleRateHz,
])

const ledgerEntry = (attachment: Attachment, stateSha256: string | undefined): LedgerEntry => ({
  plugin: JSON.stringify([
    attachment.catalogIdentity, attachment.bundleFingerprint, attachment.binaryFingerprint, attachment.role,
    attachment.inputBuses, attachment.outputBuses, attachment.workerTransport,
  ]),
  binding: JSON.stringify([attachment.nativeGraphNodeId, attachment.stageIndex, attachment.sourceIndex ?? 0, attachment.bypassed]),
  stateSha256,
})

// The attachments one native session holds, so a plan reaches the host as a delta. Latency, tail
// and parameter changes are not binding changes: the host and project control carry those.
export const createNativeVst3AttachmentLedger = (
  host: Pick<NativeAudioHostSupervisor, "detachVst">,
  now: () => number = Date.now,
  verdicts = new Map<string, AvailablePreflight>(),
  parkingLimits: NativeAudioHostParkingLimits,
) => {
  const active = new Map<string, LedgerEntry>()
  const staged = new Map<string, LedgerEntry>()
  const parked = new Map<string, { plugin: string; at: number }>()
  const liveCaptures = new Map<string, string>()
  const isParked = (instanceId: string, plugin: string) => {
    const entry = parked.get(instanceId)
    return entry !== undefined
      && entry.plugin === plugin
      && now() - entry.at < parkingLimits.parkedAgeMs
  }
  return {
    // Splits a plan into new instances, changed instances (detached first), staged ones it dropped and active ones it removed.
    reconcile(entries: ReadonlyMap<string, LedgerEntry>) {
      const attach: string[] = []
      const replace: string[] = []
      for (const [instanceId, entry] of entries) {
        const holder = staged.has(instanceId) ? staged : active
        const current = holder.get(instanceId)
        if (current === undefined) attach.push(instanceId)
        else if (current.plugin !== entry.plugin || current.binding !== entry.binding) replace.push(instanceId)
        else if (current.stateSha256 !== entry.stateSha256) {
          // A state captured from the running instance is what it already holds: record it instead of reloading.
          if (liveCaptures.get(instanceId) === entry.stateSha256) holder.set(instanceId, entry)
          else replace.push(instanceId)
        }
      }
      const removed = [...active.keys()].filter((instanceId) => !entries.has(instanceId))
      const dropped = [...staged.keys()].filter((instanceId) => !entries.has(instanceId))
      return { attach, replace, removed, dropped: dropped.filter((instanceId) => !active.has(instanceId)) }
    },
    isParked,
    verdict: (key: string) => verdicts.get(key),
    rememberVerdict: (key: string, result: AvailablePreflight) => { verdicts.set(key, result) },
    capturedFromLive: (instanceId: string, stateSha256: string) => { liveCaptures.set(instanceId, stateSha256) },
    stage: (instanceId: string, entry: LedgerEntry) => { staged.set(instanceId, entry) },
    // A staged instance is forgotten only once the host let go of it: a plan refused before that still finds it staged.
    detach: async (instanceId: string, transactionToken?: string) => {
      await host.detachVst(instanceId, transactionToken)
      staged.delete(instanceId)
      active.delete(instanceId)
      liveCaptures.delete(instanceId)
    },
    // The host parks a removed instance before the revision that drops it is prepared, because it binds every instance it
    // still holds into a prepared graph. The live graph keeps rendering it until that revision publishes. A rolled back
    // removal leaves it parked, so a plan that restores it attaches it again from the host's parking. A host that refuses
    // the detach no longer holds the instance (a worker that faulted or failed to spawn before it joined is retired when
    // the next revision publishes, while the plug-in's fault is reported on its device): nothing is parked and a
    // restoring plan loads it anew.
    release: async (instanceId: string, transactionToken?: string): Promise<ReleaseResult | undefined> => {
      const plugin = active.get(instanceId)?.plugin
      if (plugin === undefined) return
      const result = await host.detachVst(instanceId, transactionToken)
      if (result.status === "refused") {
        active.delete(instanceId)
        liveCaptures.delete(instanceId)
        return { status: "refused" }
      }
      active.delete(instanceId)
      liveCaptures.delete(instanceId)
      parked.delete(instanceId)
      parked.set(instanceId, { plugin, at: now() })
      const excess = parked.size - parkingLimits.maximumParkedInstances
      if (excess > 0) {
        const oldest = [...parked.entries()].sort((left, right) => left[1].at - right[1].at).slice(0, excess)
        for (const [oldestId] of oldest) parked.delete(oldestId)
      }
      return { status: "parked" }
    },
    // The revision is live: staged instances are active.
    published() {
      for (const [instanceId, entry] of staged) active.set(instanceId, entry)
      staged.clear()
    },
    // A rollback retires every staged instance in the host, so the next plan attaches them again.
    rolledBack() {
      staged.clear()
    },
  }
}

export type NativeVst3AttachmentLedger = ReturnType<typeof createNativeVst3AttachmentLedger>

// One ledger per native session: a transaction begin starts a new one, a live coordination continues it, and the
// transaction commit, a published revision and a rollback reach the one in force.
export const createNativeVst3SessionLedger = () => {
  let ledger: NativeVst3AttachmentLedger | undefined
  // Held beside the ledger because an insertion's preflight arrives before the session has coordinated any plug-in.
  let verdicts = new Map<string, AvailablePreflight>()
  return {
    begin: () => {
      ledger = undefined
      verdicts = new Map()
    },
    forHost: (
      host: Pick<NativeAudioHostSupervisor, "detachVst">,
      parkingLimits: NativeAudioHostParkingLimits,
    ) => ledger ??= createNativeVst3AttachmentLedger(host, Date.now, verdicts, parkingLimits),
    // An insertion's preflight is the verdict staging the plug-in would learn.
    rememberVerdict: (attachment: PreflightAttachment, sampleRateHz: number, result: AvailablePreflight) => {
      verdicts.set(verdictKey(attachment, sampleRateHz), result)
    },
    capturedFromLive: (instanceId: string, stateSha256: string) => ledger?.capturedFromLive(instanceId, stateSha256),
    published: () => ledger?.published(),
    rolledBack: () => ledger?.rolledBack(),
  }
}

type CoordinationInput = {
  serializedPlan: string
  sampleRateHz: number
  workerPath: string
  catalogStore: { load(): Promise<PluginCatalogData> }
  audioHost: Pick<NativeAudioHostSupervisor, "attachVst">
  ledger?: NativeVst3AttachmentLedger
  transactionToken?: string
  capturedVstStates?: ReadonlyMap<string, CapturedVst3State>
  requiredVstStateInstanceIds?: ReadonlySet<string>
  preflight?: typeof preflightNativeVst3Worker
  reportDefect?: (defect: NativeVst3Defect) => void
}

// Every failure that is not the plug-in's own crash is ours: it is logged as a defect.
export const coordinateNativeVst3Attachments = async (
  input: CoordinationInput,
): Promise<NativeVst3CoordinatorResult> => {
  const reportDefect = input.reportDefect ?? reportDefectToConsole
  let result: NativeVst3CoordinatorResult
  try {
    result = await coordinateDelta(input)
  } catch (error) {
    reportDefect({ source: "attachment-command", detail: error instanceof Error ? error.message : "unknown" })
    throw error
  }
  if (!result.ok && nativeVst3CoordinatorFailureOrigin(result.code) === "host") {
    reportDefect({ source: `attachment-${result.code}`, instanceId: result.instanceId, detail: result.message })
  }
  return result
}

const coordinateDelta = async (input: CoordinationInput): Promise<NativeVst3CoordinatorResult> => {
  let plan: NativeExternalAttachmentPlan
  try {
    plan = decodeNativeExternalAttachmentPlan(input.serializedPlan)
  } catch {
    return { ok: false, code: "invalid-plan", message: "The native external attachment plan is invalid." }
  }
  let catalog: PluginCatalogData
  try {
    catalog = await input.catalogStore.load()
  } catch {
    return { ok: false, code: "catalog-unavailable", message: "The trusted native plug-in catalog is unavailable." }
  }
  const resolved: Array<{ attachment: Attachment; native: PreflightAttachment }> = []
  const stateRequired = new Set<string>()
  for (const attachment of canonicalAttachments(plan.attachments)) {
    const native = resolveAttachment(catalog, attachment)
    if (!native) {
      return {
        ok: false,
        code: "attachment-unresolved",
        message: "A native VST3 attachment is stale or no longer trusted.",
        instanceId: attachment.instanceId,
      }
    }
    resolved.push({ attachment, native })
  }
  const ledger = input.ledger
  const entries = ledger && new Map(resolved.map(({ attachment }) => [
    attachment.instanceId,
    ledgerEntry(attachment, input.capturedVstStates?.get(attachment.instanceId)?.sha256),
  ]))
  const delta = ledger && entries ? ledger.reconcile(entries) : undefined
  const changed = delta && new Set([...delta.attach, ...delta.replace])
  const pending = changed ? resolved.filter((candidate) => changed.has(candidate.attachment.instanceId)) : resolved
  const runPreflight = input.preflight ?? preflightNativeVst3Worker
  for (const candidate of pending) {
    const instanceId = candidate.attachment.instanceId
    const entry = entries?.get(instanceId)
    if (entry && ledger?.isParked(instanceId, entry.plugin)) continue
    const key = verdictKey(candidate.native, input.sampleRateHz)
    const cached = ledger?.verdict(key)
    const result = cached
      ? { ...cached, hello: { ...cached.hello, instanceId, manifest: { ...cached.hello.manifest, stateRevision: candidate.native.stateRevision } } }
      : await runPreflight({
        workerPath: input.workerPath,
        attachment: candidate.native,
        sampleRateHz: input.sampleRateHz,
      })
    if (result.status === "unavailable") {
      return {
        ok: false,
        code: result.code,
        message: result.message,
        instanceId,
      }
    }
    if (!matchesManifest(candidate.attachment, result)) {
      return {
        ok: false,
        code: "manifest-mismatch",
        message: "The native VST3 worker manifest does not match the attachment plan.",
        instanceId,
      }
    }
    if (ledger && !cached) ledger.rememberVerdict(key, result)
    if (
      !candidate.attachment.bypassed
      && result.hello.manifest.supportsState === true
      && (input.requiredVstStateInstanceIds === undefined
        || input.requiredVstStateInstanceIds.has(instanceId))
    ) {
      stateRequired.add(instanceId)
    }
  }
  const validatedStates = new Map<string, CapturedVst3State>()
  for (const candidate of pending) {
    const captured = input.capturedVstStates?.get(candidate.attachment.instanceId)
    if (!captured) {
      if (stateRequired.has(candidate.attachment.instanceId)) {
        return {
          ok: false,
          code: "state-invalid",
          message: "The captured VST3 state is missing.",
          instanceId: candidate.attachment.instanceId,
        }
      }
      continue
    }
    if (!decodeCapturedVst3State(captured)) {
      return {
        ok: false,
        code: "state-invalid",
        message: "The captured VST3 state is malformed.",
        instanceId: candidate.attachment.instanceId,
      }
    }
    validatedStates.set(candidate.attachment.instanceId, captured)
  }
  try {
    // The playback controller owns the encompassing graph transaction. Attach
    // only after preflight so graph publication and VST attachment commit
    // atomically as one native session.
    for (const instanceId of delta?.dropped ?? []) await ledger?.detach(instanceId, input.transactionToken)
    for (const instanceId of delta?.removed ?? []) await ledger?.release(instanceId, input.transactionToken)
    for (const candidate of pending) {
      const instanceId = candidate.attachment.instanceId
      const { stateRevision: _stateRevision, ...attachment } = candidate.native
      const state = validatedStates.get(instanceId)
      if (delta?.replace.includes(instanceId)) await ledger?.detach(instanceId, input.transactionToken)
      await input.audioHost.attachVst(
        state ? { ...attachment, initialState: state } : attachment,
        input.transactionToken,
      )
      const entry = entries?.get(instanceId)
      if (entry) ledger?.stage(instanceId, entry)
    }
    return { ok: true, attached: pending.length }
  } catch (error) {
    if (error instanceof NativeAudioHostCommandError) throw error
    return { ok: false, code: "native-transaction-failed", message: "The native VST3 attachment transaction failed." }
  }
}

export const resolveNativeVst3AttachmentPlan = async (input: {
  plan: NativeExternalAttachmentPlan
  sampleRateHz: number
  workerPath: string
  catalogStore: { load(): Promise<PluginCatalogData> }
  capturedVstStates?: ReadonlyMap<string, CapturedVst3State>
  stateReader?: (instanceId: string, signal?: AbortSignal) => Promise<CapturedVst3State>
  preflight?: typeof preflightNativeVst3Worker
  signal?: AbortSignal
}): Promise<ResolvedVst3Attachment[]> => {
  input.signal?.throwIfAborted()
  const catalog = await input.catalogStore.load()
  input.signal?.throwIfAborted()
  const resolved: Array<{ attachment: Attachment; native: PreflightAttachment }> = []
  for (const attachment of canonicalAttachments(input.plan.attachments)) {
    const native = resolveAttachment(catalog, attachment)
    if (!native) throw new Error(`Native VST3 attachment "${attachment.instanceId}" is stale or untrusted.`)
    resolved.push({ attachment, native })
  }
  const output: ResolvedVst3Attachment[] = []
  for (const candidate of resolved) {
    input.signal?.throwIfAborted()
    const result = await (input.preflight ?? preflightNativeVst3Worker)({
      workerPath: input.workerPath,
      attachment: candidate.native,
      sampleRateHz: input.sampleRateHz,
      signal: input.signal,
    })
    if (result.status === "unavailable" || !matchesManifest(candidate.attachment, result)) {
      throw new Error(`Native VST3 attachment "${candidate.attachment.instanceId}" failed preflight.`)
    }
    if (candidate.attachment.bypassed) {
      output.push(candidate.native)
      continue
    }
    if (result.hello.manifest.supportsState !== true) {
      // A plugin that explicitly lacks the state API is still exportable:
      // instantiate its defaults and apply the persisted initial parameters.
      output.push(candidate.native)
      continue
    }
    const capturedState = input.capturedVstStates?.get(candidate.attachment.instanceId)
    if (!capturedState && !input.stateReader) {
      throw new Error(`Native VST3 attachment "${candidate.attachment.instanceId}" cannot be exported without state capture.`)
    }
    let initialState = capturedState
    if (!initialState && input.stateReader) {
      let captured: CapturedVst3State
      try {
        captured = await input.stateReader(candidate.attachment.instanceId, input.signal)
      } catch (error) {
        const detail = error instanceof Error ? ` ${error.message}` : ""
        throw new Error(`Native VST3 attachment "${candidate.attachment.instanceId}" state capture failed.${detail}`)
      }
      initialState = decodeCapturedVst3State(captured)
    }
    if (!initialState) {
      throw new Error(`Native VST3 attachment "${candidate.attachment.instanceId}" state capture failed. The captured state is malformed.`)
    }
    output.push({ ...candidate.native, initialState })
  }
  return output
}
