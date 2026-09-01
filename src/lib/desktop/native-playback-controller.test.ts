import { expect, test } from "bun:test"

import { createNativePlaybackController } from "./native-playback-controller"
import { compileLivePlaybackSnapshot, type LivePlaybackCompileContext, type LivePlaybackSnapshotInput } from "~/lib/live-playback-snapshot"
import type { RuntimeTrack } from "~/lib/timeline-runtime-types"
import { automationTargetKey, createDefaultDrumRackParams, createDefaultReverbParams, createDefaultSynthParams, createDefaultUtilityParams, externalAutomationParameterId } from "@daw-browser/shared"
import { nativeGraphNodeId, type NativeHostMappedAsset, type NativeHostMappedAssetPage, type NativeHostMeterBatch, type NativeHostPcmAsset, type NativeHostRecordingBlock, type NativeHostRecordingStatus, type NativeHostSpectrumFrame, type NativeScheduleProgress } from "@daw-browser/audio-engine/native-host-wire"
import type { SpectrumFrame } from "@daw-browser/audio-engine/audio-engine"
import type { NativeExternalAttachmentPlan } from "@daw-browser/plugin-host-protocol"
import type { EffectParamsCommitPayload } from "~/lib/undo/types"

class TestAudioBuffer implements AudioBuffer {
  readonly duration: number
  readonly length: number
  readonly numberOfChannels: number
  readonly sampleRate: number

  constructor(
    private readonly channels: Float32Array<ArrayBuffer>[] = [
      new Float32Array(1),
      new Float32Array(1),
    ],
    sampleRate = 48_000,
  ) {
    this.length = channels[0]?.length ?? 0
    this.numberOfChannels = channels.length
    this.sampleRate = sampleRate
    this.duration = this.length / sampleRate
  }

  copyFromChannel(destination: Float32Array<ArrayBuffer>, channel: number, offset = 0) {
    const source = this.channels[channel]
    if (!source) throw new Error(`Missing channel ${channel}.`)
    destination.set(source.subarray(offset, offset + destination.length))
  }

  copyToChannel(source: Float32Array<ArrayBuffer>, channel: number, offset = 0) {
    const destination = this.channels[channel]
    if (!destination) throw new Error(`Missing channel ${channel}.`)
    destination.set(source, offset)
  }

  getChannelData(channel: number) {
    const samples = this.channels[channel]
    if (!samples) throw new Error(`Missing channel ${channel}.`)
    return samples
  }
}

const silenceWavDataUrl = (frameCount: number, channelCount = 1) => {
  const bytes = new Uint8Array(44 + frameCount * channelCount * 2)
  const view = new DataView(bytes.buffer)
  const write = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset)
  write(0, "RIFF")
  view.setUint32(4, bytes.byteLength - 8, true)
  write(8, "WAVE")
  write(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, 48_000, true)
  view.setUint32(28, 48_000 * channelCount * 2, true)
  view.setUint16(32, channelCount * 2, true)
  view.setUint16(34, 16, true)
  write(36, "data")
  view.setUint32(40, bytes.byteLength - 44, true)
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")
  return `data:audio/wav;base64,${btoa(binary)}`
}

const sourceTrack = (volume = 0.8): RuntimeTrack => ({
  id: "track",
  name: "Track",
  volume,
  clips: [{
    id: "clip",
    name: "Clip",
    color: "#fff",
    startSec: 0,
    duration: 1 / 48_000,
    sourceAssetKey: "source",
    sourceKind: "url" as const,
    sampleUrl: silenceWavDataUrl(1),
    buffer: new TestAudioBuffer(),
  }],
})

const input = (track = sourceTrack()): LivePlaybackSnapshotInput => ({
  revision: 1,
  bpm: 120,
  transport: { state: "playing", playheadSec: 0, loopEnabled: false, loopStartSec: 0, loopEndSec: 0 },
  tracks: [track],
  renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
  sidechainRoutes: [],
})

const inputWithRawAssetsAndStretch = (rawAssetCount: number): LivePlaybackSnapshotInput => ({
  ...input({
    ...sourceTrack(),
    clips: [
      ...Array.from({ length: rawAssetCount }, (_, index) => ({
        ...sourceTrack().clips[0]!,
        id: `raw-clip-${index}`,
        sourceAssetKey: `raw-source-${index}`,
        buffer: new TestAudioBuffer(),
      })),
      {
        ...sourceTrack().clips[0]!,
        id: "stretch-clip",
        sourceAssetKey: "stretch-source",
        audioWarp: { enabled: true, mode: "stretch", sourceBpm: 120 },
        buffer: new TestAudioBuffer(),
      },
    ],
  }),
})

const instrumentTrack: RuntimeTrack = {
  id: "instrument",
  kind: "instrument",
  name: "Instrument",
  volume: 0.8,
  channelRole: "track",
  clips: [{
    id: "midi",
    name: "MIDI",
    color: "#fff",
    startSec: 0,
    duration: 1,
    midi: { wave: "sawtooth", notes: [{ pitch: 60, beat: 0, length: 0.5, velocity: 0.8 }] },
  }],
}

const nativeInstrumentInput = (): LivePlaybackSnapshotInput => ({
  ...input(instrumentTrack),
  renderState: {
    fx: {
      masterVolume: 1,
      masterFxInstances: [],
      trackFx: {
        instrument: {
          instances: [],
          instrument: {
            kind: "synth",
            instanceId: "synth:1",
            params: createDefaultSynthParams(),
          },
        },
      },
    },
    automationEnvelopes: [],
  },
})

const liveMidiInput = (): LivePlaybackSnapshotInput => {
  const base = nativeInstrumentInput()
  return {
    ...base,
    renderState: {
      ...base.renderState,
      fx: {
        ...base.renderState.fx,
        trackFx: {
          instrument: {
            instances: [],
            synth: createDefaultSynthParams(),
          },
        },
      },
    },
  }
}

const nativeAttachmentPlan: NativeExternalAttachmentPlan = {
  version: 1,
  attachments: [{
    instanceId: "11111111-1111-4111-8111-111111111111",
    graphNodeId: "track",
    nativeGraphNodeId: "123",
    stageIndex: 0,
    catalogIdentity: {
      format: "vst3",
      classId: "class",
      vendorId: "vendor",
      architecture: "arm64",
      scannerCatalogVersion: 2,
    },
    bundleFingerprint: "a".repeat(64),
    binaryFingerprint: "b".repeat(64),
    role: "effect",
    inputBuses: [{ name: "Main Input", channels: 2, enabled: true }],
    outputBuses: [{ name: "Main Output", channels: 2, enabled: true }],
    workerTransport: {
      slotCount: 2,
      maximumFrames: 512,
      maximumEventsPerBlock: 128,
      inputChannels: 2,
      outputChannels: 2,
    },
    declaredLatencyFrames: 0,
    declaredTailFrames: null,
    bypassed: false,
    stateRevision: 0,
    parameters: [{
      id: 7,
      title: "Mix",
      unit: "%",
      minimum: 0,
      maximum: 1,
      defaultValue: 0.25,
      stepCount: 100,
      readOnly: false,
      hidden: false,
    }],
    parameterOverrides: { "7": 0.4 },
  }],
}

type BridgeReply = { ok: true } | { ok: false; error: string }
type BridgeTransactionReply = { ok: true; transactionToken: string } | { ok: false; error: string }

