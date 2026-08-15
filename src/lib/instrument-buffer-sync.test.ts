import { afterEach, expect, test } from "bun:test";
import { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import { createDefaultDrumRackParams, createDefaultGranularParams, createDefaultSamplerParams } from "@daw-browser/shared";
import { createDrumRackBufferSync } from "~/lib/drum-rack-buffer-sync";
import { hydrateInstrumentBuffers } from "~/components/timeline/create-effects-panel-controller";
import { compileLivePlaybackSnapshot } from "~/lib/live-playback-snapshot";
import type { LocalAssetBytesResult } from "~/lib/local-assets";
import { createSamplerBufferSync } from "~/lib/sampler-buffer-sync";

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 1;
  readonly length = 48_000;
  readonly numberOfChannels = 2;
  readonly sampleRate = 48_000;
  copyFromChannel(destination: Float32Array) { destination.fill(0); }
  copyToChannel() {}
  getChannelData() { return new Float32Array(this.length); }
}

const sample = {
  assetKey: "asset-runtime",
  url: "/runtime-sample.wav",
  sourceKind: "upload" as const,
  source: { durationSec: 1, sampleRate: 48_000, channelCount: 2 },
};

const zone = {
  id: "zone-runtime",
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
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

class TestAudioEngine extends AudioEngine {
  constructor(private readonly buffer: AudioBuffer) {
    super();
  }

  override decodeAudioData() {
    return Promise.resolve(this.buffer);
  }

  override setTrackSampler() {}
  override setTrackDrumRack() {}
  override setTrackGranular() { return Promise.resolve(); }
  override setSamplerRuntimeListeners() {}
}

const createEngine = (buffer: AudioBuffer) => {
  const engine = new TestAudioEngine(buffer);
  globalThis.fetch = Object.assign(async () => new Response(new ArrayBuffer(0)), {
    preconnect: originalFetch.preconnect,
  });
  return engine;
};

test("hydrates sampler, drum-rack, and granular buffers from their live sync caches", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const samplerSync = createSamplerBufferSync();
  const drumSync = createDrumRackBufferSync();
  const sampler = {
    ...createDefaultSamplerParams(),
    zones: [zone],
  };
  const drum = {
    ...createDefaultDrumRackParams(),
    pads: createDefaultDrumRackParams().pads.map((pad) => pad.id === "pad-36" ? { ...pad, sample } : pad),
  };
  const granular = {
    ...createDefaultGranularParams(),
    zone,
  };

  await Promise.all([
    samplerSync.syncTrack(engine, "sampler-track", sampler, "sampler-instance"),
    drumSync.syncTrack(engine, "drum-track", drum, "drum-instance"),
    samplerSync.syncGranularTrack(engine, "granular-track", granular, "granular-instance"),
  ]);

  expect(samplerSync.snapshotSamplerBuffers("sampler-track", {
    kind: "sampler",
    instanceId: "sampler-instance",
    params: sampler,
  })).toEqual(new Map([["zone-runtime", buffer]]));
  expect(drumSync.snapshotBuffers("drum-track", {
    kind: "drum-rack",
    instanceId: "drum-instance",
    params: drum,
  })).toEqual(new Map([["pad-36", buffer]]));
  expect(samplerSync.snapshotGranularBuffer("granular-track", {
    kind: "granular",
    instanceId: "granular-instance",
    params: granular,
  })).toEqual({ assetKey: "asset-runtime", buffer });

  expect(samplerSync.snapshotSamplerBuffers("sampler-track", {
    kind: "sampler",
    instanceId: "stale-instance",
    params: sampler,
  })).toBeUndefined();
  expect(drumSync.snapshotBuffers("drum-track", {
    kind: "drum-rack",
    instanceId: "drum-instance",
    params: { ...drum, pads: drum.pads.map((pad) => pad.id === "pad-36" ? { ...pad, sample: { ...sample, assetKey: "stale" } } : pad) },
  })).toBeUndefined();
  expect(samplerSync.snapshotGranularBuffer("granular-track", {
    kind: "granular",
    instanceId: "granular-instance",
    params: { ...granular, zone: { ...zone, sample: { ...sample, assetKey: "stale" } } },
  })).toBeUndefined();

  const hydrated = hydrateInstrumentBuffers({
    fx: {
      masterVolume: 1,
      masterFxInstances: [],
      trackFx: {
        "sampler-track": { instances: [], instrument: { kind: "sampler", instanceId: "sampler-instance", params: sampler } },
        "drum-track": { instances: [], instrument: { kind: "drum-rack", instanceId: "drum-instance", params: drum } },
        "granular-track": { instances: [], instrument: { kind: "granular", instanceId: "granular-instance", params: granular } },
      },
    },
    automationEnvelopes: [],
  }, (targetId, instrument) => {
    if (instrument.kind === "sampler") return samplerSync.snapshotSamplerBuffers(targetId, instrument) ? { samplerBuffers: samplerSync.snapshotSamplerBuffers(targetId, instrument) } : undefined;
    if (instrument.kind === "drum-rack") return drumSync.snapshotBuffers(targetId, instrument) ? { drumRackBuffers: drumSync.snapshotBuffers(targetId, instrument) } : undefined;
    if (instrument.kind === "granular") return samplerSync.snapshotGranularBuffer(targetId, instrument) ? { granularBuffer: samplerSync.snapshotGranularBuffer(targetId, instrument) } : undefined;
    return undefined;
  });
  const compiled = compileLivePlaybackSnapshot({
    revision: 1,
    bpm: 120,
    transport: { state: "stopped", playheadSec: 0, loopEnabled: false, loopStartSec: 0, loopEndSec: 0 },
    tracks: [
      { id: "sampler-track", name: "Sampler", volume: 1, clips: [] },
      { id: "drum-track", name: "Drum Rack", volume: 1, clips: [] },
      { id: "granular-track", name: "Granular", volume: 1, clips: [] },
    ],
    renderState: hydrated,
    sidechainRoutes: [],
  });
  expect(compiled.supported).toBeTrue();
  if (compiled.supported) {
    expect(compiled.snapshot.assets.map((asset) => asset.assetId)).toEqual(["asset-runtime"]);
  }

  samplerSync.dispose();
  drumSync.dispose();
});

