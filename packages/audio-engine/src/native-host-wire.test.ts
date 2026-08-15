import { expect, test } from "bun:test"
import { audioCoreContractVersion, type AudioAssetRef, type AudioCoreGraphSnapshot } from "../../audio-core-contract/src/index"
import { graphEnvelope } from "../../../public/audio-worklets/daw-portable-graph-envelope-v3.js"
import { encodePortableGraphEnvelope, mapNativeSessionAssets, serializeNativeGraph, serializeNativeInstrumentEvents, serializeNativeInstrumentStates, serializeNativeProcessorEvents, serializeNativeProcessorStatePatch, serializeNativeScheduleWindow, serializeNativeSourceEvents, serializeNativeSpectrumSelection, serializeNativeVstParameterEvents } from "./native-host-wire"

const asset = (assetId: string, frameCount = 480): AudioAssetRef => ({
  version: audioCoreContractVersion,
  assetId,
  frameCount,
  sampleRateHz: 48_000,
  channelCount: 2,
})

test("serializes native spectrum selection in the host protocol byte order", () => {
  expect([...serializeNativeSpectrumSelection(0x0123_4567_89ab_cdefn)]).toEqual([
    0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
  ])
  expect([...serializeNativeSpectrumSelection(null)]).toEqual([
    0, 0, 0, 0, 0, 0, 0, 0,
  ])
})

test("serializes bounded same-core processor state patches", () => {
  const bytes = serializeNativeProcessorStatePatch({
    graphRevision: 7,
    nodeId: "master",
    instanceId: 11,
    kindId: 12,
    stateVersion: audioCoreContractVersion,
    state: Uint8Array.of(1, 2, 3, 4),
    bypassed: false,
    inputLayout: "stereo",
    outputLayout: "stereo",
    parameterTargets: [101, 102],
    latencyFrames: 0,
    tailFrames: 99,
  })
  const view = new DataView(bytes.buffer)
  expect(bytes.byteLength).toBe(68)
  expect(view.getUint32(0, true)).toBe(1)
  expect(view.getUint32(4, true)).toBe(7)
  expect(view.getUint32(16, true)).toBe(11)
  expect(view.getUint32(28, true)).toBe(4)
  expect(Array.from(bytes.slice(56, 60))).toEqual([1, 2, 3, 4])
  expect(view.getUint32(60, true)).toBe(101)
  expect(view.getUint32(64, true)).toBe(102)
  expect(() => serializeNativeProcessorStatePatch({
    graphRevision: 7,
    nodeId: "master",
    instanceId: 11,
    kindId: 12,
    stateVersion: audioCoreContractVersion,
    state: new Uint8Array(257),
    bypassed: false,
    inputLayout: "stereo",
    outputLayout: "stereo",
    parameterTargets: [],
    latencyFrames: 0,
    tailFrames: 0,
  })).toThrow()
})

test("serializes native processor batches with revision, epoch, and sequence identity", () => {
  const bytes = serializeNativeProcessorEvents([
    { processorInstanceId: 11, parameterTarget: 2, frameOffset: 0, value: 0.75 },
  ], { revision: 7, epoch: 3, sequence: 19 })
  const view = new DataView(bytes.buffer)
  expect(view.getUint32(0, true)).toBe(1)
  expect(view.getUint32(4, true)).toBe(7)
  expect(view.getUint32(8, true)).toBe(3)
  expect(view.getBigUint64(12, true)).toBe(19n)
  expect(view.getBigUint64(20, true)).toBe(11n)
})

test("rejects processor payloads above the native audio-core capacity", () => {
  expect(() => serializeNativeProcessorEvents(
    Array.from({ length: 257 }, () => ({
      processorInstanceId: 11,
      parameterTarget: 2,
      frameOffset: 0,
      value: 0.75,
    })),
  )).toThrow()
})