const createBridge = (
  failure?: string,
  serializeInstrumentRequests = false,
  requireStartedForSchedule = false,
  failureMessage = "failed",
  sampleRateHz = 48_000,
  suppressRedundantPausedTransition = false,
) => {
  const calls: string[] = []
  const parameterPayloads: Uint8Array[] = []
  const builtInParameterPayloads: Uint8Array[] = []
  const statePatchPayloads: Uint8Array[] = []
  const instrumentPayloads: Uint8Array[] = []
  const schedulePayloads: Uint8Array[] = []
  const graphPayloads: Uint8Array[] = []
  const installedAssets: NativeHostPcmAsset[] = []
  let legacyInstallCount = 0
  let mappedAssetCreateCount = 0
  const transports: Array<{
    epoch: number
    frame: number
    running: boolean
    hasCycleStart: boolean
    hasCycleEnd: boolean
  }> = []
  const spectrumNodeIds: Array<bigint | null> = []
  const spectrumSelections: Array<{ nodeId: bigint | null; sessionStarted: boolean }> = []
  const instrumentRequests: Array<{
    bytes: Uint8Array
    resolve: (reply: BridgeReply) => void
  }> = []
  const deviceId: `coreaudio:${string}` = "coreaudio:default"
  let instrumentRequestPending = false
  let loss = (_error?: string) => {}
  const lossListeners = new Set<(error?: string) => void>()
  let recordingBlock = (_block: NativeHostRecordingBlock) => {}
  let recordingStatus = (_status: NativeHostRecordingStatus) => {}
  let meterBatch = (_batch: NativeHostMeterBatch) => {}
  let spectrumFrame = (_frame: NativeHostSpectrumFrame) => {}
  let scheduleProgress = (_progress: NativeScheduleProgress) => {}
  let progressSequence = 0n
  let transportEpoch = 1
  let appliedTransitionId = 0n
  let appliedUrgentSequence = 0n
  let appliedProcessorSequence = 0n
  let sessionStarted = false
  let lastTransport: { frame: number; running: boolean } | undefined
  let rejectScheduleWindows = false
  const emitProgress = (frame: number) => {
    progressSequence += 1n
    const currentWindows = schedulePayloads.filter((payload) => {
      const view = new DataView(payload.buffer)
      return view.getUint32(4, true) === transportEpoch
    })
    const acceptedThroughFrame = currentWindows.reduce(
      (maximum, payload) => Math.max(maximum, Number(new DataView(payload.buffer).getBigUint64(24, true))),
      frame,
    )
    scheduleProgress({
      revision: 1,
      epoch: transportEpoch,
      progressSequence,
      renderedThroughFrame: BigInt(frame),
      acceptedThroughFrame: BigInt(acceptedThroughFrame),
      lastAcceptedWindowId: BigInt(currentWindows.length),
      appliedTransportTransitionId: appliedTransitionId,
      appliedUrgentSequence,
      appliedProcessorSequence,
      running: false,
      scheduleComplete: currentWindows.some((payload) => new DataView(payload.buffer).getUint32(40, true) === 1),
      instrumentCredits: 256,
      sourceCredits: 256,
      automationCredits: 256,
    })
  }
  const reply = (name: string) => async () => {
    calls.push(name)
    return name === failure ? { ok: false as const, error: failureMessage } : { ok: true as const }
  }
  return {
    calls,
    parameterPayloads,
    builtInParameterPayloads,
    statePatchPayloads,
    instrumentPayloads,
    schedulePayloads,
    graphPayloads,
    installedAssets,
    get legacyInstallCount() { return legacyInstallCount },
    get mappedAssetCreateCount() { return mappedAssetCreateCount },
    transports,
    spectrumNodeIds,
    spectrumSelections,
    instrumentRequests,
    captureLoss: () => loss,
    emitLoss: (error?: string) => {
      for (const listener of lossListeners) listener(error)
    },
    emitRecordingBlock: (block: NativeHostRecordingBlock) => recordingBlock(block),
    emitRecordingStatus: (status: NativeHostRecordingStatus) => recordingStatus(status),
    emitMeterBatch: (batch: NativeHostMeterBatch) => meterBatch(batch),
    emitSpectrumFrame: (frame: NativeHostSpectrumFrame) => spectrumFrame(frame),
    emitScheduleProgress: (progress: NativeScheduleProgress) => scheduleProgress(progress),
    setScheduleFailure: (rejected: boolean) => {
      rejectScheduleWindows = rejected
    },
    bridge: {
      resolveOutputDevice: async () => ({
        ok: true as const,
        device: {
          deviceId,
          name: "Default",
          nominalSampleRateHz: sampleRateHz,
          outputChannelCount: 2,
          maximumFramesPerBlock: 512,
          available: true,
        },
      }),
      resolveInputDevice: async () => ({
        ok: true as const,
        device: {
          deviceId,
          name: "Default Input",
          nominalSampleRateHz: sampleRateHz,
          inputChannelCount: 2,
          maximumFramesPerBlock: 512,
          available: true,
        },
      }),
      session: {
        configure: reply("configure"),
        beginTransaction: async (): Promise<BridgeTransactionReply> => {
          calls.push("begin")
          return failure === "begin" ? { ok: false as const, error: failureMessage } : { ok: true as const, transactionToken: "transaction-token" }
        },
        commitTransaction: reply("commit"),
        rollbackTransaction: reply("rollback"),
        installAsset: async (asset: NativeHostPcmAsset) => {
          calls.push("install")
          legacyInstallCount += 1
          installedAssets.push(asset)
          return failure === "install"
            ? { ok: false as const, error: failureMessage }
            : { ok: true as const }
        },
        createMappedAsset: async (asset: NativeHostMappedAsset) => {
          calls.push("install")
          mappedAssetCreateCount += 1
          installedAssets.push({
            sessionAssetId: asset.sessionAssetId,
            frameCount: asset.frameCount,
            sampleRateHz: asset.sampleRateHz,
            channelCount: asset.channelCount,
            planarPcm: new Uint8Array(),
          })
          return failure === "install"
            ? { ok: false as const, error: failureMessage }
            : { ok: true as const }
        },
        writeMappedAssetPage: async (_page: NativeHostMappedAssetPage) => ({ ok: true as const }),
        prepareMappedAssetRange: async () => ({ ok: true as const }),
        releaseAsset: reply("release"),
        publishGraph: async (bytes: Uint8Array) => {
          calls.push("graph")
          graphPayloads.push(bytes)
          return failure === "graph"
            ? { ok: false as const, error: "failed" }
            : { ok: true as const }
        },
        queueInstrumentEvents: (bytes: Uint8Array) => {
          calls.push("instrument")
          instrumentPayloads.push(bytes)
          const view = new DataView(bytes.buffer)
          const count = view.getUint32(0, true)
          for (let index = 0; index < count; index += 1) {
            const sequence = view.getBigUint64(20 + index * 48, true)
            if (sequence > appliedUrgentSequence) appliedUrgentSequence = sequence
          }
          queueMicrotask(() => emitProgress(0))
          if (!serializeInstrumentRequests) {
            return Promise.resolve(failure === "instrument"
              ? { ok: false as const, error: "failed" }
              : { ok: true as const })
          }
          if (instrumentRequestPending) {
            return Promise.reject(new Error("The native audio host is unavailable."))
          }
          instrumentRequestPending = true
          const request = Promise.withResolvers<BridgeReply>()
          instrumentRequests.push({ bytes, resolve: request.resolve })
          return request.promise.finally(() => {
            instrumentRequestPending = false
          })
        },
        queueParameterEvents: async (bytes: Uint8Array) => {
          calls.push("built-in-parameter")
          builtInParameterPayloads.push(bytes)
          if (bytes.byteLength >= 20) {
            appliedProcessorSequence = new DataView(bytes.buffer).getBigUint64(12, true)
            queueMicrotask(() => emitProgress(0))
          }
          return failure === "built-in-parameter"
            ? { ok: false as const, error: failureMessage }
            : { ok: true as const }
        },
        queueProcessorStatePatch: async (bytes: Uint8Array) => {
          calls.push("processor-state-patch")
          statePatchPayloads.push(bytes)
          return failure === "processor-state-patch"
            ? { ok: false as const, error: failureMessage }
            : { ok: true as const }
        },
        queueSourceEvents: reply("source"),
        queueScheduleWindow: async (bytes: Uint8Array) => {
          calls.push("schedule")
          if (requireStartedForSchedule && !sessionStarted) {
            return { ok: false as const, error: "session is not started" }
          }
          schedulePayloads.push(bytes)
          queueMicrotask(() => emitProgress(0))
          return failure === "schedule" || rejectScheduleWindows
            ? { ok: false as const, error: "failed" }
            : { ok: true as const }
        },
        queueVstParameterEvents: async (bytes: Uint8Array) => {
          calls.push("parameter")
          parameterPayloads.push(bytes)
          return failure === "parameter" ? { ok: false as const, error: "failed" } : { ok: true as const }
        },
        coordinateVstAttachments: async () => {
          calls.push("coordinate")
          return failure === "coordinate" ? { ok: false as const, error: "failed" } : { ok: true as const }
        },
        setTransport: async (transport: { epoch: number; frame: number; running: boolean; transitionId?: bigint }) => {
          calls.push("transport")
          transports.push({
            epoch: transport.epoch,
            frame: transport.frame,
            running: transport.running,
            hasCycleStart: Object.hasOwn(transport, "cycleStartSec"),
            hasCycleEnd: Object.hasOwn(transport, "cycleEndSec"),
          })
          transportEpoch = transport.epoch
          appliedTransitionId = transport.transitionId ?? (appliedTransitionId + 1n)
          const redundantPausedTransition = suppressRedundantPausedTransition
            && lastTransport !== undefined
            && !transport.running
            && !lastTransport.running
            && transport.frame === lastTransport.frame
          lastTransport = { frame: transport.frame, running: transport.running }
          if (redundantPausedTransition) return { ok: true as const }
          if (requireStartedForSchedule && !sessionStarted) return { ok: true as const }
          queueMicrotask(() => {
            emitProgress(transport.frame)
            const currentWindows = schedulePayloads.filter((payload) => {
              const view = new DataView(payload.buffer)
              return view.getUint32(4, true) === transportEpoch
            })
            const acceptedThroughFrame = currentWindows.reduce(
              (maximum, payload) => Math.max(maximum, Number(new DataView(payload.buffer).getBigUint64(24, true))),
              transport.frame,
            )
            progressSequence += 1n
            scheduleProgress({
              ...({
                revision: 1,
                epoch: transportEpoch,
                progressSequence,
                renderedThroughFrame: BigInt(transport.frame),
                acceptedThroughFrame: BigInt(acceptedThroughFrame),
                lastAcceptedWindowId: BigInt(currentWindows.length),
                appliedTransportTransitionId: appliedTransitionId,
                appliedUrgentSequence,
                appliedProcessorSequence,
                running: transport.running,
                scheduleComplete: currentWindows.some((payload) => new DataView(payload.buffer).getUint32(40, true) === 1),
                instrumentCredits: 256,
                sourceCredits: 256,
                automationCredits: 256,
              } satisfies NativeScheduleProgress),
            })
          })
          return failure === "transport" ? { ok: false as const, error: "failed" } : { ok: true as const }
        },
        configureRecording: reply("recording-configure"),
        startRecording: async () => {
          calls.push("recording-start")
          queueMicrotask(() => recordingStatus({
            generation: 1,
            sessionId: 1n,
            timelineFrame: 120,
            capturedFrames: 0,
            droppedFrames: 0,
            droppedBlocks: 0,
            availableBlocks: 64,
            queuedBlocks: 0,
            rms: 0,
            peak: 0,
            fatal: false,
            active: true,
            configured: true,
          }))
          return { ok: true as const }
        },
        stopRecording: async () => {
          calls.push("recording-stop")
          queueMicrotask(() => recordingStatus({
            generation: 1,
            sessionId: 1n,
            timelineFrame: 248,
            capturedFrames: 128,
            droppedFrames: 0,
            droppedBlocks: 0,
            availableBlocks: 64,
            queuedBlocks: 0,
            rms: 0.25,
            peak: 0.5,
            fatal: false,
            active: false,
            configured: true,
          }))
          return { ok: true as const }
        },
        cancelRecording: reply("recording-cancel"),
        start: async () => {
          calls.push("start")
          sessionStarted = true
          if (requireStartedForSchedule) queueMicrotask(() => emitProgress(0))
          return { ok: true as const }
        },
        stop: async () => {
          calls.push("stop")
          sessionStarted = false
          return { ok: true as const }
        },
        teardown: reply("teardown"),
        onLoss: (listener: () => void) => {
          loss = listener
          lossListeners.add(listener)
          return () => {
            lossListeners.delete(listener)
            if (loss === listener) loss = () => {}
          }
        },
        onRecordingBlock: (listener: (block: NativeHostRecordingBlock) => void) => {
          recordingBlock = listener
          return () => { recordingBlock = () => {} }
        },
        onRecordingStatus: (listener: (status: NativeHostRecordingStatus) => void) => {
          recordingStatus = listener
          return () => { recordingStatus = () => {} }
        },
        onMeterBatch: (listener: (batch: NativeHostMeterBatch) => void) => {
          meterBatch = listener
          return () => { meterBatch = () => {} }
        },
        setSpectrumNode: async (nodeId: bigint | null) => {
          spectrumNodeIds.push(nodeId)
          spectrumSelections.push({ nodeId, sessionStarted })
          if (nodeId !== null && !sessionStarted) {
            return { ok: false as const, error: "session is not started" }
          }
          return { ok: true as const }
        },
        onSpectrumFrame: (listener: (frame: NativeHostSpectrumFrame) => void) => {
          spectrumFrame = listener
          return () => { spectrumFrame = () => {} }
        },
        onScheduleProgress: (listener: typeof scheduleProgress) => {
          scheduleProgress = listener
          return () => { scheduleProgress = () => {} }
        },
      },
    },
  }
}

const decodeNativeInstrumentEvents = (payloads: readonly Uint8Array[]) => payloads.flatMap((payload) => {
  const view = new DataView(payload.buffer)
  const count = view.getUint32(0, true)
  return Array.from({ length: count }, (_, index) => ({
    nodeId: view.getBigUint64(4 + index * 48, true),
    type: view.getUint32(36 + index * 48, true),
  }))
})

const nativeInstrumentEventTypes = (payload: Uint8Array) =>
  decodeNativeInstrumentEvents([payload]).map(({ type }) => type)

const nativeLiveInstrumentEvents = (payloads: readonly Uint8Array[]) =>
  decodeNativeInstrumentEvents(payloads).filter(({ type }) => type === 101 || type === 102)

const nativeTransportReleaseEvents = (payloads: readonly Uint8Array[]) =>
  decodeNativeInstrumentEvents(payloads).filter(({ type }) => type === 103)

const decodeNativeSourceEvents = (payloads: readonly Uint8Array[]) => payloads.flatMap((payload) => {
  const view = new DataView(payload.buffer)
  const instrumentCount = view.getUint32(44, true)
  const sourceCount = view.getUint32(48, true)
  const sourceOffset = 60 + instrumentCount * 48
  return Array.from({ length: sourceCount }, (_, index) => {
    const offset = sourceOffset + index * 112
    return {
      epoch: view.getUint32(4, true),
      assetId: view.getUint32(offset + 20, true),
      startFrame: Number(view.getBigInt64(offset + 24, true)),
      stopFrame: Number(view.getBigInt64(offset + 32, true)),
    }
  })
})

