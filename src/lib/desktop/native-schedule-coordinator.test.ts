import { expect, test } from "bun:test"
import { audioCoreContractVersion } from "@daw-browser/audio-core-contract"
import { compileLivePlaybackSnapshot, type LivePlaybackSnapshot } from "~/lib/live-playback-snapshot"
import type { RuntimeTrack } from "~/lib/timeline-runtime-types"
import { createDefaultReverbParams, createDefaultSynthParams, externalAutomationParameterId } from "@daw-browser/shared"
import type { NativeExternalAttachmentPlan } from "@daw-browser/plugin-host-protocol"
import type { NativeScheduleProgress } from "@daw-browser/audio-engine/native-host-wire"
import {
  arrangementFrameForNativeFrame,
  createNativeScheduleCoordinator,
  nativeVstAutomationSegmentsForSnapshot,
  scheduleEndFrameFor,
} from "./native-schedule-coordinator"
import { compileLiveNativeProjection } from "@daw-browser/audio-engine/live-native-projection"

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 1 / 48_000
  readonly length = 1
  readonly numberOfChannels = 2
  readonly sampleRate = 48_000
  copyFromChannel(destination: Float32Array) { destination.fill(0) }
  copyToChannel() {}
  getChannelData() { return new Float32Array(this.length) }
}

const sourceTrack: RuntimeTrack = {
  id: "audio",
  name: "Audio",
  volume: 1,
  clips: [{
    id: "clip",
    name: "Clip",
    color: "#fff",
    startSec: 0,
    duration: 1 / 48_000,
    sourceAssetKey: "source",
    buffer: new TestAudioBuffer(),
  }],
}

const instrumentTrack: RuntimeTrack = {
  id: "instrument",
  name: "Instrument",
  kind: "instrument",
  volume: 1,
  clips: [{
    id: "midi",
    name: "MIDI",
    color: "#fff",
    startSec: 0,
    duration: 3,
    midi: {
      wave: "sawtooth",
      notes: [{ pitch: 60, beat: 0, length: 4, velocity: 0.8 }],
    },
  }],
}

const snapshotForTracks = (
  tracks: readonly RuntimeTrack[],
  playheadSec = 0,
  synthParams = createDefaultSynthParams(),
): LivePlaybackSnapshot => {
  const result = compileLivePlaybackSnapshot({
    revision: 1,
    bpm: 120,
    transport: {
      state: "playing",
      playheadSec,
      loopEnabled: false,
      loopStartSec: 0,
      loopEndSec: 0,
    },
    tracks,
    renderState: {
      fx: {
        masterVolume: 1,
        masterFxInstances: [],
        trackFx: Object.fromEntries(
          tracks
            .filter((track) => track.kind === "instrument")
            .map((track) => [track.id, {
              instances: [],
              instrument: {
                kind: "synth",
                instanceId: `synth:${track.id}`,
                params: synthParams,
              },
            }]),
        ),
      },
      automationEnvelopes: [],
    },
    sidechainRoutes: [],
  })
  if (!result.supported) throw new Error(result.reasons.join(" "))
  return result.snapshot
}

const snapshotFor = (
  track: RuntimeTrack,
  playheadSec = 0,
  synthParams = createDefaultSynthParams(),
) => snapshotForTracks([track], playheadSec, synthParams)

const loopSnapshotFor = (
  track: RuntimeTrack,
  loopStartSec: number,
  loopEndSec: number,
  playheadSec = 0,
) => {
  const snapshot = snapshotFor(track, playheadSec)
  return {
    ...snapshot,
    transport: {
      ...snapshot.transport,
      loopEnabled: true,
      loopStartSec,
      loopEndSec,
    },
  }
}

const nativeGraphFor = (snapshot: LivePlaybackSnapshot) => {
  const result = compileLiveNativeProjection({
    tracks: snapshot.tracks,
    bpm: snapshot.bpm,
    sampleRateHz: 48_000,
    revision: snapshot.revision,
    epoch: 1,
    firstSequence: 1,
    fx: snapshot.mixer.fx,
  })
  if (!result.supported) throw new Error(result.reasons.join(" "))
  return result.graph
}

