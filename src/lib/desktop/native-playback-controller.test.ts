import { expect, test } from "bun:test"

import { createNativePlaybackController } from "./native-playback-controller"
import { compileLivePlaybackSnapshot, type LivePlaybackSnapshotInput } from "~/lib/live-playback-snapshot"
import type { RuntimeTrack } from "~/lib/timeline-runtime-types"
import type { NativeHostRecordingBlock, NativeHostRecordingStatus } from "@daw-browser/audio-engine/native-host-wire"

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 1 / 48_000
  readonly length = 1
  readonly numberOfChannels = 2
  readonly sampleRate = 48_000
  copyFromChannel(destination: Float32Array) { destination.fill(0) }
  copyToChannel() {}
  getChannelData() { return new Float32Array(this.length) }
}

const sourceTrack = (volume = 1): RuntimeTrack => ({
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

const createBridge = (failure?: string) => {
  const calls: string[] = []
  const deviceId: `coreaudio:${string}` = "coreaudio:default"
  let loss = () => {}
  let recordingBlock = (_block: NativeHostRecordingBlock) => {}
  let recordingStatus = (_status: NativeHostRecordingStatus) => {}
  const reply = (name: string) => async () => {
    calls.push(name)
    return name === failure ? { ok: false as const, error: "failed" } : { ok: true as const }
  }
  return {
    calls,
    emitLoss: () => loss(),
    emitRecordingBlock: (block: NativeHostRecordingBlock) => recordingBlock(block),
    emitRecordingStatus: (status: NativeHostRecordingStatus) => recordingStatus(status),
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
        beginTransaction: reply("begin"),
        commitTransaction: reply("commit"),
        rollbackTransaction: reply("rollback"),
        installAsset: reply("install"),
        releaseAsset: reply("release"),
        publishGraph: reply("graph"),
        queueSourceEvents: reply("source"),
        setTransport: reply("transport"),
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
        start: reply("start"),
        stop: reply("stop"),
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
      },
    },
  }
}

test("commits a supported native session before starting and tears it down deterministically", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  expect(await controller.start(input().transport)).toBe("started")
  expect(fixture.calls).toEqual(["begin", "configure", "install", "graph", "source", "transport", "commit", "start"])
  await controller.dispose()
  expect(fixture.calls).toEqual([
    "begin", "configure", "install", "graph", "source", "transport", "commit", "start",
    "stop", "release", "teardown",
  ])
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
  expect(controller.isPrepared()).toBeTrue()
  await controller.start({ ...input().transport, playheadSec: 0.5 })

  expect(compilations).toBe(1)
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "install")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "start")).toHaveLength(2)
  expect(fixture.calls.filter((call) => call === "stop")).toHaveLength(1)
  expect(fixture.calls).not.toContain("release")
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
  await controller.start({ ...input().transport, playheadSec: 0.25 })

  expect(fixture.calls.filter((call) => call === "release")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "teardown")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(2)
  expect(fixture.calls.filter((call) => call === "install")).toHaveLength(2)
})

test("leaves unsupported sessions on the legacy path without opening a transaction", async () => {
  const fixture = createBridge()
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input(sourceTrack(0.5))),
  })

  expect(await controller.start(input().transport)).toBe("unavailable")
  expect(fixture.calls).toEqual([])
})

test("rolls back a failed transaction before allowing legacy fallback", async () => {
  const fixture = createBridge("install")
  const controller = createNativePlaybackController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  expect(await controller.start(input().transport)).toBe("unavailable")
  expect(fixture.calls).toEqual(["begin", "configure", "install", "rollback"])
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
  expect(fixture.calls).toEqual(["begin", "configure", "install", "graph", "source", "transport", "commit", "start"])
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
