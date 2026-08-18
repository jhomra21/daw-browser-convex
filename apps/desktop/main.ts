import { app, BrowserWindow, dialog, ipcMain, Menu, net as electronNet, powerMonitor, protocol, session, shell } from "electron"
import { createServer, type Socket } from "node:net"
import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import {
  desktopFrameSchemaV1,
  desktopJsonValueSchema,
  desktopHelloSchemaV1,
  desktopHelloSchemaV2,
  desktopHostExportRunInputSchemaV1,
  desktopHostExportRunResultSchemaV1,
  desktopHostImportInputSchemaV1,
  desktopRendererExportInputSchemaV1,
  desktopRendererImportInputSchemaV1,
  desktopProtocolVersion,
  desktopProtocolVersionV2,
  desktopRegistrationSchemaV1,
  desktopRendererRequestSchemaV1,
  desktopTrustedRendererRequestSchemaV1,
  projectIdSchemaV1,
  hostError,
  hostErrorV2,
  hostErrorSchemaV1,
  isDesktopControlOperation,
  type DesktopFrameV1,
  type DesktopOperationV1,
  type DesktopProtocolVersion,
  type DesktopRendererRequestV1,
  type DesktopTrustedRendererRequestV1,
} from "@daw-browser/desktop-protocol"
import {
  desktopApplicationMenuStateSchema,
  type DesktopApplicationMenuCommand,
} from "@daw-browser/desktop-protocol/application-menu"
import { controlErrorSchemaV1 } from "@daw-browser/control"
import { createDesktopFrameDecoder, encodeDesktopFrame } from "@daw-browser/desktop-protocol/socket"
import { serializeDesktopReply } from "@daw-browser/desktop-protocol/reply-chunks"
import { createCloseHandler } from "./close-flow"
import { createFileCapabilityManager } from "./file-capabilities"
import { createNativeFileCapabilityHelper } from "./native-file-capability-helper"
import { createRequestCorrelation } from "./request-correlation"
import { createPreparationRegistry } from "./preparation-registry"
import { desktopOperations } from "./desktop-operations"
import { createContentSecurityPolicy } from "./content-security-policy"
import { createPluginCatalogStore } from "./plugin-catalog"
import { createVst3ScannerSupervisor, packagedVst3ScannerPath } from "./vst3-scanner"
import { catalogViewForRenderer } from "./vst3-attachment"
import { preflightVst3Insertion } from "./vst3-insertion-preflight"
import { packagedVst3WorkerPath } from "./vst3-preflight"
import {
  coordinateNativeVst3Attachments,
  resolveNativeVst3AttachmentPlan,
} from "./native-vst3-coordinator"
import {
  createNativeAudioHostSupervisor,
  renderNativeOffline,
  probeNativeAudioOutputDevice,
  NativeAudioHostCommandError,
  nativeVstEditorOwnershipProbe,
  packagedAudioHostPath,
  type NativeVstEditorAnchor,
  type NativeVstEditorCommand,
} from "./audio-host"
import { createNativeVst3EditorSessionManager } from "./native-vst3-editor-session"
import {
  completeDesktopAudioRecovery,
  type DesktopAudioLifecycle,
} from "../../src/lib/desktop-audio-lifecycle"
import {
  nativeReleaseArtifactManifestName,
  verifyPackagedNativeReleaseArtifacts,
} from "./native-release-artifacts"
import type {
  NativeHostDeviceConfiguration,
  NativeHostPcmAsset,
  NativeHostRecordingConfiguration,
  NativeHostTransport,
  NativeHostMeterBatch,
  NativeScheduleProgress,
  NativeOfflineRenderPlan,
} from "@daw-browser/audio-engine/native-host-wire"
import {
  decodeNativeExternalAttachmentPlan,
  nativeVst3InsertionPreflightRequestSchema,
} from "@daw-browser/plugin-host-protocol"
import { nativeOfflineRenderPlanSchema } from "@daw-browser/desktop-protocol/native-audio-host"
import {
  allowsTrustedAudioCapturePermission,
  allowsTrustedMidiPermission,
  createTrustedDesktopOriginPolicy,
} from "./permission-policy"
import { packagedRendererRoot, rendererAssetPath } from "./renderer-path"
import { createNativeVstProjectBindings } from "./native-vst-project-bindings"
import { createApplicationMenuController } from "./application-menu"

protocol.registerSchemesAsPrivileged([{ scheme: "daw", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])

const unsigned32Schema = z.number().int().min(0).max(0xffff_ffff)
const positiveUnsigned32Schema = unsigned32Schema.min(1)
const transactionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const requestIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const exactIpcScopeSchema = z.object({ requestId: requestIdSchema }).strict()
const recoveryCompletionSchema = z.object({
  powerGeneration: z.number().int().safe(),
  result: z.enum(["ready", "failed"]),
}).passthrough()
const rendererMessageSchema = z.object({
  generation: z.number().int().safe(),
  frame: desktopFrameSchemaV1,
}).passthrough()
const offlineRenderRequestSchema = z.object({
  jobId: z.string().min(1).max(128),
  plan: nativeOfflineRenderPlanSchema,
}).passthrough()
const optionalDeviceIdSchema = z.string().optional()
const nativeSessionConfigurationSchema = z.object({
  deviceId: z.string(),
  sampleRateHz: unsigned32Schema,
  maxFramesPerBlock: unsigned32Schema,
  channelCount: unsigned32Schema,
  revision: unsigned32Schema,
}).passthrough()
const nativeSessionTransportSchema = z.object({
  epoch: unsigned32Schema,
  running: z.boolean(),
  frame: z.number().int().safe(),
  bpm: z.number().finite().positive().optional(),
  timeSignatureNumerator: z.number().int().positive().optional(),
  timeSignatureDenominator: z.number().int().positive().optional(),
  cycleActive: z.boolean().optional(),
  cycleStartSec: z.number().finite().min(0).optional(),
  cycleEndSec: z.number().finite().min(0).optional(),
  transitionId: z.bigint().positive().max(0xffff_ffff_ffff_ffffn).optional(),
}).passthrough().refine((value) => (
  (value.cycleStartSec === undefined && value.cycleEndSec === undefined)
  || (
    value.cycleStartSec !== undefined
    && value.cycleEndSec !== undefined
    && value.cycleEndSec > value.cycleStartSec
  )
)).refine((value) => (
  (!Object.hasOwn(value, "bpm") || value.bpm !== undefined)
  && (!Object.hasOwn(value, "timeSignatureNumerator") || value.timeSignatureNumerator !== undefined)
  && (!Object.hasOwn(value, "timeSignatureDenominator") || value.timeSignatureDenominator !== undefined)
  && (!Object.hasOwn(value, "cycleActive") || value.cycleActive !== undefined)
  && (!Object.hasOwn(value, "cycleStartSec") || value.cycleStartSec !== undefined)
  && (!Object.hasOwn(value, "cycleEndSec") || value.cycleEndSec !== undefined)
))
const nativeSessionRecordingConfigurationSchema = z.object({
  deviceUid: z.string(),
  generation: positiveUnsigned32Schema,
  sessionId: z.bigint().positive(),
  channelCount: z.union([z.literal(1), z.literal(2)]),
  inputChannels: z.array(unsigned32Schema),
  gain: z.number().finite().min(0),
  polarity: z.union([z.literal(1), z.literal(-1)]),
  punchStartFrame: z.number().int().safe().min(0),
  punchEndFrame: z.number().int().safe().min(0).nullable(),
  monitoring: z.boolean(),
}).strict().refine((value) => (
  value.inputChannels.length === value.channelCount
  && (value.punchEndFrame === null || value.punchEndFrame >= value.punchStartFrame)
))
const nativeSessionAssetSchema = z.object({
  sessionAssetId: unsigned32Schema,
  frameCount: unsigned32Schema,
  sampleRateHz: unsigned32Schema,
  channelCount: unsigned32Schema,
  planarPcm: z.instanceof(Uint8Array),
  contentHashPrefix: z.instanceof(Uint8Array).optional(),
}).strict()
const nativeEditorAnchorSchema = z.object({
  x: z.number().finite().min(-8_000_000).max(8_000_000),
  y: z.number().finite().min(-8_000_000).max(8_000_000),
}).passthrough()
const nativeEditorCommandSchema = z.object({
  projectId: projectIdSchemaV1,
  instanceId: uuidSchema,
  command: z.enum(["open", "close", "focus", "resize", "status"]),
  serializedPlan: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 1_048_576).optional(),
  width: unsigned32Schema.max(8192).optional(),
  height: unsigned32Schema.max(8192).optional(),
  anchor: nativeEditorAnchorSchema.optional(),
}).passthrough().refine((value) => (
  (value.anchor === undefined || value.command === "open" || value.command === "focus")
  && (
    (value.command !== "open" && value.command !== "focus" && value.command !== "status")
    || value.serializedPlan !== undefined
  )
)).refine((value) => (
  (!Object.hasOwn(value, "serializedPlan") || value.serializedPlan !== undefined)
  && (!Object.hasOwn(value, "width") || value.width !== undefined)
  && (!Object.hasOwn(value, "height") || value.height !== undefined)
  && (!Object.hasOwn(value, "anchor") || value.anchor !== undefined)
))
const nativeAttachmentCoordinationSchema = z.object({
  projectId: projectIdSchemaV1,
  serializedPlan: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 1_048_576),
  sampleRateHz: z.number().finite().positive().max(384_000),
}).passthrough()
const nativeSessionEnvelopeSchema = <Schema extends z.ZodType>(valueSchema: Schema) => (
  z.object({
    value: valueSchema,
    transactionToken: transactionTokenSchema.optional(),
  }).passthrough().refine((value) => (
    Object.hasOwn(value, "value") && Object.hasOwn(value, "transactionToken")
  ))
)
const nativeBytesEnvelopeSchema = nativeSessionEnvelopeSchema(z.instanceof(Uint8Array))
const nativeUndefinedEnvelopeSchema = nativeSessionEnvelopeSchema(z.undefined())
const nativeSpectrumNodeEnvelopeSchema = nativeSessionEnvelopeSchema(z.bigint().positive().nullable())
const nativeEditorEnvelopeSchema = nativeSessionEnvelopeSchema(nativeEditorCommandSchema)
const nativeAttachmentEnvelopeSchema = nativeSessionEnvelopeSchema(nativeAttachmentCoordinationSchema)
const nativeConfigurationEnvelopeSchema = nativeSessionEnvelopeSchema(nativeSessionConfigurationSchema)
const nativeAssetEnvelopeSchema = nativeSessionEnvelopeSchema(nativeSessionAssetSchema)
const nativeAssetIdEnvelopeSchema = nativeSessionEnvelopeSchema(positiveUnsigned32Schema)
const nativeInstanceEnvelopeSchema = nativeSessionEnvelopeSchema(uuidSchema)
const nativeTransportEnvelopeSchema = nativeSessionEnvelopeSchema(nativeSessionTransportSchema)
const pluginDirectorySchema = z.object({ directory: z.string() }).passthrough()
const outputFormatSchema = z.enum(["wav", "mp3", "ogg-opus", "flac"])
const outputFilePickerSchema = z.object({
  requestId: requestIdSchema,
  format: outputFormatSchema,
}).strict()
const capabilityReadSchema = z.object({
  requestId: requestIdSchema,
  token: z.string(),
}).passthrough()
const capabilityBeginWriteSchema = z.object({
  requestId: requestIdSchema,
  token: z.string(),
  relativePath: z.string().optional(),
}).passthrough()
const capabilityWriteChunkSchema = z.object({
  requestId: requestIdSchema,
  writerId: z.string(),
  offset: z.number(),
  chunk: z.instanceof(Uint8Array),
}).passthrough()
const capabilityWriterSchema = z.object({
  requestId: requestIdSchema,
  writerId: z.string(),
}).passthrough()
const closePreparationResultSchema = z.object({ flushed: z.literal(true) }).passthrough()

