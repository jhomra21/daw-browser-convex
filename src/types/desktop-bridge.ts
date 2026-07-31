import type {
  NativeHostDeviceConfiguration,
  NativeInputDevice,
  NativeHostMeterBatch,
  NativeHostPcmAsset,
  NativeHostRecordingBlock,
  NativeHostRecordingConfiguration,
  NativeHostRecordingStatus,
  NativeHostTransport,
  NativeScheduleProgress,
  NativeOutputDevice,
} from "@daw-browser/audio-engine/native-host-wire"
import type {
  DesktopVstParameterEditPayload,
} from "@daw-browser/desktop-protocol"
import type {
  NativeVst3InsertionPreflightRequest,
  NativeVst3InsertionPreflightResult,
} from "@daw-browser/plugin-host-protocol"

type NativeSessionReply = { ok: true } | { ok: false; error: string }
type NativeTransactionReply = { ok: true; transactionToken: string } | { ok: false; error: string }
type NativeVstEditorReply = { ok: true; status: { success: boolean; owned: boolean; supported: boolean; open: boolean; width: number; height: number } } | { ok: false; error: string }
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

type NativeSessionBridge = {
  configure(input: NativeHostDeviceConfiguration, transactionToken?: string): Promise<NativeSessionReply>
  beginTransaction(): Promise<NativeTransactionReply>
  commitTransaction(transactionToken: string): Promise<NativeSessionReply>
  rollbackTransaction(transactionToken: string): Promise<NativeSessionReply>
  detachVst(instanceId: string, transactionToken?: string): Promise<NativeSessionReply>
  editor(input: { projectId: string; instanceId: string; command: "open" | "close" | "focus" | "resize" | "status"; serializedPlan?: string; width?: number; height?: number; anchor?: NativeVstEditorAnchor; transactionToken?: string }): Promise<NativeVstEditorReply>
  installAsset(input: NativeHostPcmAsset, transactionToken?: string): Promise<NativeSessionReply>
  releaseAsset(sessionAssetId: number, transactionToken?: string): Promise<NativeSessionReply>
  publishGraph(bytes: Uint8Array, transactionToken?: string): Promise<NativeSessionReply>
  queueParameterEvents(bytes: Uint8Array, transactionToken?: string): Promise<NativeSessionReply>
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
  onLoss(listener: () => void): () => void
  onRecordingBlock(listener: (block: NativeHostRecordingBlock) => void): () => void
  onRecordingStatus(listener: (status: NativeHostRecordingStatus) => void): () => void
  onMeterBatch(listener: (batch: NativeHostMeterBatch) => void): () => void
  onScheduleProgress(listener: (progress: NativeScheduleProgress) => void): () => void
  onVstParameterEdit(listener: (payload: DesktopVstParameterEditPayload) => void): () => void
}

type NativeOutputDeviceReply = { ok: true; device: NativeOutputDevice | null } | { ok: false; error: string }
type NativeInputDeviceReply = { ok: true; device: NativeInputDevice | null } | { ok: false; error: string }

type DesktopBridge = {
  setRequestHandler(next: unknown): void
  onPrepareToClose(next: unknown): void
  prepareToClose(): Promise<{ flushed: boolean }>
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
  }
  pluginCatalog?: {
    read(): Promise<DesktopPluginCatalogReply>
    chooseDirectory(): Promise<DesktopPluginCatalogReply>
    removeDirectory(directory: string): Promise<DesktopPluginCatalogReply>
    scan(): Promise<DesktopPluginCatalogReply>
    preflightInsertion(input: NativeVst3InsertionPreflightRequest): Promise<NativeVst3InsertionPreflightResult>
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
