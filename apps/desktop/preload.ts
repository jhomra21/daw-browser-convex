import { contextBridge, ipcRenderer } from "electron"
import { desktopCancelSchemaV1, desktopExportTerminalSchemaV1, desktopReplySchemaV1, desktopTrustedRendererRequestSchemaV1, hostError, type DesktopRendererRequestV1 } from "@daw-browser/desktop-protocol"
import type {
  NativeHostDeviceConfiguration,
  NativeHostPcmAsset,
  NativeHostRecordingBlock,
  NativeHostRecordingConfiguration,
  NativeHostRecordingStatus,
  NativeHostTransport,
  NativeInputDevice,
  NativeOutputDevice,
} from "@daw-browser/audio-engine/native-host-wire"
import type {
  NativeVst3InsertionPreflightRequest,
  NativeVst3InsertionPreflightResult,
} from "@daw-browser/plugin-host-protocol"
import { createRequestQueue, type PreloadHostRequest, type PreloadHostResponse } from "./request-queue"

const incomingChannel = "daw:host-request"
const outgoingChannel = "daw:host-response"
const queueLimit = 32
let closeHandler: (() => Promise<{ flushed: boolean }>) | undefined
let activeGeneration = 0

type PluginCatalogEntry = {
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

type NativeReleaseArtifactVerification =
  | { status: "disabled" | "development" | "verified" }
  | { status: "failed"; reason: string }

type NativeAudioHostDiagnosticsReply = (
  | { ok: true }
  | { ok: false; error: string }
) & { artifactVerification: NativeReleaseArtifactVerification }

type PluginCatalog = {
  version: 3
  directories: string[]
  entries: PluginCatalogEntry[]
  diagnostics: { directory: string; message: string }[]
  scannedAtMs: number | null
}

type PluginCatalogReply =
  | { ok: true; catalog: PluginCatalog }
  | { ok: true; canceled: true }
  | { ok: false; error: string }

const invokePluginCatalog = (channel: string, value?: unknown): Promise<PluginCatalogReply> =>
  ipcRenderer.invoke(channel, value)

type NativeSessionReply = { ok: true } | { ok: false; error: string }
type NativeOutputDeviceReply = { ok: true; device: NativeOutputDevice | null } | { ok: false; error: string }
type NativeInputDeviceReply = { ok: true; device: NativeInputDevice | null } | { ok: false; error: string }
const invokeNativeSession = (channel: string, value?: NativeHostDeviceConfiguration | NativeHostPcmAsset | NativeHostRecordingConfiguration | NativeHostTransport | Uint8Array | number | string): Promise<NativeSessionReply> =>
  ipcRenderer.invoke(channel, value)
const invokeNativeOutputDevice = (preferredDeviceId?: string): Promise<NativeOutputDeviceReply> =>
  ipcRenderer.invoke("daw:audio-host:resolve-output-device", preferredDeviceId)
const invokeNativeInputDevice = (preferredDeviceId?: string): Promise<NativeInputDeviceReply> =>
  ipcRenderer.invoke("daw:audio-host:resolve-input-device", preferredDeviceId)

const reply = (generation: number, response: PreloadHostResponse) => {
  const parsed = desktopReplySchemaV1.safeParse({
    version: "v1",
    type: "reply",
    id: response.id,
    ...(response.error === undefined ? { result: response.result } : { error: response.error }),
  })
  if (parsed.success) ipcRenderer.send(outgoingChannel, { generation, frame: parsed.data })
}

const requestQueue = createRequestQueue({ reply, queueLimit })

const dispatchLifecycle = (
  generation: number,
  request: Extract<DesktopRendererRequestV1, { operation: "lifecycle.prepareToClose" }>,
) => {
  void (closeHandler ? closeHandler() : Promise.resolve({ flushed: false }))
    .then((response) => reply(generation, { id: request.id, result: response }))
    .catch(() => reply(generation, { id: request.id, error: hostError("internal", "The timeline could not prepare to close.") }))
}

ipcRenderer.on(incomingChannel, (_event, message: unknown) => {
  if (typeof message !== "object" || message === null || !("generation" in message) || !("frame" in message)) return
  const generation = message.generation
  if (typeof generation !== "number" || !Number.isSafeInteger(generation)) return
  if (generation < activeGeneration) return
  if (generation > activeGeneration) {
    requestQueue.reset(generation)
    activeGeneration = generation
  }
  const cancel = desktopCancelSchemaV1.safeParse(message.frame)
  if (cancel.success) {
    requestQueue.cancel(cancel.data.id)
    return
  }
  const parsed = desktopTrustedRendererRequestSchemaV1.safeParse(message.frame)
  if (!parsed.success) return
  if (parsed.data.operation === "lifecycle.prepareToClose") {
    dispatchLifecycle(generation, parsed.data)
    return
  }
  requestQueue.dispatch(generation, parsed.data)
})

contextBridge.exposeInMainWorld("dawDesktop", {
  setRequestHandler(next: ((request: PreloadHostRequest) => Promise<PreloadHostResponse>) | undefined) {
    requestQueue.setRequestHandler(next)
  },
  onPrepareToClose(next: typeof closeHandler) {
    closeHandler = next
  },
  async prepareToClose() {
    return closeHandler ? await closeHandler() : { flushed: false }
  },
  readChunk(requestId: string, token: string) {
    return ipcRenderer.invoke("daw:capability:readChunk", { requestId, token })
  },
  beginWrite(requestId: string, token: string, relativePath?: string) {
    return ipcRenderer.invoke("daw:capability:beginWrite", { requestId, token, relativePath })
  },
  writeChunk(requestId: string, writerId: string, offset: number, chunk: Uint8Array) {
    return ipcRenderer.invoke("daw:capability:writeChunk", { requestId, writerId, offset, chunk })
  },
  commit(requestId: string, writerId: string) {
    return ipcRenderer.invoke("daw:capability:commit", { requestId, writerId })
  },
  abort(requestId: string, writerId: string) {
    return ipcRenderer.invoke("daw:capability:abort", { requestId, writerId })
  },
  exportTerminal(jobId: string, status: "success" | "canceled" | "error") {
    const frame = desktopExportTerminalSchemaV1.parse({ version: "v1", type: "export-terminal", jobId, status })
    ipcRenderer.send(outgoingChannel, { generation: activeGeneration, frame })
  },
  ...(process.platform === "darwin" && process.arch === "arm64" ? {
    audioHost: {
      diagnostics: () => ipcRenderer.invoke("daw:audio-host:diagnostics") as Promise<NativeAudioHostDiagnosticsReply>,
      resolveOutputDevice: invokeNativeOutputDevice,
      resolveInputDevice: invokeNativeInputDevice,
      session: {
        configure: (input: NativeHostDeviceConfiguration) => invokeNativeSession("daw:audio-host:session:configure", input),
        beginTransaction: () => invokeNativeSession("daw:audio-host:session:begin-transaction"),
        commitTransaction: () => invokeNativeSession("daw:audio-host:session:commit-transaction"),
        rollbackTransaction: () => invokeNativeSession("daw:audio-host:session:rollback-transaction"),
        detachVst: (instanceId: string) => invokeNativeSession("daw:audio-host:session:detach-vst", instanceId),
        installAsset: (input: NativeHostPcmAsset) => invokeNativeSession("daw:audio-host:session:install-asset", input),
        releaseAsset: (sessionAssetId: number) => invokeNativeSession("daw:audio-host:session:release-asset", sessionAssetId),
        publishGraph: (bytes: Uint8Array) => invokeNativeSession("daw:audio-host:session:publish-graph", bytes),
        queueParameterEvents: (bytes: Uint8Array) => invokeNativeSession("daw:audio-host:session:queue-parameter-events", bytes),
        queueInstrumentEvents: (bytes: Uint8Array) => invokeNativeSession("daw:audio-host:session:queue-instrument-events", bytes),
        queueSourceEvents: (bytes: Uint8Array) => invokeNativeSession("daw:audio-host:session:queue-source-events", bytes),
        setTransport: (input: NativeHostTransport) => invokeNativeSession("daw:audio-host:session:set-transport", input),
        configureRecording: (input: NativeHostRecordingConfiguration) => invokeNativeSession("daw:audio-host:session:configure-recording", input),
        startRecording: () => invokeNativeSession("daw:audio-host:session:start-recording"),
        stopRecording: (stopFrame?: number) => invokeNativeSession("daw:audio-host:session:stop-recording", stopFrame),
        cancelRecording: () => invokeNativeSession("daw:audio-host:session:cancel-recording"),
        start: () => invokeNativeSession("daw:audio-host:session:start"),
        stop: () => invokeNativeSession("daw:audio-host:session:stop"),
        teardown: () => invokeNativeSession("daw:audio-host:session:teardown"),
        onLoss: (listener: () => void) => {
          const notify = () => listener()
          ipcRenderer.on("daw:audio-host:loss", notify)
          return () => ipcRenderer.removeListener("daw:audio-host:loss", notify)
        },
        onRecordingBlock: (listener: (block: NativeHostRecordingBlock) => void) => {
          const notify = (_event: Electron.IpcRendererEvent, block: NativeHostRecordingBlock) => listener(block)
          ipcRenderer.on("daw:audio-host:recording-block", notify)
          return () => ipcRenderer.removeListener("daw:audio-host:recording-block", notify)
        },
        onRecordingStatus: (listener: (status: NativeHostRecordingStatus) => void) => {
          const notify = (_event: Electron.IpcRendererEvent, status: NativeHostRecordingStatus) => listener(status)
          ipcRenderer.on("daw:audio-host:recording-status", notify)
          return () => ipcRenderer.removeListener("daw:audio-host:recording-status", notify)
        },
      },
    },
    pluginCatalog: {
      read: () => invokePluginCatalog("daw:plugin-catalog:read"),
      chooseDirectory: () => invokePluginCatalog("daw:plugin-catalog:choose-directory"),
      removeDirectory: (directory: string) => invokePluginCatalog("daw:plugin-catalog:remove-directory", { directory }),
      scan: () => invokePluginCatalog("daw:plugin-catalog:scan"),
      preflightInsertion: (input: NativeVst3InsertionPreflightRequest) => (
        ipcRenderer.invoke("daw:plugin-catalog:preflight-insertion", input) as Promise<NativeVst3InsertionPreflightResult>
      ),
    },
  } : {}),
})
