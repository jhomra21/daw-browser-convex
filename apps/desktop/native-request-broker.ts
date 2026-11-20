import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process"
import path from "node:path"
import type { HostEvidence } from "./ae08-evidence"
import {
  nativeAudioHostControlTypes,
  nativeAudioHostFrameHeaderBytes as headerBytes,
  nativeAudioHostMagic as magic,
  nativeAudioHostMaximumPayloadBytes as maximumPayloadBytes,
  nativeAudioHostProtocolVersion as protocolVersion,
} from "@daw-browser/desktop-protocol/native-audio-host"
import type { NativeGraphRevisionStatus } from "@daw-browser/desktop-protocol/native-revision"
import type {
  NativeAudioDevice,
  NativeHostDiagnostics,
  NativeInputDevice,
  NativeOutputDevice,
  NativeProcessorPatchStatus,
} from "@daw-browser/audio-engine/native-host-wire"

const {
  transport: transportType,
  midiEvents: midiEventsType,
  stop: stopType,
  teardown: teardownType,
  recordingStop: recordingStopType,
  scheduleWindow: scheduleWindowType,
  vstScheduleAutomationEnable: vstScheduleAutomationEnableType,
} = nativeAudioHostControlTypes

type ControlTypes = typeof nativeAudioHostControlTypes

export type NativeHostRequestType = ControlTypes[
  | "hostHello" | "deviceConfigure" | "assetInstall" | "assetRelease" | "mappedAssetCreate"
  | "mappedAssetWritePage" | "mappedAssetPrepareRange" | "mappedAssetRelease" | "start" | "stop"
  | "teardown" | "graphSnapshot" | "transport" | "parameterEvents" | "processorStatePatch"
  | "midiEvents" | "sourceEvents" | "deviceList" | "transactionBegin" | "transactionCommit"
  | "transactionRollback" | "vstParameterEvents" | "vstMidiEvents" | "vstStateSet" | "vstStateGet"
  | "vstState" | "recordingConfigure" | "recordingStart" | "recordingStop" | "recordingCancel"
  | "recordingDeviceQuery" | "deviceInventoryQuery" | "graphPrepare" | "graphPublish" | "graphRetire"
  | "graphRollback" | "graphRevisionStatus" | "vstAttach" | "vstDetach" | "vstEditor"
  | "diagnosticStart" | "diagnostics" | "scheduleWindow" | "vstScheduleAutomationEnable"
  | "instrumentStates" | "spectrumSelection"
]

export type NativeVstEditorStatus = {
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

export const nativeAudioHostControlWatchdogMs = 2_000
export const nativeAudioHostStackCaptureDeadlineMs = 1_500
const slowHotControlAckThresholdMs = 250

const nativeAudioHostRequestNames = new Map<number, string>(
  Object.entries(nativeAudioHostControlTypes).map(([name, type]) => [type, name]),
)

export const nativeAudioHostRequestName = (type: number) =>
  nativeAudioHostRequestNames.get(type) ?? "unknown"

/** The request was refused locally; no byte of it reached the host. */
export class NativeAudioHostNotSentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NativeAudioHostNotSentError"
  }
}

// A payload given as parts is joined into the frame in one copy, so a large page need not be assembled first.
export type NativeControlPayload = Uint8Array | readonly Uint8Array[]

export const encodeNativeAudioHostControlFrame = (type: number, payload: NativeControlPayload = new Uint8Array()) => {
  const parts = payload instanceof Uint8Array ? [payload] : payload
  const payloadBytes = parts.reduce((total, part) => total + part.byteLength, 0)

  if (payloadBytes > maximumPayloadBytes) return undefined
  const header = Buffer.allocUnsafe(headerBytes)
  header.writeUInt32BE(magic, 0)
  header.writeUInt32BE(protocolVersion, 4)
  header.writeUInt32BE(type, 8)
  header.writeUInt32BE(payloadBytes, 12)

  return Buffer.concat([header, ...parts], headerBytes + payloadBytes)
}

type Reply =
  | { kind: "ack"; expectedAckType: NativeHostRequestType; resolve: () => void }
  | { kind: "diagnostics"; resolve: (value: NativeHostDiagnostics) => void }
  | { kind: "outputDevice"; resolve: (value: NativeOutputDevice | null) => void }
  | { kind: "inputDevice"; resolve: (value: NativeInputDevice | null) => void }
  | { kind: "deviceInventory"; resolve: (value: NativeAudioDevice[]) => void }
  | { kind: "graphRevision"; requestedRevision: number; resolve: (value: NativeGraphRevisionStatus) => void }
  | { kind: "vstState"; instanceId: string; resolve: (value: { bytes: Uint8Array; sha256: string }) => void; cancelled: boolean }
  | { kind: "editor"; resolve: (value: NativeVstEditorStatus) => void }
  | { kind: "patchStatus"; resolve: (value: NativeProcessorPatchStatus) => void }