const decodeNativeProcessorEvents = (payloads: readonly Uint8Array[]) => payloads.flatMap((payload) => {
  const view = new DataView(payload.buffer)
  const instrumentCount = view.getUint32(44, true)
  const sourceCount = view.getUint32(48, true)
  const processorCount = view.getUint32(56, true)
  const processorOffset = 60 + instrumentCount * 48 + sourceCount * 112
  return Array.from({ length: processorCount }, (_, index) => {
    const offset = processorOffset + index * 40
    return {
      epoch: view.getUint32(4, true),
      frame: Number(view.getBigUint64(offset + 16, true)),
      value: view.getFloat32(offset + 32, true),
    }
  })
})

test("commits a supported native session before starting and tears it down deterministically", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  expect(await controller.start(input().transport)).toBe("started")
  expect(fixture.legacyInstallCount).toBe(0)
  expect(fixture.mappedAssetCreateCount).toBe(1)
  expect(fixture.calls).toEqual(["begin", "configure", "install", "graph", "transport", "commit", "start", "schedule", "transport"])
  expect(fixture.transports.every(({ hasCycleStart, hasCycleEnd }) => !hasCycleStart && !hasCycleEnd)).toBe(true)
  await controller.dispose()
  expect(fixture.calls).toEqual([
    "begin", "configure", "install", "graph", "transport", "commit", "start", "schedule", "transport",
    "stop", "release", "teardown",
  ])
})

test("starts a mapped session from persisted ordinary metadata without an eager buffer", async () => {
  const fixture = createBridge()
  const track = {
    ...sourceTrack(),
    clips: [{
      ...sourceTrack().clips[0]!,
      buffer: null,
      sourceDurationSec: 1 / 48_000,
      sourceSampleRate: 48_000,
      sourceChannelCount: 1,
    }],
  }
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input(track)),
  })

  await expect(controller.start(input(track).transport)).resolves.toBe("started")
  expect(fixture.legacyInstallCount).toBe(0)
  expect(fixture.mappedAssetCreateCount).toBe(1)
  await controller.dispose()
})

test("forwards compile context when promoting a pending preview to play", async () => {
  const fixture = createBridge()
  const previewGate = Promise.withResolvers<void>()
  const contexts: unknown[] = []
  let compilation = 0
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport, context) => {
      contexts.push(context)
      compilation += 1
      if (compilation === 1) await previewGate.promise
      return compileLivePlaybackSnapshot({ ...input(), transport })
    },
  })
  const compileContext = {
    instrumentOverride: {
      targetId: "track-1",
      instrument: {
        kind: "drum-rack",
        instanceId: "drum-rack:replacement",
        params: createDefaultDrumRackParams(),
      },
    },
  } satisfies LivePlaybackCompileContext

  const preview = controller.ensureLivePreview(0)
  const play = controller.start(input().transport, compileContext)
  previewGate.resolve()
  await expect(preview).resolves.toBe("started")
  await expect(play).resolves.toBe("started")
  expect(contexts).toEqual([undefined, compileContext])
})

test("prepares enabled Stretch clips before publishing the native graph", async () => {
  const fixture = createBridge(undefined, false, false, "failed", 48_000)
  const faults: string[] = []
  const stretchBuffer = new TestAudioBuffer([
    new Float32Array(108_600),
    new Float32Array(108_600),
  ], 44_100)
  const stretchTrack: RuntimeTrack = {
    ...sourceTrack(),
    clips: [{
      ...sourceTrack().clips[0]!,
      duration: 2.462585,
      buffer: stretchBuffer,
      sourceDurationSec: 2.462585,
      sourceSampleRate: 44_100,
      sourceChannelCount: 2,
      audioWarp: { enabled: true, mode: "stretch", sourceBpm: 200 },
    }],
  }
  const stretchInput = {
    ...input(stretchTrack),
    tracks: [
      stretchTrack,
      { id: "empty", name: "Empty", volume: 1, clips: [] },
    ],
  }
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    getProjectGeneration: () => 0,
    createBuffer: (channels, frames, sampleRate) => new TestAudioBuffer(
      Array.from({ length: channels }, () => new Float32Array(frames)),
      sampleRate,
    ),
    reportFault: (message) => faults.push(message),
    reportUnavailable: true,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
      ...stretchInput,
      transport,
    }),
  })

  const result = await controller.start(stretchInput.transport)
  expect(result).toBe("started")
  expect(faults).toEqual([])
  expect(fixture.calls).toContain("install")
  expect(fixture.calls).toContain("graph")
  expect(fixture.installedAssets).toHaveLength(1)
  expect(fixture.installedAssets[0]).toMatchObject({
    frameCount: Math.round(stretchBuffer.length * 48_000 / 44_100),
    sampleRateHz: 48_000,
    channelCount: 2,
  })
  await controller.dispose()
})

test("does not begin a native transaction when Stretch preparation fails", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  const stretchTrack: RuntimeTrack = {
    ...sourceTrack(),
    clips: [{
      ...sourceTrack().clips[0]!,
      audioWarp: { enabled: true, mode: "stretch", sourceBpm: 120 },
    }],
  }
  const compiled = compileLivePlaybackSnapshot(input(stretchTrack))
  if (!compiled.supported) throw new Error(compiled.reasons.join(" "))
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    getProjectGeneration: () => 1,
    createBuffer: () => {
      throw new Error("buffer creation unavailable")
    },
    reportFault: (message) => faults.push(message),
    compileSnapshot: async () => ({
      supported: true as const,
      snapshot: {
        ...compiled.snapshot,
        nativeExternalAttachmentPlan: nativeAttachmentPlan,
        requiresNativePlayback: true,
      },
    }),
  })

  expect(await controller.start(compiled.snapshot.transport)).toBe("blocked")
  expect(fixture.calls).toEqual([])
  expect(faults[0]).toContain("portable Stretch preparation failed")
})

test("rejects the 65th native asset after final projection", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  const snapshotInput = inputWithRawAssetsAndStretch(64)
  let createBufferCalls = 0
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    createBuffer: () => {
      createBufferCalls += 1
      return new TestAudioBuffer()
    },
    reportFault: (message) => faults.push(message),
    reportUnavailable: true,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
      ...snapshotInput,
      transport,
    }),
  })

  expect(await controller.start(snapshotInput.transport)).toBe("unavailable")
  expect(createBufferCalls).toBe(1)
  expect(fixture.calls).toEqual([])
  expect(faults[0]).toContain("installed audio asset capacity")
})

test("accepts an expanded session at the 64-asset native boundary", async () => {
  const fixture = createBridge()
  const snapshotInput = inputWithRawAssetsAndStretch(63)
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    createBuffer: (channels, frames, sampleRate) => new TestAudioBuffer(
      Array.from({ length: channels }, () => new Float32Array(frames)),
      sampleRate,
    ),
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
      ...snapshotInput,
      transport,
    }),
  })

  expect(await controller.start(snapshotInput.transport)).toBe("started")
  expect(fixture.installedAssets).toHaveLength(64)
  await controller.dispose()
})

test("reports optional native unavailability when packaged playback has no fallback", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  const stretchTrack: RuntimeTrack = {
    ...sourceTrack(),
    clips: [{
      ...sourceTrack().clips[0]!,
      audioWarp: { enabled: true, mode: "stretch", sourceBpm: 200 },
    }],
  }
  const compiled = compileLivePlaybackSnapshot(input(stretchTrack))
  if (!compiled.supported) throw new Error(compiled.reasons.join(" "))
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    getProjectGeneration: () => 0,
    createBuffer: () => {
      throw new Error("buffer creation unavailable")
    },
    reportFault: (message) => faults.push(message),
    reportUnavailable: true,
    compileSnapshot: async () => compiled,
  })

  expect(await controller.start(compiled.snapshot.transport)).toBe("unavailable")
  expect(fixture.calls).toEqual([])
  expect(faults).toEqual(["clip: portable Stretch preparation failed: buffer creation unavailable"])
})

test("rebuilds a fresh paused native session with a new transport epoch", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  await expect(controller.ensureLivePreview(2)).resolves.toBe("started")
  await controller.dispose()
  await expect(controller.ensureLivePreview(2)).resolves.toBe("started")

  expect(fixture.transports.map((transport) => ({
    epoch: transport.epoch,
    frame: transport.frame,
    running: transport.running,
  }))).toEqual([
    { epoch: 1, frame: 0, running: false },
    { epoch: 2, frame: 0, running: false },
  ])
  expect(controller.isActive()).toBeFalse()
  await controller.dispose()
})

test("seeks a paused native preview without rebuilding its prepared session", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(liveMidiInput()),
  })
  let resetCount = 0
  const unsubscribeReset = controller.subscribeNativeLiveMidiReset(() => { resetCount += 1 })

  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  const handle = controller.startLiveMidiNote({ trackId: "instrument", pitch: 60, velocity: 0.8 })
  if (!handle) throw new Error("Native live note did not start.")
  controller.releaseLiveMidiNote(handle)
  await Bun.sleep(0)
  expect(controller.hasLiveMidiTails()).toBeTrue()

  const beforeCounts = {
    begin: fixture.calls.filter((call) => call === "begin").length,
    graph: fixture.calls.filter((call) => call === "graph").length,
    install: fixture.calls.filter((call) => call === "install").length,
    coordinate: fixture.calls.filter((call) => call === "coordinate").length,
    release: fixture.calls.filter((call) => call === "release").length,
    stop: fixture.calls.filter((call) => call === "stop").length,
    teardown: fixture.calls.filter((call) => call === "teardown").length,
  }

  await expect(controller.seekPrepared(0.5)).resolves.toBe("started")

  expect(controller.isPrepared()).toBeTrue()
  expect(controller.isActive()).toBeFalse()
  expect(controller.canProcessLiveMidi()).toBeTrue()
  expect(controller.hasLiveMidiTails()).toBeTrue()
  expect(resetCount).toBe(0)
  expect(fixture.transports.at(-1)).toEqual({
    epoch: 2,
    frame: 24_000,
    running: false,
    hasCycleStart: false,
    hasCycleEnd: false,
  })
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(beforeCounts.begin)
  expect(fixture.calls.filter((call) => call === "graph")).toHaveLength(beforeCounts.graph)
  expect(fixture.calls.filter((call) => call === "install")).toHaveLength(beforeCounts.install)
  expect(fixture.calls.filter((call) => call === "coordinate")).toHaveLength(beforeCounts.coordinate)
  expect(fixture.calls.filter((call) => call === "release")).toHaveLength(beforeCounts.release)
  expect(fixture.calls.filter((call) => call === "stop")).toHaveLength(beforeCounts.stop)
  expect(fixture.calls.filter((call) => call === "teardown")).toHaveLength(beforeCounts.teardown)

  await controller.dispose()
  unsubscribeReset()
})

test("keeps released live-note ownership separate across focused instrument targets", async () => {
  const firstTrack: RuntimeTrack = { ...instrumentTrack, id: "instrument-a" }
  const secondTrack: RuntimeTrack = {
    ...instrumentTrack,
    id: "instrument-b",
    clips: instrumentTrack.clips.map((clip) => ({ ...clip, id: "midi-b" })),
  }
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
      ...input(),
      transport,
      tracks: [firstTrack, secondTrack],
      renderState: {
        fx: {
          masterVolume: 1,
          masterFxInstances: [],
          trackFx: {
            "instrument-a": {
              instances: [],
              instrument: { kind: "synth", instanceId: "synth:a", params: createDefaultSynthParams() },
            },
            "instrument-b": {
              instances: [],
              instrument: { kind: "synth", instanceId: "synth:b", params: createDefaultSynthParams() },
            },
          },
        },
        automationEnvelopes: [],
      },
      sidechainRoutes: [],
    }),
  })

  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  const first = controller.startLiveMidiNote({ trackId: "instrument-a", pitch: 60, velocity: 0.8 })
  if (!first) throw new Error("First native live note did not start.")
  controller.releaseLiveMidiNote(first)
  await Bun.sleep(0)
  await expect(controller.seekPrepared(0.5)).resolves.toBe("started")
  const second = controller.startLiveMidiNote({ trackId: "instrument-b", pitch: 60, velocity: 0.8 })
  if (!second) throw new Error("Second native live note did not start.")
  await Bun.sleep(0)

  const liveEvents = nativeLiveInstrumentEvents(fixture.instrumentPayloads)
  expect(liveEvents.filter(({ nodeId }) => nodeId === nativeGraphNodeId("instrument-a"))).toHaveLength(2)
  expect(liveEvents.filter(({ nodeId }) => nodeId === nativeGraphNodeId("instrument-b"))).toHaveLength(1)
  expect(controller.hasLiveMidiTails()).toBeTrue()

  await controller.dispose()
})

