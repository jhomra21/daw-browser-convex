import { sha256HexPattern, unsigned32Max, unsigned64Max } from "@daw-browser/desktop-protocol/wire-patterns"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { access } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"
import {
  decodeDiagnostics,
  decodeGraphRevisionStatus,
  decodeMeterBatch,
  decodeScheduleProgress,
  decodeSpectrumFrame,
  decodeVstEditorStatus,
  decodeInputDevice,
  decodeDeviceInventory,
  decodeNativeProcessorPatchStatus,
  decodeOutputDevice,
  decodeRecordingStatus,
  decodeWorkerNotification,
  isCompatibleAudioHostHello,
  readResponse,
  type AudioHostHello,
  type NativeMainRecordingStatus,
  type NativeWorkerNotification,
} from "./native-host-frame-decoders"
import {
  coreAudioDeviceId,
  encodeOfflineConfigure,
  encodeOfflineStart,
  nativeBinaryPayload,
  serializeAssetInstall,
  serializeDeviceConfiguration,
  serializeRecordingConfiguration,
  serializeTransport,
  serializeVstAttachment,
  serializeVstEditor,
  serializeVstInstanceId,
  unsigned32,
  writeUnsigned32,
  type NativeRecordingSpoolConfiguration,
  type NativeVstEditorAnchor,
  type NativeVstEditorCommand,
  type ResolvedVst3Attachment,
} from "./native-host-frame-encoders"
import type { HostEvidence } from "./ae08-evidence"
import {
  NativeAudioHostNotSentError,
  createNativeRequestBroker,
  encodeNativeAudioHostControlFrame,
  nativeAudioHostRequestName,
  type NativeControlPayload,
  type NativeHostRequestType,
  type NativeVstEditorStatus,
  type QueuedRequest,
} from "./native-request-broker"

import { defaultDecodedAudioPageFrames } from "@daw-browser/audio-engine/media-pages"
import { maxVst3WorkerStateBytes } from "@daw-browser/plugin-host-protocol"
import {
  nativeAudioHostControlTypes,
  nativeAudioHostSpoolStates,
  nativeAudioHostFrameHeaderBytes as headerBytes,
  nativeAudioHostMagic as magic,
  nativeAudioHostMaximumAssetChannels as maximumAssetChannels,
  nativeAudioHostMaximumPayloadBytes as maximumPayloadBytes,
  nativeAudioHostMaximumVstStringBytes as maximumVstStringBytes,
  nativeAudioHostProtocolVersion as protocolVersion,
  nativeAudioHostAckStatus,
  nativeOfflineRenderPlanSchema,
} from "@daw-browser/desktop-protocol/native-audio-host"
import type {
  NativeHostDeviceConfiguration,
  NativeHostDiagnostics,
  NativeHostRecordingConfiguration,
  NativeHostRecordingStatus,
  NativeHostMeterBatch,
  NativeHostSpectrumFrame,
  NativeScheduleProgress,
  NativeProcessorPatchStatus,
  NativeOutputDevice,
  NativeHostPcmAsset,
  NativeHostMappedAsset,
  NativeHostMappedAssetPage,
  NativeOfflineMappedAsset,
  NativeOfflineRenderPlan,
  NativeOfflinePcmChunk,
  NativeHostTransport,
  NativeInputDevice,
  NativeAudioDevice,
} from "@daw-browser/audio-engine/native-host-wire"
import { serializeNativeSpectrumSelection } from "@daw-browser/audio-engine/native-host-wire"

export const nativeHostConfigurationIdentityFor = (
  previous: { pid: number; generation: number; configurationGeneration: number } | undefined,
  host: { pid?: number; generation: number },
) => {
  if (host.pid === undefined) return undefined

  if (previous?.pid === host.pid && previous.generation === host.generation) return previous

  return { pid: host.pid, generation: host.generation, configurationGeneration: 0 }
}

const {
  hostHello: hostHelloType,
  hostCapabilities: hostCapabilitiesType,
  deviceConfigure: deviceConfigureType,
  graphSnapshot: graphSnapshotType,
  assetInstall: assetInstallType,
  assetRelease: assetReleaseType,
  mappedAssetCreate: mappedAssetCreateType,
  mappedAssetWritePage: mappedAssetWritePageType,
  mappedAssetPrepareRange: mappedAssetPrepareRangeType,
  mappedAssetRelease: mappedAssetReleaseType,
  transport: transportType,
  parameterEvents: parameterEventsType,
  midiEvents: midiEventsType,
  vstAttach: vstAttachType,
  vstDetach: vstDetachType,
  diagnostics: diagnosticsType,
  ack: ackType,
  notification: notificationType,
  start: startType,
  stop: stopType,
  teardown: teardownType,
  sourceEvents: sourceEventsType,
  deviceList: deviceListType,
  transactionBegin: transactionBeginType,
  transactionCommit: transactionCommitType,
  transactionRollback: transactionRollbackType,
  vstParameterEvents: vstParameterEventsType,
  vstStateGet: vstStateGetType,
  vstState: vstStateType,
  recordingConfigure: recordingConfigureType,
  recordingStart: recordingStartType,
  recordingStop: recordingStopType,
  recordingCancel: recordingCancelType,
  recordingBlock: recordingBlockType,
  recordingStatus: recordingStatusType,
  recordingDeviceQuery: recordingDeviceQueryType,
  recordingDeviceList: recordingDeviceListType,
  deviceInventoryQuery: deviceInventoryQueryType,
  deviceInventory: deviceInventoryType,
  graphPrepare: graphPrepareType,
  graphPublish: graphPublishType,
  graphRetire: graphRetireType,
  graphRollback: graphRollbackType,
  graphRevisionStatus: graphRevisionStatusType,
  vstEditor: vstEditorType,
  vstEditorStatus: vstEditorStatusType,
  diagnosticStart: diagnosticStartType,
  meterBatch: meterBatchType,
  spectrumSelection: spectrumSelectionType,
  spectrumFrame: spectrumFrameType,
  processorStatePatch: processorStatePatchType,
  processorStatePatchStatus: processorStatePatchStatusType,
  offlineConfigure: offlineConfigureType,
  offlineStart: offlineStartType,
  offlinePcmChunk: offlinePcmChunkType,
  offlineComplete: offlineCompleteType,
  offlineError: offlineErrorType,
  scheduleWindow: scheduleWindowType,
  scheduleProgress: scheduleProgressType,
  vstScheduleAutomationEnable: vstScheduleAutomationEnableType,
  instrumentStates: instrumentStatesType,
} = nativeAudioHostControlTypes

const maximumOfflineStderrBytes = 16 * 1024
const maximumOfflineQueuedFrames = 4
const nativeOfflineStageTimeoutMs = 10_000
const nativeOfflineCompletionInactivityTimeoutMs = 10_000

export const isNativeOfflineTelemetryFrame = (frameType: number) => (
  frameType === notificationType
  || frameType === meterBatchType
  || frameType === scheduleProgressType
)

export type { NativeGraphRevisionStatus } from "@daw-browser/desktop-protocol/native-revision"

import type { NativeGraphRevisionStatus } from "@daw-browser/desktop-protocol/native-revision"
import { bestEffort } from "@daw-browser/shared"

type NativeVstEditorOwnershipProbe = {
  instanceId: string
  command: "status"
}

type NativeAudioHostTerminationTimers = {
  graceful?: ReturnType<typeof setTimeout>
  sigterm?: ReturnType<typeof setTimeout>
  killObservation?: ReturnType<typeof setTimeout>
}

export const nativeVstEditorOwnershipProbe = (instanceId: string): NativeVstEditorOwnershipProbe => ({
  instanceId,
  command: "status",
})

export class NativeAudioHostCommandError extends Error {
  readonly requestType: number
  readonly requestName: string
  readonly recoverable = true
  /** From the ACK status word: `unavailable` means no audio session or core existed, not that native said no. */
  readonly reason: "refused" | "unavailable"
  /** Bounded native text that may cross to the renderer; only requests whose text is written for users carry it. */
  readonly detail: string | undefined

  constructor(
    requestType: number,
    message = `The native audio host rejected control request ${requestType}.`,
    reason: "refused" | "unavailable" = "refused",
  ) {
    super(message)
    this.name = "NativeAudioHostCommandError"
    this.reason = reason
    this.requestType = requestType
    this.requestName = nativeAudioHostRequestName(requestType)
    this.detail = this.requestName === "instrumentStates" ? message.slice(0, 256) : undefined
  }
}

export class NativeRecordingConfigureError extends Error {
  readonly phase: "request" | "readiness"
  constructor(phase: "request" | "readiness", error: Error) {
    super(error.message, { cause: error })
    this.name = "NativeRecordingConfigureError"
    this.phase = phase
  }
}

type NativeOfflineWaitStage =
  | "host handshake"
  | "offline configuration"
  | "asset installation"
  | "VST attachment"
  | "graph snapshot"
  | "instrument state"
  | "transport"
  | "schedule window"
  | "offline start"
  | "mapped asset creation"
  | "mapped asset page"
  | "mapped asset range"
  | "offline completion"

class NativeOfflineRenderTimeoutError extends Error {
  readonly stage: NativeOfflineWaitStage

  constructor(stage: NativeOfflineWaitStage) {
    super(`The native offline renderer timed out during ${stage}.`)
    this.name = "NativeOfflineRenderTimeoutError"
    this.stage = stage
  }
}

type NativeOfflineStdoutPumpInput = {
  onFrame: (frame: Buffer) => void
  onPcmFrame: (frame: Buffer) => Promise<void>
  isPcmFrame: (frame: Buffer) => boolean
  onError: (error: Error) => void
  pause: () => void
  resume: () => void
}

type NativeOfflineMappedPageRequest = {
  jobId: string
  requestId: string
  asset: NativeOfflineMappedAsset
  startFrame: number
  frameCount: number
}

export const createNativeOfflineStdoutPump = (input: NativeOfflineStdoutPumpInput) => {
  let buffer = Buffer.alloc(0)
  let maximumBufferedBytes = 0
  let sinkBusy = false
  let stopped = false
  let pumping = false

  const pump = () => {
    if (stopped || sinkBusy || pumping) return
    pumping = true

    try {
      while (!stopped && !sinkBusy && buffer.byteLength >= headerBytes) {
        const payloadBytes = buffer.readUInt32BE(12)

        if (payloadBytes > maximumPayloadBytes) {
          stopped = true
          input.onError(new Error("The native offline renderer returned an oversized frame."))

          return
        }

        if (buffer.byteLength < headerBytes + payloadBytes) return
        const frame = buffer.subarray(0, headerBytes + payloadBytes)
        buffer = buffer.subarray(frame.byteLength)

        if (frame.readUInt32BE(0) !== magic || frame.readUInt32BE(4) !== protocolVersion) {
          stopped = true
          input.onError(new Error("The native offline renderer returned an invalid frame."))

          return
        }

        if (!input.isPcmFrame(frame)) {
          input.onFrame(frame)
          continue
        }

        sinkBusy = true
        input.pause()
        void Promise.resolve().then(() => input.onPcmFrame(frame)).then(
          () => {
            sinkBusy = false

            if (stopped) return
            pump()

            if (!sinkBusy && !stopped) input.resume()
          },
          (error) => {
            stopped = true
            sinkBusy = false
            input.onError(error instanceof Error ? error : new Error("The native offline PCM sink failed."))
          },
        )
      }
    } finally {
      pumping = false
    }
  }

  return {
    push(chunk: Buffer) {
      if (stopped) return
      buffer = Buffer.concat([buffer, chunk])
      pump()
      maximumBufferedBytes = Math.max(maximumBufferedBytes, buffer.byteLength)
    },
    stop() {
      stopped = true
    },
    bufferedBytes: () => buffer.byteLength,
    maximumBufferedBytes: () => maximumBufferedBytes,
    sinkBusy: () => sinkBusy,
  }
}