test("resolves local project samples without fetching their pseudo-URLs", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const sampleBytes = new Uint8Array([1, 2, 3, 4]).buffer;
  const readCalls: string[] = [];
  let fetchCalls = 0;
  globalThis.fetch = Object.assign(async () => {
    fetchCalls += 1;
    return new Response(new ArrayBuffer(0));
  }, { preconnect: originalFetch.preconnect });
  const localSample = { ...sample, assetKey: "asset-1", url: "local-asset:asset-1" };
  const samplerSync = createSamplerBufferSync({
    projectId: () => "project:local",
    readLocalAsset: async (_projectId, assetId) => {
      readCalls.push(assetId);
      return { status: "ready", file: new File([sampleBytes], "sample.wav") };
    },
  });
  const sampler = { ...createDefaultSamplerParams(), zones: [{ ...zone, sample: localSample }] };
  const granular = { ...createDefaultGranularParams(), zone: { ...zone, sample: localSample } };
  const drum = {
    ...createDefaultDrumRackParams(),
    pads: createDefaultDrumRackParams().pads.map((pad) => pad.id === "pad-36" ? { ...pad, sample: localSample } : pad),
  };
  const samplerSyncPending = samplerSync.syncTrack(engine, "local-sampler", sampler, "sampler-instance");
  const granularSyncPending = samplerSync.syncGranularTrack(engine, "local-granular", granular, "granular-instance");
  const drumSync = createDrumRackBufferSync({
    projectId: () => "project:local",
    readLocalAsset: async (_projectId, assetId) => {
      readCalls.push(assetId);
      return { status: "ready", file: new File([sampleBytes], "sample.wav") };
    },
  });
  const drumSyncPending = drumSync.syncTrack(engine, "local-drum", drum, "drum-instance");
  await Promise.all([samplerSyncPending, granularSyncPending, drumSyncPending]);
  expect(readCalls).toHaveLength(2);
  expect(fetchCalls).toBe(0);
  expect(samplerSync.getStatus("local-sampler").zones.get(zone.id)).toBe("ready");
  expect(samplerSync.getGranularStatus("local-granular").state).toBe("ready");
  expect(samplerSync.snapshotSamplerBuffers("local-sampler", {
    kind: "sampler",
    instanceId: "sampler-instance",
    params: sampler,
  })).toEqual(new Map([[zone.id, buffer]]));
  expect(samplerSync.snapshotGranularBuffer("local-granular", {
    kind: "granular",
    instanceId: "granular-instance",
    params: granular,
  })).toEqual({ assetKey: "asset-1", buffer });
  expect(drumSync.snapshotBuffers("local-drum", {
    kind: "drum-rack",
    instanceId: "drum-instance",
    params: drum,
  })).toEqual(new Map([["pad-36", buffer]]));
  samplerSync.dispose();
  drumSync.dispose();
});