test("rejects processor event fields that would truncate at the uint32 wire boundary", () => {
  const event = { processorInstanceId: 11, parameterTarget: 0xffff_ffff, frameOffset: 0xffff_ffff, value: 0.75 }
  expect(serializeNativeProcessorEvents([event], { revision: 1, epoch: 1, sequence: Number.MAX_SAFE_INTEGER })).toBeInstanceOf(Uint8Array)
  expect(() => serializeNativeProcessorEvents([{ ...event, parameterTarget: 0x1_0000_0000 }])).toThrow()
  expect(() => serializeNativeProcessorEvents([{ ...event, frameOffset: 0x1_0000_0000 }])).toThrow()
  expect(() => serializeNativeProcessorEvents([event], { revision: 1, epoch: 1, sequence: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
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
    sourceOffsetFraction: 0.25,
    sourceFrameCount: 6,
    gain: 0.5,
    fadeInStartFrame: 7,
    fadeInEndFrame: 8,
    fadeOutStartFrame: 9,
    fadeOutEndFrame: 10,
    fadeInCurve: 0.75,
    fadeInCurvePosition: 0.25,
    fadeOutCurve: -0.5,
    fadeOutCurvePosition: 0.8,
  }], mapNativeSessionAssets([asset("a")]))
  const view = new DataView(bytes.buffer)

  expect(bytes.byteLength).toBe(116)
  expect(view.getUint32(0, true)).toBe(1)
  expect(view.getUint32(24, true)).toBe(1)
  expect(view.getBigInt64(28, true)).toBe(3n)
  expect(view.getFloat32(100, true)).toBeCloseTo(0.75)
  expect(view.getFloat32(104, true)).toBeCloseTo(0.25)
  expect(view.getFloat32(108, true)).toBeCloseTo(-0.5)
  expect(view.getFloat32(112, true)).toBeCloseTo(0.8)
  expect(view.getBigInt64(64, true)).toBe(7n)
})

