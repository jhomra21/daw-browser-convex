import { expect, test } from "bun:test"
import "fake-indexeddb/auto"
import { audioCoreContractVersion } from "@daw-browser/audio-core-contract"
import { compileLivePlaybackSnapshot, type LivePlaybackSnapshot } from "~/lib/live-playback-snapshot"
import type { RuntimeTrack } from "~/lib/timeline-runtime-types"
import { createDefaultGranularParams, createDefaultReverbParams, createDefaultSynthParams, externalAutomationParameterId, type AutomationEnvelope } from "@daw-browser/shared"
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

class LongStereoAudioBuffer implements AudioBuffer {
  readonly duration: number
  readonly length: number
  readonly numberOfChannels = 2
  readonly sampleRate: number
  private readonly channels: readonly Float32Array<ArrayBuffer>[]

  constructor(length: number, sampleRate = 48_000) {
    this.length = length
    this.sampleRate = sampleRate
    this.duration = length / this.sampleRate
    this.channels = [
      new Float32Array(new ArrayBuffer(length * Float32Array.BYTES_PER_ELEMENT)),
      new Float32Array(new ArrayBuffer(length * Float32Array.BYTES_PER_ELEMENT)),
    ]
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

  getChannelData(channel: number): Float32Array<ArrayBuffer> {
    const samples = this.channels[channel]
    if (!samples) throw new Error(`Missing channel ${channel}.`)
    return samples
  }
}

class MetadataAudioBuffer implements AudioBuffer {
  readonly duration = 60
  readonly length = 60 * 48_000
  readonly numberOfChannels = 2
  readonly sampleRate = 48_000
  copyFromChannel(destination: Float32Array) { destination.fill(0) }
  copyToChannel() {}
  getChannelData() { return new Float32Array(0) }
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
  const reenablePayloads: Uint8Array[] = []
  let remainingFailures = options.failureCount ?? 0
  let onAccept = options.onAccept
  let attempt = 0
  const progressListeners = new Set<(progress: NativeScheduleProgress) => void>()
  const lossListeners = new Set<() => void>()
  let progressUnsubscribeCount = 0
  let lossUnsubscribeCount = 0
  return {
    payloads,
    reenablePayloads,
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
      reenableVstScheduleAutomation: async (bytes: Uint8Array) => {
        reenablePayloads.push(bytes)
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

test("staged bank preserves exact held-note seam ownership and requires publication proof", async () => {
  const snapshot = snapshotFor(instrumentTrack)
  const { fixture, coordinator } = coordinatorFor(snapshot, 0, bridgeFor(), undefined, true)
  coordinator.install()
  await coordinator.prime(0)
  const seam = 48_128
  await coordinator.coverThrough(seam + 512)
  const next = { ...snapshot, revision: 2 }
  const staged = coordinator.stageRevision(next, nativeGraphFor(next), seam)
  await staged.prime(seam)
  const events = (payloads: readonly Uint8Array[]) => payloads.flatMap((payload) => {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const start = Number(view.getBigUint64(16, true))
    return Array.from({ length: view.getUint32(44, true) }, (_, index) => ({
      frame: start + view.getUint32(72 + index * 48 + 28, true),
      type: view.getUint32(72 + index * 48 + 32, true),
      note: view.getBigUint64(72 + index * 48 + 8, true),
    }))
  })
  const activePayloads = fixture.payloads.filter((bytes) => new DataView(bytes.buffer).getUint32(60, true) === 0)
  const stagedPayloads = fixture.payloads.filter((bytes) => new DataView(bytes.buffer).getUint32(60, true) === 2)
  expect(stagedPayloads.length).toBeGreaterThan(0)
  const seamEvents = [
    ...events(activePayloads).filter((event) => event.frame < seam),
    ...events(stagedPayloads),
  ]
  expect(seamEvents.map(({ frame, type }) => ({ frame, type }))).toEqual([
    { frame: 0, type: 1 }, { frame: 96_000, type: 2 },
  ])
  expect(seamEvents[0]?.note).toBe(seamEvents[1]?.note)
  for (const bytes of stagedPayloads) {
    const view = new DataView(bytes.buffer)
    expect(view.getUint32(4, true)).toBe(1)
    expect(view.getBigUint64(64, true)).toBe(BigInt(seam))
  }
  expect(staged.activateRevision({ status: "prepared", activeRevision: 1, publicationFrame: BigInt(seam) })).toBe(false)
  expect(staged.activateRevision({ status: "publish-pending", activeRevision: 1, publicationFrame: BigInt(seam) })).toBe(false)
  expect(staged.activateRevision({ status: "published", activeRevision: 2, publicationFrame: BigInt(seam + 1) })).toBe(false)
  expect(staged.activateRevision({ status: "published", activeRevision: 2, publicationFrame: BigInt(seam) })).toBe(true)
  coordinator.dispose()
  staged.install()
  fixture.emitProgress({ ...progressFor(2n), revision: 2, renderedThroughFrame: 120_000n })
  await staged.coverThrough(180_000)
  const last = fixture.payloads.at(-1)
  expect(last && new DataView(last.buffer).getUint32(60, true)).toBe(0)
  expect(last && new DataView(last.buffer).getUint32(4, true)).toBe(1)
  staged.dispose()
})

for (const { pitch, velocity } of [{ pitch: 60, velocity: 0.8 }, { pitch: 62, velocity: 0.8 }, { pitch: 60, velocity: 0.4 }]) test(`staged held pitch ${pitch} velocity ${velocity} reconciles sounding voice`, async () => {
  const snapshot = snapshotFor({ ...instrumentTrack, clips: instrumentTrack.clips.map((clip) => ({ ...clip,
    midi: clip.midi && { ...clip.midi, notes: clip.midi.notes.map((note) => ({ ...note, id: "held" })) },
  })) })
  const { fixture, coordinator } = coordinatorFor(snapshot, 0, bridgeFor(), undefined, true)
  await coordinator.prime(0)
  const edited = { ...snapshot, revision: 2, tracks: snapshot.tracks.map((track) => ({ ...track,
    clips: track.clips.map((clip) => ({ ...clip, midi: clip.midi && { ...clip.midi,
      notes: clip.midi.notes.map((note) => ({ ...note, pitch, velocity })) } })),
  })) }
  const staged = coordinator.stageRevision(edited, nativeGraphFor(edited), 48_128)
  await staged.prime(48_128)
  const events = fixture.payloads.filter((bytes) => new DataView(bytes.buffer).getUint32(60, true) === 2)
    .flatMap((bytes) => {
      const view = new DataView(bytes.buffer)
      return Array.from({ length: view.getUint32(44, true) }, (_, index) => ({
        offset: view.getUint32(72 + index * 48 + 28, true),
        type: view.getUint32(72 + index * 48 + 32, true),
        pitch: view.getUint32(72 + index * 48 + 40, true),
      }))
    }).filter((event) => event.offset === 0)
  expect(events).toEqual(pitch === 60 && velocity === 0.8 ? [] : [
    { offset: 0, type: 2, pitch: 60 }, { offset: 0, type: 1, pitch },
  ])
  staged.dispose()
  coordinator.dispose()
})

test("staged edit releases a deleted held MIDI note exactly at the seam", async () => {
  const snapshot = snapshotFor(instrumentTrack)
  const { fixture, coordinator } = coordinatorFor(snapshot, 0, bridgeFor(), undefined, true)
  await coordinator.prime(0)
  const edited = { ...snapshot, revision: 2, tracks: snapshot.tracks.map((track) => ({ ...track, clips: [] })) }
  const staged = coordinator.stageRevision(edited, nativeGraphFor(edited), 48_128)
  await staged.prime(48_128)
  const bytes = fixture.payloads.find((bytes) => new DataView(bytes.buffer).getUint32(60, true) === 2)
  if (!bytes) throw new Error("No staged payload")
  const view = new DataView(bytes.buffer)
  expect(view.getUint32(44, true)).toBe(1)
  expect(view.getUint32(72 + 32, true)).toBe(2)
  expect(view.getUint32(72 + 28, true)).toBe(0)
  expect(view.getBigUint64(72 + 8, true)).toBe(new DataView(fixture.payloads[0]!.buffer).getBigUint64(72 + 8, true))
  staged.dispose()
  coordinator.dispose()
})

test("discarding a staged bank leaves active accepted windows and refills intact", async () => {
  const snapshot = snapshotFor(instrumentTrack)
  const { fixture, coordinator } = coordinatorFor(snapshot, 0, bridgeFor(), undefined, true)
  coordinator.install()
  await coordinator.prime(0)
  const next = { ...snapshot, revision: 2 }
  const first = coordinator.stageRevision(next, nativeGraphFor(next), 48_128)
  await first.prime(48_128)
  const original = fixture.payloads.slice()
  first.dispose()
  const rebased = coordinator.stageRevision(next, nativeGraphFor(next), 49_152)
  await rebased.prime(49_152)
  expect(fixture.payloads.slice(0, original.length)).toEqual(original)
  const resent = fixture.payloads.slice(original.length)
  expect(resent.length).toBeGreaterThan(0)
  expect(Number(new DataView(resent[0]!.buffer).getBigUint64(16, true))).toBe(49_152)
  expect(new DataView(resent[0]!.buffer).getBigUint64(8, true)).toBe(1n)
  rebased.dispose()
  await coordinator.coverThrough(200_000)
  expect(new DataView(fixture.payloads.at(-1)!.buffer).getUint32(0, true)).toBe(1)
  expect(coordinator.isDisposed()).toBe(false)
  coordinator.dispose()
})

test("disposing staged work during a chunk ACK cannot submit its remaining chunks", async () => {
  const track = { ...instrumentTrack, clips: instrumentTrack.clips.map((clip) => ({
    ...clip, midi: { ...clip.midi!, notes: Array.from({ length: 300 }, (_, index) => ({
      pitch: 40 + index % 50, beat: 0.5, length: 1, velocity: 0.8,
    })) },
  })) }
  const snapshot = snapshotFor(track)
  const { fixture, coordinator } = coordinatorFor(snapshot, 0, bridgeFor(), undefined, true)
  await coordinator.prime(0)
  const staged = coordinator.stageRevision({ ...snapshot, revision: 2 },
    { ...nativeGraphFor(snapshot), revision: 2 }, 128)
  const before = fixture.payloads.length
  fixture.setOnAccept(() => staged.dispose())
  await expect(staged.prime(128)).rejects.toThrow()
  expect(fixture.payloads.length - before).toBe(1)
  expect(coordinator.isDisposed()).toBe(false)
  coordinator.dispose()
})

test("staged source hydration continues the retained cursor without a seam restart or hole", async () => {
  const track = { ...sourceTrack, clips: sourceTrack.clips.map((clip) => ({
    ...clip, duration: 4, buffer: new LongStereoAudioBuffer(192_000),
  })) }
  const snapshot = snapshotFor(track)
  const hydrated: number[] = []
  const { fixture, coordinator } = coordinatorFor(snapshot, 0, bridgeFor(), undefined, true, {
    ensureRanges: async (ranges) => { hydrated.push(...ranges.map((range) => range.startFrame)) },
    invalidateRanges: () => {},
  })
  await coordinator.prime(0)
  const staged = coordinator.stageRevision({ ...snapshot, revision: 2 },
    { ...nativeGraphFor(snapshot), revision: 2 }, 48_128)
  await staged.prime(48_128)
  const prepared = fixture.payloads.filter((bytes) => new DataView(bytes.buffer).getUint32(60, true) === 2)
  const active = fixture.payloads.filter((bytes) => new DataView(bytes.buffer).getUint32(60, true) === 0)
  expect(sourceEventsFrom(active).map(({ startFrame, stopFrame, sourceOffsetFrame }) => ({
    startFrame, stopFrame, sourceOffsetFrame,
  }))).toEqual([{ startFrame: 0, stopFrame: 96_000, sourceOffsetFrame: 0 }])
  expect(sourceEventsFrom(prepared).map(({ startFrame, stopFrame, sourceOffsetFrame }) => ({
    startFrame, stopFrame, sourceOffsetFrame,
  }))).toEqual([{ startFrame: 0, stopFrame: 144_128, sourceOffsetFrame: 0 }])
  expect(prepared.map((bytes) => Number(new DataView(bytes.buffer).getBigUint64(16, true)))).toEqual([48_128])
  expect(hydrated).toContain(48_128)
  staged.dispose()
  coordinator.dispose()
})

test("opt-in refill diagnostics aggregate progress and synchronous compilation per coordinator", async () => {
  const fixture = bridgeFor()
  const reports: Array<{ progressCount: number; compileCount: number; compileTotalMs: number; compileMaxMs: number }> = []
  const coordinator = createNativeScheduleCoordinator({
    bridge: fixture.bridge,
    snapshot: snapshotFor(instrumentTrack),
    epoch: 1,
    sampleRateHz: 48_000,
    capacity: { maximumFramesPerBlock: 128 },
    assets: [],
    startFrame: 0,
    onRefillDiagnostics: (snapshot) => reports.push(snapshot),
  })
  coordinator.install()
  await coordinator.prime(0)
  for (let index = 1; index <= 1000; index += 1) {
    fixture.emitProgress({ ...progressFor(BigInt(index)), renderedThroughFrame: 48_000n })
  }
  await Promise.resolve()
  await Promise.resolve()
  const snapshot = coordinator.refillDiagnostics()
  expect(snapshot.progressCount).toBe(1000)
  expect(snapshot.compileCount).toBeGreaterThan(0)
  expect(snapshot.compileTotalMs).toBeGreaterThanOrEqual(snapshot.compileMaxMs)
  expect(snapshot.compileMaxMs).toBeGreaterThanOrEqual(0)
  expect(reports.length).toBeLessThan(1000)
  expect(reports.at(-1)?.compileCount).toBeLessThanOrEqual(snapshot.compileCount)
  const other = createNativeScheduleCoordinator({
    bridge: bridgeFor().bridge,
    snapshot: snapshotFor(instrumentTrack),
    epoch: 1,
    sampleRateHz: 48_000,
    capacity: { maximumFramesPerBlock: 128 },
    assets: [],
    startFrame: 0,
  })
  expect(other.refillDiagnostics()).toEqual({
    progressCount: 0, compileCount: 0, compileTotalMs: 0, compileMaxMs: 0, submittedVstSegments: 0,
  })
  coordinator.dispose()
  other.dispose()
})

for (const edit of ["unchanged", "move", "trim", "delete", "tempo", "combined", "cancel", "remove-readd"]) {
  test(`source seam wire ${edit} preserves accepted origins and complete candidate ownership`, async () => {
    const track = { ...sourceTrack, clips: sourceTrack.clips.map((clip) => ({
      ...clip, duration: 4, bufferOffsetSec: 0.3 / 48_000, buffer: new LongStereoAudioBuffer(240_000),
    })) }
    const snapshot = snapshotFor(track)
    const { fixture, coordinator } = coordinatorFor(snapshot, 0, bridgeFor(), undefined, true)
    await coordinator.prime(0)
    const original = sourceEventsFrom(fixture.payloads)[0]!
    let next = { ...snapshot, revision: 2 }
    if (edit === "move" || edit === "trim" || edit === "combined") next = { ...next, tracks: [{
      ...track, clips: track.clips.map((clip) => ({ ...clip,
        startSec: edit === "trim" ? 0 : 0.25,
        bufferOffsetSec: edit === "move" ? clip.bufferOffsetSec : 0.25,
      })),
    }] }
    if (edit === "delete") next = { ...next, tracks: [{ ...track, clips: [] }] }
    if (edit === "remove-readd") next = { ...next, tracks: [] }
    if (edit === "tempo" || edit === "combined") next = { ...next, bpm: 130 }
    const staged = coordinator.stageRevision(next, nativeGraphFor(next), 48_128)
    await staged.prime(48_128)
    const declarations = sourceEventsFrom(fixture.payloads.filter((bytes) => new DataView(bytes.buffer).getUint32(60, true) === 2))
    if (edit === "delete" || edit === "remove-readd") expect(declarations).toEqual([])
    else {
      expect(declarations).toHaveLength(1)
      expect(declarations[0]?.sequence).toBeGreaterThan(original.sequence)
      expect(declarations[0]?.stopFrame).toBe(144_128)
      if (edit === "move" || edit === "trim" || edit === "combined") {
        expect(declarations[0]?.startFrame).toBe(48_128)
        expect(declarations[0]?.sourceOffsetFrame).not.toBe(original.sourceOffsetFrame)
      } else {
        expect(declarations[0]?.startFrame).toBe(original.startFrame)
        expect(declarations[0]?.sourceOffsetFrame).toBe(original.sourceOffsetFrame)
        expect(Object.is(declarations[0]?.sourceOffsetFraction, original.sourceOffsetFraction)).toBe(true)
      }
    }
    if (edit === "cancel") {
      staged.dispose()
      const rebased = coordinator.stageRevision({ ...snapshot, revision: 3 }, nativeGraphFor(snapshot), 49_152)
      await rebased.prime(49_152)
      expect(sourceEventsFrom(fixture.payloads.filter((bytes) => new DataView(bytes.buffer).getUint32(60, true) === 3))[0])
        .toMatchObject({ startFrame: original.startFrame, sourceOffsetFrame: original.sourceOffsetFrame,
          sourceOffsetFraction: original.sourceOffsetFraction })
      rebased.dispose()
    } else {
      expect(staged.activateRevision({ status: "prepared", activeRevision: 2, publicationFrame: 48_128n })).toBe(false)
      expect(staged.activateRevision({ status: "published", activeRevision: 2, publicationFrame: 48_128n })).toBe(true)
      const thirdSnapshot = { ...(edit === "remove-readd" ? snapshot : next), revision: 3 }
      const third = staged.stageRevision(thirdSnapshot, nativeGraphFor(thirdSnapshot), 60_000)
      await third.prime(60_000)
      const sources = sourceEventsFrom(fixture.payloads.filter((bytes) => new DataView(bytes.buffer).getUint32(60, true) === 3))
      if (edit === "remove-readd") expect(sources[0]?.startFrame).toBe(60_000)
      else if (edit !== "delete") {
        expect(sources[0]).toMatchObject({ startFrame: declarations[0]!.startFrame,
          sourceOffsetFrame: declarations[0]!.sourceOffsetFrame, sourceOffsetFraction: declarations[0]!.sourceOffsetFraction })
        third.dispose()
        const rebased = staged.stageRevision(thirdSnapshot, nativeGraphFor(thirdSnapshot), 61_440)
        await rebased.prime(61_440)
        const last = sourceEventsFrom(fixture.payloads.filter((bytes) =>
          new DataView(bytes.buffer).getBigUint64(64, true) === 61_440n))[0]
        expect(last).toMatchObject({ startFrame: declarations[0]!.startFrame,
          sourceOffsetFrame: declarations[0]!.sourceOffsetFrame, sourceOffsetFraction: declarations[0]!.sourceOffsetFraction })
        rebased.dispose()
      }
      third.dispose()
    }
    staged.dispose()
    coordinator.dispose()
  })
}

test("complete seam declarations sort by effective start, not accepted origin", async () => {
  const track = { ...sourceTrack, clips: sourceTrack.clips.map((clip) => ({
    ...clip, duration: 4, buffer: new LongStereoAudioBuffer(240_000),
  })) }
  const snapshot = snapshotForTracks([{ ...track, id: "later", clips: track.clips.map((clip) => ({ ...clip, id: "later-clip", startSec: 0.1 })) }, track])
  const { fixture, coordinator } = coordinatorFor(snapshot)
  await coordinator.prime(0)
  const next = { ...snapshot, revision: 2 }
  const staged = coordinator.stageRevision(next, nativeGraphFor(next), 48_128)
  await staged.prime(48_128)
  expect(sourceEventsFrom(fixture.payloads.filter((bytes) => new DataView(bytes.buffer).getUint32(60, true) === 2))
    .map(({ startFrame }) => startFrame)).toEqual([4_800, 0])
  staged.dispose()
  coordinator.dispose()
})

for (const assetRate of [44_100, 48_000, 96_000]) test(`accepted f32 origin at ${assetRate} survives two publications and a rebase`, async () => {
  const track = { ...sourceTrack, clips: sourceTrack.clips.map((clip) => ({
    ...clip, duration: 4, bufferOffsetSec: 0.3 / assetRate, buffer: new LongStereoAudioBuffer(assetRate * 5, assetRate),
  })) }
  const snapshot = snapshotFor(track, 0.25)
  const { fixture, coordinator } = coordinatorFor(snapshot)
  await coordinator.prime(12_000)
  const original = sourceEventsFrom(fixture.payloads)[0]!
  const origin = { startFrame: original.startFrame, sourceOffsetFrame: original.sourceOffsetFrame,
    sourceOffsetFraction: original.sourceOffsetFraction }
  let active = coordinator
  for (const revision of [2, 3, 4]) {
    const next = { ...snapshot, revision }
    const seam = 24_000 + revision * 512
    const staged = active.stageRevision(next, nativeGraphFor(next), seam)
    await staged.prime(seam)
    const sources = sourceEventsFrom(fixture.payloads.filter((bytes) => new DataView(bytes.buffer).getUint32(60, true) === revision))
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject(origin)
    expect(Object.is(sources[0]?.sourceOffsetFraction, original.sourceOffsetFraction)).toBe(true)
    if (revision === 4) staged.dispose()
    else {
      expect(staged.activateRevision({ status: "published", activeRevision: revision, publicationFrame: BigInt(seam) })).toBe(true)
      active.dispose()
      active = staged
    }
  }
  const rebased = active.stageRevision({ ...snapshot, revision: 4 }, nativeGraphFor(snapshot), 30_720)
  await rebased.prime(30_720)
  expect(sourceEventsFrom(fixture.payloads.filter((bytes) => new DataView(bytes.buffer).getBigUint64(64, true) === 30_720n))[0])
    .toMatchObject(origin)
  rebased.dispose()
  active.dispose()
})

test("new source origin carries a rounded f32 fraction into the integer offset", async () => {
  const track = { ...sourceTrack, clips: sourceTrack.clips.map((clip) => ({
    ...clip, duration: 4, bufferOffsetSec: 0.99999999 / 48_000, buffer: new LongStereoAudioBuffer(240_000),
  })) }
  const { fixture, coordinator } = coordinatorFor(snapshotFor(track))
  await coordinator.prime(0)
  expect(sourceEventsFrom(fixture.payloads)[0]).toMatchObject({ sourceOffsetFrame: 1, sourceOffsetFraction: 0 })
  coordinator.dispose()
})

test("preserved origins hydrate only the audible candidate horizon, not the entire accepted past", async () => {
  const track = { ...sourceTrack, clips: sourceTrack.clips.map((clip) => ({
    ...clip, duration: 4, buffer: new LongStereoAudioBuffer(240_000),
  })) }
  const snapshot = snapshotFor(track)
  const ranges: Array<{ sourceAssetKey: string; startFrame: number; endFrame: number }> = []
  const { coordinator } = coordinatorFor(snapshot, 0, bridgeFor(), undefined, true, {
    ensureRanges: async (entries) => { ranges.push(...entries) }, invalidateRanges: () => {},
  })
  await coordinator.prime(0)
  ranges.length = 0
  const staged = coordinator.stageRevision({ ...snapshot, revision: 2 }, nativeGraphFor(snapshot), 48_128)
  await staged.prime(48_128)
  expect(ranges).toEqual([{ sourceAssetKey: "source", startFrame: 48_128, endFrame: 144_129 }])
  staged.dispose()
  coordinator.dispose()
})

test("rounded fractional origins never declare samples beyond the immutable asset", async () => {
  const track = { ...sourceTrack, clips: sourceTrack.clips.map((clip) => ({
    ...clip, duration: 4, bufferOffsetSec: 0.99999999 / 48_000, buffer: new LongStereoAudioBuffer(192_000),
  })) }
  const { fixture, coordinator } = coordinatorFor(snapshotFor(track, 3))
  await coordinator.prime(144_000)
  const source = sourceEventsFrom(fixture.payloads)[0]!
  expect(source.sourceOffsetFrame + source.sourceFrameCount).toBeLessThanOrEqual(192_000)
  coordinator.dispose()
})

const instrumentEventsFrom = (payloads: readonly Uint8Array[]) => payloads.flatMap((payload) => {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const count = view.getUint32(44, true)
  const startFrame = Number(view.getBigUint64(16, true))
  return Array.from({ length: count }, (_, index) => {
    const offset = 72 + index * 48
    return {
      noteId: view.getBigUint64(offset + 8, true),
      frame: startFrame + view.getUint32(offset + 28, true),
      type: view.getUint32(offset + 32, true),
    }
  })
})

const sourceEventsFrom = (payloads: readonly Uint8Array[]) => payloads.flatMap((payload) => {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const count = view.getUint32(48, true)
  return Array.from({ length: count }, (_, index) => {
    const offset = 72 + view.getUint32(44, true) * 48 + index * 112
    return {
      assetId: view.getUint32(offset + 20, true),
      sequence: Number(view.getBigUint64(offset + 4, true)),
      startFrame: Number(view.getBigInt64(offset + 24, true)),
      stopFrame: Number(view.getBigInt64(offset + 32, true)),
      sourceOffsetFrame: Number(view.getBigUint64(offset + 40, true)),
      sourceFrameCount: Number(view.getBigUint64(offset + 48, true)),
      sourceOffsetFraction: view.getFloat32(offset + 92, true),
    }
  })
})

const processorEventsFrom = (payloads: readonly Uint8Array[]) => payloads.flatMap((payload) => {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const instrumentCount = view.getUint32(44, true)
  const sourceCount = view.getUint32(48, true)
  const processorCount = view.getUint32(56, true)
  const offset = 72 + instrumentCount * 48 + sourceCount * 112
  return Array.from({ length: processorCount }, (_, index) => {
    const eventOffset = offset + index * 40
    return {
      processorInstanceId: Number(view.getBigUint64(eventOffset, true)),
      parameterTarget: view.getUint32(eventOffset + 8, true),
      frame: Number(view.getBigUint64(eventOffset + 16, true)),
      value: view.getFloat32(eventOffset + 32, true),
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
  pageManager?: Parameters<typeof createNativeScheduleCoordinator>[0]["pageManager"],
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
      assets: snapshot.assets.map((asset, index) => {
        if (!asset.buffer) throw new Error("Expected hydrated test asset.")
        return {
          asset: {
            version: audioCoreContractVersion,
            assetId: `portable-export:${asset.assetId}`,
            frameCount: asset.buffer.length,
            sampleRateHz: asset.buffer.sampleRate,
            channelCount: asset.buffer.numberOfChannels,
          },
          sessionAssetId: index + 1,
        }
      }),
      assetSourceKeys: new Map(snapshot.assets.map((asset) => [
        `portable-export:${asset.assetId}`,
        asset.assetId,
      ])),
      startFrame: Math.round(snapshot.transport.playheadSec * 48_000),
      onHostLoss,
      pageManager,
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

test("refills 30 overlapping native source clips only below the one-second threshold", async () => {
  const buffer = new MetadataAudioBuffer()
  const tracks: RuntimeTrack[] = Array.from({ length: 30 }, (_, index) => ({
    id: `audio-${index}`,
    name: `Audio ${index}`,
    volume: 1,
    clips: [{
      id: `clip-${index}`,
      name: `Clip ${index}`,
      color: "#fff",
      startSec: 0,
      duration: 60,
      sourceAssetKey: `source-${index}`,
      buffer,
    }],
  }))
  const snapshot = snapshotForTracks(tracks)
  const fixture = bridgeFor()
  const coordinator = createNativeScheduleCoordinator({
    bridge: fixture.bridge,
    snapshot,
    graph: nativeGraphFor(snapshot),
    epoch: 1,
    sampleRateHz: 48_000,
    capacity: { maximumFramesPerBlock: 4_096 },
    assets: snapshot.assets.map((asset, index) => ({
      asset: {
        version: audioCoreContractVersion,
        assetId: `portable-export:${asset.assetId}`,
        frameCount: buffer.length,
        sampleRateHz: buffer.sampleRate,
        channelCount: buffer.numberOfChannels,
      },
      sessionAssetId: index + 1,
    })),
    assetSourceKeys: new Map(snapshot.assets.map((asset) => [
      `portable-export:${asset.assetId}`,
      asset.assetId,
    ])),
    startFrame: 0,
  })

  await coordinator.prime(0)
  expect(fixture.payloads).toHaveLength(1)
  expect(sourceEventsFrom(fixture.payloads)).toHaveLength(30)

  coordinator.onProgress({
    ...progressFor(1n),
    renderedThroughFrame: 4_096n,
    acceptedThroughFrame: 96_000n,
  })
  coordinator.onProgress({
    ...progressFor(2n),
    renderedThroughFrame: 48_000n,
    acceptedThroughFrame: 96_000n,
  })
  await Bun.sleep(0)
  expect(fixture.payloads).toHaveLength(1)

  coordinator.onProgress({
    ...progressFor(3n),
    renderedThroughFrame: 49_152n,
    acceptedThroughFrame: 96_000n,
  })
  await Bun.sleep(0)
  await Bun.sleep(0)

  expect(fixture.payloads).toHaveLength(2)
  const refillWindow = new DataView(fixture.payloads[1]!.buffer)
  expect(refillWindow.getBigUint64(16, true)).toBe(96_000n)
  expect(refillWindow.getBigUint64(24, true)).toBe(145_152n)
  const events = sourceEventsFrom(fixture.payloads)
  expect(events).toHaveLength(60)
  expect(events.slice(0, 30).every((event) => event.startFrame === 0)).toBeTrue()
  expect(events.slice(30).every((event) => event.startFrame === 96_000)).toBeTrue()
})

test("hydrates mapped source ranges before queueing a schedule window", async () => {
  const order: string[] = []
  const fixture = bridgeFor()
  fixture.setOnAccept(() => order.push("queue"))
  const pageManager = {
    ensureRanges: async () => { order.push("hydrate") },
    invalidateRanges: () => {},
    dispose: () => {},
  }
  const { coordinator } = coordinatorFor(snapshotFor(sourceTrack), 0, fixture, undefined, false, pageManager)

  await coordinator.prime(0)

  expect(order.slice(0, 2)).toEqual(["hydrate", "queue"])
})

test("schedules a later native PCM chunk and preserves its seam", async () => {
  const frameCount = 12 * 48_000
  const track: RuntimeTrack = {
    ...sourceTrack,
    clips: [{
      ...sourceTrack.clips[0]!,
      duration: frameCount / 48_000,
      buffer: new LongStereoAudioBuffer(frameCount),
    }],
  }
  const snapshot = snapshotFor(track)
  const projection = compileLiveNativeProjection({
    tracks: snapshot.tracks,
    bpm: snapshot.bpm,
    sampleRateHz: 48_000,
    revision: snapshot.revision,
    epoch: 1,
    firstSequence: 1,
    fx: snapshot.mixer.fx,
  })
  if (!projection.supported) throw new Error(projection.reasons.join(" "))
  const fixture = bridgeFor()
  const coordinator = createNativeScheduleCoordinator({
    bridge: fixture.bridge,
    snapshot,
    graph: projection.graph,
    epoch: 1,
    sampleRateHz: 48_000,
    capacity: { maximumFramesPerBlock: 512 },
    assets: projection.assets.map((entry, index) => ({
      asset: entry.asset,
      sessionAssetId: index + 1,
    })),
    nativePcmChunkDescriptors: projection.nativePcmChunkDescriptors,
    startFrame: 130_000,
  })
  await coordinator.prime(130_000)
  const events = sourceEventsFrom(fixture.payloads)
  expect(events).toHaveLength(1)
  expect(new Set(events.map((event) => event.assetId)).size).toBe(1)
  expect(events[0]?.sourceOffsetFrame).toBeGreaterThan(0)
  expect(events[0]?.sourceOffsetFraction).toBe(0)
})

test("sorts source events after opposite track traversal and active volume automation", async () => {
  const earlyTrack: RuntimeTrack = {
    ...sourceTrack,
    id: "early",
    clips: [{ ...sourceTrack.clips[0]!, id: "early-clip", sourceAssetKey: "early-asset", startSec: 0 }],
  }
  const lateTrack: RuntimeTrack = {
    ...sourceTrack,
    id: "late",
    clips: [{ ...sourceTrack.clips[0]!, id: "late-clip", sourceAssetKey: "late-asset", startSec: 1 }],
  }
  const base = snapshotForTracks([lateTrack, earlyTrack])
  const snapshot = {
    ...base,
    mixer: {
      ...base.mixer,
      automationEnvelopes: [{
        id: "early-volume",
        projectId: "project:1",
        target: { kind: "track" as const, trackId: "early" },
        targetKey: "early-volume",
        parameterId: "volume",
        enabled: true,
        points: [{ id: "volume", timeSec: 0, value: 0.5, interpolation: "hold" as const }],
        updatedAt: 1,
      }],
    },
  }
  const { fixture, coordinator } = coordinatorFor(snapshot)
  await coordinator.prime(0)
  const events = sourceEventsFrom(fixture.payloads)
  expect(events.map((event) => event.startFrame)).toEqual([0, 48_000])
  expect(events.map((event) => event.sequence)).toEqual(
    [...events].sort((left, right) => left.startFrame - right.startFrame || left.sequence - right.sequence)
      .map((event) => event.sequence),
  )
  expect(new Set(events.map((event) => event.sequence)).size).toBe(events.length)
  expect(processorEventsFrom(fixture.payloads)).toMatchObject([
    { parameterTarget: 26, frame: 0, value: 0.5 },
  ])
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
    renderedThroughFrame: 49_152n,
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
    coordinator.onProgress({ ...progressFor(sequence), renderedThroughFrame: 49_152n })
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
    renderedThroughFrame: 49_152n,
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
    renderedThroughFrame: 49_152n,
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
  expect(view.getUint32(72 + 28, true)).toBe(0)
  expect(view.getUint32(72 + 32, true)).toBe(2)
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
    renderedThroughFrame: 49_152n,
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
  expect(view.getUint32(72 + 28, true)).toBe(0)
  expect(view.getUint32(72 + 32, true)).toBe(2)
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

test("schedules a chord beyond explicit polyphony for native voice stealing", async () => {
  const track: RuntimeTrack = {
    ...instrumentTrack,
    clips: [{
      ...instrumentTrack.clips[0]!,
      duration: 3,
      midi: {
        wave: "sawtooth",
        notes: [
          { pitch: 60, beat: 0, length: 4, velocity: 0.8 },
          { pitch: 64, beat: 0, length: 4, velocity: 0.8 },
          { pitch: 67, beat: 0, length: 4, velocity: 0.8 },
        ],
      },
    }],
  }
  const snapshot = snapshotFor(track, 0, { ...createDefaultSynthParams(), polyphony: 2 })
  const graph = nativeGraphFor(snapshot)
  expect(graph.nodes.find((node) => node.id === "instrument")?.instrument?.voiceCapacity).toBe(2)
  const { fixture, coordinator } = coordinatorFor(snapshot)
  expect(() => coordinator.preflight(graph)).not.toThrow()
  await coordinator.prime(0)
  expect(instrumentEventsFrom(fixture.payloads).filter((event) => event.type === 1)).toHaveLength(3)
})

test("schedules 33 held notes on a two-voice stealing synth", async () => {
  const track: RuntimeTrack = {
    ...instrumentTrack,
    clips: [{
      ...instrumentTrack.clips[0]!,
      duration: 3,
      midi: {
        wave: "sawtooth",
        notes: Array.from({ length: 33 }, (_, index) => ({
          pitch: 36 + (index % 48),
          beat: 0,
          length: 4,
          velocity: 0.8,
        })),
      },
    }],
  }
  const snapshot = snapshotFor(track, 0, { ...createDefaultSynthParams(), polyphony: 2 })
  const { fixture, coordinator } = coordinatorFor(snapshot)
  expect(() => coordinator.preflight(nativeGraphFor(snapshot))).not.toThrow()
  await coordinator.prime(0)
  expect(instrumentEventsFrom(fixture.payloads).filter((event) => event.type === 1)).toHaveLength(33)
})
test("preflights more than 32 simultaneous granular notes", () => {
  const notes = Array.from({ length: 33 }, (_, index) => ({
    pitch: 36 + index,
    beat: 0,
    length: 4,
    velocity: 0.8,
  }))
  const track: RuntimeTrack = {
    ...instrumentTrack,
    clips: [{ ...instrumentTrack.clips[0]!, duration: 3, midi: { wave: "sawtooth", notes } }],
  }
  const base = snapshotFor(track)
  const snapshot: LivePlaybackSnapshot = {
    ...base,
    mixer: {
      ...base.mixer,
      fx: {
        ...base.mixer.fx,
        trackFx: {
          ...base.mixer.fx.trackFx,
          [track.id]: {
            instances: [],
            instrument: {
              kind: "granular",
              instanceId: "granular:instrument",
              params: createDefaultGranularParams(),
            },
          },
        },
      },
    },
  }
  expect(() => coordinatorFor(snapshot).coordinator.preflight(nativeGraphFor(snapshot))).not.toThrow()
})

test("allows stealing built-in notes beyond the initial lookahead", () => {
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
  const snapshot = snapshotFor(track, 0, { ...createDefaultSynthParams(), polyphony: 2 })
  const { coordinator } = coordinatorFor(snapshot, 0, undefined, undefined, true)
  expect(() => coordinator.preflight(nativeGraphFor(snapshot))).not.toThrow()
})

// Keep every gate: initial synth state, later callbacks, source slots, native
// processor slots, VST combined MIDI/automation, and invalid device capacity.
test("preflight rejects native instrument capacity including initialization", () => {
  const tracks = Array.from({ length: 9 }, (_, index): RuntimeTrack => ({
    ...instrumentTrack, id: `instrument-${index}`,
    clips: [{
      ...instrumentTrack.clips[0]!, id: `midi-${index}`,
      midi: { wave: "sawtooth", notes: Array.from({ length: 22 }, (_, pitch) => ({ pitch, beat: 0, length: 1 })) },
    }],
  }))
  const snapshot = snapshotForTracks(tracks)
  expect(() => coordinatorFor(snapshot).coordinator.preflight(nativeGraphFor(snapshot))).toThrow(/270 instrument events/)
})

test("preflight rejects source capacity without queuing native data", () => {
  const snapshot = snapshotForTracks(Array.from({ length: 257 }, (_, index) => ({
    ...sourceTrack, id: `audio-${index}`,
    clips: [{ ...sourceTrack.clips[0]!, id: `clip-${index}` }],
  })))
  const { fixture, coordinator } = coordinatorFor(snapshot)
  expect(() => coordinator.preflight(nativeGraphFor(snapshot))).toThrow(/257 source events/)
  expect(fixture.payloads).toHaveLength(0)
})

test("preflight rejects native processor capacity at later hold callbacks", () => {
  const base = snapshotForTracks(Array.from({ length: 257 }, (_, index) => ({
    ...sourceTrack, id: `audio-${index}`, clips: [],
  })))
  const snapshot = {
    ...base,
    mixer: {
      ...base.mixer,
      automationEnvelopes: base.tracks.map<AutomationEnvelope>((track, index) => ({
        id: `volume-${index}`, projectId: "project", targetKey: track.id,
        target: { kind: "track", trackId: track.id }, parameterId: "volume", enabled: true, updatedAt: 1,
        points: [{ id: "hold", timeSec: 4, value: 0.5, interpolation: "hold" }],
      })),
    },
  }
  // Start after initialization so this specifically exercises processor slots.
  const seek = { ...snapshot, transport: { ...snapshot.transport, playheadSec: 1 } }
  expect(() => coordinatorFor(seek).coordinator.preflight(nativeGraphFor(seek))).toThrow(/257 processor events/)
})

test("preflight rejects combined VST MIDI and automation capacity", () => {
  const base = automationSnapshot([{ id: "hold", timeSec: 0, value: 0.5, interpolation: "hold" }])
  const snapshot = {
    ...base,
    nativeExternalAttachmentPlan: {
      ...attachmentPlan,
      attachments: attachmentPlan.attachments.map((attachment) => ({
        ...attachment, workerTransport: { ...attachment.workerTransport, maximumEventsPerBlock: 1 },
      })),
    },
  }
  expect(() => coordinatorFor(snapshot).coordinator.preflight(nativeGraphFor(snapshot))).toThrow(/combines 1 MIDI and 1 automation/)
})

test("preflight rejects invalid callback sizes", () => {
  const snapshot = snapshotFor(instrumentTrack)
  for (const blockSize of [0, -1, 0.5, NaN]) {
    const coordinator = createNativeScheduleCoordinator({
      bridge: bridgeFor().bridge, snapshot, epoch: 1, sampleRateHz: 48_000,
      assets: [], startFrame: 0, capacity: { maximumFramesPerBlock: blockSize },
    })
    expect(() => coordinator.preflight(nativeGraphFor(snapshot))).toThrow(/block size is invalid/)
  }
})

test("publishes a spanning note-on and later note-off in one logical window", async () => {
  const { fixture, coordinator } = coordinatorFor(snapshotFor(instrumentTrack, 1), 0)
  await coordinator.prime(48_000)
  const payload = fixture.payloads[0]
  expect(payload).toBeDefined()
  if (!payload) return
  const view = new DataView(payload.buffer)
  expect(view.getUint32(44, true)).toBe(2)
  expect(view.getUint32(72 + 28, true)).toBe(0)
  expect(view.getUint32(72 + 48 + 28, true)).toBe(48_000)
  expect(view.getUint32(72 + 32, true)).not.toBe(view.getUint32(72 + 48 + 32, true))
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

test("counts accepted VST schedule segments separately from native worker acceptance", async () => {
  const snapshot = automationSnapshot([{ id: "start", timeSec: 0, value: 0.5, interpolation: "hold" }])
  const { coordinator } = coordinatorFor(snapshot)
  expect(coordinator.refillDiagnostics().submittedVstSegments).toBe(0)
  await coordinator.prime(0)
  expect(coordinator.refillDiagnostics().submittedVstSegments).toBeGreaterThan(0)
})

test("projects track and master volume automation into native processor events", async () => {
  const base = snapshotFor(sourceTrack)
  const snapshot = {
    ...base,
    mixer: {
      ...base.mixer,
      automationEnvelopes: [
        {
          id: "track-volume",
          projectId: "project:1",
          target: { kind: "track" as const, trackId: sourceTrack.id },
          targetKey: "track-volume",
          parameterId: "volume",
          enabled: true,
          points: [{ id: "track-volume", timeSec: 0, value: 0.5, interpolation: "hold" as const }],
          updatedAt: 1,
        },
        {
          id: "master-volume",
          projectId: "project:1",
          target: { kind: "master" as const },
          targetKey: "master-volume",
          parameterId: "volume",
          enabled: true,
          points: [{ id: "master-volume", timeSec: 0, value: 0.75, interpolation: "hold" as const }],
          updatedAt: 1,
        },
      ],
    },
  }
  const { fixture, coordinator } = coordinatorFor(snapshot)
  await coordinator.prime(0)
  expect(processorEventsFrom(fixture.payloads)).toMatchObject([
    { parameterTarget: 26, frame: 0, value: 0.5 },
    { parameterTarget: 26, frame: 0, value: 0.75 },
  ])
})

test("converts native volume ramps into callback-safe processor events", async () => {
  const longTrack: RuntimeTrack = {
    ...sourceTrack,
    clips: [{
      ...sourceTrack.clips[0]!,
      duration: 1024 / 48_000,
      buffer: new LongStereoAudioBuffer(1024),
    }],
  }
  const base = snapshotFor(longTrack)
  const snapshot = {
    ...base,
    mixer: {
      ...base.mixer,
      automationEnvelopes: [{
        id: "track-volume-ramp",
        projectId: "project:1",
        target: { kind: "track" as const, trackId: longTrack.id },
        targetKey: "track-volume-ramp",
        parameterId: "volume",
        enabled: true,
        points: [
          { id: "start", timeSec: 0, value: 0.5, interpolation: "linear" as const },
          { id: "end", timeSec: 12 / 48_000, value: 1, interpolation: "hold" as const },
        ],
        updatedAt: 1,
      }],
    },
  }
  const { fixture, coordinator } = coordinatorFor(snapshot)
  await coordinator.prime(0)
  // A 12-frame ramp takes a value per frame, then lands on its end value.
  expect(processorEventsFrom(fixture.payloads)).toMatchObject([
    ...Array.from({ length: 12 }, (_, frame) => ({ parameterTarget: 26, frame, value: Math.fround(0.5 + 0.5 * (frame / 12)) })),
    { parameterTarget: 26, frame: 12, value: 1 },
  ])
})

test("holds a native volume ramp at the smallest stride that keeps each callback inside the processor event cap", async () => {
  const rampFrames = 2_400
  const longTrack: RuntimeTrack = {
    ...sourceTrack,
    clips: [{
      ...sourceTrack.clips[0]!,
      duration: 2 * rampFrames / 48_000,
      buffer: new LongStereoAudioBuffer(2 * rampFrames),
    }],
  }
  const base = snapshotFor(longTrack)
  const snapshot = {
    ...base,
    mixer: {
      ...base.mixer,
      automationEnvelopes: [{
        id: "track-volume-fade",
        projectId: "project:1",
        target: { kind: "track" as const, trackId: longTrack.id },
        targetKey: "track-volume-fade",
        parameterId: "volume",
        enabled: true,
        points: [
          { id: "start", timeSec: 0, value: 0, interpolation: "linear" as const },
          { id: "end", timeSec: rampFrames / 48_000, value: 1, interpolation: "hold" as const },
        ],
        updatedAt: 1,
      }],
    },
  }
  const { fixture, coordinator } = coordinatorFor(snapshot)
  await coordinator.prime(0)
  const events = processorEventsFrom(fixture.payloads).filter((event) => event.frame <= rampFrames)
  const eventsPerBlock = Map.groupBy(events, (event) => Math.floor(event.frame / 512))
  // One ramp fills a 512-frame callback with 128 values (stride 4); the cap leaves 224 for ramps.
  expect(Math.max(...[...eventsPerBlock.values()].map((block) => block.length))).toBeLessThanOrEqual(224)
  const held = new Map(events.map((event) => [event.frame, event.value]))
  let value = 0
  const gain = Array.from({ length: rampFrames }, (_, frame) => {
    value = held.get(frame) ?? value
    return value
  })
  const stride = 4
  const idealStep = 1 / rampFrames
  const largestStep = Math.max(...gain.slice(1).map((sample, index) => Math.abs(sample - gain[index]!)))
  const rmsError = Math.sqrt(gain.reduce((sum, sample, frame) => sum + (sample - frame / rampFrames) ** 2, 0) / rampFrames)
  const rmsGain = Math.sqrt(gain.reduce((sum, sample) => sum + sample ** 2, 0) / rampFrames)
  expect([
    largestStep <= stride * idealStep * 1.001,
    // Holding each value for a stride lags the ideal by (stride - 1) / 2 steps, so the error sits near -57 dB.
    20 * Math.log10(rmsGain / rmsError) >= 55,
    held.get(rampFrames),
  ]).toEqual([true, true, 1])
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

test("reenables VST automation while native transport remains running", async () => {
  const snapshot = automationSnapshot([
    { id: "start", timeSec: 0, value: 0.5, interpolation: "hold" },
  ])
  const { fixture, coordinator } = coordinatorFor(snapshot)
  coordinator.install()
  fixture.emitProgress(progressFor(1n))
  const scheduleWindowCount = fixture.payloads.length

  await expect(coordinator.reenableAutomation(
    attachmentPlan.attachments[0]!.instanceId,
    [7],
  )).resolves.toBeUndefined()

  expect(fixture.reenablePayloads).toHaveLength(1)
  expect(fixture.payloads).toHaveLength(scheduleWindowCount)
  expect(fixture.reenablePayloads[0]?.byteLength).toBeGreaterThan(8)
  coordinator.dispose()
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
