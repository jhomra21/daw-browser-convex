import { createHash } from "node:crypto"
import {
  decodeNativeExternalAttachmentPlan,
  maxVst3WorkerStateBytes,
  type NativeExternalAttachmentPlan,
  type NativeVst3PreflightResult,
} from "@daw-browser/plugin-host-protocol"
import type { AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import type { DesktopVstInstanceEvent } from "@daw-browser/desktop-protocol"
import { serializeNativeGraph } from "@daw-browser/audio-engine/native-host-wire"
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
type PreflightAttachment = ResolvedVst3Attachment & { stateRevision: number }
type CapturedVst3State = { bytes: Uint8Array; sha256: string }

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

export type NativeVst3PlaybackGateReason =
  | "deterministic-vst3-fixture-unavailable"
  | "browser-playback-active"
  | "attachment-subset-unproven"
  | "attachment-handshake-unacknowledged"
  | "graph-revision-unacknowledged"
  | "graph-revision-invalid"
  | "dynamic-bus-layout-unsupported"
  | "revision-prepare-failed"
  | "revision-publish-failed"
  | "revision-retire-failed"
  | "safe-stop-failed"

export type NativeVst3PlaybackStatus =
  | { active: true; revision: number }
  | { active: false; revision: number; reason: NativeVst3PlaybackGateReason }

export type NativeVst3WorkerRevisionNotification =
  | { kind: "latency"; instanceId: string; revision: number; frames: number }
  | { kind: "tail"; instanceId: string; revision: number; frames: number }
  | {
    kind: "buses"
    instanceId: string
    revision: number
  }
  | { kind: "restart"; instanceId: string; revision: number }
  | { kind: "miss"; instanceId: string; revision: number }
  | { kind: "fault"; instanceId: string; revision: number; value: number }

export type NativeVst3RevisionResult =
  | { ok: true; status: "stale" | "unchanged" | "published"; revision: number }
  // Audio keeps running either way. "plugin-failed" is the only state shown to the user.
  | { ok: true; status: "plugin-failed" | "host-defect"; revision: number; instanceId: string }
  | { ok: false; reason: NativeVst3PlaybackGateReason; revision: number; instanceId?: string }

export type NativeVst3RevisionHost = {
  prepareRevision(input: {
    snapshot: AudioCoreGraphSnapshot
    serializedGraph: Uint8Array
    attachments: readonly Attachment[]
  }): Promise<void>
  publishRevision(revision: number): Promise<void>
  rollbackRevision(revision: number): Promise<void>
  retireRevision(revision: number): Promise<void>
  stopAudio(reason: NativeVst3PlaybackGateReason): Promise<void>
}

export type NativeVst3Defect = { source: string; instanceId?: string; detail: string }

export type NativeVst3RevisionCoordinator = {
  status(): NativeVst3PlaybackStatus
  // Instances whose own plug-in crashed or returned an API error; the renderer shows these as failed.
  failedInstances(): ReadonlySet<string>
  snapshot(): AudioCoreGraphSnapshot
  handleNotification(notification: NativeVst3WorkerRevisionNotification): Promise<NativeVst3RevisionResult>
}

export type NativeVst3RevisionCoordinatorInput = {
  snapshot: AudioCoreGraphSnapshot
  attachments: readonly Attachment[]
  attachmentHandshakeAcknowledged: boolean
  graphRevisionAcknowledged: boolean
  browserPlaybackActive: boolean
  host: NativeVst3RevisionHost
  reportDefect?: (defect: NativeVst3Defect) => void
}

export type NativeVst3RevisionCoordinatorCreation =
  | { ok: true; coordinator: NativeVst3RevisionCoordinator }
  | { ok: false; status: Extract<NativeVst3PlaybackStatus, { active: false }> }

const canonicalAttachments = (attachments: readonly Attachment[]) => [...attachments].sort((left, right) => (
  left.graphNodeId.localeCompare(right.graphNodeId)
  || left.stageIndex - right.stageIndex
  || left.catalogIdentity.classId.localeCompare(right.catalogIdentity.classId)
  || left.instanceId.localeCompare(right.instanceId)
))

const maximumExternalStageIndex = 0x7fff_ffff
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

const maximumRevision = 0xffff_ffff

const attachmentLatency = (attachment: Attachment) => (
  attachment.declaredLatencyFrames + attachment.workerTransport.maximumFrames
)

const attachmentSubsetIsProven = (
  snapshot: AudioCoreGraphSnapshot,
  attachments: readonly Attachment[],
) => {
  if (attachments.length === 0) return false
  const instanceIds = new Set(attachments.map((attachment) => attachment.instanceId))
  if (instanceIds.size !== attachments.length) return false
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const chains = new Map<string, Attachment[]>()
  const instruments = new Map<string, Attachment>()
  const graphNodeByNativeId = new Map<string, string>()
  for (const attachment of attachments) {
    if (
      !Number.isSafeInteger(attachment.stageIndex)
      || attachment.stageIndex < 0
      || attachment.stageIndex > maximumExternalStageIndex
    ) return false
    const existingGraphNode = graphNodeByNativeId.get(attachment.nativeGraphNodeId)
    if (existingGraphNode !== undefined && existingGraphNode !== attachment.graphNodeId) return false
    graphNodeByNativeId.set(attachment.nativeGraphNodeId, attachment.graphNodeId)
    if (attachment.role === "instrument") {
      if (instruments.has(attachment.graphNodeId)) return false
      instruments.set(attachment.graphNodeId, attachment)
      continue
    }
    const chain = chains.get(attachment.graphNodeId) ?? []
    if (chain.some((candidate) => candidate.stageIndex === attachment.stageIndex)) return false
    chain.push(attachment)
    chains.set(attachment.graphNodeId, chain)
  }
  const graphNodeIds = new Set([...chains.keys(), ...instruments.keys()])
  for (const graphNodeId of graphNodeIds) {
    const chain = chains.get(graphNodeId) ?? []
    const node = nodes.get(graphNodeId)
    if (!node) return false
    const ordered = [...chain].sort((left, right) => left.stageIndex - right.stageIndex)
    const instrument = instruments.get(graphNodeId)
    let totalLatency = instrument && !instrument.bypassed ? attachmentLatency(instrument) : 0
    if (instrument && (instrument.sourceIndex ?? 0) !== 0) return false
    for (const [index, attachment] of ordered.entries()) {
      if (attachment.nativeGraphNodeId !== ordered[0]?.nativeGraphNodeId) return false
      const previous = ordered[index - 1]
      const expectedInput = index === 0
        ? node.inputLayout
        : previous?.outputBuses
          ? layoutFor(previous.outputBuses)
          : undefined
      const inputLayout = attachment.role === "instrument"
        ? attachment.inputBuses.some((bus) => bus.enabled) ? undefined : "none"
        : layoutFor(attachment.inputBuses)
      const outputLayout = layoutFor(attachment.outputBuses)
      if (outputLayout !== node.outputLayout
        || (index === 0 && attachment.role === "instrument"
          ? inputLayout !== "none" || node.kind !== "instrument"
          : inputLayout !== expectedInput)
        || (index > 0 && attachment.role !== "effect")
        || attachment.workerTransport.inputChannels !== (inputLayout === "mono" ? 1 : inputLayout === "stereo" ? 2 : 0)
        || attachment.workerTransport.outputChannels !== (outputLayout === "mono" ? 1 : 2)) return false
      if (!attachment.bypassed) totalLatency += attachmentLatency(attachment)
      if (!Number.isSafeInteger(totalLatency)) return false
    }
    if ((node.externalLatencyFrames ?? 0) !== totalLatency) return false
  }
  return [...chains.values()].every((chain) => chain.every((attachment) => {
    const node = nodes.get(attachment.graphNodeId)
    const inputLayout = attachment.role === "instrument"
      ? attachment.inputBuses.some((bus) => bus.enabled) ? undefined : "none"
      : layoutFor(attachment.inputBuses)
    const outputLayout = layoutFor(attachment.outputBuses)
    const inputChannels = attachment.workerTransport.inputChannels
    const outputChannels = attachment.workerTransport.outputChannels
      return node !== undefined
      && outputLayout !== undefined
      && outputChannels === (outputLayout === "mono" ? 1 : 2)
      && (attachment.role === "instrument"
        ? inputLayout === "none" && inputChannels === 0 && node.kind === "instrument"
        : inputLayout !== undefined
          && inputChannels === (inputLayout === "mono" ? 1 : 2)
          && node.inputLayout === inputLayout)
      && node.outputLayout === outputLayout
  }))
  && [...instruments.entries()].every(([graphNodeId, attachment]) => {
    const node = nodes.get(graphNodeId)
    const inputLayout = attachment.inputBuses.some((bus) => bus.enabled) ? undefined : "none"
    const outputLayout = layoutFor(attachment.outputBuses)
    return node !== undefined
      && attachment.sourceIndex === 0
      && outputLayout !== undefined
      && attachment.workerTransport.inputChannels === 0
      && attachment.workerTransport.outputChannels === (outputLayout === "mono" ? 1 : 2)
      && inputLayout === "none"
      && node.kind === "instrument"
      && node.outputLayout === outputLayout
  })
}

const chainLatency = (attachments: readonly Attachment[], graphNodeId: string) => (
  attachments
    .filter((attachment) => !attachment.bypassed && attachment.graphNodeId === graphNodeId)
    .reduce((total, attachment) => total + attachmentLatency(attachment), 0)
)

const reviseGraphExternalLatency = (
  snapshot: AudioCoreGraphSnapshot,
  graphNodeId: string,
  latencyFrames: number,
  revision: number,
): AudioCoreGraphSnapshot | undefined => {
  if (
    !Number.isSafeInteger(latencyFrames) || latencyFrames < 0 || latencyFrames > maximumRevision
    || !Number.isSafeInteger(revision) || revision <= snapshot.revision || revision > maximumRevision
  ) return undefined
  let targetFound = false
  const nodes = snapshot.nodes.map((node) => {
    if (node.id !== graphNodeId) return node
    targetFound = true
    return { ...node, externalLatencyFrames: latencyFrames }
  })
  if (!targetFound) return undefined
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const incomingCount = new Map(nodes.map((node) => [node.id, 0]))
  const incoming = new Map<string, Array<AudioCoreGraphSnapshot["edges"][number]>>()
  const outgoing = new Map<string, string[]>()
  for (const edge of snapshot.edges) {
    if (!nodeById.has(edge.fromNodeId) || !nodeById.has(edge.toNodeId)) return undefined
    if (edge.sidechain) continue
    incomingCount.set(edge.toNodeId, (incomingCount.get(edge.toNodeId) ?? 0) + 1)
    const sources = incoming.get(edge.toNodeId) ?? []
    sources.push(edge)
    incoming.set(edge.toNodeId, sources)
    const targets = outgoing.get(edge.fromNodeId) ?? []
    targets.push(edge.toNodeId)
    outgoing.set(edge.fromNodeId, targets)
  }
  const ready = nodes.filter((node) => incomingCount.get(node.id) === 0).map((node) => node.id)
  const processOrder: string[] = []
  while (ready.length > 0) {
    const nodeId = ready.shift()!
    processOrder.push(nodeId)
    for (const targetId of outgoing.get(nodeId) ?? []) {
      const remaining = (incomingCount.get(targetId) ?? 0) - 1
      incomingCount.set(targetId, remaining)
      if (remaining === 0) ready.push(targetId)
    }
  }
  if (processOrder.length !== nodes.length) return undefined
  const pathLatency = new Map<string, number>()
  const pdcDelay = new Map<string, number>()
  const effectiveLatency = (node: AudioCoreGraphSnapshot["nodes"][number]) => (
    node.latencyFrames + (node.externalLatencyFrames ?? 0)
  )
  for (const nodeId of processOrder) {
    const node = nodeById.get(nodeId)
    if (!node) return undefined
    const incomingEdges = incoming.get(nodeId) ?? []
    let upstreamLatency = 0
    const arrivals = new Map<string, number>()
    for (const edge of incomingEdges) {
      const source = nodeById.get(edge.fromNodeId)
      const sourcePathLatency = pathLatency.get(edge.fromNodeId)
      if (!source || sourcePathLatency === undefined) return undefined
      const arrival = edge.tap === "pre-fx"
        ? sourcePathLatency - effectiveLatency(source)
        : sourcePathLatency
      if (arrival < 0) return undefined
      arrivals.set(edge.id, arrival)
      upstreamLatency = Math.max(upstreamLatency, arrival)
    }
    const nodeLatency = effectiveLatency(node)
    if (upstreamLatency > maximumRevision - nodeLatency) return undefined
    pathLatency.set(nodeId, upstreamLatency + nodeLatency)
    for (const edge of incomingEdges) {
      const arrival = arrivals.get(edge.id)
      if (arrival === undefined) return undefined
      pdcDelay.set(edge.id, upstreamLatency - arrival)
    }
  }
  return {
    ...snapshot,
    revision,
    nodes,
    edges: snapshot.edges.map((edge) => edge.sidechain
      ? edge
      : { ...edge, pdcDelayFrames: pdcDelay.get(edge.id) ?? 0 }),
  }
}

// Bits 0..7 of a fault value are the native WorkerFaultOrigin (native/plugin-host/src/worker-supervisor.h).
// Only the plug-in's own process or API is the plug-in's fault: the child exiting or being killed (1, 2),
// setup failing (8, 9), processing failing (10, 11) and a failed component restart (12). Transport,
// dispatch, callback-miss, startup, control IO and unknown-notification origins are ours.
const pluginFaultOrigins: ReadonlySet<number> = new Set([1, 2, 8, 9, 10, 11, 12])

export const nativeVst3CoordinatorFailureOrigin = (
  code: NativeVst3CoordinatorFailureCode,
): "plugin" | "host" => code === "worker-crashed" ? "plugin" : "host"

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
      reportDefect({ source: "worker-fault", instanceId, detail: `origin ${notification.value & 0xff}` })
      return undefined
    case "miss":
      reportDefect({ source: "worker-miss", instanceId, detail: "deadline miss" })
      return undefined
    default:
      return undefined
  }
}

