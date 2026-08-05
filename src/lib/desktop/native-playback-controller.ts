import {
  compileLiveNativeProjection,
} from "@daw-browser/audio-engine/live-native-projection"
import {
  mapNativeSessionAssets,
  serializeNativeGraph,
  serializeNativeProcessorStatePatch,
  nativeProcessorLatencyForState,
  nativeProcessorLayoutsForState,
  serializeNativeInstrumentStates,
  serializeNativeInstrumentEvents,
  serializeNativeProcessorEvents,
  serializeNativeVstParameterEvents,
  nativeGraphNodeId,
} from "@daw-browser/audio-engine/native-host-wire"
import { resolveGraphProcessor } from "@daw-browser/audio-engine/mixer/resolve-graph-processor"
import type { SpectrumFrame, TrackStereoLevels, TrackStereoLevelsBatch } from "@daw-browser/audio-engine/audio-engine"
import type {
  NativeHostTransport,
  NativeHostMeterBatch,
  NativeHostSpectrumFrame,
  NativeHostRecordingStatus,
  NativeInstrumentEvent,
  NativeSessionAsset,
  NativeScheduleProgress,
} from "@daw-browser/audio-engine/native-host-wire"
import type { AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import { parseExternalAutomationParameterId } from "@daw-browser/shared"
import { encodeNativeExternalAttachmentPlan, maxVst3WorkerFrames } from "@daw-browser/plugin-host-protocol"
import type { LivePlaybackSnapshot, LivePlaybackSnapshotCompilation, LivePlaybackTransport } from "~/lib/live-playback-snapshot"
import type { EffectParamsCommitPayload } from "~/lib/undo/types"
import { createPortableRecordingWriter } from "~/lib/recording/portable-recording-writer"
import type { DesktopBridge } from "~/types/desktop-bridge"
import type {
  LiveProcessorControl,
  LiveProcessorControlRequest,
  LiveProcessorControlResult,
} from "~/lib/live-processor-control"
import {
  arrangementFrameForNativeFrame,
  createNativeScheduleCoordinator,
  nativeLoopFramesForSnapshot,
  type NativeScheduleCoordinator,
} from "./native-schedule-coordinator"
import {
  encodeNativeBuiltInStateCommit,
  nativeBuiltInTimingForCommit,
} from "./native-built-in-parameter-mapper"

type NativeSessionReply = { ok: true } | { ok: false; error: string }

export type NativeLiveMidiNoteHandle = {
  backend: "native"
  trackId: string
  pitch: number
  noteId: number
}

const sanitizeNativeVst3DiagnosticError = (error: unknown) => {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
    : "Native playback could not start."
  return message.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s]*/g, "<path>").slice(0, 256)
}