const progressFor = (progressSequence: bigint, scheduleComplete = false): NativeScheduleProgress => ({
  revision: 1,
  epoch: 1,
  progressSequence,
  renderedThroughFrame: 48_000n,
  acceptedThroughFrame: 96_000n,
  lastAcceptedWindowId: 1n,
  appliedTransportTransitionId: 1n,
  appliedUrgentSequence: 0n,
  appliedProcessorSequence: 0n,
  running: true,
  scheduleComplete,
  instrumentCredits: 256,
  sourceCredits: 256,
  automationCredits: 256,
})

const bridgeFor = (options: { failureCount?: number; onAccept?: (attempt: number) => void } = {}) => {
  const payloads: Uint8Array[] = []
  const instrumentPayloads: Uint8Array[] = []
  let remainingFailures = options.failureCount ?? 0
  let onAccept = options.onAccept
  let attempt = 0
  const progressListeners = new Set<(progress: NativeScheduleProgress) => void>()
  const lossListeners = new Set<() => void>()
  let progressUnsubscribeCount = 0
  let lossUnsubscribeCount = 0
  return {
    payloads,
    setFailureCount: (count: number) => { remainingFailures = count },
    setOnAccept: (listener: (attempt: number) => void) => { onAccept = listener },
    emitProgress: (progress: NativeScheduleProgress) => {
      for (const listener of Array.from(progressListeners)) listener(progress)
    },
    emitLoss: () => {
      for (const listener of Array.from(lossListeners)) listener()
    },
    listenerStats: () => ({
      progress: progressListeners.size,
      loss: lossListeners.size,
      progressUnsubscribeCount,
      lossUnsubscribeCount,
    }),
    bridge: {
      queueScheduleWindow: async (bytes: Uint8Array) => {
        payloads.push(bytes)
        onAccept?.(attempt)
        attempt += 1
        if (remainingFailures > 0) {
          remainingFailures -= 1
          return { ok: false as const, error: "rejected" }
        }
        return { ok: true as const }
      },
      queueInstrumentEvents: async (bytes: Uint8Array) => {
        instrumentPayloads.push(bytes)
        return { ok: true as const }
      },
      onScheduleProgress: (listener: (progress: NativeScheduleProgress) => void) => {
        progressListeners.add(listener)
        return () => {
          if (!progressListeners.delete(listener)) return
          progressUnsubscribeCount += 1
        }
      },
      onLoss: (listener: () => void) => {
        lossListeners.add(listener)
        return () => {
          if (!lossListeners.delete(listener)) return
          lossUnsubscribeCount += 1
        }
      },
    },
    instrumentPayloads,
  }
}

const instrumentEventsFrom = (payloads: readonly Uint8Array[]) => payloads.flatMap((payload) => {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const count = view.getUint32(44, true)
  return Array.from({ length: count }, (_, index) => {
    const offset = 56 + index * 48
    return {
      noteId: view.getBigUint64(offset + 8, true),
      frame: view.getUint32(offset + 28, true),
      type: view.getUint32(offset + 32, true),
    }
  })
})

const initialInstrumentSequencesFrom = (payload: Uint8Array) => {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const count = view.getUint32(0, true)
  return Array.from({ length: count }, (_, index) => view.getBigUint64(20 + index * 48, true))
}

const coordinatorFor = (
  snapshot: LivePlaybackSnapshot,
  failureCount = 0,
  fixture = bridgeFor({ failureCount }),
  onHostLoss?: () => void,
  acceptsLiveMidi = false,
) => {
  fixture.setFailureCount(failureCount)
  return {
    fixture,
    coordinator: createNativeScheduleCoordinator({
      bridge: fixture.bridge,
      snapshot,
      graph: nativeGraphFor(snapshot),
      acceptsLiveMidi,
      epoch: 1,
      sampleRateHz: 48_000,
      capacity: { maximumFramesPerBlock: 512 },
      assets: snapshot.assets.map((asset, index) => ({
        asset: {
          version: audioCoreContractVersion,
          assetId: `portable-export:${asset.assetId}`,
          frameCount: asset.buffer.length,
          sampleRateHz: asset.buffer.sampleRate,
          channelCount: asset.buffer.numberOfChannels,
        },
        sessionAssetId: index + 1,
      })),
      startFrame: Math.round(snapshot.transport.playheadSec * 48_000),
      onHostLoss,
    }),
  }
}

