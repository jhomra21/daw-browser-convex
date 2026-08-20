import type {
  NativeInputDevice,
  NativeHostMeterBatch,
  NativeHostSpectrumFrame,
  NativeHostPcmAsset,
  NativeHostRecordingBlock,
  NativeHostRecordingConfiguration,
  NativeHostRecordingStatus,
  NativeHostTransport,
  NativeScheduleProgress,
  NativeOutputDevice,
  NativeOfflinePcmChunk,
  NativeOfflineRenderPlan
} from "@daw-browser/audio-engine/native-host-wire"
import type {
  DesktopOperationV1,
  ControlErrorV1,
  HostErrorV1,
  DesktopVstParameterEditPayload,
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

type NativeSessionReply = { ok: true } | { ok: false; error: string }
type NativeVstEditorReply = { ok: true; status: { success: boolean; owned: boolean; supported: boolean; open: boolean; width: number; height: number } } | { ok: false; error: string }
export type DesktopVstEditorState = { projectId: string; instanceId: string; open: boolean }
type NativeVstEditorAnchor = { x: number; y: number }
type NativeVstAttachmentCoordinationInput = { projectId: string; serializedPlan: string; sampleRateHz: number }
export type DesktopPluginCatalogEntry = {
  displayName: string
  discoveredAtMs: number
  architecture: "unknown"
  hostingStatus: "unavailable"
  unavailableReason: string
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
type NativeAudioHostDiagnosticsReply = (
  | { ok: true }
  | { ok: false; error: string }
) & { artifactVerification: NativeReleaseArtifactVerification }

type DesktopRequest = {
  id: string
  operation: DesktopOperationV1
  input: unknown
  signal: AbortSignal
  trustedActorSubject?: string
}

type DesktopResponse = {
  id: string
  result?: unknown
  error?: HostErrorV1 | ControlErrorV1
}

type DesktopRequestHandler = (request: DesktopRequest) => Promise<DesktopResponse>
type DesktopPrepareToCloseHandler = () => Promise<{ flushed: boolean }>

type NativeSessionBridge = {
  setRequestHandler(next: DesktopRequestHandler | undefined): void
  onPrepareToClose(next: DesktopPrepareToCloseHandler | undefined): void
  commitTransaction(transactionToken: string): Promise<NativeSessionReply>
  rollbackTransaction(transactionToken: string): Promise<NativeSessionReply>
  detachVst(instanceId: string, transactionToken?: string): Promise<NativeSessionReply>
  captureVstState(instanceId: string): Promise<
    | { ok: true; bytes: Uint8Array; sha256: string }
    | { ok: false; error: string }
  >
  editor(input: { projectId: string; instanceId: string; command: "open" | "close" | "focus" | "resize" | "status"; serializedPlan?: string; width?: number; height?: number; anchor?: NativeVstEditorAnchor; transactionToken?: string }): Promise<NativeVstEditorReply>
  installAsset(input: NativeHostPcmAsset, transactionToken?: string): Promise<NativeSessionReply>
  releaseAsset(sessionAssetId: number, transactionToken?: string): Promise<NativeSessionReply>
  publishGraph(bytes: Uint8Array, transactionToken?: string): Promise<NativeSessionReply>
  configureInstrumentStates?: (bytes: Uint8Array, transactionToken?: string) => Promise<NativeSessionReply>
  queueParameterEvents(bytes: Uint8Array, transactionToken?: string): Promise<NativeSessionReply>
  queueProcessorStatePatch(bytes: Uint8Array, transactionToken?: string): Promise<NativeSessionReply>
  queueVstParameterEvents(bytes: Uint8Array, transactionToken?: string): Promise<NativeSessionReply>
  queueInstrumentEvents(bytes: Uint8Array, transactionToken?: string): Promise<NativeSessionReply>
  queueScheduleWindow(bytes: Uint8Array, transactionToken?: string): Promise<NativeSessionReply>
  reenableVstScheduleAutomation(bytes: Uint8Array, transactionToken?: string): Promise<NativeSessionReply>
  queueSourceEvents(bytes: Uint8Array, transactionToken?: string): Promise<NativeSessionReply>
  coordinateVstAttachments(input: NativeVstAttachmentCoordinationInput, transactionToken?: string): Promise<NativeSessionReply>
  setTransport(input: NativeHostTransport, transactionToken?: string): Promise<NativeSessionReply>
  configureRecording(input: NativeHostRecordingConfiguration): Promise<NativeSessionReply>
  startRecording(): Promise<NativeSessionReply>
  stopRecording(stopFrame?: number): Promise<NativeSessionReply>
  cancelRecording(): Promise<NativeSessionReply>
  start(): Promise<NativeSessionReply>
  stop(): Promise<NativeSessionReply>
  teardown(): Promise<NativeSessionReply>
  onLoss(listener: (error?: string) => void): () => void
  onRecordingBlock(listener: (block: NativeHostRecordingBlock) => void): () => void
  onRecordingStatus(listener: (status: NativeHostRecordingStatus) => void): () => void
  onMeterBatch(listener: (batch: NativeHostMeterBatch) => void): () => void
  setSpectrumNode(nodeId: bigint | null): Promise<NativeSessionReply>
  onSpectrumFrame(listener: (frame: NativeHostSpectrumFrame) => void): () => void
  onScheduleProgress(listener: (progress: NativeScheduleProgress) => void): () => void
  onVstParameterEdit(listener: (payload: DesktopVstParameterEditPayload) => void): () => void
}

type NativeOutputDeviceReply = { ok: true; device: NativeOutputDevice | null } | { ok: false; error: string }
type NativeInputDeviceReply = { ok: true; device: NativeInputDevice | null } | { ok: false; error: string }
export type DesktopAudioLifecycle = {
  state: "suspended" | "recovering" | "ready" | "failed"
  powerGeneration: number
}

type DesktopBridge = {
  setRequestHandler(next: DesktopRequestHandler | undefined): void
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
  readChunk(requestId: string, token: string): Promise<Uint8Array>
  beginWrite(requestId: string, token: string, relativePath?: string): Promise<{ writerId: string }>
  writeChunk(requestId: string, writerId: string, offset: number, chunk: Uint8Array): Promise<{ nextOffset: number }>
  commit(requestId: string, writerId: string): Promise<{ basename: string; byteLength: number; mime: string }>
  abort(requestId: string, writerId: string): Promise<void>
  exportTerminal(jobId: string, status: "success" | "canceled" | "error"): void
  audioHost?: {
    diagnostics(): Promise<NativeAudioHostDiagnosticsReply>
    resolveOutputDevice(preferredDeviceId?: string): Promise<NativeOutputDeviceReply>
    resolveInputDevice(preferredDeviceId?: string): Promise<NativeInputDeviceReply>
    session: NativeSessionBridge
    offlineRender: {
      start(
        jobId: string,
        plan: NativeOfflineRenderPlan,
        onChunk: (chunk: NativeOfflinePcmChunk) => void,
      ): Promise<{ ok: true } | { ok: false; error: string }>
      cancel(jobId: string): Promise<{ accepted: boolean }>
    }
    onVstEditorState(listener: (payload: DesktopVstEditorState) => void): () => void
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
