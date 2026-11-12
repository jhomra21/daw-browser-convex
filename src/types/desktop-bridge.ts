import type {
  NativeInputDevice,
  NativeHostMeterBatch,
  NativeHostSpectrumFrame,
  NativeHostPcmAsset,
  NativeHostMappedAsset,
  NativeHostMappedAssetPage,
  NativeHostRecordingConfiguration,
  NativeHostRecordingStatus,
  NativeHostDiagnostics,
  NativeHostTransport,
  NativeScheduleProgress,
  NativeProcessorPatchRefusal,
  NativeOutputDevice,
  NativeOfflinePcmChunk,
  NativeOfflineMappedAsset,
  NativeOfflineRenderPlan
} from "@daw-browser/audio-engine/native-host-wire"
import type {
  DesktopOperationV1,
  ControlErrorV1,
  HostErrorV1,
  DesktopVstParameterEditPayload,
  DesktopVstInstanceEvent,
} from "@daw-browser/desktop-protocol"
import type {
  DesktopApplicationMenuMessage,
  DesktopApplicationMenuState,
} from "@daw-browser/desktop-protocol/application-menu"
import type {
  NativeVst3InsertionPreflightRequest,
  NativeVst3InsertionPreflightResult,
} from "@daw-browser/plugin-host-protocol"
import type { ExportAudioFormat } from "@daw-browser/shared"

import type { NativeRevisionSession } from "@daw-browser/desktop-protocol/native-revision"
import type { NativeInstrumentBudgetPolicy } from "../lib/desktop/native-instrument-budget-policy"
type NativeSessionReply = { ok: true } | { ok: false; error: string }
/** `refused`: native answered no. `unavailable`: nothing was delivered. `unconfirmed`: it may have been delivered. */
export type NativeDeliveryFailureKind = "refused" | "unconfirmed" | "unavailable"
export type NativeDeliveryReply = { ok: true } | { ok: false; error: string; kind: NativeDeliveryFailureKind }
/** Claim tokens are u64 decimal strings: they can exceed Number.MAX_SAFE_INTEGER. */
export type NativeProcessorPatchReply =
  | { ok: true; outcome: "applied" }
  | { ok: true; outcome: "claimed"; token: string }
  | {
    ok: true
    outcome: "refused"
    refusal: NativeProcessorPatchRefusal
    coreResult: number
    token?: string
  }
  | { ok: false; error: string; kind: NativeDeliveryFailureKind }