type PendingControl = {
  reject: (error: Error) => void
  deadline: ReturnType<typeof setTimeout>
  requestType: NativeHostRequestType
  requestId: number
  enqueuedAt: number
  dispatchedAt: number
  reason?: string
  stdinBackpressure?: boolean
  reply: Reply
}

export type NativeRequest = {
  type: NativeHostRequestType
  payload?: NativeControlPayload
  owner?: symbol
  allowDuringTeardown?: boolean
  reason?: string
  reject: (error: Error) => void
  reply: Reply
}

export type QueuedRequest = NativeRequest & { requestId: number; enqueuedAt: number }

/** The supervisor's lifecycle, read when a request is admitted, dispatched or times out. */
type NativeRequestBrokerHost = {
  readonly child: ChildProcessWithoutNullStreams | undefined
  readonly generation: number
  readonly suspended: boolean
  readonly tearingDown: boolean
  readonly transactionOwner: symbol | undefined
  readonly recordingFinishDispatched: boolean
  readonly evidence: HostEvidence | undefined
  markRecordingFinishDispatched(): void
  lost(message: string, source: ChildProcessWithoutNullStreams | undefined): void
}

const isHotControlRequest = (type: NativeHostRequestType) => (
  type === scheduleWindowType
  || type === midiEventsType
  || type === transportType
  || type === vstScheduleAutomationEnableType
)

const urgentLaneTypes: readonly NativeHostRequestType[] = [
  transportType, midiEventsType, stopType, teardownType, vstScheduleAutomationEnableType,
]