export const createNativeOfflineFrameMailbox = () => {
  const frames: Buffer[] = []
  let terminalError: Error | undefined
  let closedError: Error | undefined
  let resolveNext: ((frame: Buffer) => void) | undefined
  let rejectNext: ((error: Error) => void) | undefined

  const rejectPending = (error: Error) => {
    const reject = rejectNext
    resolveNext = undefined
    rejectNext = undefined
    reject?.(error)
  }

  return {
    push(frame: Buffer) {
      if (terminalError || closedError) return true
      const resolve = resolveNext
      resolveNext = undefined
      rejectNext = undefined

      if (resolve) {
        resolve(frame)

        return true
      }

      if (frames.length >= maximumOfflineQueuedFrames) return false
      frames.push(frame)

      return true
    },
    next() {
      if (terminalError) return Promise.reject<Buffer>(terminalError)

      if (closedError) return Promise.reject<Buffer>(closedError)
      const queued = frames.shift()

      if (queued) return Promise.resolve(queued)

      return new Promise<Buffer>((resolve, reject) => {
        resolveNext = resolve
        rejectNext = reject
      })
    },
    fail(error: Error) {
      if (terminalError || closedError) return
      terminalError = error
      frames.length = 0
      rejectPending(error)
    },
    close() {
      if (terminalError || closedError) return
      closedError = new Error("The native offline renderer is unavailable.")
      frames.length = 0
      rejectPending(closedError)
    },
  }
}

export const renderNativeOffline = async (input: {
  hostPath: string
  jobId?: string
  plan: NativeOfflineRenderPlan
  vstAttachments?: readonly ResolvedVst3Attachment[]
  signal: AbortSignal
  onChunk: (chunk: NativeOfflinePcmChunk) => void | Promise<void>
  onMappedPage?: (
    request: NativeOfflineMappedPageRequest,
    signal: AbortSignal,
  ) => Promise<NativeHostMappedAssetPage>
  completionInactivityMs?: number
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancelScheduled?: (timer: ReturnType<typeof setTimeout>) => void
}): Promise<void> => {
  if (!nativeOfflineRenderPlanSchema.safeParse(input.plan).success || (
    input.plan.version !== 1
    || !unsigned32(input.plan.sampleRateHz)
    || !unsigned32(input.plan.blockFrames)
    || input.plan.blockFrames === 0
    || (input.plan.channelCount !== 1 && input.plan.channelCount !== 2)
    || !Number.isSafeInteger(input.plan.totalFrames)
    || input.plan.totalFrames <= 0
    || input.plan.graph.byteLength === 0
    || input.plan.schedule.byteLength === 0
  )) throw new Error("The native offline render plan is invalid.")
  input.signal.throwIfAborted()

  const child = spawn(input.hostPath, [], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "pipe"],
  })

  let finished = false
  const mailbox = createNativeOfflineFrameMailbox()
  let refreshCompletionWatchdog: (() => void) | undefined
  const schedule = input.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancelScheduled = input.cancelScheduled ?? ((timer) => clearTimeout(timer))
  const completionInactivityMs = input.completionInactivityMs ?? nativeOfflineCompletionInactivityTimeoutMs

  const terminate = () => {
    if (!child.killed) child.kill()
  }

  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  let stderr = Buffer.alloc(0)
  let stderrTruncated = false

  const stderrText = () => {
    const text = stderr.toString("utf8").trim()

    return stderrTruncated ? `${text}\n[native stderr truncated]` : text
  }

  const withStderr = (message: string) => {
    const diagnostic = stderrText()

    return diagnostic ? `${message} Native stderr: ${diagnostic}` : message
  }

  let stopPump = () => {}
  const pendingMappedPagePromises = new Set<Promise<NativeHostMappedAssetPage>>()
  const pendingMappedPageRejectors = new Map<Promise<NativeHostMappedAssetPage>, (error: Error) => void>()

  const fail = (error: Error) => {
    if (finished) return
    finished = true
    mailbox.fail(error)

    for (const reject of pendingMappedPageRejectors.values()) reject(error)
    stopPump()
    terminate()
  }

  const nextFrame = () => {
    return mailbox.next()
  }

  const consumeOfflinePcmChunk = (frame: Buffer) => {
    const payload = frame.subarray(headerBytes)

    if (payload.byteLength < 16) throw new Error("The native offline renderer returned an invalid PCM chunk.")
    const startFrame = Number(frame.readBigUInt64BE(headerBytes))
    const frameCount = frame.readUInt32BE(headerBytes + 8)
    const channelCount = frame.readUInt32BE(headerBytes + 12)
    const sampleBytes = frameCount * channelCount * 4

    if (
      channelCount !== input.plan.channelCount
      || frameCount === 0
      || payload.byteLength !== 16 + sampleBytes
      || startFrame + frameCount > input.plan.totalFrames
    ) throw new Error("The native offline renderer returned an invalid PCM chunk.")
    const samples = new Float32Array(frameCount * channelCount)

    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = payload.readFloatBE(16 + index * Float32Array.BYTES_PER_ELEMENT)
    }

    const planes = Array.from({ length: channelCount }, (_, channel) => (
      samples.subarray(channel * frameCount, (channel + 1) * frameCount)
    ))

    return input.onChunk({ startFrame, frameCount, channelCount, planes })
  }

  const onStdoutFrame = (frame: Buffer) => {
    if (isNativeOfflineTelemetryFrame(frame.readUInt32BE(8))) return

    if (!mailbox.push(frame)) {
      fail(new Error("The native offline renderer produced frames faster than they could be consumed."))
    }
  }

  const pump = createNativeOfflineStdoutPump({
    onFrame: onStdoutFrame,
    onPcmFrame: async (frame) => {
      await consumeOfflinePcmChunk(frame)
      refreshCompletionWatchdog?.()
    },
    isPcmFrame: (frame) => frame.readUInt32BE(8) === offlinePcmChunkType,
    onError: (error) => fail(error),
    pause: () => child.stdout.pause(),
    resume: () => child.stdout.resume(),
  })

  stopPump = pump.stop
  child.stdout.on("data", pump.push)
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.byteLength >= maximumOfflineStderrBytes) {
      stderrTruncated = true

      return
    }

    const remaining = maximumOfflineStderrBytes - stderr.byteLength

    if (chunk.byteLength > remaining) {
      stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)])
      stderrTruncated = true

      return
    }

    stderr = Buffer.concat([stderr, chunk])
  })
  const onError = (error: Error) => fail(error)

  const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    if (!finished) {
      fail(new Error(withStderr(
        `The native offline renderer exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}).`,
      )))
    }
  }

  child.on("error", onError)
  child.on("close", onClose)

  const abort = () => {
    if (!finished) fail(new DOMException("Native offline rendering canceled.", "AbortError"))
  }

  input.signal.addEventListener("abort", abort, { once: true })

  const send = (type: number, payload: Uint8Array | Buffer = Buffer.alloc(0)) => {
    const frame = encodeNativeAudioHostControlFrame(type, payload)

    if (!frame || !child.stdin.writable) throw new Error("The native offline renderer is unavailable.")
    child.stdin.write(frame)
  }

  const waitFor = async (
    type: number,
    acknowledgedType: number | undefined,
    stage: NativeOfflineWaitStage,
  ) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectTimeout: ((error: Error) => void) | undefined
    const isCompletion = stage === "offline completion"
    const timeoutDelay = isCompletion ? completionInactivityMs : nativeOfflineStageTimeoutMs

    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject
      timer = schedule(() => reject(new NativeOfflineRenderTimeoutError(stage)), timeoutDelay)
    })

    const refresh = () => {
      if (!isCompletion || rejectTimeout === undefined) return

      if (timer !== undefined) cancelScheduled(timer)
      timer = schedule(() => rejectTimeout?.(new NativeOfflineRenderTimeoutError(stage)), completionInactivityMs)
    }

    if (isCompletion) refreshCompletionWatchdog = refresh

    const receive = async () => {
      while (true) {
        const frame = await nextFrame()
        const frameType = frame.readUInt32BE(8)

        if (frameType === type && frameType !== ackType) return frame

        if (frameType === offlineErrorType) {
          const payload = frame.subarray(headerBytes)

          if (payload.byteLength < 4) throw new Error("The native offline renderer failed.")
          const length = payload.readUInt32BE(0)
          throw new Error(withStderr(payload.subarray(4, 4 + Math.min(length, 256)).toString("utf8")))
        }

        if (frameType === ackType) {
          if (acknowledgedType === undefined) continue

          if (frame.byteLength > headerBytes + 8 && frame.byteLength <= headerBytes + 264
            && frame.readUInt32BE(headerBytes) === acknowledgedType
            && (frame.readUInt32BE(headerBytes + 4) === nativeAudioHostAckStatus.refused
              || frame.readUInt32BE(headerBytes + 4) === nativeAudioHostAckStatus.unavailable)) {
            const reason = frame.subarray(headerBytes + 8).toString("utf8")
            throw new Error(stage === "schedule window"
              ? `Native export could not schedule playback: ${reason}. Reload the project and retry; no export was completed.`
              : reason)
          }

          if (frame.subarray(headerBytes).byteLength !== 8
            || frame.readUInt32BE(headerBytes) !== acknowledgedType
            || frame.readUInt32BE(headerBytes + 4) !== nativeAudioHostAckStatus.accepted) {
            throw new Error(stage === "instrument state"
              ? "Native export could not prepare instrument samples. Reload the instrument samples and retry; no export was completed."
              : `Native export failed during ${stage}. Reload the source audio and retry; no export was completed.`)
          }

          return frame
        }

        if (frameType === offlineCompleteType && type === offlineCompleteType) return frame
      }
    }

    try {
      return await Promise.race([receive(), timeout])
    } finally {
      if (timer !== undefined) cancelScheduled(timer)

      if (isCompletion && refreshCompletionWatchdog === refresh) refreshCompletionWatchdog = undefined
    }
  }

  try {
    send(hostHelloType)
    const capabilities = readResponse(await waitFor(hostCapabilitiesType, undefined, "host handshake"))

    if (!capabilities || !isCompatibleAudioHostHello(capabilities)) {
      throw new Error("The native offline renderer has an incompatible host contract.")
    }

    send(offlineConfigureType, encodeOfflineConfigure(input.plan))
    await waitFor(ackType, offlineConfigureType, "offline configuration")

    for (const asset of input.plan.assets) {
      const payload = serializeAssetInstall(asset)

      if (!payload) throw new Error("The native offline asset is invalid.")
      send(assetInstallType, payload)
      await waitFor(ackType, assetInstallType, "asset installation")
    }

    for (const asset of input.plan.mappedAssets ?? []) {
      const createPayload = Buffer.alloc(28)
      createPayload.writeUInt32BE(asset.sessionAssetId, 0)
      createPayload.writeBigUInt64BE(BigInt(asset.frameCount), 4)
      createPayload.writeUInt32BE(asset.sampleRateHz, 12)
      createPayload.writeUInt32BE(asset.channelCount, 16)
      createPayload.writeBigUInt64BE(0n, 20)
      send(mappedAssetCreateType, createPayload)
      await waitFor(ackType, mappedAssetCreateType, "mapped asset creation")

      for (const range of asset.ranges) {
        const pageFrames = Math.min(
          range.frameCount,
          defaultDecodedAudioPageFrames,
          Math.floor((maximumPayloadBytes - 16) / (asset.channelCount * Float32Array.BYTES_PER_ELEMENT)),
        )

        for (let startFrame = range.startFrame; startFrame < range.startFrame + range.frameCount; startFrame += pageFrames) {
          const frameCount = Math.min(pageFrames, range.startFrame + range.frameCount - startFrame)

          if (!input.onMappedPage) throw new Error("The native offline mapped page provider is unavailable.")

          const request = {
            jobId: input.jobId ?? "offline",
            requestId: crypto.randomUUID(),
            asset,
            startFrame,
            frameCount,
          }

          const pagePromise = Promise.resolve().then(() => input.onMappedPage?.(request, input.signal)
            ?? Promise.reject(new Error("The native offline mapped page provider is unavailable.")))

          let rejectPage: ((error: Error) => void) | undefined

          const pendingPage = new Promise<NativeHostMappedAssetPage>((resolve, reject) => {
            rejectPage = reject
            void pagePromise.then(resolve, reject)
          })

          pendingMappedPagePromises.add(pendingPage)
          pendingMappedPageRejectors.set(pendingPage, (error) => rejectPage?.(error))

          const page = await pendingPage.finally(() => {
            pendingMappedPagePromises.delete(pendingPage)
            pendingMappedPageRejectors.delete(pendingPage)
          })

          if (page.sessionAssetId !== asset.sessionAssetId
            || page.startFrame !== startFrame
            || page.frameCount !== frameCount
            || page.planarPcm.byteLength !== frameCount * asset.channelCount * Float32Array.BYTES_PER_ELEMENT) {
            throw new Error("The native offline mapped page provider returned invalid audio.")
          }

          const pagePayload = Buffer.alloc(16 + page.planarPcm.byteLength)
          pagePayload.writeUInt32BE(page.sessionAssetId, 0)
          pagePayload.writeBigUInt64BE(BigInt(page.startFrame), 4)
          pagePayload.writeUInt32BE(page.frameCount, 12)
          pagePayload.set(page.planarPcm, 16)
          send(mappedAssetWritePageType, pagePayload)
          await waitFor(ackType, mappedAssetWritePageType, "mapped asset page")
        }

        const preparePayload = Buffer.alloc(20)
        preparePayload.writeUInt32BE(asset.sessionAssetId, 0)
        preparePayload.writeBigUInt64BE(BigInt(range.startFrame), 4)
        preparePayload.writeBigUInt64BE(BigInt(range.frameCount), 12)
        send(mappedAssetPrepareRangeType, preparePayload)
        await waitFor(ackType, mappedAssetPrepareRangeType, "mapped asset range")
      }
    }

    for (const attachment of input.vstAttachments ?? []) {
      const payload = serializeVstAttachment(attachment)

      if (!payload) throw new Error("The native offline VST attachment is invalid.")
      send(vstAttachType, payload)
      await waitFor(ackType, vstAttachType, "VST attachment")
    }

    send(graphSnapshotType, input.plan.graph)
    await waitFor(ackType, graphSnapshotType, "graph snapshot")

    if (input.plan.instrumentStates) {
      send(instrumentStatesType, input.plan.instrumentStates)
      await waitFor(ackType, instrumentStatesType, "instrument state")
    }

    const transport = serializeTransport(input.plan.transport)

    if (!transport) throw new Error("The native offline transport is invalid.")
    send(transportType, transport)
    await waitFor(ackType, transportType, "transport")

    for (const schedule of input.plan.scheduleWindows ?? [input.plan.schedule]) {
      send(scheduleWindowType, schedule)
      await waitFor(ackType, scheduleWindowType, "schedule window")
    }

    send(offlineStartType, encodeOfflineStart(input.plan))
    await waitFor(ackType, offlineStartType, "offline start")
    await waitFor(offlineCompleteType, undefined, "offline completion")
    finished = true
  } finally {
    finished = true
    mailbox.close()
    input.signal.removeEventListener("abort", abort)

    for (const reject of pendingMappedPageRejectors.values()) {
      reject(new Error("The native offline mapped page callback was canceled."))
    }

    await Promise.allSettled(pendingMappedPagePromises)
    stopPump()
    child.stdout.removeListener("data", pump.push)
    child.removeListener("error", onError)
    child.removeListener("close", onClose)
    terminate()
    await Promise.race([
      closed,
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ])
    child.stdout.removeAllListeners("data")
  }
}

