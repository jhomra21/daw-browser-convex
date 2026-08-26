import { expect, test } from "bun:test"
import { compileLivePlaybackSnapshot, type LivePlaybackSnapshotInput } from "./live-playback-snapshot"
import type { RuntimeTrack } from "~/lib/timeline-runtime-types"
import { createDefaultDrumRackParams, createDefaultGranularParams, createDefaultSamplerParams } from "@daw-browser/shared"

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 1
  readonly length = 48_000
  readonly numberOfChannels = 2
  readonly sampleRate = 48_000
  readonly copyFromChannel = (destination: Float32Array) => { destination.fill(0) }
  readonly copyToChannel = () => {}
  readonly getChannelData = () => new Float32Array(this.length)
}

const buffer = new TestAudioBuffer()
const track: RuntimeTrack = {
  id: "track-a",
  name: "Audio",
  volume: 0.8,
  clips: [{
    id: "clip-a",
    name: "Clip",
    color: "#fff",
    startSec: 0,
    duration: 1,
    sourceAssetKey: "asset-a",
    buffer,
  }],
  sends: [{ targetId: "return-a", amount: 0.5, tap: "pre-fader" }],
}
const returnTrack: RuntimeTrack = {
  id: "return-a",
  name: "Return",
  volume: 0.8,
  clips: [],
  channelRole: "return",
}

const input: LivePlaybackSnapshotInput = {
  revision: 7,
  bpm: 120,
  transport: { state: "paused", playheadSec: 0, loopEnabled: false, loopStartSec: 0, loopEndSec: 0 },
  tracks: [track, returnTrack],
  renderState: {
    fx: { masterVolume: 0.7, masterFxInstances: [], trackFx: {} },
    automationEnvelopes: [],
  },
  sidechainRoutes: [{ sourceTrackId: "track-a", targetTrackId: "return-a", effectInstanceId: "compressor-a" }],
}

test("compiles hydrated timeline tracks through existing mixer routing authority", () => {
  const result = compileLivePlaybackSnapshot(input)
  expect(result.supported).toBeTrue()
  if (!result.supported) return
  expect(result.snapshot.revision).toBe(7)
  expect(result.snapshot.assets).toEqual([{ assetId: "asset-a", buffer }])
  expect(result.snapshot.mixer.graph.channels[0]?.sends).toEqual([
    { targetId: "return-a", amount: 0.5, tap: "pre-fader" },
  ])
  expect(result.snapshot.mixer.sidechainRoutes).toEqual(input.sidechainRoutes)
  expect(result.snapshot.mixer.graph.master.volume).toBe(0.7)
})

test("rejects an invalid revision and unhydrated audio without creating a graph", () => {
  const result = compileLivePlaybackSnapshot({
    ...input,
    revision: 0,
    tracks: [{ ...track, clips: [{ ...track.clips[0], buffer: null }] }],
  })
  expect(result).toEqual({
    supported: false,
    reasons: [
      "Playback revision must be a positive safe integer.",
      'Audio clip "clip-a" is not hydrated.',
    ],
  })
})

test("registers hydrated sampler assets with live portable playback", () => {
  const params = createDefaultSamplerParams()
  const sample = {
    assetKey: "asset-sampler",
    url: "/sample.wav",
    sourceKind: "upload" as const,
    source: { durationSec: 1, sampleRate: 48_000, channelCount: 2 },
  }
  const zone = {
    id: "zone-a",
    sample,
    keyLow: 0,
    keyHigh: 127,
    velocityLow: 1,
    velocityHigh: 127,
    rootNote: 60,
    tuneCents: 0,
    gain: 1,
    pan: 0,
    roundRobinGroup: 0,
    roundRobinIndex: 0,
    playbackMode: "one-shot" as const,
    startSec: 0,
    crossfadeSec: 0,
    chokeGroup: 0,
  }
  const result = compileLivePlaybackSnapshot({
    ...input,
    tracks: [{
      ...track,
      clips: [{
        ...track.clips[0],
        midi: { wave: "sine", notes: [] },
        sourceAssetKey: undefined,
        buffer: undefined,
      }],
    }],
    renderState: {
      ...input.renderState,
      fx: {
        ...input.renderState.fx,
        trackFx: {
          "track-a": {
            instances: [],
            instrument: { kind: "sampler", instanceId: "sampler-a", params: { ...params, zones: [zone] } },
            samplerBuffers: new Map([[zone.id, buffer]]),
          },
        },
      },
    },
  })
  expect(result.supported).toBeTrue()
  if (!result.supported) return
  expect(result.snapshot.assets).toEqual([{ assetId: "asset-sampler", buffer }])
})

