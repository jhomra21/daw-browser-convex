import {
  compileLiveNativeProjection,
} from "@daw-browser/audio-engine/live-native-projection"
import {
  mapNativeSessionAssets,
  serializeNativeGraph,
  serializeNativeInstrumentEvents,
  serializeNativeVstParameterEvents,
  nativeGraphNodeId,
} from "@daw-browser/audio-engine/native-host-wire"
import type { TrackStereoLevels, TrackStereoLevelsBatch } from "@daw-browser/audio-engine/audio-engine"
import type {
  NativeHostMeterBatch,
  NativeHostRecordingStatus,
  NativeInstrumentEvent,
  NativeSessionAsset,
} from "@daw-browser/audio-engine/native-host-wire"
import type { AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import { parseExternalAutomationParameterId } from "@daw-browser/shared"
import { encodeNativeExternalAttachmentPlan, maxVst3WorkerFrames } from "@daw-browser/plugin-host-protocol"
import type { LivePlaybackSnapshot, LivePlaybackSnapshotCompilation, LivePlaybackTransport } from "~/lib/live-playback-snapshot"
import { createPortableRecordingWriter } from "~/lib/recording/portable-recording-writer"
import type { DesktopBridge } from "~/types/desktop-bridge"
import { createNativeScheduleCoordinator, type NativeScheduleCoordinator } from "./native-schedule-coordinator"

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
    : "Native playback could not start."
  return message.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s]*/g, "<path>").slice(0, 256)
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
    | "queueInstrumentEvents"
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
    reenableVstScheduleAutomation?: NonNullable<DesktopBridge["audioHost"]>["session"]["reenableVstScheduleAutomation"]
  }
}

