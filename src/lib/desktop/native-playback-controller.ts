import {
  compileLiveNativeProjection,
} from "@daw-browser/audio-engine/live-native-projection"
import {
  mapNativeSessionAssets,
  serializeNativeGraph,
  serializeNativeSourceEvents,
} from "@daw-browser/audio-engine/native-host-wire"
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
import type { LivePlaybackSnapshotCompilation, LivePlaybackTransport } from "~/lib/live-playback-snapshot"
import { createPortableRecordingWriter } from "~/lib/recording/portable-recording-writer"

type NativeSessionReply = { ok: true } | { ok: false; error: string }

type NativePlaybackBridge = {
  resolveOutputDevice: () => Promise<
    | { ok: true; device: NativeOutputDevice | null }
    | { ok: false; error: string }
  >
  resolveInputDevice: () => Promise<
    | { ok: true; device: NativeInputDevice | null }
    | { ok: false; error: string }
  >
  session: {
    configure: (input: NativeHostDeviceConfiguration) => Promise<NativeSessionReply>
    beginTransaction: () => Promise<NativeSessionReply>
    commitTransaction: () => Promise<NativeSessionReply>
    rollbackTransaction: () => Promise<NativeSessionReply>
    installAsset: (input: NativeHostPcmAsset) => Promise<NativeSessionReply>
    releaseAsset: (sessionAssetId: number) => Promise<NativeSessionReply>
    publishGraph: (bytes: Uint8Array) => Promise<NativeSessionReply>
    queueSourceEvents: (bytes: Uint8Array) => Promise<NativeSessionReply>
    setTransport: (input: NativeHostTransport) => Promise<NativeSessionReply>
    configureRecording: (input: NativeHostRecordingConfiguration) => Promise<NativeSessionReply>
    startRecording: () => Promise<NativeSessionReply>
    stopRecording: (stopFrame?: number) => Promise<NativeSessionReply>
    cancelRecording: () => Promise<NativeSessionReply>
    start: () => Promise<NativeSessionReply>
    stop: () => Promise<NativeSessionReply>
    teardown: () => Promise<NativeSessionReply>
    onLoss: (listener: () => void) => () => void
    onRecordingBlock: (listener: (block: NativeHostRecordingBlock) => void) => () => void
    onRecordingStatus: (listener: (status: NativeHostRecordingStatus) => void) => () => void
  }
}

type NativeStartResult = "started" | "unavailable"
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