const attachmentPlan: NativeExternalAttachmentPlan = {
  version: 1,
  attachments: [{
    instanceId: "11111111-1111-4111-8111-111111111111",
    graphNodeId: "instrument",
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
    parameterOverrides: {},
  }],
}

const automationSnapshot = (
  points: Array<{ id: string; timeSec: number; value: number; interpolation: "linear" | "hold" }>,
  playheadSec = 0,
  parameterOverrides: Record<string, number> = {},
) => {
  const snapshot = snapshotFor(instrumentTrack, playheadSec)
  const parameterId = externalAutomationParameterId(attachmentPlan.attachments[0]!.instanceId, 7)
  return {
    ...snapshot,
    nativeExternalAttachmentPlan: {
      ...attachmentPlan,
      attachments: attachmentPlan.attachments.map((attachment) => ({
        ...attachment,
        parameterOverrides,
      })),
    },
    mixer: {
      ...snapshot.mixer,
      automationEnvelopes: [{
        id: "automation",
        projectId: "project:1",
        target: { kind: "track" as const, trackId: "instrument" },
        targetKey: "automation",
        parameterId,
        enabled: true,
        points,
        updatedAt: 1,
      }],
    },
  }
}

test("removes both native schedule listeners on host loss and explicit disposal", async () => {
  const hostLossFixture = bridgeFor()
  let hostLossCount = 0
  const { coordinator: hostLossCoordinator } = coordinatorFor(
    snapshotFor(sourceTrack),
    0,
    hostLossFixture,
    () => { hostLossCount += 1 },
  )
  hostLossCoordinator.install()
  const accepted = hostLossCoordinator.waitForAccepted(1)
  hostLossFixture.emitLoss()
  await expect(accepted).rejects.toThrow("Native playback host connection was lost.")
  expect(hostLossFixture.listenerStats()).toEqual({
    progress: 0,
    loss: 0,
    progressUnsubscribeCount: 1,
    lossUnsubscribeCount: 1,
  })
  expect(hostLossCount).toBe(1)
  hostLossCoordinator.dispose()
  expect(hostLossFixture.listenerStats()).toEqual({
    progress: 0,
    loss: 0,
    progressUnsubscribeCount: 1,
    lossUnsubscribeCount: 1,
  })

  const disposeFixture = bridgeFor()
  const { coordinator: disposeCoordinator } = coordinatorFor(
    snapshotFor(sourceTrack),
    0,
    disposeFixture,
  )
  disposeCoordinator.install()
  disposeCoordinator.dispose()
  disposeCoordinator.dispose()
  expect(disposeFixture.listenerStats()).toEqual({
    progress: 0,
    loss: 0,
    progressUnsubscribeCount: 1,
    lossUnsubscribeCount: 1,
  })
})

test("does not accumulate listeners across repeated host-loss cycles", () => {
  const fixture = bridgeFor()
  const snapshot = snapshotFor(sourceTrack)
  const cycleCount = 24
  for (let index = 0; index < cycleCount; index += 1) {
    const { coordinator } = coordinatorFor(snapshot, 0, fixture)
    coordinator.install()
    fixture.emitLoss()
  }
  expect(fixture.listenerStats()).toEqual({
    progress: 0,
    loss: 0,
    progressUnsubscribeCount: cycleCount,
    lossUnsubscribeCount: cycleCount,
  })
})

test("retries one rejected source window without changing its ledger", async () => {
  const { fixture, coordinator } = coordinatorFor(snapshotFor(sourceTrack), 1)
  await coordinator.prime(0)
  expect(fixture.payloads).toHaveLength(2)
  expect(fixture.payloads[0]).toEqual(fixture.payloads[1])
  const view = new DataView(fixture.payloads[1]!.buffer)
  expect(view.getUint32(48, true)).toBe(1)
  expect(view.getUint32(44, true)).toBe(0)
})