const incomingChannel = "daw:host-request"
const outgoingChannel = "daw:host-response"
const appName = "daw-browser"
const sanitizeNativeVst3DiagnosticError = (error: Error | undefined) => {
  const message = error?.message ?? "The native VST editor session is unavailable."
  return message.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s]*/g, "<path>").slice(0, 256)
}
const preloadPath = path.join(import.meta.dirname, "preload.js")
const externalUrl = (url: string) => {
  try {
    return new URL(url).protocol === "https:"
  } catch {
    return false
  }
}
const sameAppOrigin = createTrustedDesktopOriginPolicy(MAIN_WINDOW_VITE_DEV_SERVER_URL)
type PendingRendererRequest = {
  generation: number
  resolve: (frame: Extract<DesktopFrameV1, { type: "reply" }>) => void
  reject: (error: Error) => void
}
type RendererRequestInput = Parameters<typeof desktopRendererRequestSchemaV1.parse>[0]
type RendererReplyError = Parameters<typeof controlErrorSchemaV1.safeParse>[0]
let window_: BrowserWindow | undefined
const applicationMenuCommandChannel = "daw:application-menu:command"
const applicationMenuStateChannel = "daw:application-menu:state"
const applicationMenuController = createApplicationMenuController<Menu>({
  platform: process.platform === "darwin"
    ? "darwin"
    : process.platform === "win32"
      ? "win32"
      : "linux",
  sendCommand: (command: DesktopApplicationMenuCommand) => {
    const target = window_?.webContents
    if (!target || target.isDestroyed() || !sameAppOrigin(target.getURL())) return
    target.send(applicationMenuCommandChannel, command)
  },
})
let generation = 0
const rendererPending = new Map<string, PendingRendererRequest>()
const preparationRegistry = createPreparationRegistry()
const exportScopes = new Map<string, { requestId: string; rendererGeneration: number }>()
const preparedExportModes = new Map<string, "mixdown" | "stems">()
const terminalExportsAwaitingScope = new Set<string>()
const exportScopesHasScope = (scope: { requestId: string; rendererGeneration: number }) => (
  [...exportScopes.values()].some((exportScope) => (
    exportScope.requestId === scope.requestId
    && exportScope.rendererGeneration === scope.rendererGeneration
  ))
)
const instanceId = randomBytes(16).toString("hex")
const secret = randomBytes(32).toString("hex")
let registrationPath = ""
let socketPath = ""
let socketServer: ReturnType<typeof createServer> | undefined
const acceptedSockets = new Set<Socket>()
let finishingQuit = false
let nativeMediaAvailable = false
let pluginCatalogStore: ReturnType<typeof createPluginCatalogStore> | undefined
let audioHostPath: string | undefined
let vst3WorkerPath: string | undefined
let audioHostSupervisor: ReturnType<typeof createNativeAudioHostSupervisor> | undefined
let offlineRenderJob: { jobId: string; controller: AbortController } | undefined
const abortOfflineRenderJobs = () => {
  offlineRenderJob?.controller.abort()
}
let nativeVst3EditorSessionManager: ReturnType<typeof createNativeVst3EditorSessionManager> | undefined
let audioLifecycle: DesktopAudioLifecycle = { state: "ready", powerGeneration: 0 }
let audioSuspendPromise: Promise<void> | undefined
let audioRecoveryGeneration: number | undefined
let vst3ScannerSupervisor: ReturnType<typeof createVst3ScannerSupervisor> | undefined
let nativeReleaseArtifactVerification:
  | { status: "disabled" | "development" | "verified" }
  | { status: "failed"; reason: string } = { status: "disabled" }
let removeAudioHostLossListener: (() => void) | undefined
let removeAudioHostRecordingBlockListener: (() => void) | undefined
let removeAudioHostRecordingStatusListener: (() => void) | undefined
let removeAudioHostMeterBatchListener: (() => void) | undefined
let removeAudioHostSpectrumListener: (() => void) | undefined
let removeAudioHostScheduleProgressListener: (() => void) | undefined
let removeAudioHostWorkerNotificationListener: (() => void) | undefined
const activeEditorProjectBindings = createNativeVstProjectBindings()
const nativeFileCapabilityHelper = createNativeFileCapabilityHelper()
const fileCapabilities = createFileCapabilityManager({
  dialog: {
    showOpenDialog: (options) => dialog.showOpenDialog(options),
    showSaveDialog: (options) => dialog.showSaveDialog(options),
  },
  nativeHelper: nativeFileCapabilityHelper,
  nativeOutputEnabled: () => nativeMediaAvailable,
  privateTempDirectory: () => path.join(app.getPath("userData"), "output-temp"),
})
const settleCapabilityRevocation = (operation: Promise<void>) => {
  void operation.catch(() => undefined)
}
const availableDesktopOperations = () => desktopOperations(nativeMediaAvailable)
const publishAudioLifecycle = () => {
  const target = window_?.webContents
  if (!target || target.isDestroyed() || !sameAppOrigin(target.getURL())) return
  target.send("daw:audio-host:lifecycle", audioLifecycle)
}
const recoverAudioHost = (recoveryGeneration: number) => {
  if (audioRecoveryGeneration === recoveryGeneration) return
  audioRecoveryGeneration = recoveryGeneration
  void (async () => {
    try {
      await audioSuspendPromise
      if (audioLifecycle.state !== "suspended" || audioLifecycle.powerGeneration !== recoveryGeneration) return
      await audioHostSupervisor?.resume()
      await audioHostSupervisor?.start()
      if (audioLifecycle.state !== "suspended" || audioLifecycle.powerGeneration !== recoveryGeneration) return
      audioLifecycle = { state: "recovering", powerGeneration: recoveryGeneration }
      publishAudioLifecycle()
    } catch {
      if (audioLifecycle.state !== "suspended" || audioLifecycle.powerGeneration !== recoveryGeneration) return
      audioLifecycle = { state: "failed", powerGeneration: recoveryGeneration }
      publishAudioLifecycle()
    } finally {
      if (audioRecoveryGeneration === recoveryGeneration) audioRecoveryGeneration = undefined
    }
  })()
}
const operationFailure = (_operation: DesktopOperationV1, code: Parameters<typeof hostError>[0], message: string) => hostError(code, message)
const operationFailureV2 = (_operation: DesktopOperationV1, code: Parameters<typeof hostError>[0], message: string) => hostErrorV2(code, message)
const translateRendererError = (
  operation: DesktopOperationV1,
  error: RendererReplyError,
  protocolVersion: DesktopProtocolVersion,
) => {
  if (protocolVersion !== desktopProtocolVersionV2) return error
  if (isDesktopControlOperation(operation) && controlErrorSchemaV1.safeParse(error).success) return error
  const host = hostErrorSchemaV1.safeParse(error)
  return host.success ? hostErrorV2(host.data.code, host.data.message) : error
}
const writeSocketFailure = (
  socket: Socket,
  protocolVersion: DesktopProtocolVersion,
  operation: DesktopOperationV1,
  id: string,
  code: Parameters<typeof hostError>[0],
  message: string,
) => {
  if (protocolVersion === desktopProtocolVersionV2) {
    socket.write(encodeDesktopFrame({
      version: desktopProtocolVersionV2,
      type: "reply",
      id,
      error: operationFailureV2(operation, code, message),
    }))
    return
  }
  socket.write(encodeDesktopFrame({
    version: desktopProtocolVersion,
    type: "reply",
    id,
    error: operationFailure(operation, code, message),
  }))
}

const cancelRendererRequest = (id: string, requestGeneration: number) => {
  const target = window_?.webContents
  if (!target || target.isDestroyed() || !sameAppOrigin(target.getURL())) return
  target.send(incomingChannel, {
    generation: requestGeneration,
    frame: { version: desktopProtocolVersion, type: "cancel", id },
  })
}