const indicatesNativeHostConnectionLoss = (error: unknown) => {
  const message = sanitizeNativeVst3DiagnosticError(error).toLowerCase()
  return message.includes("native playback host connection was lost")
    || message.includes("native audio host is unavailable")
    || message.includes("native audio host stopped")
    || message.includes("host connection was lost")
    || message.includes("host connection closed")
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const enabledValue = (value: unknown) => {
  if (!isRecord(value)) return undefined
  const state = isRecord(value.state) ? value.state : value
  return typeof state.enabled === "boolean" ? state.enabled : undefined
}

type NativePlaybackBridge = Pick<
  NonNullable<DesktopBridge["audioHost"]>,
  "resolveOutputDevice" | "resolveInputDevice"
> & {
  session: Pick<
    NonNullable<DesktopBridge["audioHost"]>["session"],
    | "configure"
    | "beginTransaction"
    | "commitTransaction"
    | "rollbackTransaction"
    | "installAsset"
    | "releaseAsset"
    | "publishGraph"
    | "configureInstrumentStates"
    | "queueInstrumentEvents"
    | "queueParameterEvents"
    | "queueScheduleWindow"
    | "queueSourceEvents"
    | "queueVstParameterEvents"
    | "coordinateVstAttachments"
    | "setTransport"
    | "configureRecording"
    | "startRecording"
    | "stopRecording"
    | "cancelRecording"
    | "start"
    | "stop"
    | "teardown"
    | "onLoss"
    | "onRecordingBlock"
    | "onRecordingStatus"
    | "onMeterBatch"
    | "onScheduleProgress"
  > & {
    queueProcessorStatePatch?: NonNullable<DesktopBridge["audioHost"]>["session"]["queueProcessorStatePatch"]
    reenableVstScheduleAutomation?: NonNullable<DesktopBridge["audioHost"]>["session"]["reenableVstScheduleAutomation"]
    setSpectrumNode?: NonNullable<DesktopBridge["audioHost"]>["session"]["setSpectrumNode"]
    onSpectrumFrame?: NonNullable<DesktopBridge["audioHost"]>["session"]["onSpectrumFrame"]
  }
}

type NativeStartResult = "started" | "unavailable" | "blocked"

const nativeTransportFor = (
  snapshot: LivePlaybackSnapshot,
  epoch: number,
  running: boolean,
  frame: number,
  transitionId: bigint,
): NativeHostTransport => ({
  epoch,
  running,
  frame,
  bpm: snapshot.bpm,
  timeSignatureNumerator: snapshot.timeSignature?.numerator ?? 4,
  timeSignatureDenominator: snapshot.timeSignature?.denominator ?? 4,
  cycleActive: snapshot.transport.loopEnabled,
  ...(snapshot.transport.loopEnabled
    ? {
        cycleStartSec: snapshot.transport.loopStartSec,
        cycleEndSec: snapshot.transport.loopEndSec,
      }
    : {}),
  transitionId,
})
export type NativeBuiltInParameterQueueResult =
  | { handled: true }
  | { handled: false; reason: "unprepared" | "unsupported-instance" | "unsupported-target" | "unavailable" | "bridge-error"; error?: string }
export type NativeBuiltInStatePatchResult =
  | { handled: true }
  | { handled: false; reason: "unprepared" | "unsupported-instance" | "unsupported-state" | "unavailable" | "bridge-error"; error?: string }
export type NativeRecordingDiagnostics = Pick<
  NativeHostRecordingStatus,
  "capturedFrames" | "droppedFrames" | "droppedBlocks" | "availableBlocks" | "queuedBlocks" | "rms" | "peak" | "fatal"
>

type NativeRecordingSession = {
  appSessionId: string
  numericSessionId: bigint
  generation: number
  writer: ReturnType<typeof createPortableRecordingWriter>
  unsubscribeBlock: () => void
  unsubscribeStatus: () => void
  terminal: boolean
  latestStatus?: NativeHostRecordingStatus
  onDiagnostics?: (diagnostics: NativeRecordingDiagnostics) => void
  onFailure?: (error: Error) => void
}

type LiveNoteReadiness = {
  promise: Promise<void>
  released: boolean
  force: boolean
  noteOnQueued: boolean
  releaseQueued: boolean
}

const assertReply: <T extends NativeSessionReply>(reply: T) => asserts reply is Extract<T, { ok: true }> = (reply) => {
  if (!reply.ok) throw new Error(reply.error)
}

const planarBytes = (planes: readonly Float32Array[]) => {
  const byteLength = planes.reduce((total, plane) => total + plane.byteLength, 0)
  const output = new Uint8Array(byteLength)
  let offset = 0
  for (const plane of planes) {
    output.set(new Uint8Array(plane.buffer, plane.byteOffset, plane.byteLength), offset)
    offset += plane.byteLength
  }
  return output
}

const nativeExternalLatencyFrames = (
  attachmentPlan: LivePlaybackSnapshot["nativeExternalAttachmentPlan"] | undefined,
) => {
  const latencyByNode = new Map<string, number>()
  for (const attachment of attachmentPlan?.attachments ?? []) {
    if (attachment.bypassed) continue
    const latency = attachment.declaredLatencyFrames + attachment.workerTransport.maximumFrames
    const previous = latencyByNode.get(attachment.graphNodeId) ?? 0
    if (!Number.isSafeInteger(previous + latency)) {
      throw new Error(`Native VST3 latency exceeds the supported graph range for "${attachment.graphNodeId}".`)
    }
    latencyByNode.set(attachment.graphNodeId, previous + latency)
  }
  return latencyByNode
}

const nativeVstParameterEventsForSnapshot = (
  snapshot: LivePlaybackSnapshot,
  includeCurrent = true,
) => {
  const plan = snapshot.nativeExternalAttachmentPlan
  if (!plan) return []
  return plan.attachments.filter((attachment) => !attachment.bypassed).flatMap((attachment) => {
    const descriptors = new Map((attachment.parameters ?? []).map((parameter) => [parameter.id, parameter]))
    const events = new Map<string, { id: number; value: number; sampleOffset: number }>()
    for (const [rawId, value] of Object.entries(attachment.parameterOverrides ?? {})) {
      const id = Number(rawId)
      if (!descriptors.has(id) || !Number.isFinite(value)) continue
      if (includeCurrent) events.set(`${id}:0`, { id, value: Math.min(1, Math.max(0, value)), sampleOffset: 0 })
    }
    const eventsInBlock = [...events.values()]
      .sort((left, right) => left.sampleOffset - right.sampleOffset || left.id - right.id)
      .slice(0, attachment.workerTransport.maximumEventsPerBlock)
    return eventsInBlock.length > 0 ? [{ instanceId: attachment.instanceId, events: eventsInBlock }] : []
  })
}

/**
 * Owns a single native host session and coordinates trusted external effects
 * before publishing the immutable native graph.
 */
export const createNativePlaybackController = (input: {
  bridge: NativePlaybackBridge | undefined
  compileSnapshot: (transport: LivePlaybackTransport) => Promise<LivePlaybackSnapshotCompilation>
  getProjectId?: () => string
  getProjectGeneration?: () => number
  reportFault?: (message: string) => void
  createRecordingWriter?: typeof createPortableRecordingWriter
}) => {
  let active = false
  let prepared = false
  let nativeSessionStarted = false
  let livePreviewActive = false
  let nativeHostConnectionLost = false
  let nativeHostLossProjectGeneration: number | undefined
  let nativeHostLossReason: string | undefined
  let intentionalHostTransitionDepth = 0
  let preparedProjectGeneration: number | undefined
  let pendingStart: Promise<NativeStartResult> | undefined
  let pendingStartMode: "play" | "preview" | undefined
  let lifecycleGeneration = 0
  let nativeSessionGeneration = 0
  let transportEpoch = 1
  let nextLiveProcessorSequence = 0
  let nextTransportTransitionId = 0n
  let installedAssetIds: readonly number[] = []
  let installedAssets: readonly NativeSessionAsset[] = []
  let preparedSnapshot: LivePlaybackSnapshot | undefined
  let preparedGraph: AudioCoreGraphSnapshot | undefined
  let unsubscribeMeters: (() => void) | undefined
  let recording: NativeRecordingSession | undefined
  let sampleRate = 0
  let maximumFramesPerBlock = 0
  let nextRecordingSessionId = 1n
  let recordingGeneration = 1
  let transportFrame = 0
  let nextLiveNoteId = 1
  let nextLiveEventSequence = 1_000_000
  let liveInstrumentQueueGeneration = 0
  let liveInstrumentEventTail = Promise.resolve()
  let preparedTransportTransitionGeneration = 0
  type PendingStatePatch = {
    instanceId: string
    request: {
      payload: EffectParamsCommitPayload
      bpm: number
    }
    resolve: (result: NativeBuiltInStatePatchResult) => void
  }
  const pendingStatePatches = new Map<string, PendingStatePatch>()
  let statePatchActive = false
  let statePatchPumpScheduled = false
  const liveNoteReadiness = new Map<number, LiveNoteReadiness>()
  const releasedLiveNoteHandles = new WeakSet<NativeLiveMidiNoteHandle>()
  let liveMidiTailOwned = false
  let scheduleCoordinator: NativeScheduleCoordinator | undefined
  const nativeLiveMidiResetListeners = new Set<() => void>()
  const nativeMeterListeners = new Set<(levels: TrackStereoLevelsBatch) => void>()
  const nativeMasterMeterListeners = new Set<(levels: TrackStereoLevels) => void>()
  const nativeSpectrumListeners = new Set<(frame: SpectrumFrame | null) => void>()
  let nativeMeterNodeIds = new Map<bigint, string>()
  let nativeMeterRevision = 0
  let latestMeterSequence = 0n
  let nativeLevels: TrackStereoLevelsBatch = new Map()
  let nativeMasterLevels: TrackStereoLevels = { left: 0, right: 0 }
  let nativeSpectrumNodeIds = new Map<string, bigint>()
  let nativeSpectrumTarget: string | undefined
  let latestSpectrumSequence = 0n
  let latestScheduleProgress: NativeScheduleProgress | undefined
  const processorSequenceWaiters = new Set<{
    revision: number
    epoch: number
    sequence: number
    resolve: (applied: boolean) => void
  }>()
  let unsubscribeSpectrum: (() => void) | undefined

  const resetNativeMeters = () => {
    const levels = new Map<string, TrackStereoLevels>()
    for (const nodeId of nativeMeterNodeIds.values()) {
      if (nodeId !== "master") levels.set(nodeId, { left: 0, right: 0 })
    }
    nativeLevels = levels
    nativeMasterLevels = { left: 0, right: 0 }
    for (const listener of nativeMeterListeners) listener(levels)
    for (const listener of nativeMasterMeterListeners) listener(nativeMasterLevels)
  }

  const configureNativeMeters = (revision: number, tracks: readonly { id: string }[]) => {
    nativeMeterRevision = revision
    latestMeterSequence = 0n
    nativeMeterNodeIds = new Map([
      ...tracks.map((track) => [nativeGraphNodeId(track.id), track.id] as const),
      [nativeGraphNodeId("master"), "master"],
    ])
    resetNativeMeters()
  }

  const clearNativeMeters = () => {
    unsubscribeMeters?.()
    unsubscribeMeters = undefined
    resetNativeMeters()
    nativeMeterNodeIds = new Map()
    nativeMeterRevision = 0
    latestMeterSequence = 0n
  }

  const clearNativeSpectrum = () => {
    unsubscribeSpectrum?.()
    unsubscribeSpectrum = undefined
    nativeSpectrumNodeIds = new Map()
    latestSpectrumSequence = 0n
    for (const listener of nativeSpectrumListeners) listener(null)
  }

  const configureNativeSpectrum = (tracks: readonly { id: string }[]) => {
    nativeSpectrumNodeIds = new Map([
      ...tracks.map((track) => [track.id, nativeGraphNodeId(track.id)] as const),
      ["master", nativeGraphNodeId("master")] as const,
    ])
    latestSpectrumSequence = 0n
    for (const listener of nativeSpectrumListeners) listener(null)
  }

  const configureNativeSpectrumTarget = () => {
    if (!nativeSessionStarted) return
    const nodeId = nativeSpectrumTarget === undefined
      ? null
      : nativeSpectrumNodeIds.get(nativeSpectrumTarget) ?? null
    void input.bridge?.session.setSpectrumNode?.(nodeId)
  }

  const handleNativeSpectrumFrame = (frame: NativeHostSpectrumFrame) => {
    const nodeId = nativeSpectrumNodeIds.get(nativeSpectrumTarget ?? "")
    if (
      !nodeId || frame.graphRevision !== nativeMeterRevision
      || frame.transportEpoch !== transportEpoch || frame.nodeId !== nodeId
      || frame.sequence <= latestSpectrumSequence
    ) return
    latestSpectrumSequence = frame.sequence
    const next: SpectrumFrame = {
      data: frame.data,
      sampleRate: frame.sampleRateHz,
      graphRevision: frame.graphRevision,
      transportEpoch: frame.transportEpoch,
      sequence: frame.sequence,
      nodeId: frame.nodeId,
      fftSize: frame.fftSize,
      binCount: frame.binCount,
    }
    for (const listener of nativeSpectrumListeners) listener(next)
  }
  const clearNativeSpectrumFrame = () => {
    latestSpectrumSequence = 0n
    for (const listener of nativeSpectrumListeners) listener(null)
  }

  const handleNativeMeterBatch = (batch: NativeHostMeterBatch) => {
    if (batch.graphRevision !== nativeMeterRevision || batch.transportEpoch !== transportEpoch
      || batch.sequence <= latestMeterSequence) return
    latestMeterSequence = batch.sequence
    const levels = new Map<string, TrackStereoLevels>()
    let master: TrackStereoLevels | undefined
    for (const entry of batch.entries) {
      const nodeId = nativeMeterNodeIds.get(entry.nodeId)
      if (!nodeId) continue
      const next = {
        left: Math.min(1, Math.max(0, entry.leftRms)),
        right: Math.min(1, Math.max(0, entry.rightRms)),
      }
      if (nodeId === "master") master = next
      else levels.set(nodeId, next)
    }
    if (levels.size > 0) {
      nativeLevels = new Map([...nativeLevels, ...levels])
      for (const listener of nativeMeterListeners) listener(levels)
    }
    if (master) {
      nativeMasterLevels = master
      for (const listener of nativeMasterMeterListeners) listener(master)
    }
  }

  const reportFault = (message: string) => {
    input.reportFault?.(message)
  }

  const handleNativeScheduleProgress = (progress: NativeScheduleProgress) => {
    latestScheduleProgress = progress
    for (const waiter of processorSequenceWaiters) {
      if (progress.revision !== waiter.revision || progress.epoch !== waiter.epoch) {
        waiter.resolve(false)
        processorSequenceWaiters.delete(waiter)
      } else if (progress.appliedProcessorSequence >= BigInt(waiter.sequence)) {
        waiter.resolve(true)
        processorSequenceWaiters.delete(waiter)
      }
    }
  }

  const waitForNativeProcessorSequence = (revision: number, epoch: number, sequence: number) => {
    const progress = latestScheduleProgress
    if (
      progress?.revision === revision
      && progress.epoch === epoch
      && progress.appliedProcessorSequence >= BigInt(sequence)
    ) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const waiter = { revision, epoch, sequence, resolve }
      processorSequenceWaiters.add(waiter)
      const timeout = setTimeout(() => {
        if (!processorSequenceWaiters.delete(waiter)) return
        resolve(false)
      }, 1000)
      const originalResolve = resolve
      waiter.resolve = (applied) => {
        clearTimeout(timeout)
        originalResolve(applied)
      }
    })
  }

  const hasNativeHostConnectionLoss = () => {
    if (!nativeHostConnectionLost) return false
    const projectGeneration = input.getProjectGeneration?.()
    if (
      projectGeneration !== undefined
      && nativeHostLossProjectGeneration !== undefined
      && projectGeneration !== nativeHostLossProjectGeneration
    ) {
      nativeHostConnectionLost = false
      nativeHostLossProjectGeneration = undefined
      nativeHostLossReason = undefined
      return false
    }
    return true
  }

  const nativeHostConnectionLossMessage = () =>
    nativeHostLossReason ?? "Native playback host connection was lost."

  const reportBlockedByNativeHostConnectionLoss = () => {
    const message = `Native playback start was skipped: ${nativeHostConnectionLossMessage()}`
    console.error("[native-vst3] native start unavailable", {
      result: "unavailable",
      error: message,
    })
    reportFault(message)
  }

  const markNativeHostConnectionLost = (reason?: string) => {
    nativeHostConnectionLost = true
    nativeHostLossProjectGeneration = input.getProjectGeneration?.()
    nativeHostLossReason = reason ?? nativeHostConnectionLossMessage()
  }

  const resetNativeHostConnectionLoss = () => {
    nativeHostConnectionLost = false
    nativeHostLossProjectGeneration = undefined
    nativeHostLossReason = undefined
  }

  const createCoordinatorForEpoch = (options: {
    snapshot: LivePlaybackSnapshot
    epoch: number
    sampleRateHz: number
    assets: readonly NativeSessionAsset[]
    startFrame: number
    graph?: AudioCoreGraphSnapshot
  }) => {
    const bridge = input.bridge
    if (!bridge) throw new Error("The native playback bridge is unavailable.")
    const sessionGeneration = ++nativeSessionGeneration
    return createNativeScheduleCoordinator({
      bridge: {
        queueScheduleWindow: bridge.session.queueScheduleWindow,
        queueInstrumentEvents: bridge.session.queueInstrumentEvents,
        reenableVstScheduleAutomation: bridge.session.reenableVstScheduleAutomation,
        onScheduleProgress: (listener) => bridge.session.onScheduleProgress((progress) => {
          if (sessionGeneration !== nativeSessionGeneration) return
          handleNativeScheduleProgress(progress)
          listener(progress)
        }),
        onLoss: bridge.session.onLoss,
      },
      snapshot: options.snapshot,
      graph: options.graph,
      acceptsLiveMidi: true,
      epoch: options.epoch,
      sampleRateHz: options.sampleRateHz,
      capacity: {
        maximumFramesPerBlock: maximumFramesPerBlock,
        maximumVstEventsPerBlock: maxVst3WorkerFrames,
      },
      assets: options.assets,
      startFrame: options.startFrame,
      onFault: (error) => {
        if (sessionGeneration !== nativeSessionGeneration) return
        void dispose().catch(() => undefined)
        reportFault(error.message)
      },
      onRenderedFrame: (renderedFrame) => {
        if (renderedFrame >= transportFrame) transportFrame = renderedFrame
      },
      onHostLoss: (error) => {
        if (sessionGeneration !== nativeSessionGeneration) return
        handleNativeHostLoss(error)
      },
    })
  }

  const dispose = async () => {
    intentionalHostTransitionDepth += 1
    try {
      lifecycleGeneration += 1
      preparedTransportTransitionGeneration += 1
      nativeSessionGeneration += 1
      for (const waiter of processorSequenceWaiters) waiter.resolve(false)
      processorSequenceWaiters.clear()
      latestScheduleProgress = undefined
      const hadSession = prepared
        || nativeSessionStarted
        || active
        || livePreviewActive
        || scheduleCoordinator !== undefined
      for (const pending of pendingStatePatches.values()) pending.resolve({ handled: true })
      pendingStatePatches.clear()
      statePatchPumpScheduled = false
      liveInstrumentQueueGeneration += 1
      liveInstrumentEventTail = Promise.resolve()
      pendingStart = undefined
      pendingStartMode = undefined
      const bridge = input.bridge
      const assetIds = installedAssetIds
      installedAssetIds = []
      active = false
      prepared = false
      nativeSessionStarted = false
      livePreviewActive = false
      for (const listener of nativeLiveMidiResetListeners) listener()
      liveNoteReadiness.clear()
      liveMidiTailOwned = false
      scheduleCoordinator?.dispose()
      scheduleCoordinator = undefined
      clearNativeMeters()
      clearNativeSpectrum()
      preparedProjectGeneration = undefined
      preparedSnapshot = undefined
      preparedGraph = undefined
      installedAssets = []
      sampleRate = 0
      maximumFramesPerBlock = 0
      transportFrame = 0
      if (hadSession) transportEpoch += 1
      if (!bridge) return
      const stopPromise = bridge.session.stop()
      await cancelRecording().catch(() => undefined)
      await Promise.allSettled([
        stopPromise,
        ...assetIds.map((sessionAssetId) => bridge.session.releaseAsset(sessionAssetId)),
      ])
      await bridge.session.teardown().catch(() => undefined)
    } finally {
      intentionalHostTransitionDepth -= 1
    }
  }

  const handleNativeHostLoss = (error?: string) => {
    if (intentionalHostTransitionDepth > 0) return
    const ownsNativeSession = prepared
      || nativeSessionStarted
      || active
      || livePreviewActive
      || scheduleCoordinator !== undefined
      || recording !== undefined
    if (!ownsNativeSession) return
    const message = error ?? "Native playback host connection was lost."
    markNativeHostConnectionLost(message)
    if (recording) failRecording(recording, new Error(message))
    void dispose().catch(() => undefined)
    reportFault(message)
  }

  const startAttempt = async (
    transport: LivePlaybackTransport,
    generation: number,
    projectGeneration: number,
    runTransport: boolean,
  ): Promise<NativeStartResult> => {
    const bridge = input.bridge
    if (!bridge) return "unavailable"
    if (hasNativeHostConnectionLoss()) {
      reportBlockedByNativeHostConnectionLoss()
      return "unavailable"
    }
    const cancelled = () => generation !== lifecycleGeneration
      || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
    if (prepared && preparedProjectGeneration === projectGeneration) {
      try {
        const previousCoordinator = scheduleCoordinator
        const refreshed = previousCoordinator && preparedSnapshot
          ? { supported: true as const, snapshot: { ...preparedSnapshot, transport } }
          : await input.compileSnapshot(transport)
        if (!refreshed.supported || refreshed.snapshot.revision !== preparedSnapshot?.revision) {
          preparedProjectGeneration = undefined
        } else {
          transportEpoch += 1
          clearNativeSpectrumFrame()
          const frame = Math.round(transport.playheadSec * sampleRate)
          nativeSessionGeneration += 1
          previousCoordinator?.dispose()
          const nextCoordinator = createCoordinatorForEpoch({
            snapshot: refreshed.snapshot,
            epoch: transportEpoch,
            sampleRateHz: sampleRate,
            assets: installedAssets,
            startFrame: frame,
            graph: preparedGraph,
          })
          if (preparedGraph) nextCoordinator.preflight(preparedGraph)
          nextCoordinator.install()
          scheduleCoordinator = nextCoordinator
          const transitionId = ++nextTransportTransitionId
          assertReply(await bridge.session.setTransport(
            nativeTransportFor(refreshed.snapshot, transportEpoch, false, frame, transitionId),
          ))
          await nextCoordinator.waitForTransition(transitionId, false)
          await nextCoordinator.prime(frame)
          await nextCoordinator.waitForAccepted(frame + Math.min(maximumFramesPerBlock, nextCoordinator.scheduleEndFrame() - frame))
          if (runTransport) {
            const runTransitionId = ++nextTransportTransitionId
            assertReply(await bridge.session.setTransport(
              nativeTransportFor(refreshed.snapshot, transportEpoch, true, frame, runTransitionId),
            ))
            await nextCoordinator.waitForTransition(runTransitionId, true)
          }
          if (cancelled()) {
            await dispose()
            return "unavailable"
          }
          preparedSnapshot = refreshed.snapshot
          transportFrame = frame
          active = runTransport
          livePreviewActive = true
          return "started"
        }
      } catch (error) {
        console.error("[native-vst3] session.start failed", {
          result: "unavailable",
          error: sanitizeNativeVst3DiagnosticError(error),
        })
        if (!cancelled() && indicatesNativeHostConnectionLoss(error)) {
          markNativeHostConnectionLost(error instanceof Error ? error.message : undefined)
        }
        if (!cancelled()) reportFault(error instanceof Error ? error.message : "Native playback could not resume.")
        await dispose()
        return "unavailable"
      }
    }
    if (prepared) {
      const assetIds = installedAssetIds
      installedAssetIds = []
      nativeSessionGeneration += 1
      scheduleCoordinator?.dispose()
      scheduleCoordinator = undefined
      clearNativeMeters()
      clearNativeSpectrum()
      active = false
      prepared = false
      nativeSessionStarted = false
      livePreviewActive = false
      liveInstrumentQueueGeneration += 1
      preparedProjectGeneration = undefined
      preparedSnapshot = undefined
      preparedGraph = undefined
      installedAssets = []
      sampleRate = 0
      maximumFramesPerBlock = 0
      await Promise.allSettled([
        bridge.session.stop(),
        ...assetIds.map((sessionAssetId) => bridge.session.releaseAsset(sessionAssetId)),
      ])
      await bridge.session.teardown().catch(() => undefined)
    }
    let transactionOpen = false
    let transactionToken: string | undefined
    let requiresNative = false
    try {
      const snapshotResult = await input.compileSnapshot(transport)
      if (cancelled()) return "unavailable"
      if (!snapshotResult.supported) {
        const message = snapshotResult.reasons.join(" ") || "The project cannot be compiled for native playback."
        console.error("[native-vst3] native snapshot unsupported", { error: message })
        reportFault(message)
        return "unavailable"
      }
      const { snapshot } = snapshotResult
      requiresNative = snapshot.requiresNativePlayback === true
      const unavailable = (message: string) => {
        if (!requiresNative) return "unavailable" as const
        if (!cancelled()) reportFault(message)
        return "blocked" as const
      }
      if (snapshot.tracks.some((track) => track.clips.some((clip) => (
        clip.midi?.mappings !== undefined && clip.midi.mappings.length > 0
      )))) {
        return unavailable("Native VST3 playback does not support MIDI expression automation yet.")
      }
      const deviceReply = await bridge.resolveOutputDevice()
      if (cancelled()) return "unavailable"
      if (!deviceReply.ok && indicatesNativeHostConnectionLoss(deviceReply.error)) {
        markNativeHostConnectionLost(deviceReply.error)
      }
      if (!deviceReply.ok || !deviceReply.device?.available) return unavailable("No native audio output device is available for the active VST3 effect.")
      const runtimeMaximumFrames = Math.min(deviceReply.device.maximumFramesPerBlock, maxVst3WorkerFrames)
      sampleRate = deviceReply.device.nominalSampleRateHz
      maximumFramesPerBlock = runtimeMaximumFrames
      const attachmentPlan = (() => {
        const plan = snapshot.nativeExternalAttachmentPlan
        if (!plan) return undefined
        return plan.version === 1
          ? {
            ...plan,
            attachments: plan.attachments.map((attachment) => ({
              ...attachment,
              workerTransport: {
                ...attachment.workerTransport,
                maximumFrames: runtimeMaximumFrames,
              },
            })),
          }
          : {
            ...plan,
            attachments: plan.attachments.map((attachment) => ({
              ...attachment,
              workerTransport: {
                ...attachment.workerTransport,
                maximumFrames: runtimeMaximumFrames,
              },
            })),
          }
      })()
      const runtimeSnapshot = attachmentPlan
        ? { ...snapshot, nativeExternalAttachmentPlan: attachmentPlan }
        : snapshot
      if (
        snapshot.mixer.fx.masterVolume !== 1
        || snapshot.mixer.sidechainRoutes.length > 0
      ) return unavailable("The native VST3 graph cannot activate with the current master gain or sidechain routing.")
      if (snapshot.requiresNativePlayback && !attachmentPlan) return unavailable("The active VST3 attachment plan is unavailable.")
      if (snapshot.mixer.automationEnvelopes.some((envelope) => (
        envelope.enabled && parseExternalAutomationParameterId(envelope.parameterId) === null
      ))) {
        return unavailable("Native playback supports automation only for active VST3 parameters.")
      }
      const projection = compileLiveNativeProjection({
        tracks: snapshot.tracks,
        bpm: snapshot.bpm,
        sampleRateHz: deviceReply.device.nominalSampleRateHz,
        revision: snapshot.revision,
        epoch: transportEpoch,
        firstSequence: 1,
        fx: snapshot.mixer.fx,
        externalLatencyFrames: nativeExternalLatencyFrames(attachmentPlan),
      })
      if (!projection.supported) return unavailable(projection.reasons.join(" "))
      if (deviceReply.device.outputChannelCount < 2) return unavailable("The native audio output does not provide compatible stereo routing.")
      const assets = mapNativeSessionAssets(projection.graph.assets)
      const nativeGraph = projection.graph
      const transactionReply = await bridge.session.beginTransaction()
      assertReply(transactionReply)
      transactionToken = transactionReply.transactionToken
      transactionOpen = true
      if (cancelled()) throw new Error("Native playback startup was cancelled.")
      if (attachmentPlan) {
        const coordinateVstAttachments = bridge.session.coordinateVstAttachments
        if (!coordinateVstAttachments) throw new Error("The native VST3 attachment coordinator is unavailable.")
        const projectId = input.getProjectId?.()
        if (!projectId) throw new Error("The native VST3 attachment project is unavailable.")
        const coordination = await coordinateVstAttachments({
          projectId,
          serializedPlan: encodeNativeExternalAttachmentPlan(attachmentPlan),
          sampleRateHz: deviceReply.device.nominalSampleRateHz,
        }, transactionToken)
        assertReply(coordination)
      }
      if (cancelled()) throw new Error("Native playback startup was cancelled.")
      assertReply(await bridge.session.configure({
        deviceId: deviceReply.device.deviceId,
        sampleRateHz: deviceReply.device.nominalSampleRateHz,
        maxFramesPerBlock: runtimeMaximumFrames,
        channelCount: 2,
        revision: snapshot.revision,
      }, transactionToken))
      if (cancelled()) throw new Error("Native playback startup was cancelled.")
      for (const { asset, pcm } of projection.assets) {
        const mapping = assets.find(({ asset: mapped }) => mapped.assetId === asset.assetId)
        if (!mapping) throw new Error("Native session asset mapping is incomplete.")
        assertReply(await bridge.session.installAsset({
          sessionAssetId: mapping.sessionAssetId,
          frameCount: asset.frameCount,
          sampleRateHz: asset.sampleRateHz,
          channelCount: asset.channelCount,
          planarPcm: planarBytes(pcm.planes),
        }, transactionToken))
        if (cancelled()) throw new Error("Native playback startup was cancelled.")
      }
      assertReply(await bridge.session.publishGraph(serializeNativeGraph(nativeGraph), transactionToken))
      if (bridge.session.configureInstrumentStates) {
        assertReply(await bridge.session.configureInstrumentStates(
          serializeNativeInstrumentStates(
            nativeGraph.nodes.flatMap((node) => node.kind === "instrument" && node.instrument
              ? [{ nodeId: node.id, state: node.instrument }]
              : []),
            assets,
          ),
          transactionToken,
        ))
      }
      if (cancelled()) throw new Error("Native playback startup was cancelled.")
      const parameterQueue = bridge.session.queueVstParameterEvents
      const parameterBatches = nativeVstParameterEventsForSnapshot(
        runtimeSnapshot,
      )
      if (parameterBatches.length > 0 && !parameterQueue) {
        throw new Error("The native VST3 parameter event bridge is unavailable.")
      }
      for (const batch of parameterBatches) {
        if (!parameterQueue) break
        assertReply(await parameterQueue(serializeNativeVstParameterEvents(batch.instanceId, batch.events), transactionToken))
      }
      const initialFrame = Math.round(snapshot.transport.playheadSec * deviceReply.device.nominalSampleRateHz)
      const nextCoordinator = createCoordinatorForEpoch({
        snapshot: runtimeSnapshot,
        epoch: transportEpoch,
        sampleRateHz: deviceReply.device.nominalSampleRateHz,
        assets,
        startFrame: initialFrame,
        graph: nativeGraph,
      })
      if (runTransport) nextCoordinator.preflight(nativeGraph)
      nextCoordinator.install()
      scheduleCoordinator = nextCoordinator
      const initialTransitionId = ++nextTransportTransitionId
      assertReply(await bridge.session.setTransport(
        nativeTransportFor(runtimeSnapshot, transportEpoch, false, initialFrame, initialTransitionId),
        transactionToken,
      ))
      if (cancelled()) throw new Error("Native playback startup was cancelled.")
      await nextCoordinator.queueInitialSynthState(initialFrame, transactionToken)
      if (cancelled()) throw new Error("Native playback startup was cancelled.")
      assertReply(await bridge.session.commitTransaction(transactionToken))
      transactionOpen = false
      transactionToken = undefined
      installedAssetIds = assets.map(({ sessionAssetId }) => sessionAssetId)
      installedAssets = assets
      preparedSnapshot = runtimeSnapshot
      preparedGraph = nativeGraph
      sampleRate = deviceReply.device.nominalSampleRateHz
      maximumFramesPerBlock = runtimeMaximumFrames
      transportFrame = Math.round(snapshot.transport.playheadSec * sampleRate)
      prepared = true
      preparedProjectGeneration = projectGeneration
      configureNativeMeters(snapshot.revision, snapshot.tracks)
      configureNativeSpectrum(snapshot.tracks)
      unsubscribeMeters?.()
      unsubscribeMeters = bridge.session.onMeterBatch?.(handleNativeMeterBatch)
      unsubscribeSpectrum?.()
      unsubscribeSpectrum = bridge.session.onSpectrumFrame?.(handleNativeSpectrumFrame)
      assertReply(await bridge.session.start())
      nativeSessionStarted = true
      configureNativeSpectrumTarget()
      if (cancelled()) {
        await dispose()
        return "unavailable"
      }
      await nextCoordinator.waitForTransition(nextTransportTransitionId, false)
      // VST workers are started only after the graph transaction is committed.
      // Prime the bounded owned schedule before either paused preview or playback.
      await nextCoordinator.prime(initialFrame)
      await nextCoordinator.waitForAccepted(initialFrame + Math.min(runtimeMaximumFrames, nextCoordinator.scheduleEndFrame() - initialFrame))
      if (runTransport) {
        const runTransitionId = ++nextTransportTransitionId
        assertReply(await bridge.session.setTransport(
          nativeTransportFor(runtimeSnapshot, transportEpoch, true, initialFrame, runTransitionId),
        ))
        await nextCoordinator.waitForTransition(runTransitionId, true)
      }
      active = runTransport
      livePreviewActive = true
      return "started"
    } catch (error) {
      const wasCancelled = cancelled()
      if (transactionOpen) {
        if (transactionToken) await bridge.session.rollbackTransaction(transactionToken)
        await dispose()
      }
      else if (!wasCancelled) await dispose()
      const result = requiresNative ? "blocked" : "unavailable"
      console.error("[native-vst3] native start failed", {
        result,
        error: sanitizeNativeVst3DiagnosticError(error),
      })
      if (!wasCancelled && indicatesNativeHostConnectionLoss(error)) {
        markNativeHostConnectionLost(error instanceof Error ? error.message : undefined)
      }
      if (!wasCancelled) reportFault(error instanceof Error ? error.message : "Native playback could not start.")
      return result
    }
  }

  const start = (transport: LivePlaybackTransport): Promise<NativeStartResult> => {
    if (hasNativeHostConnectionLoss()) {
      reportBlockedByNativeHostConnectionLoss()
      return Promise.resolve("unavailable")
    }
    if (active) return Promise.resolve("started")
    if (pendingStart) {
      if (pendingStartMode === "play") return pendingStart
      const previewRequest = pendingStart
      const generation = lifecycleGeneration
      const projectGeneration = input.getProjectGeneration?.() ?? 0
      const request = previewRequest.then((result) => result === "started"
        ? startAttempt(transport, generation, projectGeneration, true)
        : result)
      pendingStart = request
      pendingStartMode = "play"
      void request.finally(() => {
        if (pendingStart === request) {
          pendingStart = undefined
          pendingStartMode = undefined
        }
      })
      return request
    }
    const generation = lifecycleGeneration
    const projectGeneration = input.getProjectGeneration?.() ?? 0
    const request = startAttempt(transport, generation, projectGeneration, true)
    pendingStart = request
    pendingStartMode = "play"
    void request.finally(() => {
      if (pendingStart === request) {
        pendingStart = undefined
        pendingStartMode = undefined
      }
    })
    return request
  }

  const ensureLivePreview = (playheadSec: number): Promise<NativeStartResult> => {
    if (!input.bridge) return Promise.resolve("unavailable")
    if (hasNativeHostConnectionLoss()) {
      reportBlockedByNativeHostConnectionLoss()
      return Promise.resolve("unavailable")
    }
    if (livePreviewActive) return Promise.resolve("started")
    if (pendingStart) {
      return pendingStart
    }
    const generation = lifecycleGeneration
    const projectGeneration = input.getProjectGeneration?.() ?? 0
    const request = startAttempt({
      state: "paused",
      playheadSec,
      loopEnabled: false,
      loopStartSec: 0,
      loopEndSec: 0,
    }, generation, projectGeneration, false)
    pendingStart = request
    pendingStartMode = "preview"
    void request.finally(() => {
      if (pendingStart === request) {
        pendingStart = undefined
        pendingStartMode = undefined
      }
    })
    return request
  }

  const rebuildPrepared = async (playheadSec: number): Promise<NativeStartResult> => {
    if (!prepared) return "unavailable"
    await dispose()
    return ensureLivePreview(playheadSec)
  }

  let preparedTransportTransition = Promise.resolve()
  const queuePreparedTransportTransition = <T>(task: () => Promise<T>) => {
    const transition = preparedTransportTransition.then(task)
    preparedTransportTransition = transition.then(() => undefined, () => undefined)
    return transition
  }

  const transitionPreparedTransport = async (
    playheadSec: number,
    releaseTransportNotes: boolean,
  ): Promise<boolean> => {
    const bridge = input.bridge
    if (!bridge) return false
    const frame = Math.round(playheadSec * sampleRate)
    const transitionGeneration = preparedTransportTransitionGeneration
    transportEpoch += 1
    clearNativeSpectrumFrame()
    const nextCoordinator = preparedSnapshot && scheduleCoordinator
      ? createCoordinatorForEpoch({
        snapshot: preparedSnapshot,
        epoch: transportEpoch,
        sampleRateHz: sampleRate,
        assets: installedAssets,
        startFrame: frame,
        graph: preparedGraph,
      })
      : undefined
    scheduleCoordinator?.dispose()
    nextCoordinator?.install()
    scheduleCoordinator = nextCoordinator
    const transitionId = ++nextTransportTransitionId
    if (!preparedSnapshot) return false
    assertReply(await bridge.session.setTransport(
      nativeTransportFor(preparedSnapshot, transportEpoch, false, frame, transitionId),
    ))
    if (transitionGeneration !== preparedTransportTransitionGeneration) return false
    await nextCoordinator?.waitForTransition(transitionId, false)
    if (transitionGeneration !== preparedTransportTransitionGeneration) return false
    if (releaseTransportNotes) {
      const instrumentNodeIds = preparedSnapshot?.tracks
        .filter((track) => track.kind === "instrument")
        .map((track) => track.id) ?? []
      const releasePromises = instrumentNodeIds.map((nodeId) => {
        const sequence = nextLiveEventSequence++
        return queueLiveInstrumentEvent({
          nodeId,
          noteId: 1,
          sequence,
          // Urgent live events are applied in the next realtime block.
          frameOffset: 0,
          type: "transport-release",
          channel: 0,
          note: 0,
          value: 0,
        }).then((queued) => ({ queued, sequence }))
      })
      const releases = await Promise.all(releasePromises)
      const lastSequence = releases.reduce(
        (maximum, release) => release.queued ? Math.max(maximum, release.sequence) : maximum,
        0,
      )
      if (lastSequence > 0) await nextCoordinator?.waitForUrgent(BigInt(lastSequence))
    }
    transportFrame = frame
    active = false
    return true
  }

  const pause = async (playheadSec: number) => {
    const bridge = input.bridge
    if (!bridge || !active) return
    if (recording) throw new Error("Native recording must stop before playback can pause.")
    try {
      await queuePreparedTransportTransition(async () => {
        if (!prepared || !active) return
        await transitionPreparedTransport(playheadSec, true)
      })
    } catch (error) {
      reportFault(error instanceof Error ? error.message : "Native playback could not pause.")
      await dispose()
      throw error
    }
  }

  const seekPrepared = async (playheadSec: number): Promise<NativeStartResult> => {
    const bridge = input.bridge
    if (!bridge || !prepared || active) return "unavailable"
    if (recording) throw new Error("Native recording must stop before playback can seek.")
    try {
      return await queuePreparedTransportTransition(async () => {
        if (!prepared || active) return "unavailable"
        const transitioned = await transitionPreparedTransport(playheadSec, false)
        return transitioned ? "started" : "unavailable"
      })
    } catch (error) {
      reportFault(error instanceof Error ? error.message : "Native playback could not seek.")
      await dispose()
      throw error
    }
  }

  const clearRecording = (session: NativeRecordingSession) => {
    if (recording !== session) return
    session.unsubscribeBlock()
    session.unsubscribeStatus()
    session.writer.terminate()
    recording = undefined
  }

  const failRecording = (session: NativeRecordingSession, error: Error) => {
    if (recording !== session || session.terminal) return
    session.terminal = true
    session.onFailure?.(error)
    void cancelRecording().catch(() => {
      void session.writer.abort().catch(() => undefined).finally(() => clearRecording(session))
    })
  }

  const waitForStatus = (
    session: NativeRecordingSession,
    predicate: (status: NativeHostRecordingStatus) => boolean,
    message: string,
  ) => new Promise<NativeHostRecordingStatus>((resolve, reject) => {
    const subscription: { current?: () => void } = {}
    // A native control transition must settle promptly so stale device or host
    // state cannot retain the single recording session indefinitely.
    const deadline = setTimeout(() => {
      subscription.current?.()
      reject(new Error(message))
    }, 2_000)
    subscription.current = input.bridge?.session.onRecordingStatus((status) => {
      if (
        status.generation !== session.generation
        || status.sessionId !== session.numericSessionId
        || !predicate(status)
      ) return
      clearTimeout(deadline)
      subscription.current?.()
      resolve(status)
    })
  })

  const startRecording = async (recordingInput: {
    appSessionId: string
    layout: "mono" | "stereo"
    inputChannel: number
    gain: number
    polarity: 1 | -1
    monitoring: boolean
    punchStartFrame: number
    punchEndFrame?: number
    onDiagnostics?: (diagnostics: NativeRecordingDiagnostics) => void
    onFailure?: (error: Error) => void
  }) => {
    const bridge = input.bridge
    if (!active || !bridge || recording || sampleRate === 0) throw new Error("Native playback is not active for recording.")
    const channelCount = recordingInput.layout === "stereo" ? 2 : 1
    const inputChannels = channelCount === 2
      ? [recordingInput.inputChannel, recordingInput.inputChannel + 1]
      : [recordingInput.inputChannel]
    const numericSessionId = nextRecordingSessionId
    nextRecordingSessionId += 1n
    const generation = recordingGeneration
    recordingGeneration += 1
    const writer = (input.createRecordingWriter ?? createPortableRecordingWriter)({
      generation,
      sessionId: recordingInput.appSessionId,
      sampleRate,
      channelCount,
    })
    const session: NativeRecordingSession = {
      appSessionId: recordingInput.appSessionId,
      numericSessionId,
      generation,
      writer,
      unsubscribeBlock: () => undefined,
      unsubscribeStatus: () => undefined,
      terminal: false,
      onDiagnostics: recordingInput.onDiagnostics,
      onFailure: recordingInput.onFailure,
    }
    session.unsubscribeBlock = bridge.session.onRecordingBlock((block) => {
      if (recording !== session || session.terminal
        || block.generation !== generation || block.sessionId !== numericSessionId) return
      try {
        const samples = new Float32Array(
          block.planarPcm.buffer,
          block.planarPcm.byteOffset,
          block.planarPcm.byteLength / Float32Array.BYTES_PER_ELEMENT,
        )
        writer.write({
          version: 1,
          type: "recording-capture-block",
          generation,
          sessionId: Number(numericSessionId),
          sequence: block.sequence,
          frameCount: block.frameCount,
          channelCount,
          rms: block.rms,
          peak: block.peak,
          planes: Array.from({ length: channelCount }, (_, channel) => (
            samples.slice(channel * block.frameCount, (channel + 1) * block.frameCount)
          )),
        })
      } catch (error) {
        failRecording(session, error instanceof Error ? error : new Error("Native recording writer failed."))
      }
    })
    session.unsubscribeStatus = bridge.session.onRecordingStatus((status) => {
      if (recording !== session || status.generation !== generation || status.sessionId !== numericSessionId) return
      session.latestStatus = status
      session.onDiagnostics?.(status)
      if (status.fatal) failRecording(session, new Error("Native recording capture overflowed."))
    })
    recording = session
    try {
      await writer.ready
      const inputDeviceReply = await bridge.resolveInputDevice()
      const inputDevice = inputDeviceReply.ok ? inputDeviceReply.device : null
      if (!inputDevice?.available
        || inputChannels.some((channel) => channel >= inputDevice.inputChannelCount)) {
        throw new Error("No compatible native recording input device is available.")
      }
      assertReply(await bridge.session.configureRecording({
        deviceUid: inputDevice.deviceId,
        generation,
        sessionId: numericSessionId,
        channelCount,
        inputChannels,
        gain: recordingInput.gain,
        polarity: recordingInput.polarity,
        punchStartFrame: recordingInput.punchStartFrame,
        punchEndFrame: recordingInput.punchEndFrame ?? null,
        monitoring: recordingInput.monitoring,
      }))
      const started = waitForStatus(session, (status) => status.active, "Native recording start timed out.")
      assertReply(await bridge.session.startRecording())
      const status = await started
      return { sampleRate, channelCount, startFrame: status.timelineFrame }
    } catch (error) {
      await bridge.session.cancelRecording().catch(() => undefined)
      await writer.abort().catch(() => undefined)
      clearRecording(session)
      throw error
    }
  }

  const stopRecording = async () => {
    const bridge = input.bridge
    const session = recording
    if (!bridge || !session || session.terminal) throw new Error("Native recording is not active.")
    try {
      const stopped = waitForStatus(
        session,
        (status) => !status.active && status.queuedBlocks === 0,
        "Native recording finalization timed out.",
      )
      assertReply(await bridge.session.stopRecording())
      const status = await stopped
      const result = await session.writer.finalize(status.capturedFrames)
      clearRecording(session)
      return result
    } catch (error) {
      failRecording(session, error instanceof Error ? error : new Error("Native recording finalization failed."))
      throw error
    }
  }

  async function cancelRecording() {
    const bridge = input.bridge
    const session = recording
    if (!bridge || !session) return
    session.terminal = true
    try {
      const cancelled = waitForStatus(
        session,
        (status) => !status.active && status.queuedBlocks === 0,
        "Native recording cancellation timed out.",
      )
      assertReply(await bridge.session.cancelRecording())
      await cancelled
    } finally {
      await session.writer.abort().catch(() => undefined)
      clearRecording(session)
    }
  }

  const queueLiveInstrumentEvent = (event: NativeInstrumentEvent) => {
    const bridge = input.bridge
    if (!bridge || hasNativeHostConnectionLoss() || !livePreviewActive || sampleRate === 0) return Promise.resolve(false)
    const generation = liveInstrumentQueueGeneration
    const bytes = serializeNativeInstrumentEvents(transportEpoch, [event])
    const queued = liveInstrumentEventTail.then(async () => {
      if (
        generation !== liveInstrumentQueueGeneration
        || !input.bridge
        || hasNativeHostConnectionLoss()
        || !livePreviewActive
        || sampleRate === 0
      ) return false
      try {
        const reply = await bridge.session.queueInstrumentEvents(bytes)
        if (!reply.ok && generation === liveInstrumentQueueGeneration) reportFault(reply.error)
        return reply.ok
      } catch (error: unknown) {
        if (generation === liveInstrumentQueueGeneration && livePreviewActive) {
          reportFault(error instanceof Error ? error.message : "Native live MIDI event failed.")
        }
        return false
      }
    }).catch(() => undefined)
    liveInstrumentEventTail = queued.then(() => undefined)
    return queued
  }

  const queueBuiltInParameterEvents = async (request: {
    instanceId: string
    values: readonly { parameterId: string; value: number }[]
    revision?: number
    epoch?: number
    sequence?: number
  }): Promise<NativeBuiltInParameterQueueResult> => {
    const bridge = input.bridge
    if (!bridge) return { handled: false, reason: "unavailable" }
    if (!prepared || !preparedGraph) return { handled: false, reason: "unprepared" }
    const processor = resolveGraphProcessor(preparedGraph, request.instanceId)
    if (!processor) return { handled: false, reason: "unsupported-instance" }
    const events = []
    for (const value of request.values) {
      const parameterTarget = processor.parameterTargets.get(value.parameterId)
      if (parameterTarget === undefined || !Number.isFinite(value.value)) {
        return { handled: false, reason: "unsupported-target" }
      }
      events.push({
        processorInstanceId: processor.processor.instanceId,
        parameterTarget,
        frameOffset: 0,
        value: value.value,
      })
    }
    if (events.length === 0) return { handled: true }
    try {
      const batch = request.revision === undefined || request.epoch === undefined || request.sequence === undefined
        ? undefined
        : {
            revision: request.revision,
            epoch: request.epoch,
            sequence: request.sequence,
          }
      const reply = await bridge.session.queueParameterEvents(serializeNativeProcessorEvents(events, batch))
      return reply.ok
        ? { handled: true }
        : { handled: false, reason: "bridge-error", error: reply.error }
    } catch (error) {
      return {
        handled: false,
        reason: "bridge-error",
        error: error instanceof Error ? error.message : "Native built-in parameter queue failed.",
      }
    }
  }

  const queueLiveProcessorControl = async (
    request: LiveProcessorControlRequest,
    flush: boolean,
  ): Promise<LiveProcessorControlResult> => {
    if (request.epoch !== undefined && request.epoch !== transportEpoch) return { accepted: false, reason: "stale" }
    if (request.revision !== undefined && request.revision !== preparedGraph?.revision) return { accepted: false, reason: "stale" }
    const sequence = Math.max(nextLiveProcessorSequence + 1, request.sequence ?? 0)
    nextLiveProcessorSequence = sequence
    const result = await queueBuiltInParameterEvents({ ...request, revision: request.revision ?? preparedGraph?.revision ?? 0, epoch: request.epoch ?? transportEpoch, sequence })
    if (result.handled) {
      if (flush) {
        const applied = await waitForNativeProcessorSequence(
          request.revision ?? preparedGraph?.revision ?? 0,
          request.epoch ?? transportEpoch,
          sequence,
        )
        if (!applied) return { accepted: false, reason: "bridge-error", error: "Native processor update was not applied before timeout." }
      }
      return { accepted: true, sequence, appliedSequence: flush ? sequence : undefined }
    }
    if (result.reason === "unprepared") return { accepted: false, reason: "unprepared" }
    if (result.reason === "unavailable") return { accepted: false, reason: "unavailable" }
    if (result.reason === "unsupported-instance" || result.reason === "unsupported-target") {
      return { accepted: false, reason: "unsupported", error: result.reason }
    }
    return { accepted: false, reason: "bridge-error", error: result.error }
  }

  const liveProcessorControl: LiveProcessorControl = {
    preview: (request) => queueLiveProcessorControl(request, false),
    flush: (request) => queueLiveProcessorControl(request, true),
    reenableAutomation: async (instanceId, parameterIds, revision, epoch) => {
      if (revision !== preparedGraph?.revision || epoch !== transportEpoch) return { accepted: false, reason: "stale" }
      return reenableProcessorAutomation(instanceId, parameterIds)
    },
  }
  const reenableProcessorAutomation = async (
    instanceId: string,
    parameterIds: readonly string[],
  ): Promise<LiveProcessorControlResult> => {
    if (!prepared || !preparedGraph) return { accepted: false, reason: "unprepared" }
    const processor = resolveGraphProcessor(preparedGraph, instanceId)
      ?? resolveGraphProcessor(preparedGraph, `external-plugin:${instanceId}`)
    if (!processor || parameterIds.some((parameterId) => !processor.parameterTargets.has(parameterId))) {
      return { accepted: false, reason: "unsupported" }
    }
    const targets = parameterIds.map((parameterId) => processor.parameterTargets.get(parameterId))
      .filter((target): target is number => target !== undefined)
    if (processor.processor.kind !== "external-vst3" || !scheduleCoordinator) {
      const sequence = ++nextLiveProcessorSequence
      return { accepted: true, sequence, appliedSequence: sequence }
    }
    try {
      await scheduleCoordinator.reenableAutomation(
        processor.processor.id.startsWith("external-plugin:") ? processor.processor.id.slice("external-plugin:".length) : processor.processor.id,
        targets,
      )
      const sequence = ++nextLiveProcessorSequence
      return { accepted: true, sequence, appliedSequence: sequence }
    } catch (error) {
      return { accepted: false, reason: "bridge-error", error: error instanceof Error ? error.message : String(error) }
    }
  }

  const runBuiltInStatePatch = async (
    request: PendingStatePatch['request'],
  ): Promise<NativeBuiltInStatePatchResult> => {
    const bridge = input.bridge
    if (!bridge) return { handled: false, reason: "unavailable" }
    const queueProcessorStatePatch = bridge.session.queueProcessorStatePatch
    if (!queueProcessorStatePatch) return { handled: false, reason: "unavailable" }
    if (!prepared || !preparedGraph) return { handled: false, reason: "unprepared" }
    const commit = encodeNativeBuiltInStateCommit(request.payload, request.bpm)
    if (!commit) return { handled: false, reason: "unsupported-state" }
    if (enabledValue(request.payload.from) !== enabledValue(request.payload.to)) {
      return { handled: false, reason: "unsupported-state" }
    }
    const graph = preparedGraph
    const match = resolveGraphProcessor(graph, commit.instanceId)
    if (!match) return { handled: false, reason: "unsupported-instance" }
    const fromEnabled = enabledValue(request.payload.from)
    if (fromEnabled !== undefined && fromEnabled === match.processor.bypassed) {
      return { handled: false, reason: "unsupported-state" }
    }
    const layouts = nativeProcessorLayoutsForState(match.node, commit.instanceId, commit.state)
    if (!layouts) return { handled: false, reason: "unsupported-state" }
    const timing = nativeBuiltInTimingForCommit(request.payload, sampleRate, request.bpm)
    if (!timing) return { handled: false, reason: "unsupported-state" }
    if (
      layouts.output !== nativeProcessorLayoutsForState(match.node, commit.instanceId, match.processor.state)?.output
      || nativeProcessorLatencyForState(match.processor, commit.state) !== match.processor.latencyFrames
    ) return { handled: false, reason: "unsupported-state" }
    const tailFrames = timing.tail.kind === "unbounded" ? 0xffff_ffff : timing.tail.frames
    const patch = serializeNativeProcessorStatePatch({
      graphRevision: graph.revision,
      nodeId: match.node.id,
      instanceId: match.processor.instanceId,
      kindId: match.processor.kindId,
      stateVersion: match.processor.stateVersion,
      state: commit.state,
      bypassed: match.processor.bypassed,
      inputLayout: layouts.input,
      outputLayout: layouts.output,
      parameterTargets: [...match.parameterTargets.values()],
      latencyFrames: match.processor.latencyFrames,
      tailFrames,
    })
    try {
      const reply = await queueProcessorStatePatch(patch)
      if (!reply.ok) return { handled: false, reason: "bridge-error", error: reply.error }
      if (preparedGraph !== undefined) {
        preparedGraph = {
          ...preparedGraph,
          nodes: preparedGraph.nodes.map((node) => ({
            ...node,
              processorOrder: node.processorOrder.map((processor) => {
                if (processor.id !== commit.instanceId) return processor
                const { tailKind: _tailKind, ...processorWithoutTailKind } = processor
                return timing.tail.kind === "unbounded"
                  ? { ...processorWithoutTailKind, state: commit.state.slice(), tailFrames, tailKind: "unbounded" }
                  : { ...processorWithoutTailKind, state: commit.state.slice(), tailFrames }
              }),
          })),
        }
      }
      return { handled: true }
    } catch (error) {
      return {
        handled: false,
        reason: "bridge-error",
        error: error instanceof Error ? error.message : "Native built-in processor state patch failed.",
      }
    }
  }

  const pumpBuiltInStatePatches = async () => {
    if (statePatchActive) return
    statePatchActive = true
    try {
      while (pendingStatePatches.size > 0) {
        const pending = pendingStatePatches.values().next().value
        if (!pending) break
        pendingStatePatches.delete(pending.instanceId)
        pending.resolve(await runBuiltInStatePatch(pending.request))
      }
    } finally {
      statePatchActive = false
      statePatchPumpScheduled = false
      if (pendingStatePatches.size > 0) {
        statePatchPumpScheduled = true
        void pumpBuiltInStatePatches()
      }
    }
  }

  const queueBuiltInStatePatch = (request: PendingStatePatch['request']): Promise<NativeBuiltInStatePatchResult> => {
    const bridge = input.bridge
    if (!bridge) return Promise.resolve({ handled: false, reason: "unavailable" })
    if (!bridge.session.queueProcessorStatePatch) return Promise.resolve({ handled: false, reason: "unavailable" })
    if (!prepared || !preparedGraph) return Promise.resolve({ handled: false, reason: "unprepared" })
    const commit = encodeNativeBuiltInStateCommit(request.payload, request.bpm)
    if (!commit) return Promise.resolve({ handled: false, reason: "unsupported-state" })
    if (enabledValue(request.payload.from) !== enabledValue(request.payload.to)) {
      return Promise.resolve({ handled: false, reason: "unsupported-state" })
    }
    const previous = pendingStatePatches.get(commit.instanceId)
    previous?.resolve({ handled: true })
    const result = new Promise<NativeBuiltInStatePatchResult>((resolve) => {
      pendingStatePatches.set(commit.instanceId, { instanceId: commit.instanceId, request, resolve })
    })
    if (!statePatchActive && !statePatchPumpScheduled) {
      statePatchPumpScheduled = true
      void pumpBuiltInStatePatches()
    }
    return result
  }

  const startLiveMidiNote = (note: {
    trackId: string
    pitch: number
    velocity: number
    playheadSec?: number
  }): NativeLiveMidiNoteHandle | undefined => {
    if (!input.bridge || hasNativeHostConnectionLoss() || !Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127
      || !Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 1) return undefined
    if (preparedSnapshot && !preparedSnapshot.tracks.some((track) => track.id === note.trackId)) {
      return undefined
    }
    const noteId = nextLiveNoteId++
    const queueNoteOn = () => queueLiveInstrumentEvent({
        nodeId: note.trackId,
        noteId,
        sequence: nextLiveEventSequence++,
        frameOffset: 0,
        type: "live-note-on",
        channel: 0,
        note: note.pitch,
        value: note.velocity,
      })
    const readiness: LiveNoteReadiness = {
      promise: Promise.resolve(),
      released: false,
      force: false,
      noteOnQueued: false,
      releaseQueued: false,
    }
    const queueRelease = () => {
      if (!readiness.noteOnQueued || readiness.releaseQueued) return
      readiness.releaseQueued = true
      void queueLiveInstrumentEvent({
        nodeId: note.trackId,
        noteId,
        sequence: nextLiveEventSequence++,
        frameOffset: 0,
        type: "live-note-off",
        channel: 0,
        note: note.pitch,
        value: 0,
      }).finally(() => {
        liveNoteReadiness.delete(noteId)
      })
    }
    const queueAfterPreparation = async (result: NativeStartResult) => {
      if (
        result !== "started"
        || readiness.force
        || !preparedSnapshot?.tracks.some((track) => track.id === note.trackId)
      ) {
        liveNoteReadiness.delete(noteId)
        return
      }
      readiness.noteOnQueued = (await queueNoteOn()) === true
      if (readiness.noteOnQueued) liveMidiTailOwned = true
      if (readiness.released && readiness.noteOnQueued) queueRelease()
      else liveNoteReadiness.delete(noteId)
    }
    readiness.promise = (livePreviewActive
      ? queueAfterPreparation("started")
      : ensureLivePreview(note.playheadSec ?? 0).then(queueAfterPreparation)
    ).catch(() => {
      liveNoteReadiness.delete(noteId)
    })
    liveNoteReadiness.set(noteId, readiness)
    return { backend: "native", trackId: note.trackId, pitch: note.pitch, noteId }
  }

  const releaseLiveMidiNote = (handle: NativeLiveMidiNoteHandle, force = false) => {
    if (handle.backend !== "native" || !input.bridge) return
    if (releasedLiveNoteHandles.has(handle)) return
    releasedLiveNoteHandles.add(handle)
    const readiness = liveNoteReadiness.get(handle.noteId)
    if (readiness) {
      readiness.released = true
      readiness.force = force
      void readiness.promise
      return
    }
    if (!livePreviewActive) return
    void queueLiveInstrumentEvent({
      nodeId: handle.trackId,
      noteId: handle.noteId,
      sequence: nextLiveEventSequence++,
      frameOffset: 0,
      type: "live-note-off",
      channel: 0,
      note: handle.pitch,
      value: 0,
    })
  }

  const subscribeNativeLiveMidiReset = (listener: () => void) => {
    nativeLiveMidiResetListeners.add(listener)
    return () => nativeLiveMidiResetListeners.delete(listener)
  }

  const subscribeTrackMeters = (listener: (levels: TrackStereoLevelsBatch) => void) => {
    nativeMeterListeners.add(listener)
    if (nativeLevels.size > 0) listener(new Map(nativeLevels))
    return () => nativeMeterListeners.delete(listener)
  }

  const subscribeMasterMeter = (listener: (levels: TrackStereoLevels) => void) => {
    nativeMasterMeterListeners.add(listener)
    listener(nativeMasterLevels)
    return () => nativeMasterMeterListeners.delete(listener)
  }

  const subscribeSpectrum = (targetId: string, listener: (frame: SpectrumFrame | null) => void) => {
    nativeSpectrumListeners.add(listener)
    nativeSpectrumTarget = targetId
    if (prepared) configureNativeSpectrumTarget()
    listener(null)
    return () => {
      nativeSpectrumListeners.delete(listener)
      if (nativeSpectrumListeners.size === 0) {
        nativeSpectrumTarget = undefined
        configureNativeSpectrumTarget()
      }
    }
  }

  const currentPositionSec = () => {
    if (sampleRate <= 0) return undefined
    const loop = preparedSnapshot ? nativeLoopFramesForSnapshot(preparedSnapshot, sampleRate) : undefined
    return arrangementFrameForNativeFrame(transportFrame, loop) / sampleRate
  }

  return {
    getPendingStart: () => pendingStart
      ? { mode: pendingStartMode, promise: pendingStart }
      : undefined,
    resetNativeHostConnectionLoss,
    start,
    pause,
    dispose,
    isActive: () => active,
    isAvailable: () => input.bridge !== undefined && !hasNativeHostConnectionLoss(),
    canProcessLiveMidi: () => livePreviewActive,
    hasLiveMidiTails: () => liveMidiTailOwned,
    isPrepared: () => prepared,
    startRecording,
    stopRecording,
    cancelRecording,
    isRecording: () => recording !== undefined,
    sampleRate: () => sampleRate,
    currentPositionSec,
    ensureLivePreview,
    rebuildPrepared,
    seekPrepared,
    queueBuiltInParameterEvents,
    liveProcessorControl,
    reenableProcessorAutomation,
    queueBuiltInStatePatch,
    startLiveMidiNote,
    releaseLiveMidiNote,
    subscribeNativeLiveMidiReset,
    subscribeTrackMeters,
    subscribeMasterMeter,
    subscribeSpectrum,
  }
}