const utilityPlaybackInput = (): LivePlaybackSnapshotInput => {
  const utility = createDefaultUtilityParams()
  return {
    ...input(),
    renderState: {
      fx: {
        masterVolume: 1,
        masterFxInstances: [],
        trackFx: {
          track: {
            instances: [{ id: "utility:1", kind: "utility", params: { version: 1, state: utility } }],
          },
        },
      },
      automationEnvelopes: [],
    },
  }
}

const utilityCommit = (
  instanceId: string,
  fromState: ReturnType<typeof createDefaultUtilityParams>,
  toState: ReturnType<typeof createDefaultUtilityParams>,
) => ({
  targetId: "track",
  effect: "utility" as const,
  instanceId,
  from: { version: 1 as const, state: fromState },
  to: { version: 1 as const, state: toState },
} satisfies EffectParamsCommitPayload<"utility">)

const reverbPlaybackInput = () => ({
  ...input(),
  renderState: {
    fx: {
      masterVolume: 1,
      masterFxInstances: [],
      trackFx: {
        track: {
          instances: [{
            id: "reverb:1",
            kind: "reverb" as const,
            params: createDefaultReverbParams(),
          }],
        },
      },
    },
    automationEnvelopes: [],
  },
})

const reverbCommit = (
  fromState: ReturnType<typeof createDefaultReverbParams>,
  toState: ReturnType<typeof createDefaultReverbParams>,
) => ({
  targetId: "track",
  effect: "reverb" as const,
  instanceId: "reverb:1",
  from: fromState,
  to: toState,
} satisfies EffectParamsCommitPayload<"reverb">)

test("refreshes native built-in tail metadata when reverb state changes", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(reverbPlaybackInput()),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  const from = createDefaultReverbParams()
  const to = { ...from, decaySec: 2 }
  await expect(controller.queueBuiltInStatePatch({
    payload: reverbCommit(from, to),
    bpm: 120,
  })).resolves.toEqual({ handled: true })
  const patch = fixture.statePatchPayloads.at(-1)
  expect(patch).toBeDefined()
  if (!patch) return
  expect(new DataView(patch.buffer).getUint32(52, true)).toBe(96_960)
  await controller.dispose()
})

test("rejects enabled changes instead of claiming a same-core patch succeeded", async () => {
  const fixture = createBridge()
  const snapshotInput = utilityPlaybackInput()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  const from = createDefaultUtilityParams()
  await expect(controller.queueBuiltInStatePatch({
    payload: utilityCommit("utility:1", from, { ...from, enabled: false }),
    bpm: 120,
  })).resolves.toEqual({ handled: false, reason: "unsupported-state" })
  expect(fixture.statePatchPayloads).toHaveLength(0)
  await controller.dispose()
})

test("coalesces each processor independently without dropping distinct updates", async () => {
  const fixture = createBridge()
  const first = createDefaultUtilityParams()
  const second = { ...first, gainDb: -3 }
  const snapshotInput = {
    ...utilityPlaybackInput(),
    renderState: {
      ...utilityPlaybackInput().renderState,
      fx: {
        ...utilityPlaybackInput().renderState.fx,
        trackFx: {
          track: {
            instances: [
              { id: "utility:1", kind: "utility" as const, params: { version: 1 as const, state: first } },
              { id: "utility:2", kind: "utility" as const, params: { version: 1 as const, state: first } },
            ],
          },
        },
      },
    },
  }
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  await Promise.all([
    controller.queueBuiltInStatePatch({ payload: utilityCommit("utility:1", first, second), bpm: 120 }),
    controller.queueBuiltInStatePatch({ payload: utilityCommit("utility:2", first, { ...first, pan: 0.25 }), bpm: 120 }),
  ])
  expect(fixture.calls.filter((call) => call === "processor-state-patch")).toHaveLength(2)
  expect(fixture.statePatchPayloads.map((bytes) => new DataView(bytes.buffer).getUint32(16, true))).toHaveLength(2)
  await controller.dispose()
})

test("serializes native state patches globally while retaining one latest pending patch per processor", async () => {
  const fixture = createBridge()
  const pending: Array<{
    bytes: Uint8Array
    resolve: (reply: BridgeReply) => void
  }> = []
  fixture.bridge.session.queueProcessorStatePatch = (bytes) => new Promise((resolve) => {
    pending.push({ bytes, resolve })
  })
  const first = createDefaultUtilityParams()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot({
      ...utilityPlaybackInput(),
      renderState: {
        ...utilityPlaybackInput().renderState,
        fx: {
          ...utilityPlaybackInput().renderState.fx,
          trackFx: {
            track: {
              instances: [
                { id: "utility:1", kind: "utility", params: { version: 1, state: first } },
                { id: "utility:2", kind: "utility", params: { version: 1, state: first } },
              ],
            },
          },
        },
      },
    }),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  const firstPatch = controller.queueBuiltInStatePatch({
    payload: utilityCommit("utility:1", first, { ...first, gainDb: -1 }),
    bpm: 120,
  })
  const replacement = controller.queueBuiltInStatePatch({
    payload: utilityCommit("utility:1", first, { ...first, gainDb: -2 }),
    bpm: 120,
  })
  const distinct = controller.queueBuiltInStatePatch({
    payload: utilityCommit("utility:2", first, { ...first, pan: 0.25 }),
    bpm: 120,
  })
  expect(pending).toHaveLength(1)
  pending[0]?.resolve({ ok: true })
  await Bun.sleep(0)
  expect(pending).toHaveLength(2)
  pending[1]?.resolve({ ok: true })
  await Bun.sleep(0)
  expect(pending).toHaveLength(3)
  pending[2]?.resolve({ ok: true })
  await expect(Promise.all([firstPatch, replacement, distinct])).resolves.toEqual([
    { handled: true },
    { handled: true },
    { handled: true },
  ])
  await controller.dispose()
})

test("continues the serialized native state patch queue after a timed-out request", async () => {
  const fixture = createBridge()
  let calls = 0
  fixture.bridge.session.queueProcessorStatePatch = async (bytes) => {
    calls += 1
    if (calls === 1) throw new Error("Native audio host control request timed out.")
    fixture.statePatchPayloads.push(bytes)
    return { ok: true as const }
  }
  const snapshotInput = utilityPlaybackInput()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  const from = createDefaultUtilityParams()
  const first = controller.queueBuiltInStatePatch({
    payload: utilityCommit("utility:1", from, { ...from, gainDb: -1 }),
    bpm: 120,
  })
  const second = controller.queueBuiltInStatePatch({
    payload: utilityCommit("utility:1", from, { ...from, gainDb: -2 }),
    bpm: 120,
  })
  await expect(first).resolves.toEqual({
    handled: false,
    reason: "bridge-error",
    error: "Native audio host control request timed out.",
  })
  await expect(second).resolves.toEqual({ handled: true })
  expect(calls).toBe(2)
  await controller.dispose()
})

test("queues supported built-in parameters for active native playback without lifecycle changes", async () => {
  const fixture = createBridge()
  const snapshotInput = utilityPlaybackInput()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })
  await expect(controller.start(snapshotInput.transport)).resolves.toBe("started")
  const before = fixture.calls.slice()
  await expect(controller.queueBuiltInParameterEvents({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: -6 }],
  })).resolves.toEqual({ handled: true })
  expect(fixture.calls.slice(0, before.length)).toEqual(before)
  expect(fixture.calls.slice(before.length)).toEqual(["built-in-parameter"])
  const payload = fixture.builtInParameterPayloads[0]
  if (!payload) throw new Error("Expected built-in parameter payload.")
  const view = new DataView(payload.buffer)
  expect(view.getUint32(0, true)).toBe(1)
  expect(view.getUint32(12, true)).toBe(1)
  expect(view.getUint32(16, true)).toBe(0)
  expect(view.getFloat32(20, true)).toBe(-6)
  expect(fixture.calls).not.toContain("stop")
  expect(fixture.calls).not.toContain("teardown")
  await controller.dispose()
})

test("queues built-in parameters for paused prepared preview and reports target or bridge failures", async () => {
  const fixture = createBridge()
  const snapshotInput = utilityPlaybackInput()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  await expect(controller.queueBuiltInParameterEvents({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.pan", value: 0.25 }],
  })).resolves.toEqual({ handled: true })
  await expect(controller.queueBuiltInParameterEvents({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.unknown", value: 0.25 }],
  })).resolves.toEqual({ handled: false, reason: "unsupported-target" })
  await expect(controller.queueBuiltInParameterEvents({
    instanceId: "missing",
    values: [{ parameterId: "utility.pan", value: 0.25 }],
  })).resolves.toEqual({ handled: false, reason: "unsupported-instance" })
  await controller.dispose()

  const failedFixture = createBridge("built-in-parameter", false, false, "queue rejected")
  const failedController = createNativePlaybackController({
    bridge: failedFixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })
  await expect(failedController.ensureLivePreview(0)).resolves.toBe("started")
  await expect(failedController.queueBuiltInParameterEvents({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.pan", value: 0.25 }],
  })).resolves.toEqual({ handled: false, reason: "bridge-error", error: "queue rejected" })
  await failedController.dispose()
})

test("accepts live processor control only for the prepared revision and epoch", async () => {
  const fixture = createBridge()
  const snapshotInput = utilityPlaybackInput()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  await expect(controller.liveProcessorControl.flush({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: -3 }],
    revision: 1,
    epoch: 1,
    sequence: 1,
  })).resolves.toEqual({ accepted: true, sequence: 1, appliedSequence: 1 })
  await expect(controller.liveProcessorControl.flush({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: -2 }],
    revision: 0,
    epoch: 1,
    sequence: 2,
  })).resolves.toEqual({ accepted: false, reason: "stale" })
  await controller.dispose()
})