const assertReply = (reply: NativeSessionReply) => {
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

/**
 * Owns a single native host session. It intentionally accepts only the
 * source-only projection and leaves unsupported sessions on the legacy path.
 */
export const createNativePlaybackController = (input: {
  bridge: NativePlaybackBridge | undefined
  compileSnapshot: (transport: LivePlaybackTransport) => Promise<LivePlaybackSnapshotCompilation>
  getProjectGeneration?: () => number
  reportFault?: (message: string) => void
  createRecordingWriter?: typeof createPortableRecordingWriter
}) => {
  let active = false
  let prepared = false
  let preparedProjectGeneration: number | undefined
  let pendingStart: Promise<NativeStartResult> | undefined
  let lifecycleGeneration = 0
  const transportEpoch = 1
  let installedAssetIds: readonly number[] = []
  let unsubscribeLoss: (() => void) | undefined
  let recording: NativeRecordingSession | undefined
  let sampleRate = 0
  let nextRecordingSessionId = 1n
  let recordingGeneration = 1

  const reportFault = (message: string) => {
    input.reportFault?.(message)
  }

  const dispose = async () => {
    lifecycleGeneration += 1
    const bridge = input.bridge
    const assetIds = installedAssetIds
    installedAssetIds = []
    unsubscribeLoss?.()
    unsubscribeLoss = undefined
    active = false
    prepared = false
    preparedProjectGeneration = undefined
    sampleRate = 0
    if (!bridge) return
    await cancelRecording().catch(() => undefined)
    await Promise.allSettled([
      bridge.session.stop(),
      ...assetIds.map((sessionAssetId) => bridge.session.releaseAsset(sessionAssetId)),
    ])
    await bridge.session.teardown().catch(() => undefined)
  }

  const startAttempt = async (
    transport: LivePlaybackTransport,
    generation: number,
    projectGeneration: number,
  ): Promise<NativeStartResult> => {
    const bridge = input.bridge
    if (!bridge) return "unavailable"
    const cancelled = () => generation !== lifecycleGeneration
      || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
    if (prepared && preparedProjectGeneration === projectGeneration) {
      try {
        assertReply(await bridge.session.setTransport({
          epoch: transportEpoch,
          running: true,
          frame: Math.round(transport.playheadSec * sampleRate),
        }))
        if (cancelled()) {
          await dispose()
          return "unavailable"
        }
        assertReply(await bridge.session.start())
        active = true
        return "started"
      } catch (error) {
        if (!cancelled()) reportFault(error instanceof Error ? error.message : "Native playback could not resume.")
        await dispose()
        return "unavailable"
      }
    }
    if (prepared) {
      const assetIds = installedAssetIds
      installedAssetIds = []
      unsubscribeLoss?.()
      unsubscribeLoss = undefined
      active = false
      prepared = false
      preparedProjectGeneration = undefined
      sampleRate = 0
      await Promise.allSettled([
        bridge.session.stop(),
        ...assetIds.map((sessionAssetId) => bridge.session.releaseAsset(sessionAssetId)),
      ])
      await bridge.session.teardown().catch(() => undefined)
    }
    let transactionOpen = false
    try {
      const deviceReply = await bridge.resolveOutputDevice()
      if (cancelled()) return "unavailable"
      if (!deviceReply.ok || !deviceReply.device?.available) return "unavailable"
      const snapshotResult = await input.compileSnapshot(transport)
      if (cancelled()) return "unavailable"
      if (!snapshotResult.supported || snapshotResult.snapshot.transport.loopEnabled) return "unavailable"

      const { snapshot } = snapshotResult
      if (
        snapshot.mixer.fx.masterVolume !== 1
        || snapshot.mixer.fx.masterFxInstances.length > 0
        || Object.keys(snapshot.mixer.fx.trackFx ?? {}).length > 0
        || snapshot.mixer.sidechainRoutes.length > 0
      ) return "unavailable"
      const projection = compileLiveNativeProjection({
        tracks: snapshot.tracks,
        bpm: snapshot.bpm,
        sampleRateHz: deviceReply.device.nominalSampleRateHz,
        revision: snapshot.revision,
        epoch: transportEpoch,
        firstSequence: 1,
      })
      if (!projection.supported || deviceReply.device.outputChannelCount < 2) return "unavailable"

      const assets = mapNativeSessionAssets(projection.graph.assets)
      assertReply(await bridge.session.beginTransaction())
      transactionOpen = true
      if (cancelled()) throw new Error("Native playback startup was cancelled.")
      assertReply(await bridge.session.configure({
        deviceId: deviceReply.device.deviceId,
        sampleRateHz: deviceReply.device.nominalSampleRateHz,
        maxFramesPerBlock: deviceReply.device.maximumFramesPerBlock,
        channelCount: 2,
        revision: snapshot.revision,
      }))
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
        }))
        if (cancelled()) throw new Error("Native playback startup was cancelled.")
      }
      assertReply(await bridge.session.publishGraph(serializeNativeGraph(projection.graph)))
      if (cancelled()) throw new Error("Native playback startup was cancelled.")
      assertReply(await bridge.session.queueSourceEvents(serializeNativeSourceEvents(projection.events, assets)))
      if (cancelled()) throw new Error("Native playback startup was cancelled.")
      assertReply(await bridge.session.setTransport({
        epoch: transportEpoch,
        running: true,
        frame: Math.round(snapshot.transport.playheadSec * deviceReply.device.nominalSampleRateHz),
      }))
      if (cancelled()) throw new Error("Native playback startup was cancelled.")
      assertReply(await bridge.session.commitTransaction())
      transactionOpen = false
      installedAssetIds = assets.map(({ sessionAssetId }) => sessionAssetId)
      sampleRate = deviceReply.device.nominalSampleRateHz
      prepared = true
      preparedProjectGeneration = projectGeneration
      active = true
      unsubscribeLoss = bridge.session.onLoss(() => {
        const wasActive = active
        const recordingSession = recording
        if (recordingSession) failRecording(recordingSession, new Error("Native recording host connection was lost."))
        active = false
        prepared = false
        preparedProjectGeneration = undefined
        sampleRate = 0
        installedAssetIds = []
        unsubscribeLoss = undefined
        if (wasActive) reportFault("Native playback host connection was lost.")
      })
      assertReply(await bridge.session.start())
      if (cancelled()) {
        await dispose()
        return "unavailable"
      }
      return "started"
    } catch (error) {
      const wasCancelled = cancelled()
      if (transactionOpen) await bridge.session.rollbackTransaction()
      else await dispose()
      if (!wasCancelled) reportFault(error instanceof Error ? error.message : "Native playback could not start.")
      return "unavailable"
    }
  }

  const start = (transport: LivePlaybackTransport): Promise<NativeStartResult> => {
    if (active) return Promise.resolve("started")
    if (pendingStart) return pendingStart
    const generation = lifecycleGeneration
    const projectGeneration = input.getProjectGeneration?.() ?? 0
    const request = startAttempt(transport, generation, projectGeneration)
    pendingStart = request
    void request.finally(() => {
      if (pendingStart === request) pendingStart = undefined
    })
    return request
  }

  const pause = async (playheadSec: number) => {
    const bridge = input.bridge
    if (!bridge || !active) return
    if (recording) throw new Error("Native recording must stop before playback can pause.")
    try {
      assertReply(await bridge.session.setTransport({
        epoch: transportEpoch,
        running: false,
        frame: Math.round(playheadSec * sampleRate),
      }))
      assertReply(await bridge.session.stop())
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

  return {
    start,
    pause,
    dispose,
    isActive: () => active,
    isPrepared: () => prepared,
    startRecording,
    stopRecording,
    cancelRecording,
    isRecording: () => recording !== undefined,
    sampleRate: () => sampleRate,
  }
}