export const nativeVst3PlaybackDefaultStatus = (
  revision: number,
): Extract<NativeVst3PlaybackStatus, { active: false }> => ({
  active: false,
  revision,
  reason: "deterministic-vst3-fixture-unavailable",
})

const createNativeVst3RevisionCoordinatorImplementation = (
  input: NativeVst3RevisionCoordinatorInput,
): NativeVst3RevisionCoordinatorCreation => {
  const rejected = (reason: NativeVst3PlaybackGateReason): NativeVst3RevisionCoordinatorCreation => ({
    ok: false,
    status: { active: false, revision: input.snapshot.revision, reason },
  })
  if (input.browserPlaybackActive) return rejected("browser-playback-active")
  if (
    !Number.isSafeInteger(input.snapshot.revision)
    || input.snapshot.revision <= 0
    || input.snapshot.revision > maximumRevision
  ) return rejected("graph-revision-invalid")
  if (!attachmentSubsetIsProven(input.snapshot, input.attachments)) return rejected("attachment-subset-unproven")
  if (!input.attachmentHandshakeAcknowledged) return rejected("attachment-handshake-unacknowledged")
  if (!input.graphRevisionAcknowledged) return rejected("graph-revision-unacknowledged")

  let snapshot = input.snapshot
  let attachments = canonicalAttachments(input.attachments)
  let playbackStatus: NativeVst3PlaybackStatus = { active: true, revision: snapshot.revision }
  let pending = Promise.resolve()
  const failedInstances = new Set<string>()
  const reportDefect = input.reportDefect ?? reportDefectToConsole

  const hostDefect = (source: string, instanceId: string, detail: string): NativeVst3RevisionResult => {
    reportDefect({ source, instanceId, detail })
    return { ok: true, status: "host-defect", revision: snapshot.revision, instanceId }
  }

  const stopSafely = async (
    reason: NativeVst3PlaybackGateReason,
    instanceId?: string,
  ): Promise<NativeVst3RevisionResult> => {
    playbackStatus = { active: false, revision: snapshot.revision, reason }
    try {
      await input.host.stopAudio(reason)
      return {
        ok: false,
        reason,
        revision: snapshot.revision,
        instanceId,
      }
    } catch {
      playbackStatus = { active: false, revision: snapshot.revision, reason: "safe-stop-failed" }
      return {
        ok: false,
        reason: "safe-stop-failed",
        revision: snapshot.revision,
        instanceId,
      }
    }
  }

  const handle = async (
    notification: NativeVst3WorkerRevisionNotification,
  ): Promise<NativeVst3RevisionResult> => {
    if (!playbackStatus.active) {
      return {
        ok: false,
        reason: playbackStatus.reason,
        revision: snapshot.revision,
        instanceId: notification.instanceId,
      }
    }
    if (notification.revision !== snapshot.revision) {
      return { ok: true, status: "stale", revision: snapshot.revision }
    }
    const attachmentIndex = attachments.findIndex((attachment) => attachment.instanceId === notification.instanceId)
    const attachment = attachments[attachmentIndex]
    if (attachment === undefined) return stopSafely("attachment-subset-unproven", notification.instanceId)
    if (notification.kind === "buses") return stopSafely("dynamic-bus-layout-unsupported", notification.instanceId)
    // The host mutes a faulted instance by itself, so none of these stop audio. A component
    // restart is the worker's own business.
    if (notification.kind === "restart") return { ok: true, status: "unchanged", revision: snapshot.revision }
    if (notification.kind === "miss") return hostDefect("worker-miss", notification.instanceId, "deadline miss")
    if (notification.kind === "fault") {
      if (!pluginFaultOrigins.has(notification.value & 0xff)) {
        return hostDefect("worker-fault", notification.instanceId, `origin ${notification.value & 0xff}`)
      }
      failedInstances.add(notification.instanceId)
      return { ok: true, status: "plugin-failed", revision: snapshot.revision, instanceId: notification.instanceId }
    }
    if (notification.kind === "tail") {
      const declaredTailFrames = notification.frames === 0xffff_ffff ? null : notification.frames
      if (!Number.isSafeInteger(notification.frames)
        || notification.frames < 0
        || (declaredTailFrames !== null && declaredTailFrames > 100_000_000)) {
        return stopSafely("revision-prepare-failed", notification.instanceId)
      }
      if ((attachment.declaredTailFrames ?? null) === declaredTailFrames) {
        return { ok: true, status: "unchanged", revision: snapshot.revision }
      }
      attachments = attachments.map((candidate, index) => index === attachmentIndex
        ? { ...candidate, declaredTailFrames }
        : candidate)
      return { ok: true, status: "unchanged", revision: snapshot.revision }
    }
    if (notification.frames === attachment.declaredLatencyFrames) {
      return { ok: true, status: "unchanged", revision: snapshot.revision }
    }
    const nextRevision = snapshot.revision + 1
    if (nextRevision > maximumRevision) return stopSafely("revision-prepare-failed", notification.instanceId)
    const nextAttachment = { ...attachment, declaredLatencyFrames: notification.frames }
    const nextAttachments = attachments.map((candidate, index) => index === attachmentIndex ? nextAttachment : candidate)
    const nextSnapshot = reviseGraphExternalLatency(
      snapshot,
      attachment.graphNodeId,
      chainLatency(nextAttachments, attachment.graphNodeId),
      nextRevision,
    )
    if (!nextSnapshot || !attachmentSubsetIsProven(nextSnapshot, nextAttachments)) {
      return stopSafely("revision-prepare-failed", notification.instanceId)
    }
    try {
      await input.host.prepareRevision({
        snapshot: nextSnapshot,
        serializedGraph: serializeNativeGraph(nextSnapshot),
        attachments: nextAttachments,
      })
    } catch {
      const stopped = await stopSafely("revision-prepare-failed", notification.instanceId)
      try {
        await input.host.rollbackRevision(nextRevision)
      } catch {
        // The safe-stop result remains authoritative.
      }
      return stopped
    }
    try {
      await input.host.publishRevision(nextRevision)
    } catch {
      const stopped = await stopSafely("revision-publish-failed", notification.instanceId)
      try {
        await input.host.rollbackRevision(nextRevision)
      } catch {
        // The safe-stop result remains authoritative.
      }
      return stopped
    }
    const previousRevision = snapshot.revision
    snapshot = nextSnapshot
    attachments = nextAttachments
    playbackStatus = { active: true, revision: nextRevision }
    try {
      // Retirement is an awaited control-plane operation after the block-boundary
      // publish acknowledgement; the render callback never performs disposal.
      await input.host.retireRevision(previousRevision)
    } catch {
      return stopSafely("revision-retire-failed", notification.instanceId)
    }
    return { ok: true, status: "published", revision: nextRevision }
  }

  const coordinator: NativeVst3RevisionCoordinator = {
    status: () => playbackStatus,
    failedInstances: () => failedInstances,
    snapshot: () => snapshot,
    handleNotification(notification) {
      const result = pending.then(() => handle(notification))
      pending = result.then(() => undefined, () => undefined)
      return result
    },
  }
  return { ok: true, coordinator }
}