test("maps native graph meters and ignores stale revision or sequence batches", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })
  const trackBatches: Array<ReadonlyMap<string, { left: number; right: number }>> = []
  const masterBatches: Array<{ left: number; right: number }> = []
  const unsubscribeTrack = controller.subscribeTrackMeters((levels) => trackBatches.push(levels))
  const unsubscribeMaster = controller.subscribeMasterMeter((levels) => masterBatches.push(levels))
  await expect(controller.start(input().transport)).resolves.toBe("started")
  fixture.emitMeterBatch({
    graphRevision: 1,
    transportEpoch: 1,
    sequence: 1n,
    entries: [
      { nodeId: nativeGraphNodeId("track"), leftRms: 0.25, rightRms: 0.5 },
      { nodeId: nativeGraphNodeId("master"), leftRms: 0.75, rightRms: 1 },
    ],
  })
  fixture.emitMeterBatch({
    graphRevision: 1,
    transportEpoch: 1,
    sequence: 1n,
    entries: [{ nodeId: nativeGraphNodeId("track"), leftRms: 1, rightRms: 1 }],
  })
  fixture.emitMeterBatch({
    graphRevision: 2,
    transportEpoch: 1,
    sequence: 2n,
    entries: [{ nodeId: nativeGraphNodeId("track"), leftRms: 1, rightRms: 1 }],
  })
  expect(trackBatches.at(-1)).toEqual(new Map([["track", { left: 0.25, right: 0.5 }]]))
  expect(masterBatches.at(-1)).toEqual({ left: 0.75, right: 1 })
  await controller.dispose()
  expect(trackBatches.at(-1)).toEqual(new Map([["track", { left: 0, right: 0 }]]))
  expect(masterBatches.at(-1)).toEqual({ left: 0, right: 0 })
  unsubscribeTrack()
  unsubscribeMaster()
})

test("queues native live notes and releases them through the native backend", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(liveMidiInput()),
  })

  expect(await controller.ensureLivePreview(0)).toBe("started")
  const initialSchedule = fixture.schedulePayloads[0]
  expect(initialSchedule).toBeDefined()
  if (initialSchedule) expect(new DataView(initialSchedule.buffer).getUint32(40, true)).toBe(0)
  const handle = controller.startLiveMidiNote({ trackId: "instrument", pitch: 60, velocity: 0.8 })
  expect(handle).toMatchObject({ backend: "native", trackId: "instrument", pitch: 60 })
  if (!handle) throw new Error("Native live note did not start.")
  controller.releaseLiveMidiNote(handle)
  await Bun.sleep(0)
  expect(controller.hasLiveMidiTails()).toBeTrue()
  expect(fixture.instrumentPayloads).toHaveLength(2)
  const noteOn = new DataView(fixture.instrumentPayloads[0]!.buffer)
  const noteOff = new DataView(fixture.instrumentPayloads[1]!.buffer)
  expect(noteOn.getUint32(32, true)).toBe(0)
  expect(noteOff.getUint32(32, true)).toBe(0)
  expect(noteOn.getUint32(32, true)).toBeLessThanOrEqual(noteOff.getUint32(32, true))
  expect(noteOn.getUint32(36, true)).toBe(101)
  expect(noteOff.getUint32(36, true)).toBe(102)
  await controller.dispose()
  expect(controller.hasLiveMidiTails()).toBeFalse()
})

test("does not retain live MIDI tail ownership when note-on preparation fails", async () => {
  const fixture = createBridge("instrument")
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(liveMidiInput()),
  })

  expect(await controller.ensureLivePreview(0)).toBe("started")
  const handle = controller.startLiveMidiNote({ trackId: "instrument", pitch: 60, velocity: 0.8 })
  if (!handle) throw new Error("Native live note did not start.")
  await Bun.sleep(0)

  expect(fixture.instrumentPayloads).toHaveLength(1)
  expect(controller.hasLiveMidiTails()).toBeFalse()
  await controller.dispose()
})

test("does not retain live MIDI tail ownership when note preparation is cancelled", async () => {
  const fixture = createBridge()
  const compilation = Promise.withResolvers<ReturnType<typeof compileLivePlaybackSnapshot>>()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: () => compilation.promise,
  })

  const handle = controller.startLiveMidiNote({
    trackId: "instrument",
    pitch: 60,
    velocity: 0.8,
    playheadSec: 0.75,
  })
  if (!handle) throw new Error("Native live note did not queue.")
  expect(controller.hasLiveMidiTails()).toBeFalse()
  controller.releaseLiveMidiNote(handle, true)

  compilation.resolve(compileLivePlaybackSnapshot(liveMidiInput()))
  await expect(controller.ensureLivePreview(0.75)).resolves.toBe("started")
  await Bun.sleep(0)

  expect(fixture.instrumentPayloads).toHaveLength(0)
  expect(controller.hasLiveMidiTails()).toBeFalse()
  await controller.dispose()
})

test("retains one session-level live MIDI tail owner across repeated notes", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(liveMidiInput()),
  })

  expect(await controller.ensureLivePreview(0)).toBe("started")
  for (let index = 0; index < 32; index += 1) {
    const handle = controller.startLiveMidiNote({
      trackId: "instrument",
      pitch: index % 12 + 48,
      velocity: 0.8,
    })
    if (!handle) throw new Error("Native live note did not start.")
    controller.releaseLiveMidiNote(handle)
  }
  await Bun.sleep(0)

  expect(fixture.instrumentPayloads).toHaveLength(64)
  expect(controller.hasLiveMidiTails()).toBeTrue()
  await controller.dispose()
})

test("forces only the requested live MIDI note off", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(liveMidiInput()),
  })

  expect(await controller.ensureLivePreview(0)).toBe("started")
  const first = controller.startLiveMidiNote({ trackId: "instrument", pitch: 60, velocity: 0.8 })
  const second = controller.startLiveMidiNote({ trackId: "instrument", pitch: 64, velocity: 0.8 })
  if (!first || !second) throw new Error("Native live notes did not start.")
  controller.releaseLiveMidiNote(first, true)
  await Bun.sleep(0)
  const forcedRelease = new DataView(fixture.instrumentPayloads.at(-1)!.buffer)
  expect(forcedRelease.getUint32(36, true)).toBe(102)
  expect(forcedRelease.getUint32(44, true)).toBe(60)
  controller.releaseLiveMidiNote(second)
  await controller.dispose()
})

test("notifies MIDI overlay ownership when preview disposal rebuilds the session", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(liveMidiInput()),
  })
  let resetCount = 0
  const unsubscribe = controller.subscribeNativeLiveMidiReset(() => { resetCount += 1 })
  await controller.ensureLivePreview(0)
  await controller.dispose()
  expect(resetCount).toBe(1)
  unsubscribe()
})

test("filters native spectrum frames by target, revision, epoch, and sequence", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })
  const frames: Array<SpectrumFrame | null> = []
  const unsubscribe = controller.subscribeSpectrum("track", (frame) => frames.push(frame))
  expect(fixture.spectrumSelections.filter(({ nodeId, sessionStarted }) => nodeId !== null && !sessionStarted)).toEqual([])
  await expect(controller.start(input().transport)).resolves.toBe("started")
  expect(fixture.spectrumSelections.at(-1)).toEqual({
    nodeId: nativeGraphNodeId("track"),
    sessionStarted: true,
  })
  const valid = {
    graphRevision: 1,
    transportEpoch: 1,
    sequence: 1n,
    nodeId: nativeGraphNodeId("track"),
    sampleRateHz: 48_000,
    fftSize: 2_048,
    binCount: 1_024,
    data: new Float32Array(1_024),
  } satisfies NativeHostSpectrumFrame
  fixture.emitSpectrumFrame(valid)
  fixture.emitSpectrumFrame({ ...valid, sequence: 1n })
  fixture.emitSpectrumFrame({ ...valid, graphRevision: 2, sequence: 2n })
  expect(frames.at(-1)).toMatchObject({ sampleRate: 48_000, fftSize: 2_048, binCount: 1_024 })
  await controller.dispose()
  expect(frames.at(-1)).toBeNull()
  unsubscribe()
})

test("retains the spectrum target while rebuilding the native session", async () => {
  const fixture = createBridge()
  let projectGeneration = 0
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    getProjectGeneration: () => projectGeneration,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })
  const frames: Array<SpectrumFrame | null> = []
  const unsubscribe = controller.subscribeSpectrum("track", (frame) => frames.push(frame))

  await expect(controller.start(input().transport)).resolves.toBe("started")
  expect(fixture.spectrumNodeIds).toContain(nativeGraphNodeId("track"))

  await controller.pause(0.5)
  const beforeRebuild = {
    begin: fixture.calls.filter((call) => call === "begin").length,
    graph: fixture.calls.filter((call) => call === "graph").length,
    install: fixture.calls.filter((call) => call === "install").length,
  }
  projectGeneration += 1
  await expect(controller.start({ ...input().transport, playheadSec: 0.5 })).resolves.toBe("started")
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(beforeRebuild.begin + 1)
  expect(fixture.calls.filter((call) => call === "graph")).toHaveLength(beforeRebuild.graph + 1)
  expect(fixture.calls.filter((call) => call === "install")).toHaveLength(beforeRebuild.install + 1)
  expect(fixture.spectrumNodeIds.at(-1)).toBe(nativeGraphNodeId("track"))

  fixture.emitSpectrumFrame({
    graphRevision: 1,
    transportEpoch: 2,
    sequence: 1n,
    nodeId: nativeGraphNodeId("track"),
    sampleRateHz: 48_000,
    fftSize: 2_048,
    binCount: 1_024,
    data: new Float32Array(1_024),
  })
  expect(frames.at(-1)).toMatchObject({ nodeId: nativeGraphNodeId("track"), sequence: 1n })

  unsubscribe()
  expect(fixture.spectrumNodeIds.at(-1)).toBeNull()
  await controller.dispose()
})

test("lazily starts a paused native preview and preserves queued note order", async () => {
  const fixture = createBridge()
  const compilation = Promise.withResolvers<ReturnType<typeof compileLivePlaybackSnapshot>>()
  let compiledTransport: LivePlaybackSnapshotInput["transport"] | undefined
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: (transport) => {
      compiledTransport = transport
      return compilation.promise
    },
  })

  const handle = controller.startLiveMidiNote({
    trackId: "instrument",
    pitch: 60,
    velocity: 0.8,
    playheadSec: 0.75,
  })
  expect(handle).toBeDefined()
  expect(controller.isActive()).toBeFalse()
  expect(controller.canProcessLiveMidi()).toBeFalse()

  compilation.resolve(compileLivePlaybackSnapshot(liveMidiInput()))
  await expect(controller.ensureLivePreview(0.75)).resolves.toBe("started")
  expect(compiledTransport).toMatchObject({ state: "paused", playheadSec: 0.75 })
  expect(controller.isActive()).toBeFalse()
  expect(controller.isPrepared()).toBeTrue()
  expect(controller.canProcessLiveMidi()).toBeTrue()
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "start")).toHaveLength(1)

  if (!handle) throw new Error("Native live note did not queue.")
  controller.releaseLiveMidiNote(handle)
  controller.releaseLiveMidiNote(handle)
  await Bun.sleep(0)

  expect(fixture.instrumentPayloads).toHaveLength(2)
  const noteOn = new DataView(fixture.instrumentPayloads[0]!.buffer)
  const noteOff = new DataView(fixture.instrumentPayloads[1]!.buffer)
  expect(noteOn.getUint32(32, true)).toBe(0)
  expect(noteOff.getUint32(32, true)).toBe(0)
  expect(noteOn.getUint32(32, true)).toBe(noteOff.getUint32(32, true))
  expect(noteOn.getBigUint64(20, true)).toBe(1_000_000n)
  expect(noteOff.getBigUint64(20, true)).toBe(1_000_001n)
  await controller.dispose()
})

