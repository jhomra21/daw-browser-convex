import { expect, test } from "bun:test"
import { audioCoreContractVersion, type AudioAssetRef, type AudioCoreGraphSnapshot } from "../../audio-core-contract/src/index"
import { graphEnvelope } from "../../../public/audio-worklets/daw-portable-graph-envelope-v3.js"
import { encodePortableGraphEnvelope, mapNativeSessionAssets, serializeNativeGraph, serializeNativeInstrumentEvents, serializeNativeScheduleWindow, serializeNativeSourceEvents, serializeNativeVstParameterEvents } from "./native-host-wire"

const asset = (assetId: string, frameCount = 480): AudioAssetRef => ({
  version: audioCoreContractVersion,
  assetId,
  frameCount,
  sampleRateHz: 48_000,
  channelCount: 2,
})

test("maps unique portable assets into deterministic session-local uint32 identifiers", () => {
  const mapped = mapNativeSessionAssets([asset("z"), asset("a"), asset("z")])

  expect(mapped).toEqual([
    { asset: asset("a"), sessionAssetId: 1 },
    { asset: asset("z"), sessionAssetId: 2 },
  ])
})

test("serializes source events using the session asset identifier", () => {
  const bytes = serializeNativeSourceEvents([{
    epoch: 1,
    sequence: 2,
    sourceNodeId: "source",
    assetId: "a",
    startFrame: 3,
    stopFrame: 4,
    sourceOffsetFrame: 5,
    sourceFrameCount: 6,
    gain: 0.5,
    fadeInStartFrame: 7,
    fadeInEndFrame: 8,
    fadeOutStartFrame: 9,
    fadeOutEndFrame: 10,
  }], mapNativeSessionAssets([asset("a")]))
  const view = new DataView(bytes.buffer)

  expect(bytes.byteLength).toBe(96)
  expect(view.getUint32(0, true)).toBe(1)
  expect(view.getUint32(24, true)).toBe(1)
  expect(view.getBigInt64(28, true)).toBe(3n)
})

test("serializes bounded native VST parameter events with normalized values", () => {
  const bytes = serializeNativeVstParameterEvents("instance", [
    { id: 17, sampleOffset: 3, value: 0.75 },
  ])
  const view = new DataView(bytes.buffer)
  expect(view.getUint32(0, true)).toBe(8)
  expect(new TextDecoder().decode(bytes.slice(4, 12))).toBe("instance")
  expect(view.getUint32(12, true)).toBe(1)
  expect(view.getUint32(16, true)).toBe(17)
  expect(view.getUint32(20, true)).toBe(3)
  expect(view.getFloat64(24, true)).toBe(0.75)
  const highBytes = serializeNativeVstParameterEvents("instance", [
    { id: 0x8000_0000, sampleOffset: 0, value: 0.25 },
    { id: 0xffff_ffff, sampleOffset: 0, value: 0.5 },
  ])
  const highView = new DataView(highBytes.buffer)
  expect(highView.getUint32(16, true)).toBe(0x8000_0000)
  expect(highView.getUint32(32, true)).toBe(0xffff_ffff)
  expect(() => serializeNativeVstParameterEvents("instance", [
    { id: 0x1_0000_0000, sampleOffset: 0, value: 0.5 },
  ])).toThrow()
})

test("serializes native instrument events with absolute transport frames", () => {
  const bytes = serializeNativeInstrumentEvents(3, [{
    nodeId: "track",
    noteId: 4,
    sequence: 9,
    frameOffset: 48_000,
    type: "note-on",
    channel: 0,
    note: 60,
    value: 0.75,
  }])
  const view = new DataView(bytes.buffer)
  expect(view.getUint32(0, true)).toBe(1)
  expect(view.getBigUint64(12, true)).toBe(4n)
  expect(view.getUint32(32, true)).toBe(48_000)
  expect(() => serializeNativeInstrumentEvents(1, [{
    nodeId: "track",
    noteId: 1,
    sequence: 1,
    frameOffset: 0x1_0000_0000,
    type: "note-on",
    channel: 0,
    note: 60,
    value: 1,
  }])).toThrow()
})

