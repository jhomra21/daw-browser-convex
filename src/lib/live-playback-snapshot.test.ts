import { expect, test } from "bun:test"
import { compileLivePlaybackSnapshot, type LivePlaybackSnapshotInput } from "./live-playback-snapshot"
import type { RuntimeTrack } from "~/lib/timeline-runtime-types"

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 1
  readonly length = 48_000
  readonly numberOfChannels = 2
  readonly sampleRate = 48_000
  copyFromChannel(destination: Float32Array) { destination.fill(0) }
  copyToChannel() {}
  getChannelData() { return new Float32Array(this.length) }
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