const cancelPreparedRendererExport = (id: string) => {
  const mode = preparedExportModes.get(id)
  if (!mode) return
  preparedExportModes.delete(id)
  const target = window_?.webContents
  if (!target || target.isDestroyed() || !sameAppOrigin(target.getURL())) return
  target.send(incomingChannel, {
    generation,
    frame: {
      version: desktopProtocolVersion,
      type: "request",
      id,
      operation: "host.export.run",
      input: desktopRendererExportInputSchemaV1.parse({ canceled: true, mode }),
    },
  })
}

const rejectRendererPending = (message: string) => {
  for (const [id, pending] of rendererPending) {
    cancelRendererRequest(id, pending.generation)
    pending.reject(new Error(message))
  }
  rendererPending.clear()
}
const rejectRendererRequest = (id: string, message: string) => {
  const pending = rendererPending.get(id)
  if (!pending) return
  rendererPending.delete(id)
  cancelRendererRequest(id, pending.generation)
  pending.reject(new Error(message))
}

const sendToRenderer = (request: DesktopRendererRequestV1 | DesktopTrustedRendererRequestV1) => new Promise<Extract<DesktopFrameV1, { type: "reply" }>>((resolve, reject) => {
  const target = window_?.webContents
  if (!target || target.isDestroyed() || !sameAppOrigin(target.getURL())) {
    reject(new Error("Renderer unavailable."))
    return
  }
  if (rendererPending.has(request.id)) {
    reject(new Error("Duplicate request ID."))
    return
  }
  const expectedGeneration = generation
  rendererPending.set(request.id, { generation: expectedGeneration, resolve, reject })
  target.send(incomingChannel, { generation: expectedGeneration, frame: request })
})