test("releases a short native note exactly once after deferred preview preparation", async () => {
  const fixture = createBridge()
  const compilation = Promise.withResolvers<ReturnType<typeof compileLivePlaybackSnapshot>>()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: () => compilation.promise,
  })

  const handle = controller.startLiveMidiNote({
    trackId: "instrument",
    pitch: 60,
    velocity: 0.8,
    playheadSec: 0.75,
  })
  expect(handle).toBeDefined()
  if (!handle) throw new Error("Native live note did not queue.")
  controller.releaseLiveMidiNote(handle)
  controller.releaseLiveMidiNote(handle)

  compilation.resolve(compileLivePlaybackSnapshot(liveMidiInput()))
  await expect(controller.ensureLivePreview(0.75)).resolves.toBe("started")
  await Bun.sleep(0)

  expect(fixture.instrumentPayloads).toHaveLength(2)
  expect(new DataView(fixture.instrumentPayloads[0]!.buffer).getUint32(36, true)).toBe(101)
  expect(new DataView(fixture.instrumentPayloads[1]!.buffer).getUint32(36, true)).toBe(102)
  await controller.dispose()
})

test("does not claim live MIDI for a track absent from the prepared native graph", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  expect(controller.startLiveMidiNote({
    trackId: "instrument",
    pitch: 60,
    velocity: 0.8,
  })).toBeUndefined()
  expect(fixture.instrumentPayloads).toHaveLength(0)
  await controller.dispose()
})

test("does not claim live MIDI for an empty instrument track compiled as a source node", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
      ...input(),
      transport,
      tracks: [{ ...instrumentTrack, clips: [] }],
    }),
  })

  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  expect(controller.startLiveMidiNote({
    trackId: "instrument",
    pitch: 60,
    velocity: 0.8,
  })).toBeUndefined()
  expect(fixture.instrumentPayloads).toHaveLength(0)
  await controller.dispose()
})

test("prepares a paused native preview without starting transport", async () => {
  const fixture = createBridge()
  let compiledTransport: LivePlaybackSnapshotInput["transport"] | undefined
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => {
      compiledTransport = transport
      return compileLivePlaybackSnapshot(input())
    },
  })

  await expect(controller.ensureLivePreview(0.5)).resolves.toBe("started")
  expect(compiledTransport).toMatchObject({
    state: "paused",
    playheadSec: 0.5,
    loopEnabled: false,
    loopStartSec: 0,
    loopEndSec: 0,
  })
  expect(controller.isActive()).toBeFalse()
  expect(controller.isPrepared()).toBeTrue()
  expect(controller.canProcessLiveMidi()).toBeTrue()
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "start")).toHaveLength(1)
  await controller.dispose()
})

test("serializes synchronous native live note events through the single host request slot", async () => {
  const fixture = createBridge(undefined, true)
  const faults: string[] = []
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(liveMidiInput()),
    reportFault: (message) => faults.push(message),
  })

  expect(await controller.ensureLivePreview(0)).toBe("started")
  const handle = controller.startLiveMidiNote({ trackId: "instrument", pitch: 60, velocity: 0.8 })
  expect(handle).toBeDefined()
  if (!handle) throw new Error("Native live note did not start.")
  controller.releaseLiveMidiNote(handle)

  await Promise.resolve()
  expect(fixture.instrumentRequests).toHaveLength(1)
  expect(faults).toEqual([])
  fixture.instrumentRequests[0]?.resolve({ ok: true })
  await Bun.sleep(0)
  expect(fixture.instrumentRequests).toHaveLength(2)
  expect(faults).toEqual([])
  fixture.instrumentRequests[1]?.resolve({ ok: true })
  await Bun.sleep(0)
  expect(fixture.instrumentPayloads).toHaveLength(2)
  expect(faults).toEqual([])

  const noteOn = new DataView(fixture.instrumentPayloads[0]!.buffer)
  const noteOff = new DataView(fixture.instrumentPayloads[1]!.buffer)
  expect(noteOn.getUint32(32, true)).toBeLessThanOrEqual(noteOff.getUint32(32, true))
  expect(noteOn.getUint32(36, true)).toBe(101)
  expect(noteOff.getUint32(36, true)).toBe(102)
  await controller.dispose()
})

test("coordinates native attachments inside the encompassing session transaction", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    getProjectId: () => "project:1",
    compileSnapshot: async () => {
      const result = compileLivePlaybackSnapshot(input())
      if (!result.supported) throw new Error(result.reasons.join(" "))
      const parameterId = externalAutomationParameterId(nativeAttachmentPlan.attachments[0]!.instanceId, 7)
      return {
        supported: true,
        snapshot: {
          ...result.snapshot,
          nativeExternalAttachmentPlan: nativeAttachmentPlan,
          mixer: {
            ...result.snapshot.mixer,
            automationEnvelopes: [{
              id: "automation",
              projectId: "project:1",
              target: { kind: "track" as const, trackId: "track" },
              targetKey: automationTargetKey({ kind: "track", trackId: "track" }, "volume"),
              parameterId,
              enabled: true,
              points: [{ id: "point", timeSec: 0, value: 0.6, interpolation: "hold" as const }],
              updatedAt: 1,
            }],
          },
          requiresNativePlayback: true,
        },
      }
    },
  })

  expect(await controller.start(input().transport)).toBe("started")
  expect(fixture.calls).toEqual(["begin", "coordinate", "configure", "install", "graph", "parameter", "transport", "commit", "start", "schedule", "transport"])
  expect(fixture.schedulePayloads.some((payload) => (
    new TextDecoder().decode(payload).includes(nativeAttachmentPlan.attachments[0]!.instanceId)
  ))).toBeTrue()
  await controller.dispose()
})

test("allows native reverb alongside a native VST attachment", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    getProjectId: () => "project:1",
    compileSnapshot: async () => {
      const result = compileLivePlaybackSnapshot({
        ...input(),
        renderState: {
          fx: {
            masterVolume: 1,
            masterFxInstances: [],
            trackFx: {
              track: {
                instances: [{
                  id: "reverb:1",
                  kind: "reverb",
                  params: createDefaultReverbParams(),
                }],
              },
            },
          },
          automationEnvelopes: [],
        },
      })
      if (!result.supported) throw new Error(result.reasons.join(" "))
      return {
        supported: true,
        snapshot: {
          ...result.snapshot,
          nativeExternalAttachmentPlan: nativeAttachmentPlan,
          requiresNativePlayback: true,
        },
      }
    },
  })

  expect(await controller.start(input().transport)).toBe("started")
  expect(fixture.calls).toContain("coordinate")
  expect(fixture.calls).toContain("graph")
  const graph = fixture.graphPayloads[0]
  if (!graph) throw new Error("Expected native graph payload.")
  const view = new DataView(graph.buffer)
  const nodeBytes = view.getUint32(12, true) === 4 ? 136 : 132
  const processorOffset = 12 + 24 + 2 * nodeBytes + 48
  expect(view.getUint32(processorOffset + 8, true)).toBe(14)
  expect(view.getUint32(processorOffset + 16, true)).toBe(72)
  expect(view.getUint32(processorOffset + 48, true)).toBe(1)
  await controller.dispose()
})

test("prepares arranged synth MIDI with native reverb and VST effect", async () => {
  const fixture = createBridge()
  const instrumentAttachmentPlan: NativeExternalAttachmentPlan = {
    ...nativeAttachmentPlan,
    attachments: nativeAttachmentPlan.attachments.map((attachment) => ({
      ...attachment,
      graphNodeId: "instrument",
    })),
  }
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    getProjectId: () => "project:1",
    compileSnapshot: async () => {
      const result = compileLivePlaybackSnapshot({
        ...input(instrumentTrack),
        renderState: {
          fx: {
            masterVolume: 1,
            masterFxInstances: [],
            trackFx: {
              instrument: {
                instances: [{
                  id: "reverb:1",
                  kind: "reverb",
                  params: createDefaultReverbParams(),
                }],
                instrument: {
                  kind: "synth",
                  instanceId: "synth:1",
                  params: createDefaultSynthParams(),
                },
              },
            },
          },
          automationEnvelopes: [],
        },
      })
      if (!result.supported) throw new Error(result.reasons.join(" "))
      return {
        supported: true,
        snapshot: {
          ...result.snapshot,
          nativeExternalAttachmentPlan: instrumentAttachmentPlan,
          requiresNativePlayback: true,
        },
      }
    },
  })

  expect(await controller.start(input(instrumentTrack).transport)).toBe("started")
  expect(fixture.calls).toContain("coordinate")
  expect(fixture.calls).toContain("schedule")
  expect(fixture.schedulePayloads.length).toBeGreaterThan(0)
  await controller.dispose()
})

test("primes arranged playback only after the committed native session starts", async () => {
  const fixture = createBridge(undefined, false, true)
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot({
      ...input(instrumentTrack),
      renderState: {
        fx: {
          masterVolume: 1,
          masterFxInstances: [],
          trackFx: {
            instrument: { instances: [], instrument: { kind: "synth", instanceId: "synth:1", params: createDefaultSynthParams() } },
          },
        },
        automationEnvelopes: [],
      },
    }),
  })

  await expect(controller.start(input(instrumentTrack).transport)).resolves.toBe("started")
  expect(fixture.calls.indexOf("commit")).toBeLessThan(fixture.calls.indexOf("start"))
  expect(fixture.calls.indexOf("start")).toBeLessThan(fixture.calls.indexOf("schedule"))
  expect(controller.isActive()).toBeTrue()
  await controller.dispose()
})

test("blocks native-required playback when native instrument state is unavailable", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    reportFault: (message) => faults.push(message),
    compileSnapshot: async () => {
      const result = compileLivePlaybackSnapshot({
        ...input(instrumentTrack),
        renderState: {
          fx: {
            masterVolume: 1,
            masterFxInstances: [],
            trackFx: {},
          },
          automationEnvelopes: [],
        },
      })
      if (!result.supported) throw new Error(result.reasons.join(" "))
      return {
        supported: true,
        snapshot: {
          ...result.snapshot,
          nativeExternalAttachmentPlan: { version: 1, attachments: [] },
          requiresNativePlayback: true,
        },
      }
    },
  })

  expect(await controller.start(input().transport)).toBe("blocked")
  expect(faults).toEqual(["instrument: native instrument state is unavailable."])
  expect(fixture.calls).toEqual([])
})

test("queues bounded native VST overrides and current-block automation", async () => {
  const fixture = createBridge()
  const parameterId = externalAutomationParameterId(nativeAttachmentPlan.attachments[0]?.instanceId ?? "", 7)
  const envelope = {
    id: "automation:1",
    projectId: "project:1",
    target: { kind: "track" as const, trackId: "track", effectInstanceId: nativeAttachmentPlan.attachments[0]?.instanceId },
    targetKey: automationTargetKey(
      { kind: "track", trackId: "track", effectInstanceId: nativeAttachmentPlan.attachments[0]?.instanceId },
      parameterId,
    ),
    parameterId,
    enabled: true,
    points: [
      { id: "start", timeSec: 0, value: 0.5, interpolation: "linear" as const },
      { id: "next", timeSec: 0.005, value: 0.75, interpolation: "linear" as const },
    ],
    updatedAt: 1,
  }
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    getProjectId: () => "project:1",
    compileSnapshot: async () => {
      const result = compileLivePlaybackSnapshot(input())
      if (!result.supported) throw new Error(result.reasons.join(" "))
      return {
        supported: true,
        snapshot: {
          ...result.snapshot,
          nativeExternalAttachmentPlan: nativeAttachmentPlan,
          requiresNativePlayback: true,
          mixer: { ...result.snapshot.mixer, automationEnvelopes: [envelope] },
        },
      }
    },
  })

  expect(await controller.start(input().transport)).toBe("started")
  expect(fixture.calls).toContain("parameter")
  const bytes = fixture.parameterPayloads[0]
  expect(bytes).toBeDefined()
  if (!bytes) return
  const view = new DataView(bytes.buffer)
  const instanceBytes = view.getUint32(0, true)
  expect(view.getUint32(4 + instanceBytes, true)).toBe(1)
  expect(view.getUint32(8 + instanceBytes, true)).toBe(7)
  expect(view.getUint32(12 + instanceBytes, true)).toBe(0)
  expect(view.getFloat64(16 + instanceBytes, true)).toBe(0.4)
})