test("coalesces a synchronous completion progress callback during final submission", async () => {
  const fixture = bridgeFor()
  const snapshot = snapshotFor({
    ...instrumentTrack,
    clips: [{
      ...instrumentTrack.clips[0]!,
      duration: 1,
      midi: { wave: "sawtooth", notes: [{ pitch: 60, beat: 0, length: 1, velocity: 0.8 }] },
    }],
  })
  const completionBridge = fixture.bridge
  const completionCoordinator = createNativeScheduleCoordinator({
    bridge: completionBridge,
    snapshot,
    epoch: 1,
    sampleRateHz: 48_000,
    capacity: { maximumFramesPerBlock: 512 },
    assets: [],
    startFrame: 0,
  })
  completionCoordinator.install()
  fixture.setOnAccept(() => fixture.emitProgress(progressFor(1n, true)))
  await completionCoordinator.prime(0)
  expect(fixture.payloads).toHaveLength(1)
  expect(completionCoordinator.currentProgress()?.scheduleComplete).toBeTrue()
})

test("does not refill after completion from stale progress or effect tail rendering", async () => {
  const { fixture, coordinator } = coordinatorFor(snapshotFor(sourceTrack))
  coordinator.install()
  await coordinator.prime(0)
  fixture.emitProgress(progressFor(2n, true))
  fixture.emitProgress({ ...progressFor(1n, false), renderedThroughFrame: 480_000n })
  await Bun.sleep(0)
  expect(fixture.payloads).toHaveLength(1)
})

test("keeps live-MIDI schedule ownership open with bounded contiguous windows", async () => {
  const { fixture, coordinator } = coordinatorFor(snapshotFor(sourceTrack), 0, bridgeFor(), undefined, true)
  expect(coordinator.scheduleEndFrame()).toBe(Number.MAX_SAFE_INTEGER)
  await coordinator.prime(0)
  expect(fixture.payloads).toHaveLength(1)
  const first = new DataView(fixture.payloads[0]!.buffer)
  expect(first.getBigUint64(16, true)).toBe(0n)
  expect(first.getBigUint64(24, true)).toBe(96_000n)
  expect(first.getUint32(40, true)).toBe(0)

  coordinator.onProgress({
    ...progressFor(1n),
    renderedThroughFrame: 48_000n,
    acceptedThroughFrame: 96_000n,
  })
  await Bun.sleep(0)
  await Bun.sleep(0)
  expect(fixture.payloads).toHaveLength(2)
  const second = new DataView(fixture.payloads[1]!.buffer)
  expect(second.getBigUint64(16, true)).toBe(96_000n)
  expect(second.getUint32(40, true)).toBe(0)
})

test("reports a persistent refill rejection after bounded progress retries", async () => {
  const fixture = bridgeFor()
  const faults: Error[] = []
  const snapshot = snapshotFor(instrumentTrack)
  const coordinator = createNativeScheduleCoordinator({
    bridge: fixture.bridge,
    snapshot,
    epoch: 1,
    sampleRateHz: 48_000,
    capacity: { maximumFramesPerBlock: 512 },
    assets: [],
    startFrame: 0,
    onFault: (error) => faults.push(error),
  })
  await coordinator.prime(0)
  fixture.setFailureCount(100)
  coordinator.install()
  for (let sequence = 1n; sequence <= 8n; sequence += 1n) {
    coordinator.onProgress(progressFor(sequence))
    await Bun.sleep(100)
  }
  expect(fixture.payloads.length).toBeGreaterThanOrEqual(8)
  expect(faults).toHaveLength(1)
})

test("retries an arranged MIDI window without leaking its note ledger", async () => {
  const { fixture, coordinator } = coordinatorFor(snapshotFor(instrumentTrack), 1)
  await coordinator.prime(0)
  expect(fixture.payloads).toHaveLength(2)
  expect(fixture.payloads[0]).toEqual(fixture.payloads[1])
})

test("assigns strictly increasing initialization sequences across synth tracks", async () => {
  const secondTrack: RuntimeTrack = {
    ...instrumentTrack,
    id: "instrument-2",
    name: "Instrument 2",
    clips: [{
      ...instrumentTrack.clips[0]!,
      id: "midi-2",
    }],
  }
  const { fixture, coordinator } = coordinatorFor(snapshotForTracks([instrumentTrack, secondTrack]))
  await coordinator.queueInitialSynthState(0)
  expect(fixture.instrumentPayloads).toHaveLength(1)
  expect(initialInstrumentSequencesFrom(fixture.instrumentPayloads[0]!)).toEqual(
    Array.from({ length: 16 }, (_, index) => BigInt(index + 1)),
  )
})