test("registers hydrated drum-rack and granular assets with live portable playback", () => {
  const drumParams = createDefaultDrumRackParams()
  const drumPad = drumParams.pads[0]
  if (!drumPad) throw new Error("Default drum rack has no pads.")
  const sample = {
    assetKey: "asset-shared",
    url: "/sample.wav",
    sourceKind: "upload" as const,
    source: { durationSec: 1, sampleRate: 48_000, channelCount: 2 },
  }
  const drumRack = {
    ...drumParams,
    pads: drumParams.pads.map((pad) => pad.id === drumPad.id ? { ...pad, sample } : pad),
  }
  const granularParams = {
    ...createDefaultGranularParams(),
    zone: {
      id: "granular-zone",
      sample,
      keyLow: 0,
      keyHigh: 127,
      velocityLow: 1,
      velocityHigh: 127,
      rootNote: 60,
      tuneCents: 0,
      gain: 1,
      pan: 0,
      roundRobinGroup: 0,
      roundRobinIndex: 0,
      playbackMode: "one-shot" as const,
      startSec: 0,
      crossfadeSec: 0,
      chokeGroup: 0,
    },
  }
  const result = compileLivePlaybackSnapshot({
    ...input,
    tracks: [
      {
        ...track,
        id: "drum-track",
        clips: [{
          ...track.clips[0],
          id: "drum-clip",
          midi: { wave: "sine", notes: [] },
          sourceAssetKey: undefined,
          buffer: undefined,
        }],
      },
      {
        ...track,
        id: "granular-track",
        clips: [{
          ...track.clips[0],
          id: "granular-clip",
          midi: { wave: "sine", notes: [] },
          sourceAssetKey: undefined,
          buffer: undefined,
        }],
      },
    ],
    renderState: {
      ...input.renderState,
      fx: {
        ...input.renderState.fx,
        trackFx: {
          "drum-track": {
            instances: [],
            instrument: { kind: "drum-rack", instanceId: "drum-a", params: drumRack },
            drumRackBuffers: new Map([[drumPad.id, buffer]]),
          },
          "granular-track": {
            instances: [],
            instrument: { kind: "granular", instanceId: "granular-a", params: granularParams },
            granularBuffer: { assetKey: sample.assetKey, buffer },
          },
        },
      },
    },
  })
  expect(result.supported).toBeTrue()
  if (!result.supported) return
  expect(result.snapshot.assets).toEqual([{ assetId: "asset-shared", buffer }])
})