const renderRequest = async (operation: DesktopOperationV1 | "lifecycle.prepareToClose", input: RendererRequestInput, id: string, deadlineMs = 10_000, actorSubject?: string) => {
  const request = { version: desktopProtocolVersion, type: "request" as const, id, operation, input, deadlineMs }
  const parsed = operation !== "lifecycle.prepareToClose" && isDesktopControlOperation(operation)
    ? desktopTrustedRendererRequestSchemaV1.parse({ ...request, actorSubject })
    : desktopRendererRequestSchemaV1.parse(request)
  // This is a bounded deadline guard for a renderer IPC round trip; it is always cleared on completion.
  let timeout: ReturnType<typeof setTimeout> | undefined
  let deadlineElapsed = false
  try {
    return await Promise.race([
      sendToRenderer(parsed),
      new Promise<Extract<DesktopFrameV1, { type: "reply" }>>((_resolve, reject) => {
        timeout = setTimeout(() => {
          deadlineElapsed = true
          reject(new Error("Renderer deadline exceeded."))
        }, deadlineMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    const pending = rendererPending.get(id)
    if (deadlineElapsed && pending) cancelRendererRequest(id, pending.generation)
    rendererPending.delete(id)
  }
}

const prepareRendererInput = async (
  operation: DesktopOperationV1,
  input: RendererRequestInput,
  scope: { requestId: string; rendererGeneration: number },
  signal: AbortSignal,
) => {
  signal.throwIfAborted()
  if (operation === "host.import.audio") {
    const request = desktopHostImportInputSchemaV1.parse(input)
    const selection = request.source.kind === "picker"
      ? await fileCapabilities.pickReadFiles(scope)
      : { canceled: false as const, files: [await fileCapabilities.grantReadFile(scope, request.source.path)] }
    signal.throwIfAborted()
    return desktopRendererImportInputSchemaV1.parse(
      selection.canceled ? { canceled: true } : { canceled: false, files: selection.files },
    )
  }
  if (operation === "host.export.run") {
    const request = desktopHostExportRunInputSchemaV1.parse(input)
    const extension = request.mode === "mixdown"
      ? request.format === "ogg-opus" ? "ogg" : request.format
      : undefined
    const placeholderDestination: {
      kind: "capability-file"
      token: string
      basename: string
    } | {
      kind: "capability-directory"
      token: string
      basename: string
    } = request.mode === "mixdown"
      ? { kind: "capability-file", token: "0".repeat(64), basename: `preflight.${extension}` }
      : { kind: "capability-directory", token: "0".repeat(64), basename: "preflight" }
    const preflight = await renderRequest("host.export.run", desktopRendererExportInputSchemaV1.parse({
      ...request,
      canceled: false,
      preflightOnly: true,
      destination: placeholderDestination,
    }), scope.requestId)
    if (preflight.error) throw new Error(preflight.error.message)
    preparedExportModes.set(scope.requestId, request.mode)
    try {
      signal.throwIfAborted()
      const destination = request.destination
      if (destination.kind === "file" || destination.kind === "file-picker") {
        const selected = destination.kind === "file-picker"
          ? await fileCapabilities.pickOutputFile(scope, request.mode === "mixdown" ? request.format : undefined)
          : { canceled: false as const, file: await fileCapabilities.grantOutputFile(scope, destination.path) }
        signal.throwIfAborted()
        if (selected.canceled) return desktopRendererExportInputSchemaV1.parse({ canceled: true, mode: "mixdown" })
        return desktopRendererExportInputSchemaV1.parse({ ...request, destination: { kind: "capability-file", token: selected.file.token, basename: selected.file.basename }, canceled: false })
      }
      const selected = destination.kind === "directory-picker"
        ? await fileCapabilities.pickDirectory(scope)
        : { canceled: false as const, directory: await fileCapabilities.grantDirectory(scope, destination.path) }
      signal.throwIfAborted()
      if (selected.canceled) return desktopRendererExportInputSchemaV1.parse({ canceled: true, mode: "stems" })
      return desktopRendererExportInputSchemaV1.parse({ ...request, destination: { kind: "capability-directory", token: selected.directory.token, basename: selected.directory.basename }, canceled: false })
    } catch (error) {
      cancelPreparedRendererExport(scope.requestId)
      throw error
    } finally {
      preparedExportModes.delete(scope.requestId)
    }
  }
  return input
}

const closeSocket = async () => {
  for (const socket of acceptedSockets) socket.destroy()
  acceptedSockets.clear()
  await new Promise<void>((resolve) => socketServer?.close(() => resolve()) ?? resolve())
  socketServer = undefined
  if (socketPath) await rm(socketPath, { force: true }).catch(() => undefined)
  if (registrationPath) await rm(registrationPath, { force: true }).catch(() => undefined)
}

const registrationDirectory = () => path.join(app.getPath("userData"), "host")
const localSocketAddress = () => process.platform === "win32"
  ? `\\\\.\\pipe\\${appName}-${instanceId}`
  : path.join(registrationDirectory(), `${instanceId}.sock`)

const authenticate = (value: string) => {
  const supplied = Buffer.from(value, "hex")
  const expected = Buffer.from(secret, "hex")
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected)
}

const startSocket = async () => {
  const directory = registrationDirectory()
  if (process.platform === "win32") await mkdir(directory, { recursive: true })
  else {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
  }
  socketPath = localSocketAddress()
  if (process.platform !== "win32") await rm(socketPath, { force: true })
  socketServer = createServer((socket) => handleSocket(socket))
  await new Promise<void>((resolve, reject) => socketServer?.once("error", reject).listen(socketPath, resolve))
  if (process.platform !== "win32") await chmod(socketPath, 0o600)
  registrationPath = path.join(directory, "registration-v1.json")
  const registration = desktopRegistrationSchemaV1.parse({
    version: desktopProtocolVersion,
    instanceId,
    pid: process.pid,
    createdAt: Date.now(),
    address: socketPath,
    secret,
  })
  await writeFile(registrationPath, JSON.stringify(registration), process.platform === "win32" ? undefined : { mode: 0o600 })
  if (process.platform !== "win32") await chmod(registrationPath, 0o600)
}

const handleSocket = (socket: Socket) => {
  let authenticated = false
  let protocolVersion: DesktopProtocolVersion | undefined
  let actorSubject: string | undefined
  const correlation = createRequestCorrelation()
  const preparationControllers = new Map<string, AbortController>()
  const finalExportCandidates = new Set<string>()
  const sessionId = randomBytes(16).toString("hex")
  acceptedSockets.add(socket)
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    acceptedSockets.delete(socket)
    for (const controller of preparationControllers.values()) {
      controller.abort()
      preparationRegistry.delete(controller)
    }
    preparationControllers.clear()
    const rendererIds = [...correlation.internalIds()]
    for (const rendererId of rendererIds) {
      cancelPreparedRendererExport(rendererId)
      if (!finalExportCandidates.has(rendererId)) rejectRendererRequest(rendererId, "Desktop host connection closed.")
    }
    correlation.clear()
    for (const rendererId of rendererIds) {
      if (finalExportCandidates.has(rendererId)) continue
      settleCapabilityRevocation(fileCapabilities.revokeRequest({ requestId: rendererId, rendererGeneration: generation }))
    }
  }
  const decoder = createDesktopFrameDecoder((frame) => {
    if (!authenticated) {
      const hello = desktopHelloSchemaV1.safeParse(frame).success
        ? desktopHelloSchemaV1.safeParse(frame)
        : desktopHelloSchemaV2.safeParse(frame)
      if (!hello.success || !authenticate(hello.data.secret)) {
        socket.destroy()
        return
      }
      authenticated = true
      protocolVersion = hello.data.version
      actorSubject = `local:${hello.data.actorId}`
      socket.write(encodeDesktopFrame(
        protocolVersion === desktopProtocolVersionV2
          ? { version: desktopProtocolVersionV2, type: "helloAck", selectedVersion: desktopProtocolVersionV2, sessionId, capabilities: availableDesktopOperations() }
          : { version: desktopProtocolVersion, type: "helloAck", sessionId, capabilities: availableDesktopOperations() },
      ))
      return
    }
    const sessionProtocolVersion = protocolVersion
    if (
      sessionProtocolVersion === "v1"
      && frame.version === desktopProtocolVersionV2
      && frame.type === "request"
    ) {
      writeSocketFailure(socket, sessionProtocolVersion, frame.operation, frame.id, "unsupported-version", "Protocol version v2 is not available in this session.")
      return
    }
    if (sessionProtocolVersion === undefined || frame.version !== sessionProtocolVersion) {
      socket.destroy()
      return
    }
    if (frame.type === "cancel") {
      const rendererId = correlation.removeExternal(frame.id)
      if (rendererId) {
        finalExportCandidates.delete(rendererId)
        cancelPreparedRendererExport(rendererId)
        const controller = preparationControllers.get(rendererId)
        controller?.abort()
        if (controller) preparationRegistry.delete(controller)
        preparationControllers.delete(rendererId)
        const canceledScope = { requestId: rendererId, rendererGeneration: generation }
        settleCapabilityRevocation(fileCapabilities.revokeRequest(canceledScope).finally(() => {
          rejectRendererRequest(rendererId, "Desktop host request cancelled.")
        }))
      }
      return
    }
    if (frame.type !== "request" || correlation.getInternal(frame.id)) {
      socket.destroy()
      return
    }
    if (!availableDesktopOperations().includes(frame.operation)) {
      writeSocketFailure(socket, sessionProtocolVersion, frame.operation, frame.id, "unavailable", "The requested desktop operation is unavailable on this platform.")
      return
    }
    const rendererId = correlation.create(frame.id)
    const preparation = new AbortController()
    preparationRegistry.add(preparation)
    preparationControllers.set(rendererId, preparation)
    const scope = { requestId: rendererId, rendererGeneration: generation }
    void prepareRendererInput(frame.operation, frame.input, scope, preparation.signal)
      .then((input) => {
        preparation.signal.throwIfAborted()
        if (frame.operation === "host.export.run") {
          const parsed = desktopRendererExportInputSchemaV1.parse(input)
          if (!parsed.canceled && !parsed.preflightOnly) finalExportCandidates.add(rendererId)
        }
        return renderRequest(frame.operation, input, rendererId, frame.deadlineMs, actorSubject)
      }).then(async (reply) => {
      preparationControllers.delete(rendererId)
      preparationRegistry.delete(preparation)
      finalExportCandidates.delete(rendererId)
      if (frame.operation === "host.export.run" && !reply.error) {
        const result = desktopHostExportRunResultSchemaV1.safeParse(reply.result)
        if (result.success && result.data.status === "queued" && result.data.jobId) {
          exportScopes.set(result.data.jobId, scope)
          if (terminalExportsAwaitingScope.delete(result.data.jobId)) {
            exportScopes.delete(result.data.jobId)
            await fileCapabilities.revokeRequest(scope)
          }
        }
      }
      const externalId = correlation.getExternal(rendererId)
      if (!externalId) {
        if (frame.operation !== "host.export.run" || ![...exportScopes.values()].some((exportScope) => exportScope.requestId === scope.requestId && exportScope.rendererGeneration === scope.rendererGeneration)) {
          await fileCapabilities.revokeRequest(scope)
        }
        return
      }
      correlation.removeExternal(externalId)
      if (socket.destroyed) {
        if (frame.operation !== "host.export.run" || ![...exportScopes.values()].some((exportScope) => exportScope.requestId === scope.requestId && exportScope.rendererGeneration === scope.rendererGeneration)) {
          await fileCapabilities.revokeRequest(scope)
        }
        return
      }
      if (frame.operation === "host.import.audio" || (frame.operation === "host.export.run" && !exportScopesHasScope(scope))) {
        await fileCapabilities.revokeRequest(scope)
      }
      try {
        const translatedError = translateRendererError(
          frame.operation,
          reply.error,
          sessionProtocolVersion,
        )
        for (const outbound of serializeDesktopReply(
          frame.operation,
          frame.input,
          desktopJsonValueSchema.parse({
            ...reply,
            error: translatedError,
            id: externalId,
            version: sessionProtocolVersion,
          }),
          sessionProtocolVersion,
        )) {
          socket.write(encodeDesktopFrame(outbound))
        }
      } catch {
        writeSocketFailure(socket, sessionProtocolVersion, frame.operation, externalId, "internal", "The desktop response could not be serialized.")
      }
    }).catch(async (error) => {
      preparationControllers.delete(rendererId)
      preparationRegistry.delete(preparation)
      finalExportCandidates.delete(rendererId)
      await fileCapabilities.revokeRequest(scope)
      const externalId = correlation.getExternal(rendererId)
      if (!externalId) return
      correlation.removeExternal(externalId)
      const message = error instanceof Error && error.message === "Renderer deadline exceeded." ? "The request deadline elapsed." : "The renderer is unavailable."
      const code = error instanceof Error && error.message === "Renderer deadline exceeded." ? "deadline-exceeded" : "unavailable"
      writeSocketFailure(socket, sessionProtocolVersion, frame.operation, externalId, code, message)
    })
  })
  socket.on("data", (chunk: Buffer) => {
    try {
      decoder(chunk)
    } catch {
      socket.destroy()
    }
  })
  socket.on("close", close)
  socket.on("error", close)
}

const registerIpc = () => {
  const applicationMenuStateAllowed = (event: Electron.IpcMainEvent) => (
    window_ !== undefined
    && event.sender.id === window_.webContents.id
    && event.senderFrame !== null
    && event.senderFrame === event.sender.mainFrame
    && sameAppOrigin(event.senderFrame.url)
  )
  ipcMain.on(applicationMenuStateChannel, (event, value) => {
    if (!applicationMenuStateAllowed(event)) return
    const parsed = desktopApplicationMenuStateSchema.safeParse(value)
    if (parsed.success) applicationMenuController.setState(parsed.data)
  })
  ipcMain.handle("daw:audio-host:lifecycle", (event) => {
    if (!audioHostAllowed(event)) return { state: "failed" as const, powerGeneration: audioLifecycle.powerGeneration }
    return audioLifecycle
  })
  ipcMain.handle("daw:audio-host:recovery-complete", (event, value) => {
    if (!audioHostAllowed(event)) return { accepted: false }
    const completionRequest = recoveryCompletionSchema.safeParse(value)
    if (!completionRequest.success) return { accepted: false }
    const completion = completeDesktopAudioRecovery(
      audioLifecycle,
      completionRequest.data.powerGeneration,
      completionRequest.data.result,
    )
    if (!completion.accepted) return { accepted: false }
    audioLifecycle = completion.lifecycle
    publishAudioLifecycle()
    return { accepted: true }
  })
  ipcMain.handle("daw:audio-host:recovery-retry", (event) => {
    if (!audioHostAllowed(event) || audioLifecycle.state !== "failed") return { accepted: false }
    audioLifecycle = {
      state: "suspended",
      powerGeneration: audioLifecycle.powerGeneration + 1,
    }
    recoverAudioHost(audioLifecycle.powerGeneration)
    return { accepted: true }
  })
  ipcMain.on(outgoingChannel, (event, message) => {
    if (!window_ || event.sender.id !== window_.webContents.id || !event.senderFrame || !sameAppOrigin(event.senderFrame.url)) return
    const parsed = rendererMessageSchema.safeParse(message)
    if (!parsed.success || parsed.data.generation !== generation) return
    if (parsed.data.frame.type === "export-terminal") {
      const scope = exportScopes.get(parsed.data.frame.jobId)
      if (scope) {
        exportScopes.delete(parsed.data.frame.jobId)
        settleCapabilityRevocation(fileCapabilities.revokeRequest(scope))
      } else if (terminalExportsAwaitingScope.size < 1024) terminalExportsAwaitingScope.add(parsed.data.frame.jobId)
      return
    }
    if (parsed.data.frame.type !== "reply") return
    const pending = rendererPending.get(parsed.data.frame.id)
    if (!pending || pending.generation !== parsed.data.generation) return
    pending.resolve(parsed.data.frame)
  })
  const scopeAllowed = (event: Electron.IpcMainInvokeEvent) => (
    window_ !== undefined
    && event.sender.id === window_.webContents.id
    && event.senderFrame !== null
    && event.senderFrame === event.sender.mainFrame
    && sameAppOrigin(event.senderFrame.url)
  )
  const scopeFor = (event: Electron.IpcMainInvokeEvent, requestId: string) => (
    scopeAllowed(event) ? { requestId, rendererGeneration: generation } : undefined
  )
  const catalogAllowed = (event: Electron.IpcMainInvokeEvent) => (
    process.platform === "darwin"
    && window_ !== undefined
    && event.sender.id === window_.webContents.id
    && event.senderFrame !== null
    && sameAppOrigin(event.senderFrame.url)
    && pluginCatalogStore !== undefined
  )
  const catalogFailure = (message: string) => ({ ok: false as const, error: message })
  const catalogStoreFor = (event: Electron.IpcMainInvokeEvent) => (
    catalogAllowed(event) ? pluginCatalogStore : undefined
  )
  const audioHostAllowed = (event: Electron.IpcMainInvokeEvent) => (
    process.platform === "darwin"
    && process.arch === "arm64"
    && window_ !== undefined
    && event.sender.id === window_.webContents.id
    && event.senderFrame !== null
    && sameAppOrigin(event.senderFrame.url)
  )
  const offlinePlan = (value: NativeOfflineRenderPlan): NativeOfflineRenderPlan | undefined => {
    for (const state of value.capturedVstStates ?? []) {
      if (createHash("sha256").update(state.bytes).digest("hex") !== state.sha256) return undefined
    }
    return value
  }
  ipcMain.handle("daw:audio-host:offline-render", async (event, value) => {
    if (!audioHostAllowed(event) || !audioHostPath) {
      return { ok: false as const, error: "The native offline renderer is unavailable." }
    }
    const request = offlineRenderRequestSchema.safeParse(value)
    if (!request.success) {
      return { ok: false as const, error: "The native offline renderer is unavailable." }
    }
    const jobId = request.data.jobId
    const plan = offlinePlan(request.data.plan)
    if (!plan) {
      return { ok: false as const, error: "The native offline render plan is invalid." }
    }
    if (offlineRenderJob?.jobId === jobId) {
      return { ok: false as const, error: "An offline render with this job ID is already active." }
    }
    if (offlineRenderJob) {
      return { ok: false as const, error: "Only one native offline render may be active at a time." }
    }
    const controller = new AbortController()
    const cancelOnDestroy = () => controller.abort()
    event.sender.once("destroyed", cancelOnDestroy)
    const job = { jobId, controller }
    offlineRenderJob = job
    try {
      let vstAttachments: Awaited<ReturnType<typeof resolveNativeVst3AttachmentPlan>> | undefined
      if (plan.externalAttachments) {
        if (!pluginCatalogStore || !vst3WorkerPath) {
          throw new Error("The trusted native VST3 catalog or worker is unavailable.")
        }
        vstAttachments = await resolveNativeVst3AttachmentPlan({
          plan: plan.externalAttachments,
          sampleRateHz: plan.sampleRateHz,
          workerPath: vst3WorkerPath,
          catalogStore: pluginCatalogStore,
          capturedVstStates: new Map(
            (plan.capturedVstStates ?? []).map((state) => [state.instanceId, state]),
          ),
          signal: controller.signal,
        })
      }
      await renderNativeOffline({
        hostPath: audioHostPath,
        plan,
        vstAttachments,
        signal: controller.signal,
        onChunk: (chunk) => {
          if (!event.sender.isDestroyed()) event.sender.send("daw:audio-host:offline-pcm", { jobId, chunk })
        },
      })
      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : "Native offline rendering failed." }
    } finally {
      event.sender.removeListener("destroyed", cancelOnDestroy)
      if (offlineRenderJob === job) offlineRenderJob = undefined
    }
  })
  ipcMain.handle("daw:audio-host:offline-cancel", (event, value) => {
    if (!audioHostAllowed(event)) return { accepted: false }
    const jobId = z.string().min(1).max(128).safeParse(value)
    if (!jobId.success) return { accepted: false }
    if (!offlineRenderJob || offlineRenderJob.jobId !== jobId.data) return { accepted: false }
    offlineRenderJob.controller.abort()
    return { accepted: true }
  })
  ipcMain.handle("daw:audio-host:diagnostics", async (event) => {
    if (!audioHostAllowed(event) || !audioHostSupervisor) {
      return {
        ok: false,
        error: "The native audio host is unavailable.",
        artifactVerification: nativeReleaseArtifactVerification,
      }
    }
    try {
      return {
        ok: true,
        hello: await audioHostSupervisor.start(),
        status: audioHostSupervisor.status(),
        diagnostics: await audioHostSupervisor.diagnostics(),
        artifactVerification: nativeReleaseArtifactVerification,
      }
    } catch {
      return {
        ok: false,
        error: "The native audio host is unavailable.",
        artifactVerification: nativeReleaseArtifactVerification,
      }
    }
  })
  ipcMain.handle("daw:audio-host:resolve-output-device", async (event, value) => {
    if (!audioHostAllowed(event) || !audioHostSupervisor) {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }
    const deviceId = optionalDeviceIdSchema.safeParse(value)
    if (!deviceId.success) {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }
    try {
      return { ok: true as const, device: await audioHostSupervisor.resolveOutputDevice(deviceId.data) }
    } catch {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }
  })
  ipcMain.handle("daw:audio-host:resolve-input-device", async (event, value) => {
    if (!audioHostAllowed(event) || !audioHostSupervisor) {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }
    const deviceId = optionalDeviceIdSchema.safeParse(value)
    if (!deviceId.success) {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }
    try {
      return { ok: true as const, device: await audioHostSupervisor.resolveInputDevice(deviceId.data) }
    } catch {
      return { ok: false as const, error: "The native audio host is unavailable." }
    }
  })
  const nativeSessionFailure = (error?: NativeAudioHostCommandError) => ({
    ok: false as const,
    error: error
      ? `The native audio session rejected request ${error.requestType}.`
      : "The native audio session is unavailable.",
  })
  const sessionSupervisorFor = (event: Electron.IpcMainInvokeEvent) => (
    audioHostAllowed(event) ? audioHostSupervisor : undefined
  )
  const nativeSessionConfiguration = (
    value: z.infer<typeof nativeSessionConfigurationSchema>,
  ): NativeHostDeviceConfiguration => {
    return {
      deviceId: value.deviceId,
      sampleRateHz: value.sampleRateHz,
      maxFramesPerBlock: value.maxFramesPerBlock,
      channelCount: value.channelCount,
      revision: value.revision,
    }
  }
  const nativeSessionTransport = (
    value: z.infer<typeof nativeSessionTransportSchema>,
  ): NativeHostTransport => {
    return {
      epoch: value.epoch,
      running: value.running,
      frame: value.frame,
      bpm: value.bpm,
      timeSignatureNumerator: value.timeSignatureNumerator,
      timeSignatureDenominator: value.timeSignatureDenominator,
      cycleActive: value.cycleActive,
      cycleStartSec: value.cycleStartSec,
      cycleEndSec: value.cycleEndSec,
      transitionId: value.transitionId,
    }
  }
  const nativeSessionRecordingConfiguration = (
    value: z.infer<typeof nativeSessionRecordingConfigurationSchema>,
  ): NativeHostRecordingConfiguration => {
    return {
      deviceUid: value.deviceUid,
      generation: value.generation,
      sessionId: value.sessionId,
      channelCount: value.channelCount,
      inputChannels: value.inputChannels,
      gain: value.gain,
      polarity: value.polarity,
      punchStartFrame: value.punchStartFrame,
      punchEndFrame: value.punchEndFrame,
      monitoring: value.monitoring,
    }
  }
  const nativeSessionAsset = (
    value: z.infer<typeof nativeSessionAssetSchema>,
  ): NativeHostPcmAsset => {
    return {
      sessionAssetId: value.sessionAssetId,
      frameCount: value.frameCount,
      sampleRateHz: value.sampleRateHz,
      channelCount: value.channelCount,
      planarPcm: value.planarPcm,
      contentHashPrefix: value.contentHashPrefix,
    }
  }
  const nativeEditorAnchor = (
    event: Electron.IpcMainInvokeEvent,
    value: z.infer<typeof nativeEditorCommandSchema>,
  ): NativeVstEditorAnchor | null | undefined => {
    if (!value.anchor) return undefined
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)
    if (!ownerWindow) return null
    const contentBounds = ownerWindow.getContentBounds()
    const zoomFactor = event.sender.getZoomFactor()
    const x = Math.round(contentBounds.x + value.anchor.x * zoomFactor)
    const y = Math.round(contentBounds.y + value.anchor.y * zoomFactor)
    if (
      !Number.isSafeInteger(x)
      || !Number.isSafeInteger(y)
      || x < -0x8000_0000
      || x > 0x7fff_ffff
      || y < -0x8000_0000
      || y > 0x7fff_ffff
    ) return null
    return { x, y }
  }
  ipcMain.handle("daw:audio-host:session:configure", async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeConfigurationEnvelopeSchema.safeParse(value)
    if (!supervisor || !envelope.success) return nativeSessionFailure()
    const configuration = nativeSessionConfiguration(envelope.data.value)
    try {
      await supervisor.configure(configuration, envelope.data.transactionToken)
      return { ok: true as const }
    } catch (error) {
      return nativeSessionFailure(error instanceof NativeAudioHostCommandError ? error : undefined)
    }
  })
  ipcMain.handle("daw:audio-host:session:install-asset", async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeAssetEnvelopeSchema.safeParse(value)
    if (!supervisor || !envelope.success) return nativeSessionFailure()
    const asset = nativeSessionAsset(envelope.data.value)
    try {
      await supervisor.installAsset(asset, envelope.data.transactionToken)
      return { ok: true as const }
    } catch (error) {
      return nativeSessionFailure(error instanceof NativeAudioHostCommandError ? error : undefined)
    }
  })
  ipcMain.handle("daw:audio-host:session:release-asset", async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeAssetIdEnvelopeSchema.safeParse(value)
    if (!supervisor || !envelope.success) return nativeSessionFailure()
    try {
      await supervisor.releaseAsset(envelope.data.value, envelope.data.transactionToken)
      return { ok: true as const }
    } catch (error) {
      return nativeSessionFailure(error instanceof NativeAudioHostCommandError ? error : undefined)
    }
  })
  ipcMain.handle("daw:audio-host:session:detach-vst", async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeInstanceEnvelopeSchema.safeParse(value)
    if (!supervisor || !envelope.success) return nativeSessionFailure()
    try {
      await supervisor.detachVst(envelope.data.value, envelope.data.transactionToken)
      activeEditorProjectBindings.remove(envelope.data.value, envelope.data.transactionToken)
      return { ok: true as const }
    } catch (error) {
      return nativeSessionFailure(error instanceof NativeAudioHostCommandError ? error : undefined)
    }
  })
  ipcMain.handle("daw:audio-host:session:get-vst-state", async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const instanceId = uuidSchema.safeParse(value)
    if (!supervisor || !instanceId.success) return { ok: false as const, error: "The native VST state request is invalid." }
    try {
      const state = await supervisor.getVstState(instanceId.data)
      if (
        state.bytes.byteLength > 512 * 1024
        || !/^[a-f0-9]{64}$/.test(state.sha256)
        || createHash("sha256").update(state.bytes).digest("hex") !== state.sha256
      ) return { ok: false as const, error: "The native VST state response is invalid." }
      return { ok: true as const, bytes: state.bytes, sha256: state.sha256 }
    } catch (error) {
      return nativeSessionFailure(error instanceof NativeAudioHostCommandError ? error : undefined)
    }
  })
  ipcMain.handle("daw:audio-host:session:editor", async (event, rawValue) => {
    const envelope = nativeEditorEnvelopeSchema.safeParse(rawValue)
    const allowed = audioHostAllowed(event)
    const activeHostCandidate = allowed && audioHostSupervisor?.status().running
      ? audioHostSupervisor
      : undefined
    const manager = allowed ? nativeVst3EditorSessionManager : undefined
    if ((!manager && !activeHostCandidate) || !envelope.success) {
      return { ok: false as const, error: "The native VST editor command is invalid." }
    }
    const value = envelope.data.value
    const anchor = nativeEditorAnchor(event, value)
    if (anchor === null) {
      return { ok: false as const, error: "The native VST editor command is invalid." }
    }
    try {
      const editorCommand: NativeVstEditorCommand = value.command
      const projectId = value.projectId
      const command = {
        projectId,
        instanceId: value.instanceId,
        command: editorCommand,
        serializedPlan: value.serializedPlan,
        width: value.width,
        height: value.height,
        anchor,
      }
      // Prefer the isolated editor host. A plug-in editor can allocate UI or
      // runtime state outside the realtime graph, so its failure should remain
      // independent from playback whenever the isolated manager is available.
      if (manager) {
        const status = await manager.execute(command)
        return { ok: true as const, status }
      }
      if (activeHostCandidate) {
        try {
          if (activeHostCandidate.transactionOpen() && !envelope.data.transactionToken) {
            throw new Error("The native audio host transaction token is required.")
          }
          const boundProjectId = activeEditorProjectBindings.projectFor(command.instanceId)
          if (boundProjectId !== undefined && boundProjectId !== projectId) {
            throw new Error("The active native VST editor project binding changed.")
          }
          if (boundProjectId === undefined) throw new Error("The active native VST editor is not owned by a committed project binding.")
          const ownership = await activeHostCandidate.executeVstEditorCommand(
            nativeVstEditorOwnershipProbe(command.instanceId),
            envelope.data.transactionToken,
          )
          if (!ownership.owned) throw new Error("The active native VST editor is not owned by the committed project binding.")
          const { projectId: _projectId, ...nativeCommand } = command
          const status = command.command === "status"
            ? ownership
            : await activeHostCandidate.executeVstEditorCommand(nativeCommand, envelope.data.transactionToken)
          return { ok: true as const, status }
        } catch (error) {
          console.error("[native-vst3] editor active route failed", {
            error: sanitizeNativeVst3DiagnosticError(error instanceof Error ? error : undefined),
          })
          const diagnostics = await activeHostCandidate.diagnostics().catch(() => undefined)
          if (diagnostics?.state === "running" || !manager) throw error
        }
      }
      return { ok: false as const, error: "The native VST editor session is unavailable." }
    } catch (error) {
      console.error("[native-vst3] editor command failed", {
        error: sanitizeNativeVst3DiagnosticError(error instanceof Error ? error : undefined),
      })
      return {
        ok: false as const,
        error: sanitizeNativeVst3DiagnosticError(error instanceof Error ? error : undefined),
      }
    }
  })
  ipcMain.handle("daw:audio-host:session:coordinate-vst-attachments", async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeAttachmentEnvelopeSchema.safeParse(value)
    const workerPath = vst3WorkerPath
    if (
      !supervisor
      || !pluginCatalogStore
      || !workerPath
      || !envelope.success
    ) return nativeSessionFailure()
    const sessionValue = envelope.data.value
    const result = await coordinateNativeVst3Attachments({
      serializedPlan: sessionValue.serializedPlan,
      sampleRateHz: sessionValue.sampleRateHz,
      workerPath,
      catalogStore: pluginCatalogStore,
      audioHost: supervisor,
      transactionToken: envelope.data.transactionToken,
    })
    if (!result.ok) {
      activeEditorProjectBindings.rollback(envelope.data.transactionToken)
      return { ok: false as const, error: result.message }
    }
    try {
      const plan = decodeNativeExternalAttachmentPlan(sessionValue.serializedPlan)
      const projectId = projectIdSchemaV1.parse(sessionValue.projectId)
      activeEditorProjectBindings.stage(
        plan.attachments.map((attachment) => attachment.instanceId),
        projectId,
        envelope.data.transactionToken,
      )
      return { ok: true as const }
    } catch {
      activeEditorProjectBindings.rollback(envelope.data.transactionToken)
      return nativeSessionFailure()
    }
  })
  const registerNativeSessionBytes = (
    channel: string,
    operation: (supervisor: NonNullable<typeof audioHostSupervisor>, bytes: Uint8Array, transactionToken?: string) => Promise<void>,
  ) => ipcMain.handle(channel, async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeBytesEnvelopeSchema.safeParse(value)
    if (!supervisor || !envelope.success) return nativeSessionFailure()
    try {
      await operation(supervisor, envelope.data.value, envelope.data.transactionToken)
      return { ok: true as const }
    } catch (error) {
      return nativeSessionFailure(error instanceof NativeAudioHostCommandError ? error : undefined)
    }
  })
  registerNativeSessionBytes("daw:audio-host:session:publish-graph", (supervisor, bytes, transactionToken) => supervisor.publishGraph(bytes, transactionToken))
  registerNativeSessionBytes("daw:audio-host:session:configure-instrument-states", (supervisor, bytes, transactionToken) => supervisor.configureInstrumentStates(bytes, transactionToken))
  registerNativeSessionBytes("daw:audio-host:session:queue-parameter-events", (supervisor, bytes, transactionToken) => supervisor.queueParameterEvents(bytes, transactionToken))
  registerNativeSessionBytes("daw:audio-host:session:queue-processor-state-patch", (supervisor, bytes, transactionToken) => supervisor.queueProcessorStatePatch(bytes, transactionToken))
  registerNativeSessionBytes("daw:audio-host:session:queue-vst-parameter-events", (supervisor, bytes, transactionToken) => supervisor.queueVstParameterEvents(bytes, transactionToken))
  registerNativeSessionBytes("daw:audio-host:session:queue-instrument-events", (supervisor, bytes, transactionToken) => supervisor.queueInstrumentEvents(bytes, transactionToken))
  registerNativeSessionBytes("daw:audio-host:session:queue-schedule-window", (supervisor, bytes, transactionToken) => supervisor.queueScheduleWindow(bytes, transactionToken))
  registerNativeSessionBytes("daw:audio-host:session:reenable-vst-schedule-automation", (supervisor, bytes, transactionToken) => supervisor.reenableVstScheduleAutomation(bytes, transactionToken))
  registerNativeSessionBytes("daw:audio-host:session:queue-source-events", (supervisor, bytes, transactionToken) => supervisor.queueSourceEvents(bytes, transactionToken))
  ipcMain.handle("daw:audio-host:session:set-spectrum-node", async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeSpectrumNodeEnvelopeSchema.safeParse(value)
    if (!supervisor || !envelope.success || envelope.data.transactionToken !== undefined) return nativeSessionFailure()
    try {
      await supervisor.setSpectrumNode(envelope.data.value)
      return { ok: true as const }
    } catch {
      return nativeSessionFailure()
    }
  })
  ipcMain.handle("daw:audio-host:session:set-transport", async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeTransportEnvelopeSchema.safeParse(value)
    if (!supervisor || !envelope.success) return nativeSessionFailure()
    const transport = nativeSessionTransport(envelope.data.value)
    try {
      await supervisor.setTransport(transport, envelope.data.transactionToken)
      return { ok: true as const }
    } catch {
      return nativeSessionFailure()
    }
  })
  ipcMain.handle("daw:audio-host:session:configure-recording", async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const request = nativeSessionRecordingConfigurationSchema.safeParse(value)
    if (!supervisor || !request.success) return nativeSessionFailure()
    const configuration = nativeSessionRecordingConfiguration(request.data)
    try {
      await supervisor.configureRecording(configuration)
      return { ok: true as const }
    } catch {
      return nativeSessionFailure()
    }
  })
  ipcMain.handle("daw:audio-host:session:stop-recording", async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const endFrame = z.number().int().safe().min(0).optional().safeParse(value)
    if (!supervisor || !endFrame.success) return nativeSessionFailure()
    try {
      await supervisor.stopRecording(endFrame.data)
      return { ok: true as const }
    } catch {
      return nativeSessionFailure()
    }
  })
  const registerNativeSessionControl = (
    channel: string,
    operation: (supervisor: NonNullable<typeof audioHostSupervisor>) => Promise<void>,
  ) => ipcMain.handle(channel, async (event) => {
    const supervisor = sessionSupervisorFor(event)
    if (!supervisor) return nativeSessionFailure()
    try {
      await operation(supervisor)
      return { ok: true as const }
    } catch {
      return nativeSessionFailure()
    }
  })
  ipcMain.handle("daw:audio-host:session:begin-transaction", async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    if (!supervisor || !nativeUndefinedEnvelopeSchema.safeParse(value).success) return nativeSessionFailure()
    try {
      const transactionToken = await supervisor.beginTransaction()
      activeEditorProjectBindings.stageEmpty(transactionToken)
      return { ok: true as const, transactionToken }
    } catch {
      return nativeSessionFailure()
    }
  })
  ipcMain.handle("daw:audio-host:session:commit-transaction", async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeUndefinedEnvelopeSchema.safeParse(value)
    if (!supervisor || !envelope.success || !envelope.data.transactionToken) return nativeSessionFailure()
    try {
      await supervisor.commitTransaction(envelope.data.transactionToken)
      activeEditorProjectBindings.commit(envelope.data.transactionToken)
      return { ok: true as const }
    } catch {
      activeEditorProjectBindings.rollback(envelope.data.transactionToken)
      return nativeSessionFailure()
    }
  })
  ipcMain.handle("daw:audio-host:session:rollback-transaction", async (event, value) => {
    const supervisor = sessionSupervisorFor(event)
    const envelope = nativeUndefinedEnvelopeSchema.safeParse(value)
    if (!supervisor || !envelope.success || !envelope.data.transactionToken) return nativeSessionFailure()
    try {
      await supervisor.rollbackTransaction(envelope.data.transactionToken)
      return { ok: true as const }
    } catch {
      return nativeSessionFailure()
    } finally {
      activeEditorProjectBindings.rollback(envelope.data.transactionToken)
    }
  })
  registerNativeSessionControl("daw:audio-host:session:start", (supervisor) => supervisor.startAudio())
  registerNativeSessionControl("daw:audio-host:session:stop", (supervisor) => supervisor.stopAudio())
  registerNativeSessionControl("daw:audio-host:session:start-recording", (supervisor) => supervisor.startRecording())
  registerNativeSessionControl("daw:audio-host:session:cancel-recording", (supervisor) => supervisor.cancelRecording())
  ipcMain.handle("daw:audio-host:session:teardown", async (event) => {
    const supervisor = sessionSupervisorFor(event)
    if (!supervisor) return nativeSessionFailure()
    try {
      await supervisor.teardown()
      activeEditorProjectBindings.clear()
      return { ok: true as const }
    } catch {
      activeEditorProjectBindings.clear()
      return nativeSessionFailure()
    }
  })
  ipcMain.handle("daw:plugin-catalog:read", async (event) => {
    const store = catalogStoreFor(event)
    if (!store) return catalogFailure("The desktop plug-in catalog is unavailable.")
    try {
      return { ok: true, catalog: catalogViewForRenderer(await store.load()) }
    } catch {
      return catalogFailure("The plug-in catalog could not be read.")
    }
  })
  ipcMain.handle("daw:plugin-catalog:choose-directory", async (event) => {
    const store = catalogStoreFor(event)
    const currentWindow = window_
    if (!store || !currentWindow) return catalogFailure("The desktop plug-in catalog is unavailable.")
    const selection = await dialog.showOpenDialog(currentWindow, { properties: ["openDirectory", "createDirectory"] })
    if (selection.canceled || selection.filePaths.length !== 1) return { ok: true, canceled: true }
    try {
      return { ok: true, canceled: false, catalog: catalogViewForRenderer(await store.addDirectory(selection.filePaths[0])) }
    } catch {
      return catalogFailure("The selected plug-in directory could not be added.")
    }
  })
  ipcMain.handle("daw:plugin-catalog:remove-directory", async (event, value) => {
    const store = catalogStoreFor(event)
    if (!store) return catalogFailure("The desktop plug-in catalog is unavailable.")
    const request = pluginDirectorySchema.safeParse(value)
    if (!request.success) return catalogFailure("A plug-in directory is required.")
    try {
      return { ok: true, catalog: catalogViewForRenderer(await store.removeDirectory(request.data.directory)) }
    } catch {
      return catalogFailure("The plug-in directory could not be removed.")
    }
  })
  ipcMain.handle("daw:plugin-catalog:scan", async (event) => {
    const store = catalogStoreFor(event)
    const scanner = vst3ScannerSupervisor
    if (!store || !scanner) return catalogFailure("The desktop plug-in catalog is unavailable.")
    try {
      const catalog = await store.load()
      return { ok: true, catalog: catalogViewForRenderer(await store.scan((entry) => scanner.scan(entry, catalog.directories))) }
    } catch {
      return catalogFailure("The plug-in catalog could not be scanned.")
    }
  })
  ipcMain.handle("daw:plugin-catalog:preflight-insertion", async (event, value) => {
    const store = catalogStoreFor(event)
    const request = nativeVst3InsertionPreflightRequestSchema.safeParse(value)
    const workerPath = vst3WorkerPath
    if (!store || !request.success) {
      return { ok: false as const, code: "untrusted-catalog" as const, message: "The native VST3 insertion request is invalid." }
    }
    if (!audioHostAllowed(event) || !audioHostPath || !workerPath) {
      return { ok: false as const, code: "host-unavailable" as const, message: "The native VST3 host is unavailable." }
    }
    try {
      const device = await probeNativeAudioOutputDevice(audioHostPath)
      if (!device?.available) {
        return { ok: false as const, code: "host-unavailable" as const, message: "No native audio output device is available." }
      }
      return await preflightVst3Insertion({
        request: request.data,
        catalog: await store.load(),
        workerPath,
        sampleRateHz: device.nominalSampleRateHz,
      })
    } catch {
      return { ok: false as const, code: "host-unavailable" as const, message: "The native VST3 host preflight failed." }
    }
  })
  ipcMain.handle("daw:export:pick-output-file", async (event, value) => {
    if (!scopeAllowed(event)) throw new Error("Invalid export output picker request.")
    const request = outputFilePickerSchema.safeParse(value)
    const scope = request.success ? scopeFor(event, request.data.requestId) : undefined
    if (!scope || !request.success) throw new Error("Invalid export output picker request.")
    const selected = await fileCapabilities.pickOutputFile(scope, request.data.format)
    if (selected.canceled) return selected
    return { canceled: false as const, file: { token: selected.file.token, basename: selected.file.basename } }
  })
  ipcMain.handle("daw:export:pick-output-directory", async (event, value) => {
    if (!scopeAllowed(event)) throw new Error("Invalid export output picker request.")
    const request = exactIpcScopeSchema.safeParse(value)
    const scope = request.success ? scopeFor(event, request.data.requestId) : undefined
    if (!scope) throw new Error("Invalid export output picker request.")
    const selected = await fileCapabilities.pickDirectory(scope)
    if (selected.canceled) return selected
    return { canceled: false as const, directory: { token: selected.directory.token, basename: selected.directory.basename } }
  })
  ipcMain.handle("daw:export:release-output", async (event, value) => {
    if (!scopeAllowed(event)) throw new Error("Invalid export output release request.")
    const request = exactIpcScopeSchema.safeParse(value)
    const scope = request.success ? scopeFor(event, request.data.requestId) : undefined
    if (!scope) throw new Error("Invalid export output release request.")
    await fileCapabilities.revokeRequest(scope)
  })
  ipcMain.handle("daw:capability:readChunk", async (event, value) => {
    if (!scopeAllowed(event)) throw new Error("Invalid capability request.")
    const request = capabilityReadSchema.safeParse(value)
    const scope = request.success ? scopeFor(event, request.data.requestId) : undefined
    if (!scope || !request.success) throw new Error("Invalid capability request.")
    return fileCapabilities.readFile(scope, request.data.token)
  })
  ipcMain.handle("daw:capability:beginWrite", async (event, value) => {
    if (!scopeAllowed(event)) throw new Error("Invalid capability request.")
    const request = capabilityBeginWriteSchema.safeParse(value)
    const scope = request.success ? scopeFor(event, request.data.requestId) : undefined
    if (!scope || !request.success) throw new Error("Invalid capability request.")
    return fileCapabilities.beginWrite(scope, request.data.token, request.data.relativePath)
  })
  ipcMain.handle("daw:capability:writeChunk", async (event, value) => {
    if (!scopeAllowed(event)) throw new Error("Invalid capability request.")
    const request = capabilityWriteChunkSchema.safeParse(value)
    const scope = request.success ? scopeFor(event, request.data.requestId) : undefined
    if (!scope || !request.success) throw new Error("Invalid capability request.")
    return fileCapabilities.writeChunk(
      scope,
      request.data.writerId,
      request.data.offset,
      request.data.chunk,
    )
  })
  ipcMain.handle("daw:capability:commit", async (event, value) => {
    if (!scopeAllowed(event)) throw new Error("Invalid capability request.")
    const request = capabilityWriterSchema.safeParse(value)
    const scope = request.success ? scopeFor(event, request.data.requestId) : undefined
    if (!scope || !request.success) throw new Error("Invalid capability request.")
    return fileCapabilities.commitWrite(scope, request.data.writerId)
  })
  ipcMain.handle("daw:capability:abort", async (event, value) => {
    if (!scopeAllowed(event)) throw new Error("Invalid capability request.")
    const request = capabilityWriterSchema.safeParse(value)
    const scope = request.success ? scopeFor(event, request.data.requestId) : undefined
    if (!scope || !request.success) throw new Error("Invalid capability request.")
    await fileCapabilities.abortWrite(scope, request.data.writerId)
  })
}