export type NativeRecordingScope = { projectId: string; projectGeneration: number }
export type NativeRecordingTake = {
  takeId: string
  state: "pending" | "interrupted" | "complete"
  sampleRateHz: number | null
  channelCount: number
  frames: number | null
  bytes: number | null
  blocks: number | null
}
export type NativeRecordingRelease = { reason: "discard" } | {
  reason: "imported"
  sessionId: string
  frames: number
  bytes: number
  blocks: number
  sampleRateHz: number
  channelCount: number
  finalized: boolean
  savedClip?: { clipId: string; sourceAssetKey: string }
}
export type NativeRecordingImportedTake = {
  takeId: string
  scope: NativeRecordingScope
  acknowledgment: Extract<NativeRecordingRelease, { reason: "imported" }>
}
export type NativeRecordingFailure = { generation: number; sessionId: bigint; message: string }
export type NativeRecordingSpoolBridge = {
  list(scope: NativeRecordingScope, cursor?: string): Promise<{ takes: NativeRecordingTake[]; nextCursor: string | null }>
  read(scope: NativeRecordingScope, takeId: string, offset: number, length: number): Promise<Uint8Array>
  release(scope: NativeRecordingScope, takeId: string, acknowledgment: NativeRecordingRelease): Promise<void>
}
type NativeVstEditorReply = {
  ok: true
  status: {
    success: boolean
    owned: boolean
    supported: boolean
    open: boolean
    width: number
    height: number
    capturedState?: { bytes: Uint8Array; sha256: string }
    closeError?: string
    teardownError?: string
  }
} | { ok: false; error: string }
export type DesktopVstEditorState = { projectId: string; instanceId: string; open: boolean }
export type DesktopVstEditorCapturedState = {
  requestId: string
  projectId: string
  instanceId: string
  state: { bytes: Uint8Array; sha256: string }
}
type NativeVstEditorAnchor = { x: number; y: number }
type NativeVstAttachmentCoordinationInput = {
  projectId: string
  serializedPlan: string
  sampleRateHz: number
  requiredVstStateInstanceIds?: readonly string[]
  capturedVstStates?: readonly { instanceId: string; bytes: Uint8Array; sha256: string }[]
}
export type DesktopPluginCatalogEntry = {
  displayName: string
  discoveredAtMs: number
  architecture: "unknown"
  hostingStatus: "discovered" | "scanning" | "ready" | "failed"
  unavailableReason?: string
  classes: Array<{
    classId: string
    vendor: string
    name: string
    version: string
    role: "effect" | "instrument"
    source: "moduleinfo" | "factory"
    sdkVersion?: string
  }>
  scanHealth: "filesystem-only" | "scanned" | "scan-failed"
  scannerVersion?: string
  sdkVersion?: string
  binaryFingerprint?: string
  catalogReference?: Omit<NativeVst3InsertionPreflightRequest["reference"], "classId" | "vendorId">
}
export type DesktopPluginCatalog = {
  version: 3
  directories: string[]
  entries: DesktopPluginCatalogEntry[]
  diagnostics: { directory: string; message: string }[]
  scannedAtMs: number | null
}
export type DesktopPluginCatalogReply =
  | { ok: true; catalog: DesktopPluginCatalog }
  | { ok: true; canceled: true }
  | { ok: false; error: string }
type NativeReleaseArtifactVerification =
  | { status: "disabled" | "development" | "verified" }
  | { status: "failed"; reason: string }
type NativeAudioHostHello = {
  capabilities: number
  abiVersion: number
  processorContractHash: string
  graphContractHash: string
  artifactId: string
  deviceState: "idle" | "configured" | "running" | "faulted"
  readinessReason: "ready" | "device-not-configured" | "graph-not-prepared" | "transport-not-prepared"
}
type NativeAudioHostStatus = {
  running: boolean
  hello?: NativeAudioHostHello
  pid?: number
  generation: number
}
type NativeAudioHostDiagnosticsReply = (
  | {
      ok: true
      hello: NativeAudioHostHello
      status: NativeAudioHostStatus
      configurationGeneration: number
      diagnostics: NativeHostDiagnostics
    }
  | { ok: false; error: string }
) & { artifactVerification: NativeReleaseArtifactVerification }

type DesktopRequest = {
  id: string
  operation: DesktopOperationV1
  input: unknown
  trustedActorSubject?: string
}

type DesktopResponse = {
  id: string
  result?: unknown
  error?: HostErrorV1 | ControlErrorV1
}

type DesktopRequestHandler = (request: DesktopRequest) => Promise<DesktopResponse>
type DesktopRequestCancellationHandler = (requestId: string) => void
type DesktopPrepareToCloseHandler = () => Promise<{ flushed: boolean }>