export const packagedAudioHostPath = (resourcesPath: string, isPackaged: boolean, explicitPath?: string) => (
  isPackaged ? path.join(resourcesPath, "daw-audio-host-macos") : explicitPath
)

/**
 * `refused`: native answered and said no. `unavailable`: nothing was delivered. `unconfirmed`: the request may have
 * reached native but no answer arrived, so the caller must not retry blindly. `undefined` means no supervisor.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the argument is a catch-clause value, classified here at the boundary
export const nativeDeliveryFailureKind = (thrown: unknown) => {
  if (thrown instanceof NativeAudioHostCommandError) {
    return thrown.reason
  }

  return thrown === undefined || thrown instanceof NativeAudioHostNotSentError ? "unavailable" as const : "unconfirmed" as const
}

/** The renderer reply for a failed native session command. `thrown` is a catch-clause value; omit it when nothing was sent. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the argument is a catch-clause value, classified here at the boundary
export const nativeSessionFailure = (thrown?: unknown) => ({
  ok: false as const,
  kind: nativeDeliveryFailureKind(thrown),
  error: thrown instanceof NativeAudioHostCommandError
    ? `The native audio session rejected ${thrown.requestName} request ${thrown.requestType}.${thrown.detail === undefined ? "" : ` ${thrown.detail}`}`
    : "The native audio session is unavailable.",
})

/** The renderer reply for a patch status. A u64 token can exceed Number.MAX_SAFE_INTEGER, so it crosses IPC as decimal text. */
export const nativeProcessorPatchReply = (status: NativeProcessorPatchStatus) => {
  if (status.outcome === "applied") return { ok: true as const, outcome: "applied" as const }

  if (status.outcome === "claimed") return { ok: true as const, outcome: "claimed" as const, token: status.token.toString() }
  const refused = { ok: true as const, outcome: "refused" as const, refusal: status.refusal, coreResult: status.coreResult }

  return status.token === undefined ? refused : { ...refused, token: status.token.toString() }
}

type SpawnHost = (hostPath: string) => ChildProcessWithoutNullStreams

export type NativeAudioHostSupervisorOptions = {
  evidence?: HostEvidence
  hostEnvironment?: NodeJS.ProcessEnv
  gracefulTerminationMs?: number
  sigtermTerminationMs?: number
  sigkillObservationMs?: number
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancelScheduled?: (timer: ReturnType<typeof setTimeout>) => void
  kill?: (child: ChildProcessWithoutNullStreams, signal: "SIGTERM" | "SIGKILL") => boolean
}

export type NativeAudioHostSupervisor = {
  start(): Promise<AudioHostHello>
  runTransaction<T>(operation: (transaction: Pick<NativeAudioHostSupervisor, "attachVst">) => Promise<T>): Promise<T>
  invalidateManualTransaction(): Promise<void>
  configure(input: NativeHostDeviceConfiguration, transactionToken?: string): Promise<void>
  beginTransaction(): Promise<string>
  commitTransaction(transactionToken: string): Promise<void>
  rollbackTransaction(transactionToken: string): Promise<void>
  attachVst(input: ResolvedVst3Attachment, transactionToken?: string): Promise<void>
  getVstState(instanceId: string, transactionToken?: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; sha256: string }>
  detachVst(instanceId: string, transactionToken?: string): Promise<{ status: "detached" | "refused" }>
  executeVstEditorCommand(input: { instanceId: string; command: NativeVstEditorCommand; width?: number; height?: number; anchor?: NativeVstEditorAnchor }, transactionToken?: string): Promise<NativeVstEditorStatus>
  installAsset(input: NativeHostPcmAsset, transactionToken?: string): Promise<void>
  createMappedAsset(input: NativeHostMappedAsset, transactionToken?: string): Promise<void>
  writeMappedAssetPage(input: NativeHostMappedAssetPage, transactionToken?: string): Promise<void>
  prepareMappedAssetRange(sessionAssetId: number, startFrame: number, frameCount: number, transactionToken?: string): Promise<void>
  releaseMappedAsset(sessionAssetId: number, transactionToken?: string): Promise<void>
  releaseAsset(sessionAssetId: number, transactionToken?: string): Promise<void>
  publishGraph(bytes: Uint8Array, transactionToken?: string): Promise<void>
  configureInstrumentStates(bytes: Uint8Array, transactionToken?: string): Promise<void>
  prepareGraphRevision(bytes: Uint8Array, requestedPublicationFrame?: bigint, transactionToken?: string): Promise<NativeGraphRevisionStatus>
  inspectGraphRevision(revision: number, transactionToken?: string): Promise<NativeGraphRevisionStatus>
  allocateRuntimeRevision(): number
  publishGraphRevision(revision: number, requestedPublicationFrame?: bigint, transactionToken?: string): Promise<NativeGraphRevisionStatus>
  rollbackGraphRevision(revision: number, transactionToken?: string): Promise<NativeGraphRevisionStatus>
  retireGraphRevision(revision: number, transactionToken?: string): Promise<NativeGraphRevisionStatus>
  queueParameterEvents(bytes: Uint8Array, transactionToken?: string): Promise<void>
  queueProcessorStatePatch(bytes: Uint8Array, transactionToken?: string): Promise<NativeProcessorPatchStatus>
  queueVstParameterEvents(bytes: Uint8Array, transactionToken?: string): Promise<void>
  queueInstrumentEvents(bytes: Uint8Array, transactionToken?: string): Promise<void>
  queueSourceEvents(bytes: Uint8Array, transactionToken?: string): Promise<void>
  setTransport(input: NativeHostTransport, transactionToken?: string): Promise<void>
  resolveOutputDevice(preferredDeviceId?: string): Promise<NativeOutputDevice | null>
  resolveInputDevice(preferredDeviceId?: string): Promise<NativeInputDevice | null>
  listDevices(): Promise<NativeAudioDevice[]>
  startAudio(): Promise<void>
  startDiagnosticAudio(): Promise<void>
  stopAudio(reason?: string): Promise<void>
  diagnostics(): Promise<NativeHostDiagnostics>
  configureRecording(input: NativeHostRecordingConfiguration, spool: NativeRecordingSpoolConfiguration): Promise<NativeHostRecordingStatus>
  startRecording(): Promise<void>
  stopRecording(stopFrame?: number): Promise<void>
  cancelRecording(): Promise<void>
  teardownSession(): Promise<void>
  waitForRecordingFinish(): Promise<void>
  waitForRecordingOutcome(): Promise<void>
  recordingAdmissionAvailable(): boolean
  recordingFinalizationPending(): boolean
  teardown(): Promise<void>
  status(): { running: boolean; hello?: AudioHostHello; generation: number; pid?: number }
  transactionOpen(): boolean
  onLoss(listener: (error: Error) => void): () => void
  onRecordingStatus(listener: (status: NativeMainRecordingStatus) => void): () => void
  onMeterBatch(listener: (batch: NativeHostMeterBatch) => void): () => void
  setSpectrumNode(nodeId: bigint | null): Promise<void>
  onSpectrumFrame(listener: (frame: NativeHostSpectrumFrame) => void): () => void
  queueScheduleWindow(bytes: Uint8Array, transactionToken?: string): Promise<void>
  reenableVstScheduleAutomation(bytes: Uint8Array, transactionToken?: string): Promise<void>
  onScheduleProgress(listener: (progress: NativeScheduleProgress) => void): () => void
  onWorkerNotification(listener: (notification: NativeWorkerNotification) => void): () => void
  suspend(): Promise<void>
  resume(): Promise<void>
}