const createWindow = () => {
  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL && !existsSync(preloadPath)) {
    throw new Error(`Desktop preload bundle is missing: ${preloadPath}`)
  }
  window_ = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  window_.webContents.on("did-start-navigation", () => {
    abortOfflineRenderJobs()
    applicationMenuController.reset()
    preparationRegistry.abortAll()
    settleCapabilityRevocation(fileCapabilities.revokeRendererGeneration(generation))
    generation += 1
    rejectRendererPending("Renderer reloaded.")
  })
  window_.webContents.on("render-process-gone", () => {
    abortOfflineRenderJobs()
    applicationMenuController.reset()
    preparationRegistry.abortAll()
    settleCapabilityRevocation(fileCapabilities.revokeRendererGeneration(generation))
    generation += 1
    rejectRendererPending("Renderer crashed.")
  })
  window_.webContents.setWindowOpenHandler(({ url }) => {
    if (externalUrl(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  window_.webContents.on("will-navigate", (event, url) => {
    if (!sameAppOrigin(url)) event.preventDefault()
  })
  const close = createCloseHandler({
    prepare: async () => {
      try {
        const reply = await renderRequest("lifecycle.prepareToClose", {}, randomUUID(), 10_000)
        return closePreparationResultSchema.safeParse(reply.result).success
      } catch {
        return false
      }
    },
    confirmDiscard: async () => {
      const choice = await dialog.showMessageBox(window_!, {
        type: "warning",
        buttons: ["Cancel", "Quit and Discard"],
        defaultId: 0,
        cancelId: 0,
        message: "The project could not finish saving before closing.",
        detail: "Cancel keeps the project open. Quit and Discard closes without waiting for recording finalization or pending writes.",
        noLink: true,
      })
      return choice.response === 1
    },
    destroy: () => window_?.destroy(),
    finishQuit,
  })
  window_.on("close", (event) => {
    if (window_?.isDestroyed() || finishingQuit) return
    event.preventDefault()
    void close()
  })
  void window_.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL ?? "daw://app/")
}

app.setName(appName)
const finishQuit = async () => {
  if (finishingQuit) return
  finishingQuit = true
  preparationRegistry.abortAll()
  rejectRendererPending("Application is closing.")
  activeEditorProjectBindings.clear()
  await fileCapabilities.revokeAll()
  await nativeVst3EditorSessionManager?.teardownAll()
  await audioHostSupervisor?.teardown()
  powerMonitor.removeAllListeners("suspend")
  powerMonitor.removeAllListeners("resume")
  removeAudioHostLossListener?.()
  removeAudioHostRecordingBlockListener?.()
  removeAudioHostRecordingStatusListener?.()
  removeAudioHostMeterBatchListener?.()
  removeAudioHostSpectrumListener?.()
  removeAudioHostScheduleProgressListener?.()
  removeAudioHostWorkerNotificationListener?.()
  await closeSocket()
  app.exit()
}
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
else {
  app.on("second-instance", () => {
    window_?.show()
    window_?.focus()
  })
  app.whenReady().then(async () => {
    nativeMediaAvailable = await nativeFileCapabilityHelper.selfTest()
    let scannerPath: string | undefined
    if (process.platform === "darwin" && app.isPackaged) {
      const manifestPath = path.join(process.resourcesPath, nativeReleaseArtifactManifestName)
      if (existsSync(manifestPath)) {
        try {
          const artifacts = await verifyPackagedNativeReleaseArtifacts(process.resourcesPath)
          scannerPath = artifacts.scannerPath
          vst3WorkerPath = artifacts.workerPath
          audioHostPath = artifacts.audioHostPath
          nativeReleaseArtifactVerification = { status: "verified" }
        } catch (error) {
          nativeReleaseArtifactVerification = {
            status: "failed",
            reason: error instanceof Error ? error.message : "Native release artifact verification failed.",
          }
        }
      }
    } else if (process.platform === "darwin") {
      scannerPath = packagedVst3ScannerPath(process.resourcesPath, false, process.env.DAW_VST3_SCANNER_PATH)
      vst3WorkerPath = packagedVst3WorkerPath(process.resourcesPath, false, process.env.DAW_VST3_WORKER_PATH)
      audioHostPath = packagedAudioHostPath(process.resourcesPath, false, process.env.DAW_AUDIO_HOST_PATH)
      nativeReleaseArtifactVerification = { status: "development" }
    }
    vst3ScannerSupervisor = scannerPath ? createVst3ScannerSupervisor({
      platform: process.platform,
      arch: process.arch,
      scannerPath,
    }) : undefined
    pluginCatalogStore = createPluginCatalogStore({
      filePath: path.join(app.getPath("userData"), "plugin-catalog-v1.json"),
    })
    audioHostSupervisor = audioHostPath ? createNativeAudioHostSupervisor(audioHostPath) : undefined
    const sendVstParameterEdit = (input: {
      projectId: string
      source: "active-playback" | "editor-session"
      instanceId: string
      parameterId: number
      normalizedValue: number
    }) => {
      const target = window_?.webContents
      if (!target || target.isDestroyed() || !sameAppOrigin(target.getURL())) return
      target.send("daw:audio-host:vst-parameter-edit", input)
    }
    removeAudioHostWorkerNotificationListener = audioHostSupervisor?.onWorkerNotification((notification) => {
      if (notification.kind !== "parameter-edit") return
      const projectId = activeEditorProjectBindings.projectFor(notification.instanceId)
      if (!projectId) return
      sendVstParameterEdit({
        projectId,
        source: "active-playback",
        instanceId: notification.instanceId,
        parameterId: notification.parameterId,
        normalizedValue: notification.normalizedValue,
      })
    })
    const editorHostPath = audioHostPath
    nativeVst3EditorSessionManager = editorHostPath && vst3WorkerPath
      ? createNativeVst3EditorSessionManager({
        workerPath: vst3WorkerPath,
        catalogStore: pluginCatalogStore,
        createSupervisor: () => createNativeAudioHostSupervisor(editorHostPath),
        onEditorInteraction: () => {
          const target = window_
          if (!target || target.isDestroyed() || finishingQuit) return
          target.show()
          app.focus({ steal: true })
          target.focus()
        },
        onEditorOpenState: (input) => {
          const target = window_?.webContents
          if (!target || target.isDestroyed() || !sameAppOrigin(target.getURL())) return
          target.send("daw:audio-host:vst-editor-state", input)
        },
        onParameterEdit: (input) => sendVstParameterEdit({
          projectId: input.projectId,
          source: "editor-session",
          instanceId: input.instanceId,
          parameterId: input.parameterId,
          normalizedValue: input.normalizedValue,
        }),
      })
      : undefined
    const handleSuspend = () => {
      if (finishingQuit || (audioLifecycle.state === "suspended" && audioRecoveryGeneration === undefined)) return
      audioRecoveryGeneration = undefined
      audioLifecycle = { state: "suspended", powerGeneration: audioLifecycle.powerGeneration + 1 }
      publishAudioLifecycle()
      audioSuspendPromise = Promise.allSettled([
        audioHostSupervisor?.suspend(),
        nativeVst3EditorSessionManager?.suspendAll(),
      ]).then(() => undefined)
    }
    const handleResume = () => {
      if (finishingQuit || audioLifecycle.state !== "suspended") return
      audioLifecycle = { state: "suspended", powerGeneration: audioLifecycle.powerGeneration + 1 }
      const recoveryGeneration = audioLifecycle.powerGeneration
      recoverAudioHost(recoveryGeneration)
    }
    powerMonitor.on("suspend", handleSuspend)
    powerMonitor.on("resume", handleResume)
    removeAudioHostLossListener = audioHostSupervisor?.onLoss((error) => {
      activeEditorProjectBindings.clear()
      const target = window_?.webContents
      if (target && !target.isDestroyed() && sameAppOrigin(target.getURL())) {
        target.send("daw:audio-host:loss", sanitizeNativeVst3DiagnosticError(error))
      }
    })
    removeAudioHostRecordingBlockListener = audioHostSupervisor?.onRecordingBlock((block) => {
      const target = window_?.webContents
      if (target && !target.isDestroyed() && sameAppOrigin(target.getURL())) {
        target.send("daw:audio-host:recording-block", block)
      }
    })
    removeAudioHostRecordingStatusListener = audioHostSupervisor?.onRecordingStatus((status) => {
      const target = window_?.webContents
      if (target && !target.isDestroyed() && sameAppOrigin(target.getURL())) {
        target.send("daw:audio-host:recording-status", status)
      }
    })
    removeAudioHostMeterBatchListener = audioHostSupervisor?.onMeterBatch((batch: NativeHostMeterBatch) => {
      const target = window_?.webContents
      if (target && !target.isDestroyed() && sameAppOrigin(target.getURL())) {
        target.send("daw:audio-host:meter-batch", batch)
      }
    })
    removeAudioHostSpectrumListener = audioHostSupervisor?.onSpectrumFrame((frame) => {
      const target = window_?.webContents
      if (target && !target.isDestroyed() && sameAppOrigin(target.getURL())) {
        target.send("daw:audio-host:spectrum-frame", frame)
      }
    })
    removeAudioHostScheduleProgressListener = audioHostSupervisor?.onScheduleProgress((progress: NativeScheduleProgress) => {
      const target = window_?.webContents
      if (target && !target.isDestroyed() && sameAppOrigin(target.getURL())) {
        target.send("daw:audio-host:schedule-progress", progress)
      }
    })
    protocol.handle("daw", (request) => {
      const rendererRoot = MAIN_WINDOW_VITE_DEV_SERVER_URL
        ? path.join(import.meta.dirname, "../renderer/main_window")
        : packagedRendererRoot(app.getAppPath())
      const safePath = rendererAssetPath(rendererRoot, request.url)
      if (!safePath || !existsSync(safePath)) return new Response("Not found", { status: 404 })
      return electronNet.fetch(pathToFileURL(safePath).toString())
    })
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [createContentSecurityPolicy(Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL))],
      },
    }))
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => callback(
      (
        allowsTrustedAudioCapturePermission({
          permission,
          requestingUrl: details.requestingUrl,
          mediaTypes: "mediaTypes" in details ? details.mediaTypes : undefined,
        }, sameAppOrigin)
      )
      || allowsTrustedMidiPermission({
        permission,
        trustedRendererId: window_?.webContents.id,
        requestingRendererId: webContents.id,
        requestingUrl: details.requestingUrl,
        isMainFrame: details.isMainFrame,
      }, sameAppOrigin),
    ))
    session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
      (
        webContents !== null
        && allowsTrustedAudioCapturePermission({
          permission,
          requestingUrl: requestingOrigin,
          mediaTypes: details.mediaType === "audio" ? ["audio"] : undefined,
        }, sameAppOrigin)
      )
      || allowsTrustedMidiPermission({
        permission,
        trustedRendererId: window_?.webContents.id,
        requestingRendererId: webContents?.id,
        requestingUrl: requestingOrigin,
        isMainFrame: details.isMainFrame,
      }, sameAppOrigin))
    registerIpc()
    applicationMenuController.install({
      buildFromTemplate: (template) => Menu.buildFromTemplate(template),
      setApplicationMenu: (menu) => Menu.setApplicationMenu(menu),
    })
    await startSocket()
    createWindow()
  }).catch((error) => {
    console.error("[desktop] startup failed", error)
    app.quit()
  })
  app.on("before-quit", (event) => {
    if (finishingQuit) return
    event.preventDefault()
    if (window_ && !window_.isDestroyed()) window_.close()
    else void finishQuit()
  })
  app.on("window-all-closed", () => void finishQuit())
}