export const createNativeVst3RevisionCoordinator = (
  input: NativeVst3RevisionCoordinatorInput,
): NativeVst3RevisionCoordinatorCreation => createNativeVst3RevisionCoordinatorImplementation(input)

const maximumParkedInstances = 4
const parkedAgeMs = 60_000

type AvailablePreflight = Extract<NativeVst3PreflightResult, { status: "available" }>
type LedgerEntry = { plugin: string; binding: string; load: string }

// What the host compares to take a parked instance back, so a match here means the host reuses it.
const loadKey = (native: PreflightAttachment, stateSha256: string | undefined) => JSON.stringify([
  native.classId, native.vendorId, native.canonicalBundlePath, native.canonicalExecutablePath,
  native.bundleFingerprint, native.binaryFingerprint, native.role, native.inputLayout, native.outputLayout,
  native.workerTransport, native.parameterIds, native.initialParameterValues, stateSha256 ?? "",
])

const verdictKey = (native: PreflightAttachment, sampleRateHz: number) => JSON.stringify([
  native.classId, native.vendorId, native.bundleFingerprint, native.binaryFingerprint, native.role,
  native.workerTransport, native.stateRevision, sampleRateHz,
])

const ledgerEntry = (attachment: Attachment, native: PreflightAttachment, stateSha256: string | undefined): LedgerEntry => ({
  plugin: JSON.stringify([
    attachment.catalogIdentity, attachment.bundleFingerprint, attachment.binaryFingerprint, attachment.role,
    attachment.inputBuses, attachment.outputBuses, attachment.workerTransport,
  ]),
  binding: JSON.stringify([attachment.nativeGraphNodeId, attachment.stageIndex, attachment.sourceIndex ?? 0, attachment.bypassed]),
  load: loadKey(native, stateSha256),
})