export const createNativeAudioHostSupervisor = (
  hostPath: string,
  spawnHost: SpawnHost | undefined = undefined,
  options: NativeAudioHostSupervisorOptions = {},
): NativeAudioHostSupervisor => {
  const evidence = options.evidence

  const defaultSpawnHost: SpawnHost = (executable) => spawn(executable, [], {
    env: { PATH: "/usr/bin:/bin", ...options.hostEnvironment },
    stdio: ["pipe", "pipe", "pipe"],
  })

  let child: ChildProcessWithoutNullStreams | undefined
  let hello: AudioHostHello | undefined
  let buffer = Buffer.alloc(0)
  let startPromise: Promise<AudioHostHello> | undefined
  let teardownPromise: Promise<void> | undefined
  let childTerminationPromise: Promise<void> | undefined
  let resumePromise: Promise<void> | undefined
  let lifecycleGeneration = 0
  let runtimeRevision = 0
  // Bind evidence to the actual child: a planned close can arrive after the
  // teardown promise has settled and the replacement generation has started.
  const evidenceTerminationCauses = new WeakMap<ChildProcessWithoutNullStreams, string>()
  let suspended = false
  let lifecycleIntentVersion = 0
  let terminationFailure: Error | undefined
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancelScheduled = options.cancelScheduled ?? ((timer) => clearTimeout(timer))
  const gracefulTerminationMs = options.gracefulTerminationMs ?? 250
  const sigtermTerminationMs = options.sigtermTerminationMs ?? 250
  const sigkillObservationMs = options.sigkillObservationMs ?? 250
  let transactionTail = Promise.resolve()
  let transactionOwner: symbol | undefined
  let manualTransactionToken: string | undefined
  let manualTransactionGeneration = 0
  let manualTransactionInvalidationVersion = 0
  let manualInvalidationPromise: Promise<void> | undefined
  let nextTransportTransitionId = 0n
  const lossListeners = new Set<(error: Error) => void>()
  const recordingStatusListeners = new Set<(status: NativeMainRecordingStatus) => void>()
  let recordingConfiguration: NativeHostRecordingConfiguration | undefined
  let recordingAdmitted = false
  let recordingReady: { promise: Promise<NativeHostRecordingStatus>; resolve: (value: NativeHostRecordingStatus) => void; reject: (error: Error) => void } | undefined
  let recordingFinish: { pending: boolean; dispatched: boolean; promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } | undefined
  let recordingSuspendPromise: Promise<void> | undefined
  const meterBatchListeners = new Set<(batch: NativeHostMeterBatch) => void>()
  const spectrumFrameListeners = new Set<(frame: NativeHostSpectrumFrame) => void>()
  const scheduleProgressListeners = new Set<(progress: NativeScheduleProgress) => void>()
  const workerNotificationListeners = new Set<(notification: NativeWorkerNotification) => void>()

  const broker = createNativeRequestBroker({
    get child() { return child },
    get generation() { return lifecycleGeneration },
    get suspended() { return suspended },
    get tearingDown() { return teardownPromise !== undefined },
    get transactionOwner() { return transactionOwner },
    get recordingFinishDispatched() { return recordingFinish?.pending === true && recordingFinish.dispatched },
    evidence,
    markRecordingFinishDispatched: () => { if (recordingFinish) recordingFinish.dispatched = true },
    lost: (message, source) => lost(message, source),
  })

  const lost = (message: string, source = child) => {
    if (!source || child !== source) return
    console.error("[native-audio-host-termination-request]", JSON.stringify({
      reason: "host-process-loss",
      requester: "audio-host-supervisor-lost",
      timestamp: Date.now(),
      lifecycleGeneration,
      pid: source.pid ?? null,
      signal: "SIGTERM",
      pendingRequest: broker.pendingRequestName(),
      message: message.replace(/[\r\n\t]+/g, " ").slice(0, 256),
    }))
    console.error("[native-vst3] native audio host lost", JSON.stringify({
      message: message.slice(0, 256),
      lifecycleGeneration,
      pid: source.pid ?? null,
    }))
    const error = new Error(message)
    recordingAdmitted = false
    recordingReady?.reject(error)

    if (recordingFinish) { recordingFinish.pending = false; recordingFinish.reject(error) }

    broker.rejectPending(error, false)
    child = undefined
    hello = undefined
    lifecycleGeneration += 1
    startPromise = undefined
    transactionOwner = undefined
    manualTransactionToken = undefined
    manualTransactionGeneration = -1
    nextTransportTransitionId = 0n
    buffer = Buffer.alloc(0)
    const currentChild = source
    evidenceTerminationCauses.set(currentChild, `supervisor-terminated: ${message.replace(/[\r\n\t]+/g, " ").slice(0, 256)}`)
    currentChild?.kill()
    broker.rejectQueued(error)

    for (const listener of lossListeners) listener(error)
  }

  const terminateDetachedChild = (current: ChildProcessWithoutNullStreams) => new Promise<void>((resolve, reject) => {
    let settled = false
    const timers: NativeAudioHostTerminationTimers = {}

    const finish = (error?: Error) => {
      if (settled) return
      settled = true

      if (timers.graceful) cancelScheduled(timers.graceful)

      if (timers.sigterm) cancelScheduled(timers.sigterm)

      if (timers.killObservation) cancelScheduled(timers.killObservation)

      if (error) {
        terminationFailure = error
        reject(error)
      }
      else resolve()
    }

    current.once("close", () => finish())
    // An error does not prove that the child has closed. Keep the bounded
    // termination sequence alive until close is observed or it hard-fails.
    current.once("error", () => undefined)

    const kill = (signal: "SIGTERM" | "SIGKILL") => {
      console.error("[native-audio-host-termination-request]", JSON.stringify({
        reason: signal === "SIGTERM" ? "suspend-graceful-termination" : "suspend-forced-termination",
        requester: "audio-host-supervisor-suspend",
        timestamp: Date.now(),
        lifecycleGeneration,
        pid: current.pid ?? null,
        signal,
        pendingRequest: broker.pendingRequestName(),
      }))

      try {
        return options.kill?.(current, signal) ?? current.kill(signal)
      } catch {
        return false
      }
    }

    timers.graceful = schedule(() => {
      kill("SIGTERM")
      timers.sigterm = schedule(() => {
        const killed = kill("SIGKILL")
        timers.killObservation = schedule(() => {
          finish(new Error(
            killed
              ? "The native audio host did not close after SIGKILL."
              : "The native audio host could not be terminated.",
          ))
        }, sigkillObservationMs)
      }, sigtermTerminationMs)
    }, gracefulTerminationMs)
  })

  const decode = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])

    while (buffer.byteLength >= headerBytes) {
      const payloadBytes = buffer.readUInt32BE(12)

      if (payloadBytes > maximumPayloadBytes || buffer.byteLength < headerBytes + payloadBytes) return
      const frame = buffer.subarray(0, headerBytes + payloadBytes)
      buffer = buffer.subarray(headerBytes + payloadBytes)
      const pending = broker.pending()

      if (frame.readUInt32BE(0) !== magic || frame.readUInt32BE(4) !== protocolVersion) return lost("The native audio host returned an invalid control frame.")

      if (frame.readUInt32BE(8) === recordingBlockType) {
        return lost("Reserved recording PCM frame is not valid in native host v23.")
      } else if (frame.readUInt32BE(8) === recordingStatusType) {
        const status = decodeRecordingStatus(frame)

        if (!status) return lost("The native audio host returned invalid recording status.")

        if (recordingConfiguration && status.generation === recordingConfiguration.generation
          && status.sessionId === recordingConfiguration.sessionId) {
          if (status.spool?.state === nativeAudioHostSpoolStates.ready && status.configured) recordingReady?.resolve(status)
          else if (status.spool && status.spool.state >= nativeAudioHostSpoolStates.failed) recordingReady?.reject(new Error("Native recording preparation failed."))

          if (recordingFinish && status.spool && status.spool.state >= nativeAudioHostSpoolStates.complete) {
            recordingFinish.pending = false

            if (status.spool.state === nativeAudioHostSpoolStates.complete) recordingFinish.resolve()
            else recordingFinish.reject(new Error("Native recording persistence failed; source retained for recovery."))
          }

          if (status.spool && status.spool.state >= nativeAudioHostSpoolStates.complete) recordingAdmitted = false
        }

        for (const listener of recordingStatusListeners) listener(status)
      } else if (frame.readUInt32BE(8) === meterBatchType) {
        const batch = decodeMeterBatch(frame)

        if (!batch) return lost("The native audio host returned an invalid meter batch.")

        for (const listener of meterBatchListeners) listener(batch)
      } else if (frame.readUInt32BE(8) === spectrumFrameType) {
        const spectrum = decodeSpectrumFrame(frame)

        if (!spectrum) return lost("The native audio host returned an invalid spectrum frame.")

        for (const listener of spectrumFrameListeners) listener(spectrum)
      } else if (frame.readUInt32BE(8) === diagnosticsType
        && decodeDiagnostics(frame)?.state === "faulted") {
        // The existing diagnostics frame is also an unsolicited terminal
        // device-status event. Reuse session loss, including pending rejection,
        // so the renderer cannot keep waiting after callbacks have stopped.
        return lost("Audio output device was disconnected. Select an available device in Audio Settings.")
      } else if (frame.readUInt32BE(8) === scheduleProgressType) {
        const progress = decodeScheduleProgress(frame)

        if (!progress || progress.revision === 0 || progress.epoch === 0
          || progress.progressSequence === 0n) {
          return lost("The native audio host returned invalid schedule progress.")
        }

        for (const listener of scheduleProgressListeners) listener(progress)
      } else if (frame.readUInt32BE(8) === notificationType) {
        const notification = decodeWorkerNotification(frame)

        if (!notification) return lost("The native audio host returned an invalid worker notification.")

        for (const listener of workerNotificationListeners) listener(notification)
      } else if (frame.readUInt32BE(8) === hostCapabilitiesType && !hello) {
        const parsed = readResponse(frame)

        if (!parsed || !isCompatibleAudioHostHello(parsed)) {
          return lost("The native audio host returned an incompatible protocol response.")
        }

        hello = parsed

        if (pending) {
          broker.settle(pending)

          if (pending.reply.kind === "ack") pending.reply.resolve()
        }
      } else if (frame.readUInt32BE(8) === diagnosticsType && pending?.reply.kind === "diagnostics") {
        const current = pending
        const reply = pending.reply
        const diagnostic = decodeDiagnostics(frame)

        if (!diagnostic) {
          broker.rejectPending(new Error("The native audio host returned an invalid diagnostics response."))
        } else {
          broker.settle(current)
          reply.resolve(diagnostic)
        }
      } else if (frame.readUInt32BE(8) === deviceListType && pending?.reply.kind === "outputDevice") {
        const current = pending
        const reply = pending.reply
        const device = decodeOutputDevice(frame)

        if (device === undefined) return lost("The native audio host returned an invalid device response.")
        broker.settle(current)
        reply.resolve(device)
      } else if (frame.readUInt32BE(8) === recordingDeviceListType && pending?.reply.kind === "inputDevice") {
        const current = pending
        const reply = pending.reply
        const device = decodeInputDevice(frame)

        if (device === undefined) return lost("The native audio host returned an invalid input device response.")
        broker.settle(current)
        reply.resolve(device)
      } else if (frame.readUInt32BE(8) === deviceInventoryType && pending?.reply.kind === "deviceInventory") {
        const current = pending
        const reply = pending.reply
        const devices = decodeDeviceInventory(frame)

        if (devices === undefined) return lost("The native audio host returned an invalid device inventory response.")
        broker.settle(current)
        reply.resolve(devices)
      } else if (frame.readUInt32BE(8) === graphRevisionStatusType && pending?.reply.kind === "graphRevision") {
        const current = pending
        const reply = pending.reply
        const status = decodeGraphRevisionStatus(frame)

        if (!status) return lost("The native audio host returned an invalid graph revision status.")

        if (status.requestedRevision !== reply.requestedRevision) continue

        if (current.requestType === graphRevisionStatusType) evidence?.("inspect-reply-received", { pid: child?.pid ?? null, revision: status.requestedRevision })
        broker.settle(current)
        reply.resolve(status)
      } else if (frame.readUInt32BE(8) === graphRevisionStatusType) {
        // A timed-out revision can reply after reconciliation was requested or
        // completed. It cannot settle another command or prove process loss.
        if (!decodeGraphRevisionStatus(frame)) return lost("The native audio host returned an invalid graph revision status.")
      } else if (frame.readUInt32BE(8) === vstStateType && pending?.reply.kind === "vstState") {
        const current = pending
        const reply = pending.reply
        const payload = frame.subarray(headerBytes)

        const rejectState = (message: string) => {
          broker.rejectPending(new NativeAudioHostCommandError(vstStateGetType, message))
        }

        if (payload.byteLength < 4) {
          rejectState("The native audio host returned an invalid VST state response.")
          continue
        }

        const instanceBytes = payload.readUInt32LE(0)
        const instanceEnd = 4 + instanceBytes

        if (instanceBytes === 0 || instanceBytes > maximumVstStringBytes || payload.byteLength < instanceEnd + 8) {
          rejectState("The native audio host returned an invalid VST state response.")
          continue
        }

        const instanceId = payload.subarray(4, instanceEnd).toString("utf8")
        const stateBytes = payload.readUInt32LE(instanceEnd)
        const hashBytes = payload.readUInt32LE(instanceEnd + 4)
        const start = instanceEnd + 8
        const sha256 = payload.subarray(start + stateBytes).toString("utf8")

        if (
          instanceId !== reply.instanceId
          || hashBytes !== 64
          || stateBytes > maxVst3WorkerStateBytes
          || payload.byteLength !== start + stateBytes + hashBytes
          || !sha256HexPattern.test(sha256)
        ) {
          rejectState("The native audio host returned an invalid VST state response.")
          continue
        }

        const bytes = Uint8Array.from(payload.subarray(start, start + stateBytes))
        broker.settle(current)

        if (!reply.cancelled) reply.resolve({ bytes, sha256 })
      } else if (frame.readUInt32BE(8) === vstEditorStatusType && pending?.reply.kind === "editor") {
        const current = pending
        const reply = pending.reply
        const status = decodeVstEditorStatus(frame)

        if (!status) return lost("The native audio host returned an invalid VST editor response.")
        broker.settle(current)
        reply.resolve(status)
      } else if (frame.readUInt32BE(8) === processorStatePatchStatusType && pending?.reply.kind === "patchStatus") {
        const current = pending
        const reply = pending.reply
        const status = decodeNativeProcessorPatchStatus(frame.subarray(headerBytes))

        if (!status) return lost("The native audio host returned an invalid processor patch status.")
        broker.settle(current)
        reply.resolve(status)
      } else if (frame.readUInt32BE(8) === ackType && pending?.reply.kind === "patchStatus") {
        // A patch is answered by a status frame; an ACK is never proof the patch was taken.
        return lost("The native audio host acknowledged a processor patch instead of reporting its status.")
      } else if (
        frame.readUInt32BE(8) === ackType
        && frame.byteLength >= headerBytes + 8
        && frame.byteLength <= headerBytes + 8 + 256
        && pending
        && (
          (pending.reply.kind === "ack" && frame.readUInt32BE(headerBytes) === pending.reply.expectedAckType)
          || (pending.reply.kind === "vstState" && frame.readUInt32BE(headerBytes) === vstStateGetType)
        )
      ) {
        const current = pending
        const status = frame.readUInt32BE(headerBytes + 4)

        if (
          status !== nativeAudioHostAckStatus.refused
          && status !== nativeAudioHostAckStatus.accepted
          && status !== nativeAudioHostAckStatus.unavailable
        ) return lost("The native audio host returned an invalid control acknowledgement.")
        const accepted = status === nativeAudioHostAckStatus.accepted
        broker.settle(current, accepted)

        if (accepted) {
          if (current.reply.kind === "ack") current.reply.resolve()
        } else {
          current.reject(new NativeAudioHostCommandError(
            frame.readUInt32BE(headerBytes),
            frame.byteLength > headerBytes + 8
              ? frame.subarray(headerBytes + 8).toString("utf8")
              : frame.readUInt32BE(headerBytes) === vstStateGetType
              ? "The native audio host could not capture VST state."
              : frame.readUInt32BE(headerBytes) === midiEventsType
                ? "The native audio host rejected instrument events: invalid graph target, parameter range, or queue capacity."
                : undefined,
            status === nativeAudioHostAckStatus.unavailable ? "unavailable" : "refused",
          ))
        }
      } else return lost("The native audio host rejected a control request.")
    }
  }

  const ownerForToken = (token: string | undefined) => (
    token !== undefined
    && token.length <= 128
    && manualTransactionToken === token
    && manualTransactionGeneration === lifecycleGeneration
      ? transactionOwner
      : undefined
  )

  const assertTransactionAccess = (token: string | undefined) => {
    if (transactionOwner === undefined) {
      if (token !== undefined) throw new Error("The native audio host transaction token is stale.")

      return undefined
    }

    if (token === undefined || ownerForToken(token) !== transactionOwner) {
      throw new Error("The native audio host transaction token is invalid.")
    }

    return transactionOwner
  }

  const send = (
    type: NativeHostRequestType,
    payload?: NativeControlPayload,
    owner?: symbol,
    allowDuringTeardown = false,
    reason?: string,
  ) => new Promise<void>((resolve, reject) => {
    if (!broker.admits(owner, allowDuringTeardown)) {
      reject(new NativeAudioHostNotSentError("The native audio host is unavailable."))

      return
    }

    const queued = broker.submit({
      type, payload, owner, allowDuringTeardown, reject, reason,
      reply: { kind: "ack", expectedAckType: type, resolve },
    })

    if (!queued) reject(new NativeAudioHostNotSentError(broker.queueFullMessage(type)))
  })

  const enqueueTransaction = <T>(operation: () => Promise<T>) => {
    const result = transactionTail.then(operation)
    transactionTail = result.then(() => undefined, () => undefined)

    return result
  }

  // Failing to start or to gain transaction access happens before anything is written.
  const admitStarted = (token: string | undefined) => {
    try {
      return assertTransactionAccess(token)
    } catch (error) {
      throw new NativeAudioHostNotSentError(error instanceof Error ? error.message : "The native audio host is unavailable.")
    }
  }

  const admit = async (token: string | undefined) => {
    try {
      await supervisor.start()
    } catch (error) {
      throw new NativeAudioHostNotSentError(error instanceof Error ? error.message : "The native audio host is unavailable.")
    }

    return admitStarted(token)
  }

  const request = async (type: NativeHostRequestType, payload?: NativeControlPayload, token?: string, reason?: string) => {
    await send(type, payload, await admit(token), false, reason)
  }

  const requestEditor = async (
    payload: Buffer,
    owner?: symbol,
  ): Promise<NativeVstEditorStatus> => {
    await supervisor.start()

    return new Promise((resolve, reject) => {
      if (!broker.admits(owner, false)) {
        reject(new Error("The native audio host is unavailable."))

        return
      }

      const queued = broker.submit({ type: vstEditorType, payload, owner, reject, reply: { kind: "editor", resolve } })

      if (!queued) reject(new Error("The native host request queue is full."))
    })
  }

  const requestPatchStatus = async (payload: Buffer, token?: string): Promise<NativeProcessorPatchStatus> => {
    const owner = await admit(token)

    return new Promise((resolve, reject) => {
      if (!broker.admits(owner, false)) {
        reject(new NativeAudioHostNotSentError("The native audio host is unavailable."))

        return
      }

      const queued = broker.submit({
        type: processorStatePatchType, payload, owner, reject, reply: { kind: "patchStatus", resolve },
      })

      if (!queued) reject(new NativeAudioHostNotSentError("The native audio host request queue is full."))
    })
  }

  const requestGraphRevision = (type: NativeHostRequestType, payload: Buffer, token?: string) =>
    new Promise<NativeGraphRevisionStatus>((resolve, reject) => {
      // Nothing is sent here: these are `unavailable`, never an unconfirmed request.
      // A busy control slot queues the request like a processor patch.
      const owner = admitStarted(token)

      if (!hello || !broker.admits(owner, false)) {
        throw new NativeAudioHostNotSentError("The native audio host is unavailable.")
      }

      const queued = broker.submit({
        type,
        payload,
        owner,
        reject,
        reply: {
          kind: "graphRevision",
          resolve,
          requestedRevision: type === graphPrepareType
            ? Number(payload.readBigUInt64BE(8))
            : payload.readUInt32BE(0),
        },
      })

      if (!queued) throw new NativeAudioHostNotSentError("The native audio host request queue is full.")
    })

  const attachVst = async (input: ResolvedVst3Attachment, token?: string, owner?: symbol) => {
    const payload = serializeVstAttachment(input)

    if (!payload) throw new Error("The native VST attachment is invalid.")
    await supervisor.start()
    await send(vstAttachType, payload, owner ?? assertTransactionAccess(token))
  }

  const supervisor: NativeAudioHostSupervisor = {
    start() {
      if (suspended) {
        if (resumePromise) return resumePromise.then(() => supervisor.start())

        return Promise.reject(new Error("The native audio host is suspended."))
      }

      if (terminationFailure) return Promise.reject(terminationFailure)

      if (childTerminationPromise) return childTerminationPromise.then(() => supervisor.start())

      if (teardownPromise) return Promise.reject(new Error("The native audio host is tearing down."))

      if (hello) return Promise.resolve(hello)

      if (startPromise) return startPromise
      const generation = lifecycleGeneration
      let spawned: ChildProcessWithoutNullStreams | undefined

      const attempt = (async () => {
        if (childTerminationPromise) await childTerminationPromise
        await access(hostPath)

        if (generation !== lifecycleGeneration || teardownPromise) {
          throw new Error("The native audio host startup was cancelled.")
        }

        spawned = (spawnHost ?? defaultSpawnHost)(hostPath)
        runtimeRevision = 0
        child = spawned
        evidence?.("host-spawn", { pid: spawned.pid ?? null, lifecycleGeneration: generation, cause: "supervisor-start" })
        console.error("[native-vst3] native audio host spawned", JSON.stringify({
          lifecycleGeneration,
          pid: spawned.pid ?? null,
        }))
        spawned.once("error", (error) => {
          console.error("[native-vst3] native audio host spawn error", JSON.stringify({
            lifecycleGeneration,
            pid: spawned?.pid ?? null,
            message: error.message.slice(0, 256),
          }))
          lost("The native audio host could not start.", spawned)
        })
        spawned.once("close", (code, signal) => {
          evidence?.("host-exit", { pid: spawned?.pid ?? null, lifecycleGeneration: generation,
            code, signal, cause: spawned ? evidenceTerminationCauses.get(spawned) ?? "crash" : "spawn-failure" })
          const requestType = broker.pending()?.requestType

          const pendingRequest = requestType === undefined
            ? undefined
            : `${nativeAudioHostRequestName(requestType)} request ${requestType}`

          console.error("[native-vst3] native audio host closed", JSON.stringify({
            code,
            signal,
            terminationReason: spawned
              ? evidenceTerminationCauses.get(spawned) ?? "unexpected-host-exit"
              : "spawn-failure",
            lifecycleGeneration,
            pid: spawned?.pid ?? null,
            pendingRequestType: requestType,
            pendingRequestName: requestType === undefined ? undefined : nativeAudioHostRequestName(requestType),
          }))

          if (teardownPromise && child === spawned && !recordingFinish?.pending) {
            // A child that exits during planned teardown has crossed the physical
            // shutdown boundary even if its final ACK never reaches the pipe.
            // Only settle teardown here; pending Finish/other operation failures
            // continue through the real loss path and remain observable.
            broker.resolveTeardownOnExit()

            return
          }

          lost(
            pendingRequest
              ? `The native audio host stopped during ${pendingRequest}.`
              : "The native audio host stopped.",
            spawned,
          )
        })
        spawned.stderr.on("data", (chunk: Buffer) => {
          console.error("[native-vst3] native audio host stderr", chunk.toString("utf8").trim())
        })
        spawned.stdout.on("data", (chunk: Buffer) => {
          if (child === spawned) decode(chunk)
        })
        await send(hostHelloType)

        if (child !== spawned || !hello) throw new Error("The native audio host did not complete its handshake.")
        evidence?.("hostHello", { pid: spawned.pid ?? null, lifecycleGeneration: generation })

        return hello
      })()

      startPromise = attempt
      void attempt.then(
        () => {
          if (startPromise === attempt) startPromise = undefined
        },
        () => {
          if (startPromise === attempt) startPromise = undefined

          if (spawned && child === spawned) lost("The native audio host could not start.", spawned)
        },
      )

      return attempt
    },
    runTransaction(operation) {
      return enqueueTransaction(async () => {
        const generation = lifecycleGeneration
        await supervisor.start()

        if (generation !== lifecycleGeneration || teardownPromise) {
          throw new Error("The native audio host transaction was cancelled.")
        }

        if (transactionOwner) throw new Error("The native audio host transaction is unavailable.")
        const owner = Symbol("native-audio-host-transaction")
        transactionOwner = owner
        let transactionOpen = false

        try {
          await send(transactionBeginType, undefined, owner)
          transactionOpen = true

          const value = await operation({
            attachVst: (input) => attachVst(input, undefined, owner),
          })

          await send(transactionCommitType, undefined, owner)
          transactionOpen = false

          return value
        } catch (error) {
          if (transactionOpen) {
            try {
              await send(transactionRollbackType, undefined, owner)
            } catch {
              // The original transaction failure remains authoritative.
            }
          }

          throw error
        } finally {
          if (transactionOwner === owner) transactionOwner = undefined
        }
      })
    },
    async configure(input, transactionToken) {
      evidence?.("structural-rebuild", { pid: child?.pid ?? null, lifecycleGeneration, cause: "device-configure" })
      const payload = serializeDeviceConfiguration(input)

      if (!payload) throw new Error("The native audio host configuration is invalid.")
      await request(deviceConfigureType, payload, transactionToken)
      runtimeRevision = Math.max(runtimeRevision, input.revision)
    },
    async beginTransaction() {
      const invalidationVersion = manualTransactionInvalidationVersion

      return enqueueTransaction(async () => {
        if (invalidationVersion !== manualTransactionInvalidationVersion || transactionOwner) {
          throw new Error("The native audio host transaction is unavailable.")
        }

        const generation = lifecycleGeneration
        await supervisor.start()

        if (
          invalidationVersion !== manualTransactionInvalidationVersion
          || generation !== lifecycleGeneration
          || teardownPromise
          || suspended
        ) throw new Error("The native audio host transaction was cancelled.")
        const owner = Symbol("native-audio-host-manual-transaction")
        const token = randomBytes(32).toString("base64url")
        transactionOwner = owner
        manualTransactionToken = token
        manualTransactionGeneration = generation
        let nativeTransactionOpen = false

        try {
          await send(transactionBeginType, undefined, owner)
          nativeTransactionOpen = true

          if (
            invalidationVersion !== manualTransactionInvalidationVersion
            || generation !== lifecycleGeneration
            || transactionOwner !== owner
            || manualTransactionToken !== token
          ) throw new Error("The native audio host transaction was cancelled.")

          return token
        } catch (error) {
          if (nativeTransactionOpen) {
            try {
              await send(transactionRollbackType, undefined, owner)
            } catch {
              // A lost host may reject the best-effort cleanup.
            }
          }

          if (transactionOwner === owner && manualTransactionToken === token) {
            transactionOwner = undefined
            manualTransactionToken = undefined
            manualTransactionGeneration = -1
          }

          throw error
        }
      })
    },
    async invalidateManualTransaction() {
      manualTransactionInvalidationVersion += 1

      if (manualInvalidationPromise) return manualInvalidationPromise
      const owner = transactionOwner
      const token = manualTransactionToken

      if (!owner || !token) return
      const generation = manualTransactionGeneration
      manualTransactionToken = undefined
      manualTransactionGeneration = -1

      const operation = transactionTail.then(async () => {
        const current = child

        const shouldRollback = (
          generation === lifecycleGeneration
          && current !== undefined
          && hello !== undefined
          && !suspended
          && teardownPromise === undefined
          && transactionOwner === owner
        )

        try {
          if (shouldRollback) {
            try {
              await send(transactionRollbackType, undefined, owner)
            } catch {
              // Renderer loss must release local ownership even if rollback fails.
            }
          }
        } finally {
          if (transactionOwner === owner) transactionOwner = undefined
        }
      })

      manualInvalidationPromise = operation
      transactionTail = operation.then(() => undefined, () => undefined)
      void operation.then(
        () => {
          if (manualInvalidationPromise === operation) manualInvalidationPromise = undefined
        },
        () => {
          if (manualInvalidationPromise === operation) manualInvalidationPromise = undefined
        },
      )

      return operation
    },
    async commitTransaction(transactionToken) {
      const invalidationVersion = manualTransactionInvalidationVersion

      return enqueueTransaction(async () => {
        const owner = assertTransactionAccess(transactionToken)

        if (!owner) throw new Error("The native audio host transaction is unavailable.")

        try {
          await send(transactionCommitType, undefined, owner)

          if (
            invalidationVersion !== manualTransactionInvalidationVersion
            || manualTransactionToken !== transactionToken
            || manualTransactionGeneration !== lifecycleGeneration
          ) {
            try {
              await send(transactionRollbackType, undefined, owner)
            } catch {
              lost("The native audio host transaction was committed after renderer invalidation.")
            }

            throw new Error("The native audio host transaction was cancelled.")
          }
        } finally {
          if (transactionOwner === owner) {
            transactionOwner = undefined
            manualTransactionToken = undefined
            manualTransactionGeneration = -1
          }
        }
      })
    },
    async rollbackTransaction(transactionToken) {
      const invalidationVersion = manualTransactionInvalidationVersion

      return enqueueTransaction(async () => {
        const owner = assertTransactionAccess(transactionToken)

        if (!owner) throw new Error("The native audio host transaction is unavailable.")

        try {
          await send(transactionRollbackType, undefined, owner)

          if (
            invalidationVersion !== manualTransactionInvalidationVersion
            || manualTransactionToken !== transactionToken
            || manualTransactionGeneration !== lifecycleGeneration
          ) {
            throw new Error("The native audio host transaction was cancelled.")
          }
        } finally {
          if (transactionOwner === owner) {
            transactionOwner = undefined
            manualTransactionToken = undefined
            manualTransactionGeneration = -1
          }
        }
      })
    },
    async attachVst(input, transactionToken) {
      await attachVst(input, transactionToken)
    },
    async getVstState(instanceId, transactionToken, signal) {
      const payload = serializeVstInstanceId(instanceId)

      if (!payload) throw new Error("The native VST state request is invalid.")
      signal?.throwIfAborted()
      await supervisor.start()

      if (!child) throw new Error("The native audio host is unavailable.")
      signal?.throwIfAborted()
      const owner = assertTransactionAccess(transactionToken)

      if (owner) throw new Error("The native audio host transaction token is invalid.")
      let queued: QueuedRequest | undefined

      const requestPromise = new Promise<{ bytes: Uint8Array; sha256: string }>((resolve, reject) => {
        queued = broker.submit({
          type: vstStateGetType,
          payload,
          reject,
          reply: { kind: "vstState", resolve, instanceId, cancelled: false },
        })

        if (!queued) reject(new Error("The native host request queue is full."))
      })

      if (!signal) return requestPromise

      return new Promise((resolve, reject) => {
        const abort = () => {
          const abortError = new DOMException("Native VST state capture canceled.", "AbortError")

          if (!queued || !broker.cancelQueued(queued, abortError)) broker.cancelPendingVstState(instanceId, abortError)
          reject(abortError)
        }

        signal.addEventListener("abort", abort, { once: true })
        requestPromise.then(
          (value) => {
            signal.removeEventListener("abort", abort)
            resolve(value)
          },
          (error: Error) => {
            signal.removeEventListener("abort", abort)
            reject(error)
          },
        )
      })
    },
    async detachVst(instanceId, transactionToken) {
      const payload = serializeVstInstanceId(instanceId)

      if (!payload) throw new Error("The native VST attachment is invalid.")

      try {
        await request(vstDetachType, payload, transactionToken)

        return { status: "detached" }
      } catch (error) {
        if (error instanceof NativeAudioHostCommandError && error.reason === "refused") {
          return { status: "refused" }
        }

        throw error
      }
    },
    async executeVstEditorCommand(input, transactionToken) {
      const payload = serializeVstEditor(input)

      if (!payload) throw new Error("The native VST editor command is invalid.")

      return requestEditor(payload, assertTransactionAccess(transactionToken))
    },
    async installAsset(input, transactionToken) {
      const payload = serializeAssetInstall(input)

      if (!payload) throw new Error("The native audio host asset is invalid.")
      evidence?.("asset-install", { pid: child?.pid ?? null, sessionAssetId: input.sessionAssetId })
      await request(assetInstallType, payload, transactionToken)
    },
    async createMappedAsset(input, transactionToken) {
      const hash = input.contentHashPrefix ?? 0n

      if (
        !unsigned32(input.sessionAssetId) || input.sessionAssetId === 0
        || !Number.isSafeInteger(input.frameCount) || input.frameCount <= 0
        || !unsigned32(input.sampleRateHz) || input.sampleRateHz === 0
        || !unsigned32(input.channelCount) || input.channelCount === 0 || input.channelCount > maximumAssetChannels
        || hash < 0n || hash > unsigned64Max
      ) throw new Error("The native mapped audio asset is invalid.")
      const payload = Buffer.alloc(28)
      payload.writeUInt32BE(input.sessionAssetId, 0)
      payload.writeBigUInt64BE(BigInt(input.frameCount), 4)
      payload.writeUInt32BE(input.sampleRateHz, 12)
      payload.writeUInt32BE(input.channelCount, 16)
      payload.writeBigUInt64BE(hash, 20)
      evidence?.("asset-install", { pid: child?.pid ?? null, sessionAssetId: input.sessionAssetId })
      await request(mappedAssetCreateType, payload, transactionToken)
    },
    async writeMappedAssetPage(input, transactionToken) {
      if (
        !unsigned32(input.sessionAssetId) || input.sessionAssetId === 0
        || !Number.isSafeInteger(input.startFrame) || input.startFrame < 0
        || !unsigned32(input.frameCount) || input.frameCount === 0
        || input.planarPcm.byteLength === 0
        || input.planarPcm.byteLength > maximumPayloadBytes - 16
        || input.planarPcm.byteLength % (input.frameCount * 4) !== 0
      ) throw new Error("The native mapped audio page is invalid.")
      const pageHeader = Buffer.allocUnsafe(16)
      pageHeader.writeUInt32BE(input.sessionAssetId, 0)
      pageHeader.writeBigUInt64BE(BigInt(input.startFrame), 4)
      pageHeader.writeUInt32BE(input.frameCount, 12)
      evidence?.("asset-page-write", { pid: child?.pid ?? null, sessionAssetId: input.sessionAssetId, bytes: input.planarPcm.byteLength })
      await request(mappedAssetWritePageType, [pageHeader, input.planarPcm], transactionToken)
    },
    async prepareMappedAssetRange(sessionAssetId, startFrame, frameCount, transactionToken) {
      if (
        !unsigned32(sessionAssetId) || sessionAssetId === 0
        || !Number.isSafeInteger(startFrame) || startFrame < 0
        || !Number.isSafeInteger(frameCount) || frameCount <= 0
      ) throw new Error("The native mapped audio range is invalid.")
      const payload = Buffer.alloc(20)
      payload.writeUInt32BE(sessionAssetId, 0)
      payload.writeBigUInt64BE(BigInt(startFrame), 4)
      payload.writeBigUInt64BE(BigInt(frameCount), 12)
      await request(mappedAssetPrepareRangeType, payload, transactionToken)
    },
    async releaseMappedAsset(sessionAssetId, transactionToken) {
      if (!unsigned32(sessionAssetId) || sessionAssetId === 0) throw new Error("The native mapped audio asset is invalid.")
      await request(mappedAssetReleaseType, writeUnsigned32(sessionAssetId), transactionToken)
    },
    async releaseAsset(sessionAssetId, transactionToken) {
      if (!unsigned32(sessionAssetId) || sessionAssetId === 0) throw new Error("The native audio host asset is invalid.")
      await request(assetReleaseType, writeUnsigned32(sessionAssetId), transactionToken)
    },
    async publishGraph(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 13)

      if (!payload) throw new Error("The native audio host graph payload is invalid.")
      await request(graphSnapshotType, payload, transactionToken)
      runtimeRevision = Math.max(runtimeRevision, Number(payload.readBigUInt64BE(0)))
    },
    async configureInstrumentStates(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 4)

      if (!payload) throw new Error("The native audio host instrument state payload is invalid.")
      await request(instrumentStatesType, payload, transactionToken)
    },
    async prepareGraphRevision(bytes, requestedPublicationFrame = 0n, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 13)

      if (!payload) throw new NativeAudioHostNotSentError("The native audio host graph payload is invalid.")
      runtimeRevision = Math.max(runtimeRevision, Number(payload.readBigUInt64BE(0)))

      if (requestedPublicationFrame < 0n || requestedPublicationFrame > 0x7fff_ffff_ffff_ffffn) {
        throw new NativeAudioHostNotSentError("The native graph publication frame is invalid.")
      }

      const request = Buffer.alloc(20 + payload.byteLength - 12)
      request.writeBigUInt64BE(requestedPublicationFrame, 0)
      request.writeBigUInt64BE(payload.readBigUInt64BE(0), 8)
      request.writeUInt32BE(payload.readUInt32BE(8), 16)
      payload.copy(request, 20, 12)

      return requestGraphRevision(graphPrepareType, request, transactionToken)
    },
    allocateRuntimeRevision() {
      if (!child || !hello || runtimeRevision >= unsigned32Max)
        throw new NativeAudioHostNotSentError("The native runtime revision allocator is unavailable or exhausted.")

      return ++runtimeRevision
    },
    async inspectGraphRevision(revision, transactionToken) {
      if (!unsigned32(revision) || revision === 0) throw new NativeAudioHostNotSentError("The native audio host graph revision is invalid.")

      return requestGraphRevision(graphRevisionStatusType, writeUnsigned32(revision), transactionToken)
    },
    async publishGraphRevision(revision, requestedPublicationFrame = 0n, transactionToken) {
      if (!unsigned32(revision) || revision === 0) throw new NativeAudioHostNotSentError("The native audio host graph revision is invalid.")

      if (requestedPublicationFrame < 0n || requestedPublicationFrame > 0x7fff_ffff_ffff_ffffn) {
        throw new NativeAudioHostNotSentError("The native graph publication frame is invalid.")
      }

      const payload = Buffer.alloc(12)
      payload.writeUInt32BE(revision, 0)
      payload.writeBigUInt64BE(requestedPublicationFrame, 4)

      return requestGraphRevision(graphPublishType, payload, transactionToken)
    },
    async rollbackGraphRevision(revision, transactionToken) {
      if (!unsigned32(revision) || revision === 0) throw new NativeAudioHostNotSentError("The native audio host graph revision is invalid.")

      return requestGraphRevision(graphRollbackType, writeUnsigned32(revision), transactionToken)
    },
    async retireGraphRevision(revision, transactionToken) {
      if (!unsigned32(revision) || revision === 0) throw new NativeAudioHostNotSentError("The native audio host graph revision is invalid.")

      return requestGraphRevision(graphRetireType, writeUnsigned32(revision), transactionToken)
    },
    async queueParameterEvents(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 4)

      if (!payload) throw new NativeAudioHostNotSentError("The native audio host parameter payload is invalid.")
      await request(parameterEventsType, payload, transactionToken)
    },
    async queueProcessorStatePatch(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 56)

      if (!payload) throw new NativeAudioHostNotSentError("The native audio host processor state patch is invalid.")

      return requestPatchStatus(payload, transactionToken)
    },
    async queueVstParameterEvents(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 8)

      if (!payload) throw new Error("The native VST parameter payload is invalid.")
      await request(vstParameterEventsType, payload, transactionToken)
    },
    async queueInstrumentEvents(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 4)

      if (!payload) throw new NativeAudioHostNotSentError("The native audio host instrument payload is invalid.")
      await request(midiEventsType, payload, transactionToken)
    },
    async queueScheduleWindow(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 56)

      if (!payload) throw new Error("The native schedule window payload is invalid.")
      // Header offsets 0 and 56 of serializeNativeScheduleWindow: the revision and the processor automation (lane) event count.
      evidence?.("schedule-window", { revision: payload.readUInt32LE(0), processorAutomationEvents: payload.readUInt32LE(56) })
      await request(scheduleWindowType, payload, transactionToken)
    },
    async reenableVstScheduleAutomation(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 8)

      if (!payload) throw new Error("The native VST schedule automation enable payload is invalid.")
      await request(vstScheduleAutomationEnableType, payload, transactionToken)
    },
    async queueSourceEvents(bytes, transactionToken) {
      const payload = nativeBinaryPayload(bytes, 4)

      if (!payload) throw new Error("The native audio host source payload is invalid.")
      await request(sourceEventsType, payload, transactionToken)
    },
    async setTransport(input, transactionToken) {
      const transitionId = input.transitionId ?? (nextTransportTransitionId + 1n)

      if (transitionId > nextTransportTransitionId) nextTransportTransitionId = transitionId
      const payload = serializeTransport({...input, transitionId})

      if (!payload) throw new Error("The native audio host transport is invalid.")
      await request(transportType, payload, transactionToken)
    },
    async resolveOutputDevice(preferredDeviceId) {
      assertTransactionAccess(undefined)
      await supervisor.start()
      const current = child

      if (!current || broker.pending() || (preferredDeviceId !== undefined && !coreAudioDeviceId(preferredDeviceId))) {
        throw new Error("The native audio host device request is invalid.")
      }

      const payload = preferredDeviceId === undefined ? undefined : Buffer.from(preferredDeviceId, "utf8")
      const frame = encodeNativeAudioHostControlFrame(deviceListType, payload)

      if (!frame) throw new Error("The native audio host protocol is unavailable.")

      return new Promise<NativeOutputDevice | null>((resolve, reject) => {
        broker.startDirect(current, deviceListType, frame, { kind: "outputDevice", resolve }, reject,
          "The native audio host device request timed out.")
      })
    },
    async resolveInputDevice(preferredDeviceId) {
      assertTransactionAccess(undefined)
      await supervisor.start()
      const current = child

      if (!current || broker.pending() || (preferredDeviceId !== undefined && !coreAudioDeviceId(preferredDeviceId))) {
        throw new Error("The native audio host input device request is invalid.")
      }

      const payload = preferredDeviceId === undefined ? undefined : Buffer.from(preferredDeviceId, "utf8")
      const frame = encodeNativeAudioHostControlFrame(recordingDeviceQueryType, payload)

      if (!frame) throw new Error("The native audio host protocol is unavailable.")

      return new Promise<NativeInputDevice | null>((resolve, reject) => {
        broker.startDirect(current, recordingDeviceQueryType, frame, { kind: "inputDevice", resolve }, reject,
          "The native audio host input device request timed out.")
      })
    },
    async listDevices() {
      assertTransactionAccess(undefined)
      await supervisor.start()

      return new Promise<NativeAudioDevice[]>((resolve, reject) => {
        if (!broker.admits(undefined)) {
          reject(new NativeAudioHostNotSentError("The native audio host is unavailable."))

          return
        }

        const queued = broker.submit({ type: deviceInventoryQueryType, reject, reply: { kind: "deviceInventory", resolve } })

        if (!queued) reject(new NativeAudioHostNotSentError(broker.queueFullMessage(deviceInventoryQueryType)))
      })
    },
    async startAudio() {
      await request(startType)
    },
    async startDiagnosticAudio() {
      await request(diagnosticStartType)
    },
    async stopAudio(reason = "unspecified") {
      if (reason.length === 0 || reason.length > 120 || !/^[A-Za-z0-9_-]+$/.test(reason)
        || Buffer.byteLength(reason, "utf8") > 120) {
        throw new Error("The native audio stop reason is invalid.")
      }

      await supervisor.waitForRecordingFinish()
      const reasonBytes = Buffer.from(reason, "utf8")
      const payload = Buffer.alloc(4 + reasonBytes.byteLength)
      payload.writeUInt32BE(reasonBytes.byteLength, 0)
      reasonBytes.copy(payload, 4)
      await request(stopType, payload, undefined, reason)
    },
    async diagnostics() {
      assertTransactionAccess(undefined)
      await supervisor.start()
      const current = child

      if (!current || broker.pending()) throw new Error("The native audio host is unavailable.")
      const frame = encodeNativeAudioHostControlFrame(diagnosticsType)

      if (!frame) throw new Error("The native audio host protocol is unavailable.")

      return new Promise<NativeHostDiagnostics>((resolve, reject) => {
        broker.startDirect(current, diagnosticsType, frame, { kind: "diagnostics", resolve }, reject,
          "The native audio host diagnostics timed out.")
      })
    },
    async configureRecording(input, spool) {
      const payload = serializeRecordingConfiguration(input, spool)

      if (!payload) throw new Error("The native recording configuration is invalid.")

      if (recordingFinish?.pending) throw new Error("Native recording is finishing.")

      if (recordingAdmitted) throw new Error("Native recording is already admitted.")
      recordingAdmitted = true
      recordingConfiguration = input
      recordingFinish = undefined
      let resolve: (status: NativeHostRecordingStatus) => void = () => {}
      let reject: (error: Error) => void = () => {}
      const promise = new Promise<NativeHostRecordingStatus>((yes, no) => { resolve = yes; reject = no })
      bestEffort(promise, 'the awaiting caller observes this rejection')
      recordingReady = { promise, resolve, reject }

      try {
        try { await request(recordingConfigureType, payload) }
        catch (error) { throw new NativeRecordingConfigureError("request",
          error instanceof Error ? error : new Error("Native recording configure request failed.")) }

        try { return await promise }
        catch (error) { throw new NativeRecordingConfigureError("readiness",
          error instanceof Error ? error : new Error("Native recording readiness failed.")) }
      }
      catch (error) {
        recordingAdmitted = false
        reject(error instanceof Error ? error : new Error("Recording configure failed."))
        throw error
      }
    },
    async startRecording() {
      await recordingReady?.promise
      await request(recordingStartType)
    },
    async stopRecording(stopFrame) {
      if (stopFrame !== undefined && (!Number.isSafeInteger(stopFrame) || stopFrame < 0)) {
        throw new Error("The native recording stop frame is invalid.")
      }

      if (recordingFinish?.pending) throw new Error("Native recording is already finishing.")
      let resolve: () => void = () => {}
      let reject: (error: Error) => void = () => {}
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
      bestEffort(promise, 'the awaiting caller observes this rejection')
      const finish = { pending: true, dispatched: false, promise, resolve, reject }
      recordingFinish = finish
      let payload: Buffer | undefined

      if (stopFrame !== undefined) { payload = Buffer.alloc(8); payload.writeBigInt64BE(BigInt(stopFrame)) }

      try { await request(recordingStopType, payload) }
      catch (error) {
        finish.pending = false
        reject(error instanceof Error ? error : new Error("Recording stop was interrupted."))
        throw error
      }
    },
    async cancelRecording() {
      if (recordingFinish?.pending) throw new Error("Accepted recording Finish cannot be cancelled.")
      await request(recordingCancelType)
    },
    async teardownSession() {
      if (!child && !startPromise) return

      if (!hello) await supervisor.start()
      await request(teardownType)
    },
    // Lifecycle waits for settlement; callers requesting the take outcome use
    // the separate rejecting promise. Failure cannot veto future shutdown.
    waitForRecordingFinish: () => recordingFinish?.promise.then(() => undefined, () => undefined) ?? Promise.resolve(),
    waitForRecordingOutcome: () => recordingFinish?.promise ?? Promise.resolve(),
    recordingAdmissionAvailable: () => !recordingAdmitted && !recordingFinish?.pending,
    recordingFinalizationPending: () => recordingFinish?.pending === true,
    teardown() {
      evidence?.("host-teardown-request", { pid: child?.pid ?? null, lifecycleGeneration, cause: "application-shutdown" })

      if (teardownPromise) return teardownPromise
      lifecycleGeneration += 1
      lifecycleIntentVersion += 1
      const current = child

      if (current) evidenceTerminationCauses.set(current, "application-shutdown")
      const hadPending = broker.pending() !== undefined
      const pendingRequestName = broker.pendingRequestName()
      const termination = childTerminationPromise

      const stopping = (async () => {
        // No unconditional microtask while cancelling an ordinary handshake:
        // invalidate it synchronously. A real pending Finish still owns a barrier.
        if (recordingFinish?.pending) await supervisor.waitForRecordingFinish()

        try {
          if (termination) await termination
          else if (hadPending) broker.rejectPending(new Error("The native audio host is tearing down."))
          else if (current && hello && !transactionOwner) await send(teardownType, undefined, undefined, true)
        } finally {
          broker.rejectPending(new Error("The native audio host is tearing down."))
          transactionOwner = undefined
          manualTransactionToken = undefined
          manualTransactionGeneration = -1

          if (child === current) child = undefined
          recordingAdmitted = false
          hello = undefined
          buffer = Buffer.alloc(0)

          if (current) console.error("[native-audio-host-termination-request]", JSON.stringify({
            reason: "application-shutdown",
            timestamp: Date.now(),
            lifecycleGeneration,
            pid: current.pid ?? null,
            signal: "SIGTERM",
            pendingRequest: pendingRequestName,
          }))
          current?.kill()
        }
      })()

      teardownPromise = stopping
      void stopping.then(
        () => {
          if (teardownPromise === stopping) teardownPromise = undefined
        },
        () => {
          if (teardownPromise === stopping) teardownPromise = undefined
        },
      )

      return stopping
    },
    suspend() {
      evidence?.("host-suspend-request", { pid: child?.pid ?? null, lifecycleGeneration, cause: "quit-or-suspend" })

      if (child && evidence) evidenceTerminationCauses.set(child, "quit")

      if (recordingSuspendPromise) return recordingSuspendPromise

      if (recordingFinish?.pending) {
        const finishing = supervisor.waitForRecordingFinish().then(() => {
          recordingSuspendPromise = undefined

          return supervisor.suspend()
        })

        recordingSuspendPromise = finishing

        return finishing
      }

      if (suspended && !resumePromise) return childTerminationPromise ?? (terminationFailure
        ? Promise.reject(terminationFailure)
        : Promise.resolve())
      suspended = true
      lifecycleIntentVersion += 1
      lifecycleGeneration += 1
      const current = child

      if (current) evidenceTerminationCauses.set(current, "app-suspend")
      const error = new Error("The native audio host was suspended.")
      // Install the boundary before settling anything: rejected work must not
      // dispatch another pre-suspend command.
      child = undefined
      recordingAdmitted = false
      hello = undefined
      startPromise = undefined
      transactionOwner = undefined
      manualTransactionToken = undefined
      manualTransactionGeneration = -1
      nextTransportTransitionId = 0n
      buffer = Buffer.alloc(0)
      broker.rejectPending(error, false)
      broker.rejectQueued(error)

      if (current) {
        try {
          const frame = encodeNativeAudioHostControlFrame(teardownType)

          if (frame) current.stdin.write(frame)
        } catch {}
      }

      const termination = childTerminationPromise ?? (current ? terminateDetachedChild(current) : Promise.resolve())
      childTerminationPromise = termination
      void termination.then(
        () => {
          if (childTerminationPromise === termination) childTerminationPromise = undefined
        },
        () => {
          if (childTerminationPromise === termination) childTerminationPromise = undefined
        },
      )

      return termination
    },
    resume() {
      if (recordingSuspendPromise) {
        return recordingSuspendPromise.then(() => supervisor.resume())
      }

      if (teardownPromise) return teardownPromise

      if (resumePromise) return resumePromise

      if (terminationFailure) return Promise.reject(terminationFailure)
      const requestedIntentVersion = lifecycleIntentVersion + 1
      lifecycleIntentVersion = requestedIntentVersion
      const termination = childTerminationPromise ?? Promise.resolve()

      const next = termination.then(() => {
        if (lifecycleIntentVersion === requestedIntentVersion) suspended = false
      })

      resumePromise = next
      void next.then(
        () => {
          if (resumePromise === next) resumePromise = undefined
        },
        () => {
          if (resumePromise === next) resumePromise = undefined
        },
      )

      return next
    },
    status: () => ({ running: child !== undefined && hello !== undefined, hello: hello ? hello : undefined,
      generation: lifecycleGeneration, pid: child?.pid }),
    transactionOpen: () => transactionOwner !== undefined,
    onLoss(listener) {
      lossListeners.add(listener)

      return () => lossListeners.delete(listener)
    },
    onRecordingStatus(listener) {
      recordingStatusListeners.add(listener)

      return () => recordingStatusListeners.delete(listener)
    },
    onMeterBatch(listener) {
      meterBatchListeners.add(listener)

      return () => meterBatchListeners.delete(listener)
    },
    async setSpectrumNode(nodeId) {
      const payload = Buffer.from(serializeNativeSpectrumSelection(nodeId))
      await request(spectrumSelectionType, payload)
    },
    onSpectrumFrame(listener) {
      spectrumFrameListeners.add(listener)

      return () => spectrumFrameListeners.delete(listener)
    },
    onScheduleProgress(listener) {
      scheduleProgressListeners.add(listener)

      return () => scheduleProgressListeners.delete(listener)
    },
    onWorkerNotification(listener) {
      workerNotificationListeners.add(listener)

      return () => workerNotificationListeners.delete(listener)
    },
  }

  return supervisor
}

export const probeNativeAudioOutputDevice = async (
  hostPath: string,
  preferredDeviceId?: string,
  createSupervisor: (hostPath: string) => NativeAudioHostSupervisor = createNativeAudioHostSupervisor,
): Promise<NativeOutputDevice | null> => {
  const probe = createSupervisor(hostPath)

  try {
    return await probe.resolveOutputDevice(preferredDeviceId)
  } finally {
    await probe.teardown().catch(() => undefined)
  }
}