test("keeps an active arranged note across repeated schedule windows", async () => {
  const track: RuntimeTrack = {
    ...instrumentTrack,
    clips: [{
      ...instrumentTrack.clips[0]!,
      duration: 5,
      midi: { wave: "sawtooth", notes: [{ pitch: 60, beat: 0, length: 20, velocity: 0.8 }] },
    }],
  }
  const { fixture, coordinator } = coordinatorFor(snapshotFor(track))
  await coordinator.prime(0)
  coordinator.onProgress({
    revision: 1,
    epoch: 1,
    progressSequence: 1n,
    renderedThroughFrame: 48_000n,
    acceptedThroughFrame: 96_000n,
    lastAcceptedWindowId: 1n,
    appliedTransportTransitionId: 1n,
    appliedUrgentSequence: 0n,
  appliedProcessorSequence: 0n,
    running: true,
    scheduleComplete: false,
    instrumentCredits: 256,
    sourceCredits: 256,
    automationCredits: 256,
  })
  await Bun.sleep(0)
  await Bun.sleep(0)
  expect(fixture.payloads.length).toBeGreaterThanOrEqual(2)
  const second = fixture.payloads[1]
  if (!second) throw new Error("Expected the repeated schedule window.")
  const view = new DataView(second.buffer)
  expect(view.getUint32(44, true)).toBe(0)
})

test("moves a note-off at a window boundary into the following window", async () => {
  const track: RuntimeTrack = {
    ...instrumentTrack,
    clips: [{
      ...instrumentTrack.clips[0]!,
      duration: 3,
      midi: { wave: "sawtooth", notes: [{ pitch: 60, beat: 0, length: 4, velocity: 0.8 }] },
    }],
  }
  const { fixture, coordinator } = coordinatorFor(snapshotFor(track))
  await coordinator.prime(0)
  coordinator.onProgress({
    revision: 1,
    epoch: 1,
    progressSequence: 1n,
    renderedThroughFrame: 48_000n,
    acceptedThroughFrame: 96_000n,
    lastAcceptedWindowId: 1n,
    appliedTransportTransitionId: 1n,
    appliedUrgentSequence: 0n,
  appliedProcessorSequence: 0n,
    running: true,
    scheduleComplete: false,
    instrumentCredits: 256,
    sourceCredits: 256,
    automationCredits: 256,
  })
  await Bun.sleep(0)
  await Bun.sleep(0)
  const second = fixture.payloads[1]
  expect(second).toBeDefined()
  if (!second) return
  const view = new DataView(second.buffer)
  expect(view.getUint32(44, true)).toBe(1)
  expect(view.getUint32(56 + 28, true)).toBe(96_000)
  expect(view.getUint32(56 + 32, true)).toBe(2)
  const events = instrumentEventsFrom(fixture.payloads)
  expect(events.filter((event) => event.type === 1)).toHaveLength(1)
  expect(events.filter((event) => event.type === 2)).toHaveLength(1)
  expect(events.find((event) => event.type === 1)?.noteId)
    .toBe(events.find((event) => event.type === 2)?.noteId)
})

test("extends the final schedule window so the final note-off is accepted", async () => {
  const track: RuntimeTrack = {
    ...instrumentTrack,
    clips: [{
      ...instrumentTrack.clips[0]!,
      duration: 2,
      midi: { wave: "sawtooth", notes: [{ pitch: 60, beat: 0, length: 4, velocity: 0.8 }] },
    }],
  }
  const defaults = createDefaultSynthParams()
  const { fixture, coordinator } = coordinatorFor(snapshotFor(track, 0, {
    ...defaults,
    ampEnvelope: { ...defaults.ampEnvelope, releaseSec: 0 },
  }))
  await coordinator.prime(0)
  coordinator.onProgress({
    revision: 1,
    epoch: 1,
    progressSequence: 1n,
    renderedThroughFrame: 48_000n,
    acceptedThroughFrame: 96_000n,
    lastAcceptedWindowId: 1n,
    appliedTransportTransitionId: 1n,
    appliedUrgentSequence: 0n,
  appliedProcessorSequence: 0n,
    running: true,
    scheduleComplete: false,
    instrumentCredits: 256,
    sourceCredits: 256,
    automationCredits: 256,
  })
  await Bun.sleep(0)
  await Bun.sleep(0)
  const second = fixture.payloads[1]
  expect(second).toBeDefined()
  if (!second) return
  const view = new DataView(second.buffer)
  expect(view.getUint32(16, true)).toBe(96_000)
  expect(view.getUint32(24, true)).toBe(96_001)
  expect(view.getUint32(40, true)).toBe(1)
  expect(view.getUint32(44, true)).toBe(1)
  expect(view.getUint32(56 + 28, true)).toBe(96_000)
  expect(view.getUint32(56 + 32, true)).toBe(2)
})