type NativeStartResult = "started" | "unavailable" | "blocked"
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
  let livePreviewActive = false
  let preparedProjectGeneration: number | undefined
  let pendingStart: Promise<NativeStartResult> | undefined
  let pendingStartMode: "play" | "preview" | undefined
  let lifecycleGeneration = 0
  let transportEpoch = 1
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
  const liveNoteReadiness = new Map<number, LiveNoteReadiness>()
  let scheduleCoordinator: NativeScheduleCoordinator | undefined
  const nativeMeterListeners = new Set<(levels: TrackStereoLevelsBatch) => void>()
  const nativeMasterMeterListeners = new Set<(levels: TrackStereoLevels) => void>()
  let nativeMeterNodeIds = new Map<bigint, string>()
  let nativeMeterRevision = 0
  let latestMeterSequence = 0n
  let nativeLevels: TrackStereoLevelsBatch = new Map()
  let nativeMasterLevels: TrackStereoLevels = { left: 0, right: 0 }

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

  const createCoordinatorForEpoch = (options: {
    snapshot: LivePlaybackSnapshot
    epoch: number
    sampleRateHz: number
    assets: readonly NativeSessionAsset[]
    startFrame: number
  }) => {
    const bridge = input.bridge
    if (!bridge) throw new Error("The native playback bridge is unavailable.")
    return createNativeScheduleCoordinator({
      bridge: {
        queueScheduleWindow: bridge.session.queueScheduleWindow,
        queueInstrumentEvents: bridge.session.queueInstrumentEvents,
        reenableVstScheduleAutomation: bridge.session.reenableVstScheduleAutomation,
        onScheduleProgress: bridge.session.onScheduleProgress,
        onLoss: bridge.session.onLoss,
      },
      snapshot: options.snapshot,
      epoch: options.epoch,
      sampleRateHz: options.sampleRateHz,
      capacity: {
        maximumFramesPerBlock: maximumFramesPerBlock,
        maximumVstEventsPerBlock: maxVst3WorkerFrames,
      },
      assets: options.assets,
      startFrame: options.startFrame,
      onFault: (error) => reportFault(error.message),
      onRenderedFrame: (renderedFrame) => {
        if (renderedFrame >= transportFrame) transportFrame = renderedFrame
      },
      onHostLoss: handleNativeHostLoss,
    })
  }

  const dispose = async () => {
    lifecycleGeneration += 1
    liveInstrumentQueueGeneration += 1
    liveInstrumentEventTail = Promise.resolve()
    pendingStart = undefined
    pendingStartMode = undefined
    const bridge = input.bridge
    const assetIds = installedAssetIds
    installedAssetIds = []
    active = false
    prepared = false
    livePreviewActive = false
    liveNoteReadiness.clear()
    scheduleCoordinator?.dispose()
    scheduleCoordinator = undefined
    clearNativeMeters()
    preparedProjectGeneration = undefined
    preparedSnapshot = undefined
    preparedGraph = undefined
    installedAssets = []
    sampleRate = 0
    maximumFramesPerBlock = 0
    transportFrame = 0
    if (!bridge) return
    const stopPromise = bridge.session.stop()
    await cancelRecording().catch(() => undefined)
    await Promise.allSettled([
      stopPromise,
      ...assetIds.map((sessionAssetId) => bridge.session.releaseAsset(sessionAssetId)),
    ])
    await bridge.session.teardown().catch(() => undefined)
  }

  const handleNativeHostLoss = () => {
    if (recording) failRecording(recording, new Error("Native playback host connection was lost."))
    void dispose().catch(() => undefined)
    reportFault("Native playback host connection was lost.")
  }

  const startAttempt = async (
    transport: LivePlaybackTransport,
    generation: number,
    projectGeneration: number,
    runTransport: boolean,
  ): Promise<NativeStartResult> => {
    const bridge = input.bridge
    if (!bridge) return "unavailable"
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
          const frame = Math.round(transport.playheadSec * sampleRate)
          previousCoordinator?.dispose()
          const nextCoordinator = createCoordinatorForEpoch({
            snapshot: refreshed.snapshot,
            epoch: transportEpoch,
            sampleRateHz: sampleRate,
            assets: installedAssets,
            startFrame: frame,
          })
          if (preparedGraph) nextCoordinator.preflight(preparedGraph)
          nextCoordinator.install()
          scheduleCoordinator = nextCoordinator
          const transitionId = ++nextTransportTransitionId
          assertReply(await bridge.session.setTransport({
            epoch: transportEpoch,
            running: false,
            frame,
            transitionId,
          }))
          await nextCoordinator.waitForTransition(transitionId, false)
          if (runTransport) {
            await nextCoordinator.prime(frame)
            await nextCoordinator.waitForAccepted(frame + Math.min(maximumFramesPerBlock, nextCoordinator.scheduleEndFrame() - frame))
            const runTransitionId = ++nextTransportTransitionId
            assertReply(await bridge.session.setTransport({
              epoch: transportEpoch,
              running: true,
              frame,
              transitionId: runTransitionId,
            }))
            await nextCoordinator.waitForTransition(runTransitionId, true)
          }
          if (cancelled()) {
            await dispose()
            return "unavailable"
          }
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
        if (!cancelled()) reportFault(error instanceof Error ? error.message : "Native playback could not resume.")
        await dispose()
        return "unavailable"
      }
    }
    if (prepared) {
      const assetIds = installedAssetIds
      installedAssetIds = []
      scheduleCoordinator?.dispose()
      scheduleCoordinator = undefined
      clearNativeMeters()
      active = false
      prepared = false
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
      if (!snapshotResult.supported || snapshotResult.snapshot.transport.loopEnabled) return "unavailable"

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
      if (!deviceReply.ok || !deviceReply.device?.available) return unavailable("No native audio output device is available for the active VST3 effect.")
      const runtimeMaximumFrames = Math.min(deviceReply.device.maximumFramesPerBlock, maxVst3WorkerFrames)
      sampleRate = deviceReply.device.nominalSampleRateHz
      maximumFramesPerBlock = runtimeMaximumFrames
      const attachmentPlan = snapshot.nativeExternalAttachmentPlan
        ? {
          ...snapshot.nativeExternalAttachmentPlan,
          attachments: snapshot.nativeExternalAttachmentPlan.attachments.map((attachment) => ({
            ...attachment,
            workerTransport: {
              ...attachment.workerTransport,
              maximumFrames: runtimeMaximumFrames,
            },
          })),
        }
        : undefined
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
      })
      if (runTransport) nextCoordinator.preflight(nativeGraph)
      nextCoordinator.install()
      scheduleCoordinator = nextCoordinator
      assertReply(await bridge.session.setTransport({
        epoch: transportEpoch,
        running: false,
        frame: initialFrame,
        transitionId: ++nextTransportTransitionId,
      }, transactionToken))
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
      unsubscribeMeters?.()
      unsubscribeMeters = bridge.session.onMeterBatch?.(handleNativeMeterBatch)
      assertReply(await bridge.session.start())
      if (cancelled()) {
        await dispose()
        return "unavailable"
      }
      await nextCoordinator.waitForTransition(nextTransportTransitionId, false)
      if (runTransport) {
        // VST workers are started only after the graph transaction is committed.
        // Prime the arranged schedule against that active session, matching the
        // already-prepared live-preview promotion path.
        await nextCoordinator.prime(initialFrame)
        await nextCoordinator.waitForAccepted(initialFrame + Math.min(runtimeMaximumFrames, nextCoordinator.scheduleEndFrame() - initialFrame))
        const runTransitionId = ++nextTransportTransitionId
        assertReply(await bridge.session.setTransport({
          epoch: transportEpoch,
          running: true,
          frame: initialFrame,
          transitionId: runTransitionId,
        }))
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
      if (!wasCancelled) reportFault(error instanceof Error ? error.message : "Native playback could not start.")
      return result
    }
  }

  const start = (transport: LivePlaybackTransport): Promise<NativeStartResult> => {
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

  const pause = async (playheadSec: number) => {
    const bridge = input.bridge
    if (!bridge || !active) return
    if (recording) throw new Error("Native recording must stop before playback can pause.")
    try {
      const frame = Math.round(playheadSec * sampleRate)
      transportEpoch += 1
      const nextCoordinator = preparedSnapshot && scheduleCoordinator
        ? createCoordinatorForEpoch({
          snapshot: preparedSnapshot,
          epoch: transportEpoch,
          sampleRateHz: sampleRate,
          assets: installedAssets,
          startFrame: frame,
        })
        : undefined
      scheduleCoordinator?.dispose()
      nextCoordinator?.install()
      scheduleCoordinator = nextCoordinator
      const transitionId = ++nextTransportTransitionId
      assertReply(await bridge.session.setTransport({
        epoch: transportEpoch,
        running: false,
        frame,
        transitionId,
      }))
      await nextCoordinator?.waitForTransition(transitionId, false)
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
      transportFrame = frame
      active = false
    } catch (error) {
      reportFault(error instanceof Error ? error.message : "Native playback could not pause.")
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
    if (!bridge || !livePreviewActive || sampleRate === 0) return Promise.resolve(false)
    const generation = liveInstrumentQueueGeneration
    const bytes = serializeNativeInstrumentEvents(transportEpoch, [event])
    const queued = liveInstrumentEventTail.then(async () => {
      if (
        generation !== liveInstrumentQueueGeneration
        || !input.bridge
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

  const startLiveMidiNote = (note: {
    trackId: string
    pitch: number
    velocity: number
    playheadSec?: number
  }): NativeLiveMidiNoteHandle | undefined => {
    if (!input.bridge || !Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127
      || !Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 1) return undefined
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
    if (livePreviewActive) {
      void queueNoteOn()
      return { backend: "native", trackId: note.trackId, pitch: note.pitch, noteId }
    }
    const readiness: LiveNoteReadiness = {
      promise: Promise.resolve(),
      released: false,
      force: false,
    }
    readiness.promise = ensureLivePreview(note.playheadSec ?? 0).then(async (result) => {
      if (result !== "started" || readiness.force) {
        liveNoteReadiness.delete(noteId)
        return
      }
      await queueNoteOn()
      if (readiness.released) {
        void queueLiveInstrumentEvent({
          nodeId: note.trackId,
          noteId,
          sequence: nextLiveEventSequence++,
          frameOffset: 0,
          type: "live-note-off",
          channel: 0,
          note: note.pitch,
          value: 0,
        })
      }
      liveNoteReadiness.delete(noteId)
    }).catch(() => {
      liveNoteReadiness.delete(noteId)
    })
    liveNoteReadiness.set(noteId, readiness)
    return { backend: "native", trackId: note.trackId, pitch: note.pitch, noteId }
  }

  const releaseLiveMidiNote = (handle: NativeLiveMidiNoteHandle, force = false) => {
    if (handle.backend !== "native" || !input.bridge) return
    const readiness = liveNoteReadiness.get(handle.noteId)
    if (readiness) {
      readiness.released = true
      readiness.force = force
      if (force) liveNoteReadiness.delete(handle.noteId)
    }
    const releaseQueueGeneration = liveInstrumentQueueGeneration
    const release = () => {
      if (!livePreviewActive) return
      void queueLiveInstrumentEvent(force ? {
        nodeId: handle.trackId,
        noteId: handle.noteId,
        sequence: nextLiveEventSequence++,
        frameOffset: 0,
        type: "all-sound-off",
        channel: 0,
        note: 0,
        value: 0,
      } : {
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
    if (force && !readiness) {
      release()
      return
    }
    if (!readiness) {
      release()
      return
    }
    void readiness.promise.then(() => {
      if (!livePreviewActive || releaseQueueGeneration !== liveInstrumentQueueGeneration || readiness.force) return
      if (readiness.released) release()
      liveNoteReadiness.delete(handle.noteId)
    })
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

  return {
    start,
    pause,
    dispose,
    isActive: () => active,
    isAvailable: () => input.bridge !== undefined,
    canProcessLiveMidi: () => livePreviewActive,
    isPrepared: () => prepared,
    startRecording,
    stopRecording,
    cancelRecording,
    isRecording: () => recording !== undefined,
    sampleRate: () => sampleRate,
    ensureLivePreview,
    startLiveMidiNote,
    releaseLiveMidiNote,
    subscribeTrackMeters,
    subscribeMasterMeter,
  }
}