test("clones hydrated instrument buffers without cloning AudioBuffer objects", () => {
  const samplerParams = createDefaultSamplerParams()
  const samplerSample = {
    assetKey: "asset-sampler",
    url: "/sampler.wav",
    sourceKind: "upload" as const,
    source: { durationSec: 1, sampleRate: 48_000, channelCount: 2 },
  }
  const samplerZone = {
    id: "sampler-zone",
    sample: samplerSample,
    keyLow: 0,
    keyHigh: 127,
    velocityLow: 1,
    velocityHigh: 127,
    rootNote: 60,
    tuneCents: 0,
    gain: 1,
    pan: 0,
    roundRobinGroup: 0,
    roundRobinIndex: 0,
    playbackMode: "one-shot" as const,
    startSec: 0,
    crossfadeSec: 0,
    chokeGroup: 0,
  }
  const drumParams = createDefaultDrumRackParams()
  const drumPad = drumParams.pads[0]
  if (!drumPad) throw new Error("Default drum rack has no pads.")
  const drumSample = {
    assetKey: "asset-drum",
    url: "/drum.wav",
    sourceKind: "upload" as const,
    source: { durationSec: 1, sampleRate: 48_000, channelCount: 2 },
  }
  const drumRack = {
    ...drumParams,
    pads: drumParams.pads.map((pad) => pad.id === drumPad.id ? { ...pad, sample: drumSample } : pad),
  }
  const granularSample = {
    assetKey: "asset-granular",
    url: "/granular.wav",
    sourceKind: "upload" as const,
    source: { durationSec: 1, sampleRate: 48_000, channelCount: 2 },
  }
  const granularParams = {
    ...createDefaultGranularParams(),
    zone: {
      ...samplerZone,
      id: "granular-zone",
      sample: granularSample,
    },
  }
  const samplerBuffers = new Map([[samplerZone.id, buffer]])
  const drumRackBuffers = new Map([[drumPad.id, buffer]])
  const granularBuffer = { assetKey: granularSample.assetKey, buffer }
  const fx = {
    masterVolume: 0.7,
    masterFxInstances: [],
    trackFx: {
      "sampler-track": {
        instances: [],
        instrument: { kind: "sampler" as const, instanceId: "sampler-a", params: { ...samplerParams, zones: [samplerZone] } },
        samplerBuffers,
      },
      "drum-track": {
        instances: [],
        instrument: { kind: "drum-rack" as const, instanceId: "drum-a", params: drumRack },
        drumRackBuffers,
      },
      "granular-track": {
        instances: [],
        instrument: { kind: "granular" as const, instanceId: "granular-a", params: granularParams },
        granularBuffer,
      },
    },
  }

  expect(() => structuredClone({ fx })).toThrow()
  const result = compileLivePlaybackSnapshot({
    ...input,
    tracks: ["sampler-track", "drum-track", "granular-track"].map((id, index) => ({
      ...track,
      id,
      clips: [{
        ...track.clips[0],
        id: `midi-clip-${index}`,
        midi: { wave: "sine", notes: [] },
        sourceAssetKey: undefined,
        buffer: undefined,
      }],
    })),
    renderState: { ...input.renderState, fx },
  })

  expect(result.supported).toBeTrue()
  if (!result.supported) return
  const snapshotFx = result.snapshot.mixer.fx
  const samplerSnapshotBuffers = snapshotFx.trackFx?.["sampler-track"]?.samplerBuffers
  const drumSnapshotBuffers = snapshotFx.trackFx?.["drum-track"]?.drumRackBuffers
  const granularSnapshotBuffer = snapshotFx.trackFx?.["granular-track"]?.granularBuffer
  expect(samplerSnapshotBuffers).not.toBe(samplerBuffers)
  expect(drumSnapshotBuffers).not.toBe(drumRackBuffers)
  expect(samplerSnapshotBuffers?.get(samplerZone.id)).toBe(buffer)
  expect(drumSnapshotBuffers?.get(drumPad.id)).toBe(buffer)
  expect(granularSnapshotBuffer?.assetKey).toBe(granularBuffer.assetKey)
  expect(granularSnapshotBuffer?.buffer).toBe(buffer)
  expect(result.snapshot.assets).toEqual([
    { assetId: "asset-sampler", buffer },
    { assetId: "asset-drum", buffer },
    { assetId: "asset-granular", buffer },
  ])

  samplerBuffers.set("mutated", buffer)
  drumRackBuffers.clear()
  expect(samplerSnapshotBuffers?.has("mutated")).toBeFalse()
  expect(drumSnapshotBuffers?.size).toBe(1)
})