test("projects repeated loop iterations onto monotonic native frames", async () => {
  const track: RuntimeTrack = {
    ...instrumentTrack,
    clips: [{
      ...instrumentTrack.clips[0]!,
      duration: 3,
      midi: { wave: "sawtooth", notes: [{ pitch: 60, beat: 0, length: 1, velocity: 0.8 }] },
    }],
  }
  const { fixture, coordinator } = coordinatorFor(loopSnapshotFor(track, 0, 1))
  await coordinator.prime(0)
  const events = instrumentEventsFrom(fixture.payloads)
  const noteOns = events.filter((event) => event.type === 1)
  expect(noteOns.length).toBeGreaterThanOrEqual(2)
  expect(new Set(noteOns.map((event) => event.noteId)).size).toBe(noteOns.length)
  for (let index = 1; index < fixture.payloads.length; index += 1) {
    const previous = new DataView(fixture.payloads[index - 1]!.buffer).getUint32(16, true)
    const current = new DataView(fixture.payloads[index]!.buffer).getUint32(16, true)
    expect(current).toBeGreaterThanOrEqual(previous)
    expect(new DataView(fixture.payloads[index]!.buffer).getUint32(44, true)).toBe(0)
  }
})

test("wraps the public arrangement frame at the integer loop boundary", () => {
  expect(arrangementFrameForNativeFrame(72_000, {
    startFrame: 24_000,
    endFrame: 72_000,
    lengthFrames: 48_000,
  })).toBe(24_000)
  expect(arrangementFrameForNativeFrame(96_000, {
    startFrame: 24_000,
    endFrame: 72_000,
    lengthFrames: 48_000,
  })).toBe(48_000)
})

test("releases a note carried from an earlier window at the loop boundary", async () => {
  const track: RuntimeTrack = {
    ...instrumentTrack,
    clips: [{
      ...instrumentTrack.clips[0]!,
      duration: 8,
      midi: { wave: "sawtooth", notes: [{ pitch: 60, beat: 0, length: 20, velocity: 0.8 }] },
    }],
  }
  const { fixture, coordinator } = coordinatorFor(loopSnapshotFor(track, 4, 5))
  await coordinator.prime(0)
  coordinator.onProgress({ ...progressFor(1n), renderedThroughFrame: 96_000n })
  await Bun.sleep(0)
  coordinator.onProgress({ ...progressFor(2n), renderedThroughFrame: 192_000n })
  await Bun.sleep(0)
  const beforeWrap = instrumentEventsFrom(fixture.payloads)
  expect(beforeWrap.some((event) => event.type === 2 && event.frame === 192_000)).toBeFalse()
  coordinator.onProgress({ ...progressFor(3n), renderedThroughFrame: 240_000n })
  await Bun.sleep(0)
  const events = instrumentEventsFrom(fixture.payloads)
  expect(events.some((event) => event.type === 2 && event.frame === 240_000)).toBeTrue()
})

test("preflight preserves one voice for a spanning loop note across callbacks", () => {
  const track: RuntimeTrack = {
    ...instrumentTrack,
    clips: [{
      ...instrumentTrack.clips[0]!,
      duration: 8,
      midi: { wave: "sawtooth", notes: [{ pitch: 60, beat: 0, length: 20, velocity: 0.8 }] },
    }],
  }
  const baseSnapshot = snapshotFor(track, 4, { ...createDefaultSynthParams(), polyphony: 1 })
  const snapshotWithOneVoice = {
    ...baseSnapshot,
    transport: {
      ...baseSnapshot.transport,
      loopEnabled: true,
      loopStartSec: 4,
      loopEndSec: 5,
    },
  }
  const { coordinator } = coordinatorFor(snapshotWithOneVoice)
  expect(() => coordinator.preflight(nativeGraphFor(snapshotWithOneVoice))).not.toThrow()
})

