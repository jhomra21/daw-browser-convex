import { expect, test } from "bun:test"

import { createNativePlaybackController } from "./native-playback-controller"
import { compileLivePlaybackSnapshot, type LivePlaybackSnapshotInput } from "~/lib/live-playback-snapshot"
import type { RuntimeTrack } from "~/lib/timeline-runtime-types"
import { automationTargetKey, createDefaultReverbParams, createDefaultSynthParams, externalAutomationParameterId } from "@daw-browser/shared"
import { nativeGraphNodeId, type NativeHostMeterBatch, type NativeHostRecordingBlock, type NativeHostRecordingStatus, type NativeHostSpectrumFrame, type NativeScheduleProgress } from "@daw-browser/audio-engine/native-host-wire"
import type { SpectrumFrame } from "@daw-browser/audio-engine/audio-engine"
import type { NativeExternalAttachmentPlan } from "@daw-browser/plugin-host-protocol"

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 1 / 48_000
  readonly length = 1
  readonly numberOfChannels = 2
  readonly sampleRate = 48_000
  copyFromChannel(destination: Float32Array) { destination.fill(0) }
  copyToChannel() {}
  getChannelData() { return new Float32Array(this.length) }
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

const nativeAttachmentPlan: NativeExternalAttachmentPlan = {
  version: 1,
  attachments: [{
    instanceId: "11111111-1111-4111-8111-111111111111",
    graphNodeId: "track",
    nativeGraphNodeId: "123",
    chainIndex: 0,
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
) => {
  const calls: string[] = []
  const parameterPayloads: Uint8Array[] = []
  const instrumentPayloads: Uint8Array[] = []
  const schedulePayloads: Uint8Array[] = []
  const graphPayloads: Uint8Array[] = []
  const instrumentRequests: Array<{
    bytes: Uint8Array
    resolve: (reply: BridgeReply) => void
  }> = []
  const deviceId: `coreaudio:${string}` = "coreaudio:default"
  let instrumentRequestPending = false
  let loss = () => {}
  let recordingBlock = (_block: NativeHostRecordingBlock) => {}
  let recordingStatus = (_status: NativeHostRecordingStatus) => {}
  let meterBatch = (_batch: NativeHostMeterBatch) => {}
  let spectrumFrame = (_frame: NativeHostSpectrumFrame) => {}
  let scheduleProgress = (_progress: NativeScheduleProgress) => {}
  let progressSequence = 0n
  let transportEpoch = 1
  let appliedTransitionId = 0n
  let appliedUrgentSequence = 0n
  let sessionStarted = false
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
      running: false,
      scheduleComplete: currentWindows.some((payload) => new DataView(payload.buffer).getUint32(40, true) === 1),
      instrumentCredits: 256,
      sourceCredits: 256,
      automationCredits: 256,
    })
  }
  const reply = (name: string) => async () => {
    calls.push(name)
    return name === failure ? { ok: false as const, error: "failed" } : { ok: true as const }
  }
  return {
    calls,
    parameterPayloads,
    instrumentPayloads,
    schedulePayloads,
    graphPayloads,
    instrumentRequests,
    emitLoss: () => loss(),
    emitRecordingBlock: (block: NativeHostRecordingBlock) => recordingBlock(block),
    emitRecordingStatus: (status: NativeHostRecordingStatus) => recordingStatus(status),
    emitMeterBatch: (batch: NativeHostMeterBatch) => meterBatch(batch),
    emitSpectrumFrame: (frame: NativeHostSpectrumFrame) => spectrumFrame(frame),
    emitScheduleProgress: (progress: NativeScheduleProgress) => scheduleProgress(progress),
    bridge: {
      resolveOutputDevice: async () => ({
        ok: true as const,
        device: {
          deviceId,
          name: "Default",
          nominalSampleRateHz: 48_000,
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
          nominalSampleRateHz: 48_000,
          inputChannelCount: 2,
          maximumFramesPerBlock: 512,
          available: true,
        },
      }),
      session: {
        configure: reply("configure"),
        beginTransaction: async (): Promise<BridgeTransactionReply> => {
          calls.push("begin")
          return failure === "begin" ? { ok: false as const, error: "failed" } : { ok: true as const, transactionToken: "transaction-token" }
        },
        commitTransaction: reply("commit"),
        rollbackTransaction: reply("rollback"),
        installAsset: reply("install"),
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
        queueSourceEvents: reply("source"),
        queueScheduleWindow: async (bytes: Uint8Array) => {
          calls.push("schedule")
          if (requireStartedForSchedule && !sessionStarted) {
            return { ok: false as const, error: "session is not started" }
          }
          schedulePayloads.push(bytes)
          queueMicrotask(() => emitProgress(0))
          return failure === "schedule" ? { ok: false as const, error: "failed" } : { ok: true as const }
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
          transportEpoch = transport.epoch
          appliedTransitionId = transport.transitionId ?? (appliedTransitionId + 1n)
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
          return () => { loss = () => {} }
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
        setSpectrumNode: async () => ({ ok: true as const }),
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

const nativeInstrumentEventTypes = (payload: Uint8Array) => {
  const view = new DataView(payload.buffer)
  const count = view.getUint32(0, true)
  return Array.from({ length: count }, (_, index) => view.getUint32(36 + index * 48, true))
}

test("commits a supported native session before starting and tears it down deterministically", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  expect(await controller.start(input().transport)).toBe("started")
  expect(fixture.calls).toEqual(["begin", "configure", "install", "graph", "transport", "commit", "start", "schedule", "transport"])
  await controller.dispose()
  expect(fixture.calls).toEqual([
    "begin", "configure", "install", "graph", "transport", "commit", "start", "schedule", "transport",
    "stop", "release", "teardown",
  ])
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
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  expect(await controller.start(input().transport)).toBe("started")
  const handle = controller.startLiveMidiNote({ trackId: "instrument", pitch: 60, velocity: 0.8 })
  expect(handle).toMatchObject({ backend: "native", trackId: "instrument", pitch: 60 })
  if (!handle) throw new Error("Native live note did not start.")
  controller.releaseLiveMidiNote(handle)
  await Bun.sleep(0)
  expect(fixture.instrumentPayloads).toHaveLength(2)
  const noteOn = new DataView(fixture.instrumentPayloads[0]!.buffer)
  const noteOff = new DataView(fixture.instrumentPayloads[1]!.buffer)
  expect(noteOn.getUint32(32, true)).toBe(0)
  expect(noteOff.getUint32(32, true)).toBe(0)
  expect(noteOn.getUint32(32, true)).toBeLessThanOrEqual(noteOff.getUint32(32, true))
  expect(noteOn.getUint32(36, true)).toBe(101)
  expect(noteOff.getUint32(36, true)).toBe(102)
  await controller.dispose()
})

test("filters native spectrum frames by target, revision, epoch, and sequence", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })
  const frames: Array<SpectrumFrame | null> = []
  const unsubscribe = controller.subscribeSpectrum("track", (frame) => frames.push(frame))
  await expect(controller.start(input().transport)).resolves.toBe("started")
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

  compilation.resolve(compileLivePlaybackSnapshot(input()))
  await expect(controller.ensureLivePreview(0.75)).resolves.toBe("started")
  expect(compiledTransport).toMatchObject({ state: "paused", playheadSec: 0.75 })
  expect(controller.isActive()).toBeFalse()
  expect(controller.isPrepared()).toBeTrue()
  expect(controller.canProcessLiveMidi()).toBeTrue()
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "start")).toHaveLength(1)

  if (!handle) throw new Error("Native live note did not queue.")
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
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    reportFault: (message) => faults.push(message),
  })

  expect(await controller.start(input().transport)).toBe("started")
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

test("pause and resume retain the prepared native graph and installed assets", async () => {
  const fixture = createBridge()
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
  expect(fixture.calls.filter((call) => call === "transport")).toHaveLength(5)
  expect(fixture.calls).not.toContain("release")
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
  expect(fixture.calls).toEqual(["begin", "configure", "install", "graph", "transport", "commit", "start", "schedule", "transport", "stop"])
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