type NativeSessionBridge = {
  revisions: NativeRevisionSession
  setRequestHandler(next: DesktopRequestHandler | undefined): void
  onPrepareToClose(next: DesktopPrepareToCloseHandler | undefined): void
  commitTransaction(transactionToken: string): Promise<NativeSessionReply>
  rollbackTransaction(transactionToken: string): Promise<NativeSessionReply>
  detachVst(instanceId: string, transactionToken?: string): Promise<NativeSessionReply>
  captureVstState(instanceId: string): Promise<
    | { ok: true; bytes: Uint8Array; sha256: string }
    | { ok: false; error: string }
  >
  editor(input: {
    projectId: string
    instanceId: string
    command: "open" | "close" | "focus" | "resize" | "status"
    serializedPlan?: string
    initialState?: { bytes: Uint8Array; sha256: string }
    requiresState?: boolean
    captureState?: boolean
    width?: number
    height?: number
    anchor?: NativeVstEditorAnchor
    transactionToken?: string
  }): Promise<NativeVstEditorReply>
  installAsset(input: NativeHostPcmAsset, transactionToken?: string): Promise<NativeSessionReply>
  createMappedAsset(input: NativeHostMappedAsset, transactionToken?: string): Promise<NativeSessionReply>
  writeMappedAssetPage(input: NativeHostMappedAssetPage, transactionToken?: string): Promise<NativeSessionReply>
  prepareMappedAssetRange(sessionAssetId: number, startFrame: number, frameCount: number, transactionToken?: string): Promise<NativeSessionReply>
  releaseMappedAsset(sessionAssetId: number, transactionToken?: string): Promise<NativeSessionReply>
  releaseAsset(sessionAssetId: number, transactionToken?: string): Promise<NativeSessionReply>
  publishGraph(bytes: Uint8Array, transactionToken?: string): Promise<NativeSessionReply>
  configureInstrumentStates?: (bytes: Uint8Array, transactionToken?: string) => Promise<NativeSessionReply>
  queueParameterEvents(bytes: Uint8Array, transactionToken?: string): Promise<NativeDeliveryReply>
  queueProcessorStatePatch(bytes: Uint8Array, transactionToken?: string): Promise<NativeProcessorPatchReply>
  queueVstParameterEvents(bytes: Uint8Array, transactionToken?: string): Promise<NativeSessionReply>
  queueInstrumentEvents(bytes: Uint8Array, transactionToken?: string): Promise<NativeDeliveryReply>
  queueScheduleWindow(bytes: Uint8Array, transactionToken?: string): Promise<NativeSessionReply>
  reenableVstScheduleAutomation(bytes: Uint8Array, transactionToken?: string): Promise<NativeSessionReply>
  queueSourceEvents(bytes: Uint8Array, transactionToken?: string): Promise<NativeSessionReply>
  coordinateVstAttachments(input: NativeVstAttachmentCoordinationInput, transactionToken?: string): Promise<NativeSessionReply>
  setTransport(input: NativeHostTransport, transactionToken?: string): Promise<NativeSessionReply>
  configureRecording(input: NativeHostRecordingConfiguration & { spoolImportVersion: 1 }): Promise<
    { ok: true; takeId: string; sampleRateHz: number; channelCount: number } | { ok: false; error: string }
  >
  startRecording(binding?: Pick<NativeHostRecordingConfiguration, "projectId" | "projectGeneration" | "generation" | "sessionId">): Promise<NativeSessionReply>
  stopRecording(stopFrame?: number): Promise<NativeSessionReply>
  cancelRecording(): Promise<NativeSessionReply>
  start(): Promise<NativeSessionReply>
  stop(reason?: string): Promise<NativeSessionReply>
  teardown(reason: string): Promise<NativeSessionReply>
  onLoss(listener: (error?: string) => void): () => void
  onRecordingFailure?: (listener: (failure: NativeRecordingFailure) => void) => () => void
  onRecordingStatus(listener: (status: NativeHostRecordingStatus) => void): () => void
  onMeterBatch(listener: (batch: NativeHostMeterBatch) => void): () => void
  setSpectrumNode(nodeId: bigint | null): Promise<NativeSessionReply>
  onSpectrumFrame(listener: (frame: NativeHostSpectrumFrame) => void): () => void
  onScheduleProgress(listener: (progress: NativeScheduleProgress) => void): () => void
  onVstParameterEdit(listener: (payload: DesktopVstParameterEditPayload) => void): () => void
  onVstInstanceEvent(listener: (event: DesktopVstInstanceEvent) => void): () => void
}

type NativeOutputDeviceReply = { ok: true; device: NativeOutputDevice | null } | { ok: false; error: string }
type NativeInputDeviceReply = { ok: true; device: NativeInputDevice | null } | { ok: false; error: string }
export type DesktopAudioLifecycle = {
  state: "suspended" | "recovering" | "ready" | "failed"
  powerGeneration: number
}

