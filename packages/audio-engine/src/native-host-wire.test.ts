import { expect, test } from "bun:test"
import { audioCoreContractVersion, type AudioAssetRef, type AudioCoreGraphSnapshot } from "../../audio-core-contract/src/index"
import { graphEnvelope } from "../../../public/audio-worklets/daw-portable-graph-envelope-v3.js"
import { encodePortableGraphEnvelope, mapNativeSessionAssets, serializeNativeGraph, serializeNativeSourceEvents } from "./native-host-wire"

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