test("serializes absent native fade curves with defaults and keeps signed anchors", () => {
  const bytes = serializeNativeSourceEvents([{
    epoch: 1,
    sequence: 2,
    sourceNodeId: "source",
    assetId: "a",
    startFrame: 100,
    stopFrame: 200,
    sourceOffsetFrame: 5,
    sourceFrameCount: 6,
    gain: 1,
    fadeInStartFrame: -20,
    fadeInEndFrame: 120,
    fadeOutStartFrame: 150,
    fadeOutEndFrame: 240,
  }], mapNativeSessionAssets([asset("a")]))
  const view = new DataView(bytes.buffer)
  expect(view.getBigInt64(64, true)).toBe(-20n)
  expect(view.getBigInt64(72, true)).toBe(120n)
  expect(view.getFloat32(100, true)).toBe(0)
  expect(view.getFloat32(104, true)).toBe(0.5)
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

test("serializes native synth state with its bounded ABI payload", () => {
  const bytes = serializeNativeInstrumentStates([{
    nodeId: "instrument",
    state: {
      version: audioCoreContractVersion,
      kind: "synth",
      voiceCapacity: 8,
      outputLayout: "stereo",
      parameterTargets: [],
      outputGain: 0.75,
      outputPan: -0.25,
    },
  }], [])
  const view = new DataView(bytes.buffer)

  expect(bytes.byteLength).toBe(184)
  expect(view.getUint32(0, true)).toBe(1)
  expect(view.getUint32(12, true)).toBe(1)
  expect(view.getUint32(16, true)).toBe(156)
  expect(view.getUint32(20, true)).toBe(0)
  expect(view.getFloat32(28 + 148, true)).toBeCloseTo(0.75)
  expect(view.getFloat32(28 + 152, true)).toBeCloseTo(-0.25)
})

test("serializes empty sampled instruments without staged assets", () => {
  const base = {
    version: 1 as const,
    voiceCapacity: 4,
    outputLayout: "stereo" as const,
    ampAttackMs: 1,
    ampDecayMs: 10,
    ampSustain: 1,
    ampReleaseMs: 20,
    filterEnabled: true,
    filterMode: "lowpass" as const,
    filterCutoffHz: 20_000,
    filterResonance: 0.707,
    filterEnvelopeAmount: 0,
    filterAttackMs: 1,
    filterDecayMs: 10,
    filterSustain: 0,
    filterReleaseMs: 20,
    lfoEnabled: false,
    lfoRateHz: 5,
    lfoPitchCents: 0,
    lfoFilterHz: 0,
    lfoAmplitude: 0,
    lfoPan: 0,
    retrigger: true,
    zones: [],
  }
  const bytes = serializeNativeInstrumentStates([
    { nodeId: "sampler", state: { ...base, kind: "sampler" } },
    { nodeId: "drums", state: { ...base, kind: "drum-rack" } },
    {
      nodeId: "granular",
      state: {
        version: 1,
        kind: "granular",
        voiceCapacity: 2,
        outputLayout: "stereo",
        assetId: "",
        seed: 1,
        maxGrains: 2,
        windowShape: "hann",
        freeze: false,
        grainSizeMs: 5,
        densityHz: 1,
        position: 0,
        spray: 0,
        pitchSemitones: 0,
        reverseProbability: 0,
        stereoSpread: 0,
      },
    },
  ], [])
  const view = new DataView(bytes.buffer)
  expect(view.getUint32(0, true)).toBe(3)
  expect(view.getUint32(16, true)).toBe(88)
  expect(view.getUint32(20, true)).toBe(0)
  expect(view.getBigUint64(4 + 24 + 88 + 24 + 88 + 24 + 4, true)).toBe(0n)
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

test("keeps portable playback source buses sequential", () => {
  const sourceNodes: AudioCoreGraphSnapshot["nodes"] = Array.from(
    { length: 6 },
    (_, index): AudioCoreGraphSnapshot["nodes"][number] => ({
      id: `track-${index}`,
      kind: "source",
      inputLayout: "stereo",
      outputLayout: "stereo",
      processorOrder: [],
      latencyFrames: 0,
    }),
  )
  const snapshot: AudioCoreGraphSnapshot = {
    version: audioCoreContractVersion,
    revision: 9,
    contractHash: "contract",
    masterNodeId: "master",
    assets: [],
    nodes: [
      ...sourceNodes,
      {
        id: "master",
        kind: "master",
        inputLayout: "stereo",
        outputLayout: "stereo",
        processorOrder: [],
        latencyFrames: 0,
      },
    ],
    edges: [],
  }
  const bytes = encodePortableGraphEnvelope(snapshot)
  const view = new DataView(bytes.buffer)

  for (let index = 0; index < sourceNodes.length; index += 1) {
    expect(view.getUint32(24 + index * 132 + 20, true)).toBe(index)
  }
  expect(view.getUint32(24 + sourceNodes.length * 132 + 20, true)).toBe(0)
})

test("serializes native playback sources as disconnected after the native frame header", () => {
  const sourceNodes: AudioCoreGraphSnapshot["nodes"] = Array.from(
    { length: 6 },
    (_, index): AudioCoreGraphSnapshot["nodes"][number] => ({
      id: `track-${index}`,
      kind: "source",
      inputLayout: "stereo",
      outputLayout: "stereo",
      processorOrder: [],
      latencyFrames: 0,
    }),
  )
  const snapshot: AudioCoreGraphSnapshot = {
    version: audioCoreContractVersion,
    revision: 9,
    contractHash: "contract",
    masterNodeId: "master",
    assets: [],
    nodes: [
      ...sourceNodes,
      {
        id: "master",
        kind: "master",
        inputLayout: "stereo",
        outputLayout: "stereo",
        processorOrder: [],
        latencyFrames: 0,
      },
    ],
    edges: [],
  }
  const bytes = serializeNativeGraph(snapshot)
  const view = new DataView(bytes.buffer)

  for (let index = 0; index < sourceNodes.length; index += 1) {
    expect(view.getUint32(12 + 24 + index * 132 + 20, true)).toBe(0xffff_ffff)
  }
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
      ...Array.from(
        { length: 3 },
        (_, index): AudioCoreGraphSnapshot["nodes"][number] => ({
          id: `source-${index}`,
          kind: "source",
          inputLayout: "stereo",
          outputLayout: "stereo",
          processorOrder: [],
          latencyFrames: 0,
        }),
      ),
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
      fromNodeId: "source-0",
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