// The attachments one native session holds, so a plan reaches the host as a delta. Latency, tail
// and parameter changes are not binding changes: the host and project control carry those.
export const createNativeVst3AttachmentLedger = (
  host: Pick<NativeAudioHostSupervisor, "detachVst">,
  now: () => number = Date.now,
) => {
  const active = new Map<string, LedgerEntry>()
  const staged = new Map<string, LedgerEntry>()
  const parked = new Map<string, { load: string; at: number }>()
  const verdicts = new Map<string, AvailablePreflight>()
  let removed: string[] = []
  const parkedLoad = (instanceId: string) => {
    const entry = parked.get(instanceId)
    return entry !== undefined && now() - entry.at < parkedAgeMs ? entry.load : undefined
  }
  return {
    // Splits a plan into new instances, changed instances (detached first) and staged ones it dropped.
    // It also records which active instances the plan removed, for the next publication.
    reconcile(entries: ReadonlyMap<string, LedgerEntry>) {
      const attach: string[] = []
      const replace: string[] = []
      for (const [instanceId, entry] of entries) {
        const current = staged.get(instanceId) ?? active.get(instanceId)
        if (current === undefined) attach.push(instanceId)
        else if (current.plugin !== entry.plugin || current.binding !== entry.binding) replace.push(instanceId)
      }
      removed = [...active.keys()].filter((instanceId) => !entries.has(instanceId))
      const dropped = [...staged.keys()].filter((instanceId) => !entries.has(instanceId))
      for (const instanceId of dropped) staged.delete(instanceId)
      return { attach, replace, dropped: dropped.filter((instanceId) => !active.has(instanceId)) }
    },
    parkedMatches: (instanceId: string, load: string) => parkedLoad(instanceId) === load,
    verdict: (key: string) => verdicts.get(key),
    rememberVerdict: (key: string, result: AvailablePreflight) => { verdicts.set(key, result) },
    stage: (instanceId: string, entry: LedgerEntry) => { staged.set(instanceId, entry) },
    detach: (instanceId: string, transactionToken?: string) => host.detachVst(instanceId, transactionToken),
    // The revision is live: staged instances are active, removed ones are detached and the host parks them.
    async published() {
      for (const [instanceId, entry] of staged) active.set(instanceId, entry)
      staged.clear()
      for (const instanceId of removed) {
        const entry = active.get(instanceId)
        active.delete(instanceId)
        if (entry === undefined) continue
        await host.detachVst(instanceId)
        parked.delete(instanceId)
        parked.set(instanceId, { load: entry.load, at: now() })
      }
      removed = []
      for (const instanceId of [...parked.keys()].slice(0, Math.max(0, parked.size - maximumParkedInstances))) {
        parked.delete(instanceId)
      }
    },
    // A rollback retires every staged instance in the host, so the next plan attaches them again.
    rolledBack() {
      staged.clear()
      removed = []
    },
  }
}