test("rejects a configured sampler zone without its authoritative buffer", () => {
  const sample = {
    assetKey: "asset-missing-sampler",
    url: "/sampler.wav",
    sourceKind: "upload" as const,
    source: { durationSec: 1, sampleRate: 48_000, channelCount: 2 },
  }
  const zone = {
    id: "sampler-zone",
    sample,
    keyLow: 0,
    keyHigh: 127,
    velocityLow: 1,
    velocityHigh: 127,
    rootNote: 60,
    tuneCents: 0,
    gain: 1,
    pan: 0,
    roundRobinGroup: 0,
    roundRobinIndex: 0,
    playbackMode: "one-shot" as const,
    startSec: 0,
    crossfadeSec: 0,
    chokeGroup: 0,
  }
  const result = compileLivePlaybackSnapshot({
    ...input,
    tracks: [{ ...track, clips: [{ ...track.clips[0], midi: { wave: "sine", notes: [] }, sourceAssetKey: undefined, buffer: undefined }] }],
    renderState: {
      ...input.renderState,
      fx: {
        ...input.renderState.fx,
        trackFx: {
          "track-a": {
            instances: [],
            instrument: { kind: "sampler", instanceId: "sampler-a", params: { ...createDefaultSamplerParams(), zones: [zone] } },
          },
        },
      },
    },
  })
  expect(result).toEqual({
    supported: false,
    reasons: ['Sampler zone "sampler-zone" is missing its authoritative audio buffer.'],
  })
})

test("rejects a configured Drum Rack pad when its buffer cache is absent", () => {
  const params = createDefaultDrumRackParams()
  const pad = params.pads[0]
  if (!pad) throw new Error("Default drum rack has no pads.")
  const sample = {
    assetKey: "asset-missing-drum",
    url: "/drum.wav",
    sourceKind: "upload" as const,
    source: { durationSec: 1, sampleRate: 48_000, channelCount: 2 },
  }
  const result = compileLivePlaybackSnapshot({
    ...input,
    tracks: [{ ...track, clips: [{ ...track.clips[0], midi: { wave: "sine", notes: [] }, sourceAssetKey: undefined, buffer: undefined }] }],
    renderState: {
      ...input.renderState,
      fx: {
        ...input.renderState.fx,
        trackFx: {
          "track-a": {
            instances: [],
            instrument: {
              kind: "drum-rack",
              instanceId: "drum-a",
              params: { ...params, pads: params.pads.map((item) => item.id === pad.id ? { ...item, sample } : item) },
            },
          },
        },
      },
    },
  })
  expect(result).toEqual({
    supported: false,
    reasons: [`Drum Rack pad "${pad.id}" is missing its authoritative audio buffer.`],
  })
})

test("rejects a configured Granular zone without its authoritative buffer", () => {
  const sample = {
    assetKey: "asset-missing-granular",
    url: "/granular.wav",
    sourceKind: "upload" as const,
    source: { durationSec: 1, sampleRate: 48_000, channelCount: 2 },
  }
  const zone = {
    id: "granular-zone",
    sample,
    keyLow: 0,
    keyHigh: 127,
    velocityLow: 1,
    velocityHigh: 127,
    rootNote: 60,
    tuneCents: 0,
    gain: 1,
    pan: 0,
    roundRobinGroup: 0,
    roundRobinIndex: 0,
    playbackMode: "one-shot" as const,
    startSec: 0,
    crossfadeSec: 0,
    chokeGroup: 0,
  }
  const result = compileLivePlaybackSnapshot({
    ...input,
    tracks: [{ ...track, clips: [{ ...track.clips[0], midi: { wave: "sine", notes: [] }, sourceAssetKey: undefined, buffer: undefined }] }],
    renderState: {
      ...input.renderState,
      fx: {
        ...input.renderState.fx,
        trackFx: {
          "track-a": {
            instances: [],
            instrument: { kind: "granular", instanceId: "granular-a", params: { ...createDefaultGranularParams(), zone } },
          },
        },
      },
    },
  })
  expect(result).toEqual({
    supported: false,
    reasons: ['Granular zone "granular-zone" is missing its authoritative audio buffer.'],
  })
})