test("queues native MIDI events for a projected synth track", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot({
      ...input(instrumentTrack),
      renderState: {
        fx: {
          masterVolume: 1,
          masterFxInstances: [],
          trackFx: {
            instrument: { instances: [], instrument: { kind: "synth", instanceId: "synth:1", params: createDefaultSynthParams() } },
          },
        },
        automationEnvelopes: [],
      },
    }),
  })

  expect(await controller.start(input().transport)).toBe("started")
  expect(fixture.calls).toContain("instrument")
  expect(fixture.instrumentPayloads).toHaveLength(1)
  expect(fixture.calls).toContain("schedule")
  const eventTypes = nativeInstrumentEventTypes(fixture.instrumentPayloads[0]!)
  expect(eventTypes).toEqual([5, 5, 5, 5, 5, 5, 5, 5])
  await controller.dispose()
})

test("rejects schedules that exceed the native callback capacity", async () => {
  const fixture = createBridge()
  const denseTrack: RuntimeTrack = {
    ...instrumentTrack,
    clips: [{
      ...instrumentTrack.clips[0]!,
      midi: {
        wave: "sawtooth",
        notes: Array.from({ length: 600 }, (_, index) => ({
          pitch: 36 + (index % 48),
          beat: 0,
          length: 0.25,
          velocity: 0.5,
        })),
      },
    }],
  }
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot({
      ...input(denseTrack),
      renderState: {
        fx: {
          masterVolume: 1,
          masterFxInstances: [],
          trackFx: {
            instrument: { instances: [], instrument: { kind: "synth", instanceId: "synth:1", params: createDefaultSynthParams() } },
          },
        },
        automationEnvelopes: [],
      },
    }),
  })

  expect(await controller.start(input().transport)).toBe("unavailable")
  await controller.dispose()
})

test("omits arranged MIDI from paused native preview initialization", async () => {
  const createController = (fixture: ReturnType<typeof createBridge>) => createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot({
      ...input(instrumentTrack),
      renderState: {
        fx: {
          masterVolume: 1,
          masterFxInstances: [],
          trackFx: {
            instrument: { instances: [], instrument: { kind: "synth", instanceId: "synth:1", params: createDefaultSynthParams() } },
          },
        },
        automationEnvelopes: [],
      },
    }),
  })
  const fixture = createBridge()
  const controller = createController(fixture)

  expect(await controller.ensureLivePreview(0.5)).toBe("started")
  expect(fixture.instrumentPayloads).toHaveLength(1)
  expect(nativeInstrumentEventTypes(fixture.instrumentPayloads[0]!)).toEqual([5, 5, 5, 5, 5, 5, 5, 5])
  await controller.dispose()
})

test("releases only instrument nodes from the prepared native graph", async () => {
  const actualInstrumentTrack: RuntimeTrack = {
    ...instrumentTrack,
    id: "actual-instrument",
  }
  const emptyInstrumentTrack: RuntimeTrack = {
    ...instrumentTrack,
    id: "empty-instrument",
    clips: [],
  }
  const snapshotInput: LivePlaybackSnapshotInput = {
    ...input(),
    tracks: [actualInstrumentTrack, emptyInstrumentTrack],
    renderState: {
      fx: {
        masterVolume: 1,
        masterFxInstances: [],
        trackFx: {
          "actual-instrument": {
            instances: [],
            instrument: {
              kind: "synth",
              instanceId: "synth:actual",
              params: createDefaultSynthParams(),
            },
          },
        },
      },
      automationEnvelopes: [],
    },
  }
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })

  await expect(controller.start(snapshotInput.transport)).resolves.toBe("started")
  const initialPayloadCount = fixture.instrumentPayloads.length
  await controller.pause(0.5)

  const releaseEvents = nativeTransportReleaseEvents(
    fixture.instrumentPayloads.slice(initialPayloadCount),
  )
  expect(releaseEvents).toEqual([{
    nodeId: nativeGraphNodeId("actual-instrument"),
    type: 103,
  }])
  expect(releaseEvents).not.toContainEqual({
    nodeId: nativeGraphNodeId("empty-instrument"),
    type: 103,
  })

  await controller.dispose()
})

test("pause and resume retain the prepared native graph and installed assets", async () => {
  const fixture = createBridge(undefined, false, false, "failed", 48_000, true)
  let compilations = 0
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => {
      compilations += 1
      return compileLivePlaybackSnapshot(input())
    },
  })

  await controller.start(input().transport)
  await controller.pause(0.5)
  expect(controller.isActive()).toBeFalse()
  expect(controller.canProcessLiveMidi()).toBeTrue()
  expect(controller.isPrepared()).toBeTrue()
  expect(fixture.calls.filter((call) => call === "stop")).toHaveLength(0)
  await controller.start({ ...input().transport, playheadSec: 0.5 })

  expect(compilations).toBe(1)
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "install")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "start")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "transport")).toHaveLength(4)
  expect(fixture.transports.map(({ running }) => running)).toEqual([false, true, false, true])
  expect(fixture.transports.map(({ epoch }) => epoch)).toEqual([1, 1, 2, 2])
  expect(controller.isActive()).toBeTrue()
  expect(controller.isPrepared()).toBeTrue()
  expect(fixture.calls).not.toContain("release")
})

test("primes each advancing prepared resume with active source and automation windows", async () => {
  const fixture = createBridge()
  const track = {
    ...sourceTrack(),
    clips: [{
      ...sourceTrack().clips[0]!,
      duration: 5,
      sourceKind: "url" as const,
      sampleUrl: silenceWavDataUrl(270_000, 2),
      buffer: new TestAudioBuffer([
        new Float32Array(270_000),
        new Float32Array(270_000),
      ]),
    }],
  }
  const snapshotInput: LivePlaybackSnapshotInput = {
    ...input(track),
    renderState: {
      ...input(track).renderState,
      automationEnvelopes: [{
        id: "volume-automation",
        projectId: "project:1",
        target: { kind: "track", trackId: "track" },
        targetKey: automationTargetKey({ kind: "track", trackId: "track" }, "volume"),
        parameterId: "volume",
        enabled: true,
        points: [
          { id: "start", timeSec: 0, value: 0.25, interpolation: "linear" },
          { id: "end", timeSec: 6, value: 0.75, interpolation: "linear" },
        ],
        updatedAt: 1,
      }],
    },
  }
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })

  await expect(controller.start(snapshotInput.transport)).resolves.toBe("started")
  await controller.pause(3)
  await expect(controller.start({ ...snapshotInput.transport, playheadSec: 3 })).resolves.toBe("started")
  await controller.pause(3.5)
  await expect(controller.start({ ...snapshotInput.transport, playheadSec: 3.5 })).resolves.toBe("started")

  const runningTransports = fixture.transports.filter(({ running }) => running)
  expect(runningTransports.map(({ epoch, frame }) => ({ epoch, frame }))).toEqual([
    { epoch: 1, frame: 0 },
    { epoch: 2, frame: 144_000 },
    { epoch: 3, frame: 168_000 },
  ])
  const sourceEvents = decodeNativeSourceEvents(fixture.schedulePayloads)
  expect(new Set(sourceEvents.filter((event) => event.epoch === 1).map((event) => event.assetId)).size).toBe(1)
  expect(new Set(sourceEvents.filter((event) => event.epoch === 2).map((event) => event.assetId)).size).toBe(1)
  expect(sourceEvents.find((event) => event.epoch === 2)?.assetId)
    .toBe(sourceEvents.find((event) => event.epoch === 1)?.assetId)
  for (const transport of runningTransports) {
    const windows = fixture.schedulePayloads.filter((payload) => {
      const view = new DataView(payload.buffer)
      return view.getUint32(4, true) === transport.epoch
        && Number(view.getBigUint64(16, true)) <= transport.frame
        && Number(view.getBigUint64(24, true)) > transport.frame
    })
    expect(windows.length).toBeGreaterThan(0)
    expect(windows.some((payload) => decodeNativeSourceEvents([payload]).some((event) => (
      event.startFrame <= transport.frame && event.stopFrame > transport.frame
    )))).toBeTrue()
    expect(windows.some((payload) => decodeNativeProcessorEvents([payload]).some((event) => (
      event.frame >= transport.frame
    )))).toBeTrue()
  }

  await controller.dispose()
})

test("rebuilds the coordinator when same-frame resume changes loop scheduling", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  await controller.start(input().transport)
  await controller.pause(0.5)
  await expect(controller.start({
    ...input().transport,
    playheadSec: 0.5,
    loopEnabled: true,
    loopStartSec: 0.25,
    loopEndSec: 1.25,
  })).resolves.toBe("started")

  expect(fixture.transports.map(({ epoch, running, hasCycleStart, hasCycleEnd }) => ({
    epoch,
    running,
    hasCycleStart,
    hasCycleEnd,
  }))).toEqual([
    { epoch: 1, running: false, hasCycleStart: false, hasCycleEnd: false },
    { epoch: 1, running: true, hasCycleStart: false, hasCycleEnd: false },
    { epoch: 2, running: false, hasCycleStart: false, hasCycleEnd: false },
    { epoch: 3, running: false, hasCycleStart: true, hasCycleEnd: true },
    { epoch: 3, running: true, hasCycleStart: true, hasCycleEnd: true },
  ])
  expect(controller.isActive()).toBeTrue()
  expect(controller.isPrepared()).toBeTrue()
  await controller.dispose()
})

test("does not let a superseded prepared resume dispose its replacement coordinator", async () => {
  const fixture = createBridge()
  const epoch2PausedTransitionReached = Promise.withResolvers<void>()
  const resumeGate = Promise.withResolvers<void>()
  let transportTail = Promise.resolve()
  const originalSetTransport = fixture.bridge.session.setTransport
  const bridge = {
    ...fixture.bridge,
    session: {
      ...fixture.bridge.session,
      setTransport: (transport: Parameters<typeof originalSetTransport>[0]) => {
        const request = transportTail.then(async () => {
          if (transport.epoch === 2 && !transport.running) {
            epoch2PausedTransitionReached.resolve()
            await resumeGate.promise
          }
          return originalSetTransport(transport)
        })
        transportTail = request.then(() => undefined, () => undefined)
        return request
      },
    },
  }
  const faults: string[] = []
  const controller = createNativePlaybackController({
    bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    reportFault: (message) => faults.push(message),
  })

  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  const play = controller.start({ ...input().transport, playheadSec: 0.125 })
  await epoch2PausedTransitionReached.promise
  const seek = controller.seekPrepared(0.25)
  resumeGate.resolve()

  await expect(play).resolves.toBe("unavailable")
  await expect(seek).resolves.toBe("started")
  expect(faults).toEqual([])
  expect(controller.isPrepared()).toBeTrue()
  expect(controller.isActive()).toBeFalse()
  await expect(controller.start(input().transport)).resolves.toBe("started")
  expect(controller.isActive()).toBeTrue()
  await controller.dispose()
})