export type NativeVst3AttachmentLedger = ReturnType<typeof createNativeVst3AttachmentLedger>

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
  const entries = ledger && new Map(resolved.map(({ attachment, native }) => [
    attachment.instanceId,
    ledgerEntry(attachment, native, input.capturedVstStates?.get(attachment.instanceId)?.sha256),
  ]))
  const delta = ledger && entries ? ledger.reconcile(entries) : undefined
  const changed = delta && new Set([...delta.attach, ...delta.replace])
  const pending = changed ? resolved.filter((candidate) => changed.has(candidate.attachment.instanceId)) : resolved
  const runPreflight = input.preflight ?? preflightNativeVst3Worker
  for (const candidate of pending) {
    const instanceId = candidate.attachment.instanceId
    const entry = entries?.get(instanceId)
    // The host takes a parked instance back as it was preflighted, so there is nothing to load.
    if (ledger && entry && ledger.parkedMatches(instanceId, entry.load)) continue
    const key = verdictKey(candidate.native, input.sampleRateHz)
    const cached = input.capturedVstStates?.has(instanceId) ? undefined : ledger?.verdict(key)
    const result = cached
      ? { ...cached, hello: { ...cached.hello, instanceId } }
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
    if (ledger && !cached && !input.capturedVstStates?.has(instanceId)) ledger.rememberVerdict(key, result)
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