test("accepts overlapping arranged notes up to synth voice capacity", () => {
  const track: RuntimeTrack = {
    ...instrumentTrack,
    clips: [{
      ...instrumentTrack.clips[0]!,
      duration: 3,
      midi: {
        wave: "sawtooth",
        notes: [
          { pitch: 60, beat: 0, length: 4, velocity: 0.8 },
          { pitch: 64, beat: 0.5, length: 3.5, velocity: 0.8 },
        ],
      },
    }],
  }
  const snapshot = snapshotFor(track, 0, { ...createDefaultSynthParams(), polyphony: 2 })
  const { coordinator } = coordinatorFor(snapshot)
  expect(() => coordinator.preflight(nativeGraphFor(snapshot))).not.toThrow()
})

test("rejects one more overlapping arranged note than synth voice capacity", () => {
  const track: RuntimeTrack = {
    ...instrumentTrack,
    clips: [{
      ...instrumentTrack.clips[0]!,
      duration: 3,
      midi: {
        wave: "sawtooth",
        notes: [
          { pitch: 60, beat: 0, length: 4, velocity: 0.8 },
          { pitch: 64, beat: 0.5, length: 3.5, velocity: 0.8 },
          { pitch: 67, beat: 1, length: 3, velocity: 0.8 },
        ],
      },
    }],
  }
  const snapshot = snapshotFor(track, 0, { ...createDefaultSynthParams(), polyphony: 2 })
  const { coordinator } = coordinatorFor(snapshot)
  expect(() => coordinator.preflight(nativeGraphFor(snapshot))).toThrow(/simultaneous voices/)
})

test("preflights finite live-MIDI capacity beyond the initial lookahead", () => {
  const track: RuntimeTrack = {
    ...instrumentTrack,
    clips: [{
      ...instrumentTrack.clips[0]!,
      duration: 6,
      midi: {
        wave: "sawtooth",
        notes: Array.from({ length: 33 }, (_, index) => ({
          pitch: 36 + (index % 48),
          beat: 8,
          length: 1,
          velocity: 0.8,
        })),
      },
    }],
  }
  const snapshot = snapshotFor(track, 0, { ...createDefaultSynthParams(), polyphony: 128 })
  const { coordinator } = coordinatorFor(snapshot, 0, undefined, undefined, true)
  expect(() => coordinator.preflight(nativeGraphFor(snapshot))).toThrow(
    "instrument instrument needs 33 simultaneous voices",
  )
})

test("publishes a spanning note-on and later note-off in one logical window", async () => {
  const { fixture, coordinator } = coordinatorFor(snapshotFor(instrumentTrack, 1), 0)
  await coordinator.prime(48_000)
  const payload = fixture.payloads[0]
  expect(payload).toBeDefined()
  if (!payload) return
  const view = new DataView(payload.buffer)
  expect(view.getUint32(44, true)).toBe(2)
  expect(view.getUint32(56 + 28, true)).toBe(48_000)
  expect(view.getUint32(56 + 48 + 28, true)).toBe(96_000)
  expect(view.getUint32(56 + 32, true)).not.toBe(view.getUint32(56 + 48 + 32, true))
})