type DesktopBridge = {
  benchmarkSabRecording?: boolean
  /** True only when the app was launched with DAW_AE08_EXTERNAL_NATIVE_SESSION=1: the acceptance runner owns the native session. */
  acceptanceExternalNativeSession?: boolean
  benchmarkHeartbeat?: () => Promise<{ mainEpochMs: number } | null>
  traceDiagnosticsV2(id: string, stage: "controller-before-native" | "controller-after-native" | "controller-parsed"): void
  setRequestHandler(next: DesktopRequestHandler | undefined, onCancel?: DesktopRequestCancellationHandler): void
  onPrepareToClose(next: DesktopPrepareToCloseHandler | undefined): void
  prepareToClose(): Promise<{ flushed: boolean }>
  pickOutputFile(
    requestId: string,
    format: ExportAudioFormat,
  ): Promise<{ canceled: true } | { canceled: false; file: { token: string; basename: string } }>
  pickOutputDirectory(
    requestId: string,
  ): Promise<{ canceled: true } | { canceled: false; directory: { token: string; basename: string } }>
  releaseExportOutput(requestId: string): Promise<void>
  readChunk(requestId: string, token: string, offset: number, length: number): Promise<Uint8Array>
  beginWrite(requestId: string, token: string, relativePath?: string): Promise<{ writerId: string }>
  writeChunk(requestId: string, writerId: string, offset: number, chunk: Uint8Array): Promise<{ nextOffset: number }>
  commit(requestId: string, writerId: string): Promise<{ basename: string; byteLength: number; mime: string }>
  abort(requestId: string, writerId: string): Promise<void>
  exportTerminal(jobId: string, status: "success" | "canceled" | "error"): void
  importTerminal(jobId: string): void
  audioHost?: {
    instrumentBudgetPolicy?: NativeInstrumentBudgetPolicy
    diagnostics(): Promise<NativeAudioHostDiagnosticsReply>
    resolveOutputDevice(preferredDeviceId?: string): Promise<NativeOutputDeviceReply>
    resolveInputDevice(preferredDeviceId?: string): Promise<NativeInputDeviceReply>
    session: NativeSessionBridge
    recordingSpool: NativeRecordingSpoolBridge
    offlineRender: {
      start(
        jobId: string,
        plan: NativeOfflineRenderPlan,
        onChunk: (chunk: NativeOfflinePcmChunk) => void | Promise<void>,
        onMappedPage: (
          requestId: string,
            asset: NativeOfflineMappedAsset,
          startFrame: number,
          frameCount: number,
          ) => Promise<NativeHostMappedAssetPage>,
      ): Promise<{ ok: true } | { ok: false; error: string }>
      cancel(jobId: string): Promise<{ accepted: boolean }>
    }
    onVstEditorState(listener: (payload: DesktopVstEditorState) => void): () => void
    onVstEditorCapturedState(listener: (payload: DesktopVstEditorCapturedState) => Promise<void> | void): () => void
    getLifecycle(): Promise<DesktopAudioLifecycle>
    onLifecycle(listener: (lifecycle: DesktopAudioLifecycle) => void): () => void
    completeRecovery(
      generation: number,
      result: "ready" | "failed",
    ): Promise<{ accepted: boolean }>
    retryRecovery(): Promise<{ accepted: boolean }>
  }
  pluginCatalog?: {
    read(): Promise<DesktopPluginCatalogReply>
    chooseDirectory(): Promise<DesktopPluginCatalogReply>
    removeDirectory(directory: string): Promise<DesktopPluginCatalogReply>
    scan(): Promise<DesktopPluginCatalogReply>
    preflightInsertion(input: NativeVst3InsertionPreflightRequest): Promise<NativeVst3InsertionPreflightResult>
  }
  applicationMenu?: {
    onCommand(listener: (command: DesktopApplicationMenuMessage) => void): () => void
    setState(state: DesktopApplicationMenuState): void
  }
}

export type { DesktopBridge }

declare global {
  // Declaration merging requires an interface for the DOM Window surface.
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface Window {
    dawDesktop?: DesktopBridge
  }
}