test("queues live MIDI notes through the prepared native host while paused", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot({
      ...input(instrumentTrack),
      renderState: {
        fx: {
          masterVolume: 1,
          masterFxInstances: [],
          trackFx: {
            instrument: { instances: [], instrument: { kind: "synth", instanceId: "synth:1", params: createDefaultSynthParams() } },
          },
        },
        automationEnvelopes: [],
      },
    }),
  })

  await controller.start(input(instrumentTrack).transport)
  await controller.pause(0.5)
  const handle = controller.startLiveMidiNote({ trackId: "instrument", pitch: 60, velocity: 0.8 })
  expect(handle).toBeDefined()
  if (!handle) throw new Error("Native live note did not start while paused.")
  controller.releaseLiveMidiNote(handle)
  await Bun.sleep(0)

  expect(fixture.instrumentPayloads).toHaveLength(4)
  expect(fixture.calls.filter((call) => call === "stop")).toHaveLength(0)
  const noteOn = new DataView(fixture.instrumentPayloads[2]!.buffer)
  const noteOff = new DataView(fixture.instrumentPayloads[3]!.buffer)
  expect(noteOn.getUint32(32, true)).toBe(0)
  expect(noteOff.getUint32(32, true)).toBe(0)
  expect(noteOn.getUint32(32, true)).toBe(noteOff.getUint32(32, true))

  await controller.dispose()
  expect(controller.canProcessLiveMidi()).toBeFalse()
  expect(fixture.calls.filter((call) => call === "stop")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "teardown")).toHaveLength(1)
})

test("shares one in-flight native playback startup across concurrent callers", async () => {
  const fixture = createBridge()
  const compilation = Promise.withResolvers<ReturnType<typeof compileLivePlaybackSnapshot>>()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: () => compilation.promise,
  })

  const first = controller.start(input().transport)
  const second = controller.start(input().transport)
  expect(second).toBe(first)
  compilation.resolve(compileLivePlaybackSnapshot(input()))

  await expect(Promise.all([first, second])).resolves.toEqual(["started", "started"])
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)
})

test("project generation changes release retained native assets before rebuilding", async () => {
  const fixture = createBridge()
  let projectGeneration = 1
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    getProjectGeneration: () => projectGeneration,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  await controller.start(input().transport)
  await controller.pause(0.25)
  projectGeneration += 1
  await controller.dispose()
  await controller.ensureLivePreview(0.25)

  expect(fixture.calls.filter((call) => call === "release")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "teardown")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(2)
  expect(fixture.calls.filter((call) => call === "install")).toHaveLength(2)
  expect(controller.isActive()).toBeFalse()
  expect(controller.canProcessLiveMidi()).toBeTrue()
})

test("starts sessions with non-unity track gain without opening a legacy fallback", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input(sourceTrack(0.5))),
  })

  expect(await controller.start(input().transport)).toBe("started")
  expect(fixture.calls).toContain("begin")
  expect(fixture.calls).toContain("start")
  await controller.dispose()
})

test("rolls back a failed transaction before allowing legacy fallback", async () => {
  const fixture = createBridge("install")
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  expect(await controller.start(input().transport)).toBe("unavailable")
  expect(fixture.calls).toEqual(["begin", "configure", "install", "rollback", "stop", "teardown"])
})

test("ignores native host loss before native ownership begins", () => {
  const fixture = createBridge()
  const faults: string[] = []
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    reportFault: (message) => faults.push(message),
  })

  fixture.emitLoss()

  expect(controller.isActive()).toBeFalse()
  expect(controller.isAvailable()).toBeTrue()
  expect(faults).toEqual([])
  expect(fixture.calls).toEqual([])
})

test("ignores native host loss after native session disposal", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    reportFault: (message) => faults.push(message),
  })

  await controller.start(input().transport)
  await controller.dispose()
  fixture.emitLoss()

  expect(controller.isActive()).toBeFalse()
  expect(faults).toEqual([])
})

test("invalidates native ownership before reporting a terminal refill fault", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  const longInstrumentTrack: RuntimeTrack = {
    ...instrumentTrack,
    clips: instrumentTrack.clips.map((clip) => ({ ...clip, duration: 10 })),
  }
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
      ...nativeInstrumentInput(),
      transport,
      tracks: [longInstrumentTrack],
    }),
    reportFault: (message) => faults.push(message),
  })

  await expect(controller.start(input().transport)).resolves.toBe("started")
  fixture.setScheduleFailure(true)
  for (let index = 0; index < 16; index += 1) {
    fixture.emitScheduleProgress({
      revision: 1,
      epoch: 1,
      progressSequence: BigInt(index + 100),
      renderedThroughFrame: BigInt((index + 1) * 48_000),
      acceptedThroughFrame: 96_000n,
      lastAcceptedWindowId: 1n,
      appliedTransportTransitionId: 2n,
      appliedUrgentSequence: 0n,
      appliedProcessorSequence: 0n,
      running: true,
      scheduleComplete: false,
      instrumentCredits: 256,
      sourceCredits: 256,
      automationCredits: 256,
    })
    await Bun.sleep(0)
  }
  await Bun.sleep(200)

  expect(controller.isActive()).toBeFalse()
  expect(controller.isPrepared()).toBeFalse()
  expect(faults).toHaveLength(1)

  fixture.setScheduleFailure(false)
  await expect(controller.start(input().transport)).resolves.toBe("started")
  expect(controller.isActive()).toBeTrue()
  await controller.dispose()
})

test("ignores a queued loss from a retired coordinator after replacement", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    reportFault: (message) => faults.push(message),
  })

  await expect(controller.start(input().transport)).resolves.toBe("started")
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const retiredLoss = fixture.captureLoss()
    await controller.dispose()
    await expect(controller.start(input().transport)).resolves.toBe("started")
    retiredLoss(`stale retired coordinator loss ${cycle}`)
    expect(controller.isActive()).toBeTrue()
    expect(controller.isAvailable()).toBeTrue()
  }
  expect(faults).toEqual([])
  await controller.dispose()
})

test("host loss reports the fault without starting another backend", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    reportFault: (message) => faults.push(message),
  })

  await controller.start(input().transport)
  fixture.emitLoss()
  expect(controller.isActive()).toBeFalse()
  expect(faults).toEqual(["Native playback host connection was lost."])
  expect(controller.isAvailable()).toBeFalse()
  expect(controller.startLiveMidiNote({ trackId: "instrument", pitch: 60, velocity: 0.8 })).toBeUndefined()
  expect(fixture.calls).toEqual(["begin", "configure", "install", "graph", "transport", "commit", "start", "schedule", "transport"])
})

test("rebuilds the full native session on the next start after host loss", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  await controller.start(input().transport)
  fixture.emitLoss("The native audio host stopped.")
  await expect(controller.start(input().transport)).resolves.toBe("started")

  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(2)
  expect(fixture.calls.filter((call) => call === "graph")).toHaveLength(2)
  expect(fixture.calls.filter((call) => call === "install")).toHaveLength(2)
  expect(fixture.calls.filter((call) => call === "stop")).toHaveLength(0)
  expect(fixture.calls.filter((call) => call === "teardown")).toHaveLength(0)
  await controller.dispose()
})

test("terminates recovery when the rebuilt host is lost again", async () => {
  const fixture = createBridge()
  let recoveryStartCount = 0
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  await controller.start(input().transport)
  fixture.emitLoss()
  const originalStart = fixture.bridge.session.start
  fixture.bridge.session.start = async () => {
    const reply = await originalStart()
    recoveryStartCount += 1
    if (recoveryStartCount === 1) fixture.emitLoss("The native audio host stopped again.")
    return reply
  }
  const first = controller.start(input().transport)
  const second = controller.start(input().transport)
  expect(second).toBe(first)

  await expect(first).resolves.toBe("unavailable")
  expect(recoveryStartCount).toBe(1)
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(2)
  expect(controller.isPrepared()).toBeFalse()
  await controller.dispose()
})

test("keeps an in-flight start coalesced while host loss invalidates its first generation", async () => {
  const fixture = createBridge()
  const startGate = Promise.withResolvers<void>()
  const originalStart = fixture.bridge.session.start
  fixture.bridge.session.start = async () => {
    fixture.calls.push("start-gate")
    await startGate.promise
    return originalStart()
  }
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  const first = controller.start(input().transport)
  for (let index = 0; index < 20 && !fixture.calls.includes("start-gate"); index += 1) {
    await Promise.resolve()
  }
  expect(fixture.calls).toContain("start-gate")
  fixture.emitLoss("The native audio host stopped.")
  const second = controller.start(input().transport)
  expect(second).toBe(first)
  startGate.resolve()

  await expect(first).resolves.toBe("started")
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(2)
  expect(fixture.calls).not.toContain("rollback")
  expect(fixture.calls).not.toContain("teardown")
  await controller.dispose()
})

test("preserves the native host loss reason in the playback fault", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    reportFault: (message) => faults.push(message),
  })

  await controller.start(input().transport)
  fixture.emitLoss("The native audio host control request timed out.")

  expect(faults).toEqual(["The native audio host control request timed out."])
  expect(controller.isAvailable()).toBeFalse()
})

test("allows a new native session after explicit host recovery", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  await expect(controller.start(input().transport)).resolves.toBe("started")
  fixture.emitLoss("The native audio host stopped.")
  await controller.dispose()
  controller.resetNativeHostConnectionLoss()

  await expect(controller.start(input().transport)).resolves.toBe("started")
  await controller.dispose()
})

test("disables native after a start failure caused by host loss", async () => {
  const fixture = createBridge("begin", false, false, "The native audio host is unavailable.")
  const faults: string[] = []
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    reportFault: (message) => faults.push(message),
  })

  await expect(controller.start(input().transport)).resolves.toBe("unavailable")
  expect(faults).toEqual(["The native audio host is unavailable."])
  expect(controller.isAvailable()).toBeFalse()
  const callsAfterFailure = fixture.calls.length
  await expect(controller.ensureLivePreview(0)).resolves.toBe("unavailable")
  await expect(controller.start(input().transport)).resolves.toBe("unavailable")
  expect(faults.at(-1)).toContain("The native audio host is unavailable")
  expect(fixture.calls).toHaveLength(callsAfterFailure)
})

test("persists native recording blocks and finalizes only after terminal status", async () => {
  const fixture = createBridge()
  const written: Array<{ frameCount: number; planes: readonly Float32Array[] }> = []
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    createRecordingWriter: () => ({
      ready: Promise.resolve(),
      write: (block) => written.push(block),
      finalize: async (capturedFrames) => ({ capturedFrames }),
      abort: async () => undefined,
      terminate: () => undefined,
    }),
  })

  await controller.start(input().transport)
  await expect(controller.startRecording({
    appSessionId: "take-1",
    layout: "mono",
    inputChannel: 0,
    gain: 1,
    polarity: 1,
    monitoring: true,
    punchStartFrame: 120,
  })).resolves.toEqual({ sampleRate: 48_000, channelCount: 1, startFrame: 120 })
  const samples = new Float32Array([0.25, -0.5])
  fixture.emitRecordingBlock({
    generation: 1,
    sessionId: 1n,
    sequence: 0,
    frameCount: 2,
    channelCount: 1,
    rms: 0.4,
    peak: 0.5,
    planarPcm: new Uint8Array(samples.buffer),
  })
  expect(written).toHaveLength(1)
  expect(Array.from(written[0]?.planes[0] ?? [])).toEqual([0.25, -0.5])
  await expect(controller.stopRecording()).resolves.toEqual({ capturedFrames: 128 })
  expect(controller.isRecording()).toBeFalse()
  expect(fixture.calls).toContain("recording-configure")
  expect(fixture.calls).toContain("recording-start")
  expect(fixture.calls).toContain("recording-stop")
})

test("does not require a browser audio engine when the native bridge is absent", async () => {
  const controller = createNativePlaybackController({
    bridge: undefined,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  expect(await controller.start(input().transport)).toBe("unavailable")
})