test("projects non-empty VST automation segments across start, seek, and end boundaries", () => {
  const atStart = nativeVstAutomationSegmentsForSnapshot(
    automationSnapshot([{ id: "start", timeSec: 0, value: 0.5, interpolation: "hold" }]),
    48_000,
    0,
    1,
  )
  expect(atStart).toMatchObject([{ startFrame: 0, endFrame: 1, startValue: 0.5, endValue: 0.5 }])

  const beforeSeek = nativeVstAutomationSegmentsForSnapshot(
    automationSnapshot([{ id: "before", timeSec: 0, value: 0.25, interpolation: "hold" }], 1),
    48_000,
    48_000,
    48_001,
  )
  expect(beforeSeek).toMatchObject([{ startFrame: 48_000, endFrame: 48_001, startValue: 0.25 }])

  const inside = nativeVstAutomationSegmentsForSnapshot(
    automationSnapshot([
      { id: "inside", timeSec: 0.5, value: 0.25, interpolation: "linear" },
      { id: "end", timeSec: 1, value: 0.75, interpolation: "hold" },
    ]),
    48_000,
    0,
    48_000,
  )
  expect(inside).toMatchObject([
    { startFrame: 0, endFrame: 24_000 },
    { startFrame: 24_000, endFrame: 48_000, interpolation: "linear" },
  ])
  expect(inside.every((segment) => segment.startFrame < segment.endFrame)).toBeTrue()

  const endBoundary = nativeVstAutomationSegmentsForSnapshot(
    automationSnapshot([
      { id: "start", timeSec: 0, value: 0.1, interpolation: "linear" },
      { id: "end", timeSec: 1, value: 0.9, interpolation: "hold" },
    ]),
    48_000,
    0,
    48_000,
  )
  expect(endBoundary.every((segment) => segment.startFrame < segment.endFrame)).toBeTrue()
})

test("does not let persisted parameter initialization suppress scheduled automation", () => {
  const segments = nativeVstAutomationSegmentsForSnapshot(
    automationSnapshot([{ id: "persisted", timeSec: 0, value: 0.5, interpolation: "hold" }], 0, { "7": 0.25 }),
    48_000,
    0,
    1,
  )
  expect(segments).toMatchObject([{ parameterId: 7, startValue: 0.5, endValue: 0.5 }])
})

test("extends finite scheduling through synth release metadata", () => {
  const defaults = createDefaultSynthParams()
  const snapshot = snapshotFor(instrumentTrack, 0, {
    ...defaults,
    ampEnvelope: { ...defaults.ampEnvelope, releaseSec: 4 },
  })
  expect(scheduleEndFrameFor(snapshot, 48_000, nativeGraphFor(snapshot))).toBe(7 * 48_000)
})

test("extends finite scheduling through built-in reverb metadata", () => {
  const snapshot = snapshotFor(sourceTrack)
  const reverbSnapshot = {
    ...snapshot,
    mixer: {
      ...snapshot.mixer,
      fx: {
        ...snapshot.mixer.fx,
        masterFxInstances: [{
          id: "reverb",
          kind: "reverb" as const,
          params: { ...createDefaultReverbParams(), decaySec: 4, preDelayMs: 100 },
        }],
      },
    },
  }
  expect(scheduleEndFrameFor(reverbSnapshot, 48_000, nativeGraphFor(reverbSnapshot)))
    .toBe(48_001 + 3.1 * 48_000)
})

test("extends finite scheduling through a declared VST tail", () => {
  const defaults = createDefaultSynthParams()
  const snapshot = {
    ...snapshotFor(instrumentTrack, 0, {
      ...defaults,
      ampEnvelope: { ...defaults.ampEnvelope, releaseSec: 0 },
    }),
    nativeExternalAttachmentPlan: {
      ...attachmentPlan,
      attachments: attachmentPlan.attachments.map((attachment) => ({
        ...attachment,
        declaredTailFrames: 48_000,
      })),
    },
  }
  expect(scheduleEndFrameFor(snapshot, 48_000, nativeGraphFor(snapshot))).toBe(4 * 48_000)
})

test("leaves unbounded processor continuation to the native host tail observer", () => {
  const base = snapshotFor(sourceTrack)
  const snapshot = {
    ...base,
    mixer: {
      ...base.mixer,
      fx: {
        ...base.mixer.fx,
        masterFxInstances: [{
          id: "reverb",
          kind: "reverb" as const,
          params: { ...createDefaultReverbParams(), decaySec: 4, preDelayMs: 100 },
        }],
      },
    },
  }
  const graph = nativeGraphFor(snapshot)
  const unboundedGraph = {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      processorOrder: node.processorOrder.map((processor) => ({
        ...processor,
        tailKind: "unbounded" as const,
        tailFrames: 48_000 * 30,
      })),
    })),
  }
  expect(scheduleEndFrameFor(snapshot, 48_000, unboundedGraph)).toBe(2)
})