test("serializes bounded native schedule ownership events", () => {
  const bytes = serializeNativeScheduleWindow({
    revision: 4,
    epoch: 2,
    startFrame: 100,
    endFrame: 200,
    windowId: 9,
    instrumentEvents: [{
      nodeId: "track",
      noteId: 1,
      sequence: 1,
      frameOffset: 120,
      type: "all-sound-off",
      channel: 0,
      note: 0,
      value: 0,
    }],
  })
  const view = new DataView(bytes.buffer)
  expect(bytes.byteLength).toBe(104)
  expect(view.getUint32(0, true)).toBe(4)
  expect(view.getUint32(40, true)).toBe(1)
  expect(view.getUint32(56 + 32, true)).toBe(104)
  expect(() => serializeNativeScheduleWindow({
    revision: 4, epoch: 2, startFrame: 100, endFrame: 200, windowId: 9,
    instrumentEvents: [{ nodeId: "track", noteId: 1, sequence: 1, frameOffset: 200, type: "live-note-off", channel: 0, note: 60, value: 0 }],
  })).toThrow()
})

test("prefixes each native graph envelope with a big-endian revision and payload length", () => {
  const snapshot: AudioCoreGraphSnapshot = {
    version: audioCoreContractVersion,
    revision: 7,
    contractHash: "contract",
    masterNodeId: "master",
    assets: [],
    nodes: [
      { id: "source", kind: "source", inputLayout: "stereo", outputLayout: "stereo", processorOrder: [], latencyFrames: 0 },
      { id: "master", kind: "master", inputLayout: "stereo", outputLayout: "stereo", processorOrder: [], latencyFrames: 0 },
    ],
    edges: [{
      version: audioCoreContractVersion,
      id: "source-master",
      fromNodeId: "source",
      toNodeId: "master",
      gain: 1,
      kind: "output",
      tap: "post-fader",
      sidechain: false,
      pdcDelayFrames: 0,
    }],
  }
  const bytes = serializeNativeGraph(snapshot)
  const view = new DataView(bytes.buffer)

  expect(view.getBigUint64(0, false)).toBe(7n)
  expect(view.getUint32(8, false)).toBe(bytes.byteLength - 12)
  expect(view.getUint32(12, true)).toBe(3)
})

test("serializes external native latency separately from built-in node latency", () => {
  const snapshot: AudioCoreGraphSnapshot = {
    version: audioCoreContractVersion,
    revision: 8,
    contractHash: "contract",
    masterNodeId: "master",
    assets: [],
    nodes: [
      {
        id: "source",
        kind: "source",
        inputLayout: "stereo",
        outputLayout: "stereo",
        processorOrder: [],
        latencyFrames: 7,
        externalLatencyFrames: 512,
      },
      {
        id: "master",
        kind: "master",
        inputLayout: "stereo",
        outputLayout: "stereo",
        processorOrder: [],
        latencyFrames: 0,
      },
    ],
    edges: [{
      version: audioCoreContractVersion,
      id: "source-master",
      fromNodeId: "source",
      toNodeId: "master",
      gain: 1,
      kind: "output",
      tap: "post-fader",
      sidechain: false,
      pdcDelayFrames: 0,
    }],
  }
  const bytes = serializeNativeGraph(snapshot)
  const view = new DataView(bytes.buffer)

  expect(view.getUint32(12, true)).toBe(4)
  expect(view.getUint32(12 + 24 + 24, true)).toBe(7)
  expect(view.getUint32(12 + 24 + 28, true)).toBe(512)
})

test("keeps the browser worklet graph envelope byte-for-byte equal to the native encoder", () => {
  const snapshot: AudioCoreGraphSnapshot = {
    version: audioCoreContractVersion,
    revision: 3,
    contractHash: "contract",
    masterNodeId: "master",
    assets: [],
    nodes: [
      {
        id: "source",
        kind: "source",
        inputLayout: "stereo",
        outputLayout: "stereo",
        processorOrder: [],
        latencyFrames: 0,
      },
      {
        id: "master",
        kind: "master",
        inputLayout: "stereo",
        outputLayout: "stereo",
        processorOrder: [],
        latencyFrames: 0,
      },
    ],
    edges: [{
      version: audioCoreContractVersion,
      id: "source-master",
      fromNodeId: "source",
      toNodeId: "master",
      gain: 0.75,
      kind: "output",
      tap: "post-fader",
      sidechain: false,
      pdcDelayFrames: 2,
    }],
  }
  expect([...graphEnvelope(snapshot)]).toEqual([...encodePortableGraphEnvelope(snapshot)])
})