export const createNativeRequestBroker = (host: NativeRequestBrokerHost) => {
  let pending: PendingControl | undefined
  let nextControlRequestId = 0
  const urgentSends: QueuedRequest[] = []
  const normalSends: QueuedRequest[] = []
  const refillSends: QueuedRequest[] = []

  const laneFor = (type: NativeHostRequestType) => (
    urgentLaneTypes.includes(type)
      ? { queue: urgentSends, limit: 64, fullMessage: "The native audio host urgent request queue is full." }
      : type === scheduleWindowType
      ? { queue: refillSends, limit: 8, fullMessage: "The native audio host schedule queue is full." }
      : { queue: normalSends, limit: 32, fullMessage: "The native audio host request queue is full." }
  )

  const queueDepth = () => urgentSends.length + normalSends.length + refillSends.length

  // Per-request control lines are acceptance evidence: they fire for every inspect, prepare, publish and page write, so
  // production writes none of them.
  const logControlEnqueue = (
    type: NativeHostRequestType,
    requestId: number,
    enqueuedAt: number,
    reason?: string,
  ) => {
    if (!host.evidence || isHotControlRequest(type)) return
    console.info("[native-audio-host-control]", JSON.stringify({
      phase: "enqueue",
      requestId,
      request: nativeAudioHostRequestName(type),
      pid: host.child?.pid ?? null,
      generation: host.generation,
      reason: reason ?? null,
      enqueuedAt,
      queueDepth: queueDepth(),
    }))
  }

  const logControlAck = (control: PendingControl, accepted = true) => {
    const elapsedMs = performance.now() - control.dispatchedAt

    // Hot acks are logged only when slow (a rare anomaly, always logged) to avoid playback log and main-thread overhead.
    // Every other ack needs the evidence switch.
    const shouldLog = isHotControlRequest(control.requestType)
      ? elapsedMs >= slowHotControlAckThresholdMs
      : Boolean(host.evidence)

    if (!shouldLog) return
    console.info("[native-audio-host-control]", JSON.stringify({
      phase: "ack",
      requestId: control.requestId,
      request: nativeAudioHostRequestName(control.requestType),
      pid: host.child?.pid ?? null,
      generation: host.generation,
      reason: control.reason ?? null,
      ackAt: Date.now(),
      elapsedMs,
      accepted,
    }))
  }

  const logControlWrite = (
    control: PendingControl,
    child: ChildProcessWithoutNullStreams,
    stdinBackpressure: boolean,
  ) => {
    if (!host.evidence || isHotControlRequest(control.requestType)) return
    console.info("[native-audio-host-control]", JSON.stringify({
      phase: "write",
      requestId: control.requestId,
      request: nativeAudioHostRequestName(control.requestType),
      pid: child.pid ?? null,
      generation: host.generation,
      reason: control.reason ?? null,
      enqueuedAt: control.enqueuedAt,
      dispatchedAt: Date.now(),
      queueWaitMs: Math.max(0, Date.now() - control.enqueuedAt),
      queueDepth: queueDepth(),
      stdinBackpressure,
      stdinWritableLength: child.stdin.writableLength,
    }))
  }

  const rejectPending = (error: Error, dispatch = true) => {
    const current = pending
    pending = undefined

    if (current) {
      clearTimeout(current.deadline)
      current.reject(error)
    }

    if (dispatch) dispatchNext()
  }

  const captureHostStack = (
    source: ChildProcessWithoutNullStreams | undefined,
    requestId: number,
    done: () => void,
  ) => {
    const pid = source?.pid

    if (!pid) {
      done()

      return
    }

    const outputPath = path.join("/tmp", `daw-native-audio-host-stack-${pid}-${requestId}.txt`)
    let sampler: ChildProcess

    try {
      sampler = spawn("/usr/bin/sample", [String(pid), "1", "-file", outputPath], { stdio: "ignore" })
    } catch (error) {
      console.error("[native-audio-host-stack-capture]", JSON.stringify({
        pid, requestId, outputPath, error: error instanceof Error ? error.message : "spawn-failed",
      }))
      done()

      return
    }

    // The sample delays termination by at most 1.5 s, deliberately capturing a stuck host's stacks before SIGTERM.
    let finished = false

    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      done()
    }

    const deadline = setTimeout(() => {
      sampler.kill("SIGTERM")
      finish()
    }, nativeAudioHostStackCaptureDeadlineMs)

    sampler.once("error", (error) => {
      console.error("[native-audio-host-stack-capture]", JSON.stringify({ pid, requestId, outputPath, error: error.message }))
      finish()
    })
    sampler.once("close", (code, signal) => {
      console.error("[native-audio-host-stack-capture]", JSON.stringify({ pid, requestId, outputPath, code, signal }))
      finish()
    })
    console.error("[native-audio-host-stack-capture]", JSON.stringify({ pid, requestId, outputPath, status: "started" }))
  }

  const controlTimedOut = (message: string, source: ChildProcessWithoutNullStreams | undefined) => {
    // Only a dispatched Finish can be draining persistence behind a blocked
    // Stop ACK. A queued Stop must not hide the preceding command's stall.
    if (!host.recordingFinishDispatched) {
      const current = pending

      if (current) {
        console.error("[native-audio-host-control-timeout]", JSON.stringify({
          requestId: current.requestId,
          request: nativeAudioHostRequestName(current.requestType),
          pid: source?.pid ?? null,
          generation: host.generation,
          reason: current.reason ?? null,
          enqueuedAt: current.enqueuedAt,
          dispatchedAt: current.dispatchedAt,
          timedOutAt: Date.now(),
          eventLoopDelayMs: Math.max(0, performance.now() - current.dispatchedAt - nativeAudioHostControlWatchdogMs),
          stdinBackpressure: current.stdinBackpressure ?? null,
          queueDepth: queueDepth(),
        }))
        captureHostStack(source, current.requestId, () => {
          // A late reply can release this slot and dispatch a persistence-draining Stop.
          if (pending === current) host.lost(message, source)
        })

        return
      }

      host.lost(message, source)
    }
  }

  const startRequest = (
    child: ChildProcessWithoutNullStreams,
    request: Pick<QueuedRequest, "type" | "requestId" | "enqueuedAt" | "reason" | "reject" | "reply">,
    frame: Buffer,
    timeoutMessage = "The native audio host control request timed out.",
  ) => {
    const dispatchedAt = performance.now()

    // Control liveness is not a recording drain deadline. Stdout may block a
    // Stop ACK while the process-owned writer safely completes persistence.
    // Keep the parser and child until a terminal or actual process-loss event.
    // A missing publication reply is not host loss. Keep the child and allow
    // explicit status reconciliation; never restart or roll back active work.
    // Native transition admission replies pending immediately. This deadline
    // covers a missing control reply, never the duration of rendered warmup,
    // and starts at dispatch, not at enqueue.
    const deadline = request.reply.kind === "graphRevision"
      ? setTimeout(() => {
        rejectPending(new Error("Native graph revision reply timed out; inspect revision status."))
      }, 2_000)
      : setTimeout(
        () => controlTimedOut(timeoutMessage, child),
        nativeAudioHostControlWatchdogMs,
      )

    const started: PendingControl = {
      reject: request.reject,
      deadline,
      requestType: request.type,
      requestId: request.requestId,
      enqueuedAt: request.enqueuedAt,
      dispatchedAt,
      reason: request.reason,
      reply: request.reply,
    }

    pending = started
    started.stdinBackpressure = !child.stdin.write(frame)

    if (pending === started) logControlWrite(started, child, started.stdinBackpressure)
  }

  const permits = (owner: symbol | undefined, allowDuringTeardown: boolean | undefined) => !(
    (host.tearingDown && !allowDuringTeardown)
    || (host.transactionOwner !== undefined && host.transactionOwner !== owner)
  )

  const dispatchNext = (): void => {
    const child = host.child

    if (host.suspended || pending || !child) return
    const next = urgentSends.shift() ?? refillSends.shift() ?? normalSends.shift()

    if (!next) return

    if (!permits(next.owner, next.allowDuringTeardown)) {
      next.reject(new NativeAudioHostNotSentError("The native audio host is unavailable."))
      dispatchNext()

      return
    }

    const frame = encodeNativeAudioHostControlFrame(next.type, next.payload)

    if (!frame) {
      next.reject(new NativeAudioHostNotSentError("The native audio host protocol is unavailable."))
      dispatchNext()

      return
    }

    startRequest(child, next, frame)

    if (next.type === recordingStopType) host.markRecordingFinishDispatched()

    // Main's account of an inspect's wait: what it queued behind (`queuedMs`, 0 when the control slot was free) and what is still queued.
    if (next.reply.kind === "graphRevision") {
      host.evidence?.("inspect-dispatch", { pid: child.pid ?? null, revision: next.reply.requestedRevision, queuedMs: Date.now() - next.enqueuedAt,
        queueDepth: queueDepth() })
    }
  }

  return {
    pending: () => pending,
    pendingRequestName: () => pending?.requestType === undefined
      ? null
      : nativeAudioHostRequestName(pending.requestType),
    /** Whether a request from `owner` may be queued now. */
    admits: (owner: symbol | undefined, allowDuringTeardown?: boolean) => (
      !host.suspended && host.child !== undefined && permits(owner, allowDuringTeardown)
    ),
    /** Queues a request in its lane and dispatches it when the control slot is free. `undefined` means the lane is full. */
    submit: (request: NativeRequest): QueuedRequest | undefined => {
      const lane = laneFor(request.type)

      if (lane.queue.length >= lane.limit) return undefined
      const queued = { ...request, requestId: ++nextControlRequestId, enqueuedAt: Date.now() }
      lane.queue.push(queued)
      logControlEnqueue(queued.type, queued.requestId, queued.enqueuedAt, queued.reason)

      if (queued.reply.kind === "vstState") host.evidence?.("vst-state-get", { pid: host.child?.pid ?? null })
      dispatchNext()

      return queued
    },
    queueFullMessage: (type: NativeHostRequestType) => laneFor(type).fullMessage,
    /** Writes a request now, outside the queue; the caller has checked that the control slot is free. */
    startDirect: (
      child: ChildProcessWithoutNullStreams,
      type: NativeHostRequestType,
      frame: Buffer,
      reply: Reply,
      reject: (error: Error) => void,
      timeoutMessage: string,
    ) => {
      const request = { type, requestId: ++nextControlRequestId, enqueuedAt: Date.now(), reject, reply }
      logControlEnqueue(type, request.requestId, request.enqueuedAt)
      startRequest(child, request, frame, timeoutMessage)
    },
    /** The reply for `current` arrived: free the slot and dispatch the next request. */
    settle: (current: PendingControl, accepted = true) => {
      logControlAck(current, accepted)
      clearTimeout(current.deadline)
      pending = undefined
      dispatchNext()
    },
    rejectPending,
    rejectQueued: (error: Error) => {
      for (const queue of [urgentSends, normalSends, refillSends]) {
        while (queue.length > 0) queue.shift()?.reject(error)
      }
    },
    /** Removes a request that has not been written; false when it already left the queue. */
    cancelQueued: (queued: QueuedRequest, error: Error) => {
      const queue = laneFor(queued.type).queue
      const index = queue.indexOf(queued)

      if (index < 0) return false
      queue.splice(index, 1)
      queued.reject(error)
      dispatchNext()

      return true
    },
    /** The slot stays held until the host answers; the late state is dropped. */
    cancelPendingVstState: (instanceId: string, error: Error) => {
      if (pending?.reply.kind === "vstState" && pending.reply.instanceId === instanceId) {
        pending.reply.cancelled = true
        pending.reject(error)
      }
    },
    /** A child that exits during planned teardown answers the teardown request. */
    resolveTeardownOnExit: () => {
      const closing = pending

      if (closing?.requestType !== teardownType) return
      pending = undefined
      clearTimeout(closing.deadline)

      if (closing.reply.kind === "ack") closing.reply.resolve()
    },
  }
}