test("isolates sampled instrument buffers by project identity", async () => {
  const projectABuffer = new TestAudioBuffer();
  const projectBBuffer = new TestAudioBuffer();
  let projectId = "project:a";
  const reads: string[] = [];
  class ProjectAudioEngine extends AudioEngine {
    override decodeAudioData(data: ArrayBuffer) {
      return Promise.resolve(new Uint8Array(data)[0] === 1 ? projectABuffer : projectBBuffer);
    }
    override setTrackSampler() {}
    override setTrackDrumRack() {}
    override setTrackGranular() { return Promise.resolve(); }
    override setSamplerRuntimeListeners() {}
  }
  const engine = new ProjectAudioEngine();
  const localSample = { ...sample, assetKey: "shared-asset", url: "local-asset:shared-asset" };
  const sampler = { ...createDefaultSamplerParams(), zones: [{ ...zone, sample: localSample }] };
  const granular = { ...createDefaultGranularParams(), zone: { ...zone, sample: localSample } };
  const drum = {
    ...createDefaultDrumRackParams(),
    pads: createDefaultDrumRackParams().pads.map((pad) => pad.id === "pad-36" ? { ...pad, sample: localSample } : pad),
  };
  const readLocalAsset = async (activeProjectId: string): Promise<LocalAssetBytesResult> => {
    reads.push(activeProjectId);
    return {
      status: "ready",
      file: new File([new Uint8Array([activeProjectId === "project:a" ? 1 : 2])], "sample.wav"),
    };
  };
  const samplerSync = createSamplerBufferSync({ projectId: () => projectId, readLocalAsset });
  const drumSync = createDrumRackBufferSync({ projectId: () => projectId, readLocalAsset });

  await samplerSync.syncTrack(engine, "sampler", sampler, "sampler-instance");
  await drumSync.syncTrack(engine, "drum", drum, "drum-instance");
  expect(samplerSync.snapshotSamplerBuffers("sampler", {
    kind: "sampler",
    instanceId: "sampler-instance",
    params: sampler,
  })).toEqual(new Map([[zone.id, projectABuffer]]));
  expect(drumSync.snapshotBuffers("drum", {
    kind: "drum-rack",
    instanceId: "drum-instance",
    params: drum,
  })).toEqual(new Map([["pad-36", projectABuffer]]));

  projectId = "project:b";
  expect(samplerSync.snapshotSamplerBuffers("sampler", {
    kind: "sampler",
    instanceId: "sampler-instance",
    params: sampler,
  })).toBeUndefined();
  await samplerSync.syncTrack(engine, "sampler", sampler, "sampler-instance");
  await drumSync.syncTrack(engine, "drum", drum, "drum-instance");
  expect(samplerSync.snapshotSamplerBuffers("sampler", {
    kind: "sampler",
    instanceId: "sampler-instance",
    params: sampler,
  })).toEqual(new Map([[zone.id, projectBBuffer]]));
  expect(drumSync.snapshotBuffers("drum", {
    kind: "drum-rack",
    instanceId: "drum-instance",
    params: drum,
  })).toEqual(new Map([["pad-36", projectBBuffer]]));

  projectId = "project:a";
  await samplerSync.syncGranularTrack(engine, "granular", granular, "granular-instance");
  expect(samplerSync.snapshotGranularBuffer("granular", {
    kind: "granular",
    instanceId: "granular-instance",
    params: granular,
  })).toEqual({ assetKey: "shared-asset", buffer: projectABuffer });
  projectId = "project:b";
  expect(samplerSync.snapshotGranularBuffer("granular", {
    kind: "granular",
    instanceId: "granular-instance",
    params: granular,
  })).toBeUndefined();
  await samplerSync.syncGranularTrack(engine, "granular", granular, "granular-instance");
  expect(samplerSync.snapshotGranularBuffer("granular", {
    kind: "granular",
    instanceId: "granular-instance",
    params: granular,
  })).toEqual({ assetKey: "shared-asset", buffer: projectBBuffer });
  expect(reads).toEqual(["project:a", "project:a", "project:b", "project:b"]);

  samplerSync.dispose();
  drumSync.dispose();
});
