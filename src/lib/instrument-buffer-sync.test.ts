import { afterEach, expect, test } from "bun:test";
import { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import { createDefaultDrumRackParams, createDefaultGranularParams, createDefaultSamplerParams, type GranularParams, type SamplerParams, type TrackInstrumentParams } from "@daw-browser/shared";
import { createDrumRackBufferSync } from "~/lib/drum-rack-buffer-sync";
import { DRUM_RACK_MAX_DECODED_BYTES } from "@daw-browser/audio-engine/drum-rack-runtime";
import type { ExportRenderStateSnapshot } from "~/lib/export/run-export-job";
import { compileLivePlaybackSnapshot } from "~/lib/live-playback-snapshot";
import type { LocalAssetBytesResult } from "~/lib/local-assets";
import { createSamplerBufferSync } from "~/lib/sampler-buffer-sync";
import { createSampledInstrumentRegionBudget } from "~/lib/sampled-instrument-region-budget";
import { sampledInstrumentRegion, sampledInstrumentRegionIdentity, type SampledInstrumentBuffer } from "@daw-browser/audio-engine/sampled-instrument-region";
import type { DecodedAudioPage } from "@daw-browser/audio-engine/media-pages";

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 1;
  readonly length = 48_000;
  readonly numberOfChannels = 2;
  readonly sampleRate = 48_000;
  copyFromChannel(destination: Float32Array) { destination.fill(0); }
  copyToChannel() {}
  getChannelData() { return new Float32Array(this.length); }
}

const sampled = (buffer: AudioBuffer): SampledInstrumentBuffer => ({ buffer, sourceStartFrame: 0 });
const decodeTestPages = async function* (
  _source: Blob | string | URL | Request,
  options?: { startSec?: number; endSec?: number },
): AsyncGenerator<DecodedAudioPage> {
  const startFrame = Math.round((options?.startSec ?? 0) * 48_000);
  const endFrame = Math.round((options?.endSec ?? 1) * 48_000);
  const frameCount = endFrame - startFrame;
  yield {
    startFrame,
    frameCount,
    sampleRate: 48_000,
    channelCount: 2,
    planes: [new Float32Array(frameCount), new Float32Array(frameCount)],
  };
};
const hydrateInstrumentBuffers = (
  renderState: ExportRenderStateSnapshot,
  snapshot: (targetId: string, instrument: TrackInstrumentParams) => {
    samplerBuffers?: ReadonlyMap<string, SampledInstrumentBuffer>
    drumRackBuffers?: ReadonlyMap<string, SampledInstrumentBuffer>
    granularBuffer?: { assetKey: string } & SampledInstrumentBuffer
  } | undefined,
): ExportRenderStateSnapshot => ({
  ...renderState,
  fx: {
    ...renderState.fx,
    trackFx: Object.fromEntries(Object.entries(renderState.fx.trackFx ?? {}).map(([trackId, entry]) => {
      if (!entry.instrument) return [trackId, entry]
      const buffers = snapshot(trackId, entry.instrument)
      const { samplerBuffers: _sampler, drumRackBuffers: _drum, granularBuffer: _granular, ...withoutBuffers } = entry
      return [trackId, buffers ? { ...withoutBuffers, ...buffers } : withoutBuffers]
    })),
  },
});

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
type TestRejectionReason = Error;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

class TestAudioEngine extends AudioEngine {
  private samplerRuntimeListeners: Parameters<AudioEngine["setSamplerRuntimeListeners"]>[0] = {};
  private readonly samplerBuffers = new Map<string, ReadonlyMap<string, SampledInstrumentBuffer>>();
  private readonly granularBuffers = new Map<string, Parameters<AudioEngine["setTrackGranular"]>[2]>();

  constructor(private readonly buffer: AudioBuffer) {
    super();
  }

  override decodeAudioData() {
    return Promise.resolve(this.buffer);
  }

  override setTrackSampler(trackId: string, _params: SamplerParams, buffers?: ReadonlyMap<string, SampledInstrumentBuffer>) {
    this.samplerBuffers.set(trackId, buffers ?? new Map());
  }
  override setTrackDrumRack() {}
  override setTrackGranular(trackId: string, _params: GranularParams, installedBuffer?: Parameters<AudioEngine["setTrackGranular"]>[2]) {
    this.granularBuffers.set(trackId, installedBuffer);
    return Promise.resolve();
  }
  override setSamplerRuntimeListeners(listeners: Parameters<AudioEngine["setSamplerRuntimeListeners"]>[0]) {
    this.samplerRuntimeListeners = listeners;
  }
  override addSamplerRuntimeListeners(listeners: Parameters<AudioEngine["addSamplerRuntimeListeners"]>[0]) {
    const previous = this.samplerRuntimeListeners;
    this.samplerRuntimeListeners = { ...previous, ...listeners };
    return () => {
      this.samplerRuntimeListeners = previous;
      return true;
    };
  }

  emitSamplerRegionUse(use: Parameters<NonNullable<Parameters<AudioEngine["setSamplerRuntimeListeners"]>[0]["onAssetUse"]>>[0]) {
    this.samplerRuntimeListeners.onAssetUse?.(use);
  }
  emitDrumRackRegionUse(use: Parameters<NonNullable<Parameters<AudioEngine["setSamplerRuntimeListeners"]>[0]["onDrumRackAssetUse"]>>[0]) {
    this.samplerRuntimeListeners.onDrumRackAssetUse?.(use);
  }

  samplerBufferIds(trackId: string) {
    return [...(this.samplerBuffers.get(trackId)?.keys() ?? [])];
  }

  granularBuffer(trackId: string) {
    return this.granularBuffers.get(trackId);
  }

  emitSamplerNoteMiss(miss: Parameters<NonNullable<Parameters<AudioEngine["setSamplerRuntimeListeners"]>[0]["onNoteMiss"]>>[0]) {
    this.samplerRuntimeListeners.onNoteMiss?.(miss);
  }
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
  const samplerSync = createSamplerBufferSync({ decodePages: decodeTestPages, createBuffer: () => buffer });
  const drumSync = createDrumRackBufferSync({ decodePages: decodeTestPages, createBuffer: () => buffer });
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
  })).toEqual(new Map([["zone-runtime", sampled(buffer)]]));
  expect(drumSync.snapshotBuffers("drum-track", {
    kind: "drum-rack",
    instanceId: "drum-instance",
    params: drum,
  })).toEqual(new Map([["pad-36", sampled(buffer)]]));
  expect(samplerSync.snapshotGranularBuffer("granular-track", {
    kind: "granular",
    instanceId: "granular-instance",
    params: granular,
  })).toEqual({ assetKey: sampledInstrumentRegionIdentity(sample, sampledInstrumentRegion(sample.source, 0, 1)), ...sampled(buffer) });

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
    expect(compiled.snapshot.assets.map((asset) => asset.assetId)).toEqual([
      sampledInstrumentRegionIdentity(sample, sampledInstrumentRegion(sample.source, 0, 1)),
    ]);
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
    decodePages: decodeTestPages,
    createBuffer: () => buffer,
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
    decodePages: decodeTestPages,
    createBuffer: () => buffer,
    projectId: () => "project:local",
    readLocalAsset: async (_projectId, assetId) => {
      readCalls.push(assetId);
      return { status: "ready", file: new File([sampleBytes], "sample.wav") };
    },
  });
  const drumSyncPending = drumSync.syncTrack(engine, "local-drum", drum, "drum-instance");
  await Promise.all([samplerSyncPending, granularSyncPending, drumSyncPending]);
  expect(readCalls).toHaveLength(3);
  expect(fetchCalls).toBe(0);
  expect(samplerSync.getStatus("local-sampler").zones.get(zone.id)).toBe("ready");
  expect(samplerSync.getGranularStatus("local-granular").state).toBe("ready");
  expect(samplerSync.snapshotSamplerBuffers("local-sampler", {
    kind: "sampler",
    instanceId: "sampler-instance",
    params: sampler,
  })).toEqual(new Map([[zone.id, sampled(buffer)]]));
  expect(samplerSync.snapshotGranularBuffer("local-granular", {
    kind: "granular",
    instanceId: "granular-instance",
    params: granular,
  })).toEqual({ assetKey: sampledInstrumentRegionIdentity(localSample, sampledInstrumentRegion(localSample.source, 0, 1)), ...sampled(buffer) });
  expect(drumSync.snapshotBuffers("local-drum", {
    kind: "drum-rack",
    instanceId: "drum-instance",
    params: drum,
  })).toEqual(new Map([["pad-36", sampled(buffer)]]));
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
  const samplerSync = createSamplerBufferSync({ projectId: () => projectId, readLocalAsset, decodePages: decodeTestPages, createBuffer: () => projectId === "project:a" ? projectABuffer : projectBBuffer });
  const drumSync = createDrumRackBufferSync({ projectId: () => projectId, readLocalAsset, decodePages: decodeTestPages, createBuffer: () => projectId === "project:a" ? projectABuffer : projectBBuffer });

  await samplerSync.syncTrack(engine, "sampler", sampler, "sampler-instance");
  await drumSync.syncTrack(engine, "drum", drum, "drum-instance");
  expect(samplerSync.snapshotSamplerBuffers("sampler", {
    kind: "sampler",
    instanceId: "sampler-instance",
    params: sampler,
  })).toEqual(new Map([[zone.id, sampled(projectABuffer)]]));
  expect(drumSync.snapshotBuffers("drum", {
    kind: "drum-rack",
    instanceId: "drum-instance",
    params: drum,
  })).toEqual(new Map([["pad-36", sampled(projectABuffer)]]));

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
  })).toEqual(new Map([[zone.id, sampled(projectBBuffer)]]));
  expect(drumSync.snapshotBuffers("drum", {
    kind: "drum-rack",
    instanceId: "drum-instance",
    params: drum,
  })).toEqual(new Map([["pad-36", sampled(projectBBuffer)]]));

  projectId = "project:a";
  await samplerSync.syncGranularTrack(engine, "granular", granular, "granular-instance");
  expect(samplerSync.snapshotGranularBuffer("granular", {
    kind: "granular",
    instanceId: "granular-instance",
    params: granular,
  })).toEqual({ assetKey: sampledInstrumentRegionIdentity(localSample, sampledInstrumentRegion(localSample.source, 0, 1)), ...sampled(projectABuffer) });
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
  })).toEqual({ assetKey: sampledInstrumentRegionIdentity(localSample, sampledInstrumentRegion(localSample.source, 0, 1)), ...sampled(projectBBuffer) });
  expect(reads).toEqual(["project:a", "project:a", "project:b", "project:b", "project:a", "project:b"]);

  samplerSync.dispose();
  drumSync.dispose();
});

test("pins active sampler regions and releases them after the final voice ends", async () => {
  const bufferForRegion = (_channels: number, frames: number, sampleRate: number): AudioBuffer => Object.assign(Object.create(null), {
    duration: frames / sampleRate,
    length: frames,
    numberOfChannels: 2,
    sampleRate,
    getChannelData: () => new Float32Array(frames),
  });
  const engine = new TestAudioEngine(bufferForRegion(2, 1, 48_000));
  const source = { durationSec: 3, sampleRate: 48_000, channelCount: 2 };
  const firstZone = { ...zone, id: "zone-first", sample: { ...sample, assetKey: "asset-first", source }, startSec: 0, endSec: 1.5 };
  const secondZone = { ...zone, id: "zone-second", sample: { ...sample, assetKey: "asset-second", source }, startSec: 1.5, endSec: 3 };
  const params: SamplerParams = {
    ...createDefaultSamplerParams(),
    cachePolicy: "lazy",
    maxDecodedBytes: 1 * 1024 * 1024,
    zones: [firstZone, secondZone],
  };
  const sync = createSamplerBufferSync({
    decodePages: decodeTestPages,
    createBuffer: bufferForRegion,
    resolveUrl: (url) => url,
  });

  await sync.syncTrack(engine, "sampler-cache", params, "sampler-instance");
  await sync.retryZone(engine, "sampler-cache", firstZone.id);
  const firstRegionKey = sampledInstrumentRegionIdentity(firstZone.sample, sampledInstrumentRegion(firstZone.sample.source, 0, 1.5));
  engine.emitSamplerRegionUse({ trackId: "sampler-cache", regionKey: firstRegionKey, voiceId: 1, active: true });
  engine.emitSamplerRegionUse({ trackId: "sampler-cache", regionKey: firstRegionKey, voiceId: 2, active: true });
  await sync.retryZone(engine, "sampler-cache", secondZone.id);

  expect(sync.snapshotSamplerBuffers("sampler-cache", {
    kind: "sampler",
    instanceId: "sampler-instance",
    params,
  })).toBeDefined();

  engine.emitSamplerRegionUse({ trackId: "sampler-cache", regionKey: firstRegionKey, voiceId: 1, active: false });
  expect(sync.snapshotSamplerBuffers("sampler-cache", {
    kind: "sampler",
    instanceId: "sampler-instance",
    params,
  })?.has(firstZone.id)).toBe(true);
  engine.emitSamplerRegionUse({ trackId: "sampler-cache", regionKey: firstRegionKey, voiceId: 2, active: false });
  await sync.retryZone(engine, "sampler-cache", secondZone.id);

  expect(sync.getStatus("sampler-cache").totalBytes).toBe(576_000);
  expect(sync.snapshotSamplerBuffers("sampler-cache", {
    kind: "sampler",
    instanceId: "sampler-instance",
    params,
  })?.has(firstZone.id)).toBe(false);
  expect(sync.snapshotSamplerBuffers("sampler-cache", {
    kind: "sampler",
    instanceId: "sampler-instance",
    params,
  })?.has(secondZone.id)).toBe(true);
  sync.dispose();
});

test("releases a retired sampler generation through the ending voice token", async () => {
  const buffer = new TestAudioBuffer();
  const regionBytes = 48_000 * 2 * 4;
  const aggregate = createSampledInstrumentRegionBudget(regionBytes * 2);
  const engine = createEngine(buffer);
  const sync = createSamplerBufferSync({ aggregateBudget: aggregate, decodePages: decodeTestPages, createBuffer: () => buffer });
  const params = { ...createDefaultSamplerParams(), maxDecodedBytes: regionBytes, zones: [zone] };
  await sync.syncTrack(engine, "sampler-generation", params, "sampler-instance");
  const regionKey = sampledInstrumentRegionIdentity(zone.sample, sampledInstrumentRegion(zone.sample.source, 0, 1));
  const key = `sampler\u0000sampler-generation\u0000${regionKey}`;
  engine.emitSamplerRegionUse({ trackId: "sampler-generation", regionKey, voiceId: 1, active: true });
  aggregate.release(key);
  aggregate.set(key, regionBytes, () => undefined, new TestAudioBuffer());
  expect(aggregate.totalBytes()).toBe(regionBytes * 2);
  engine.emitSamplerRegionUse({ trackId: "sampler-generation", regionKey, voiceId: 1, active: false });
  expect(aggregate.totalBytes()).toBe(regionBytes);
  sync.dispose();
});

test("releases a retired Drum Rack generation through the ending hit token", async () => {
  const buffer = new TestAudioBuffer();
  const regionBytes = 48_000 * 2 * 4;
  const aggregate = createSampledInstrumentRegionBudget(regionBytes * 2);
  const engine = createEngine(buffer);
  const pad = createDefaultDrumRackParams().pads[0];
  if (!pad) throw new Error("Missing default Drum Rack pad");
  const params = {
    ...createDefaultDrumRackParams(),
    pads: createDefaultDrumRackParams().pads.map((candidate) => candidate.id === pad.id
      ? { ...candidate, sample, startSec: 0, endSec: 1 }
      : candidate),
  };
  const sync = createDrumRackBufferSync({ aggregateBudget: aggregate, decodePages: decodeTestPages, createBuffer: () => buffer });
  await sync.syncTrack(engine, "drum-generation", params, "drum-instance");
  const regionKey = sampledInstrumentRegionIdentity(sample, sampledInstrumentRegion(sample.source, 0, 1));
  const key = `drum\u0000drum-generation\u0000${regionKey}`;
  engine.emitDrumRackRegionUse({ trackId: "drum-generation", regionKey, hitId: 1, active: true });
  aggregate.release(key);
  aggregate.set(key, regionBytes, () => undefined, new TestAudioBuffer());
  expect(aggregate.totalBytes()).toBe(regionBytes * 2);
  engine.emitDrumRackRegionUse({ trackId: "drum-generation", regionKey, hitId: 1, active: false });
  expect(aggregate.totalBytes()).toBe(regionBytes);
  sync.dispose();
});

test("retries a Drum Rack region after the first request is aborted", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  let calls = 0;
  let firstStartedResolve: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
  const decodePages = async function* (
    _source: Blob | string | URL | Request,
    options?: { startFrame?: number; endFrame?: number; signal?: AbortSignal },
  ): AsyncGenerator<DecodedAudioPage> {
    calls += 1;
    if (calls === 1) {
      firstStartedResolve?.();
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      options?.signal?.throwIfAborted();
    }
    const startFrame = options?.startFrame ?? 0;
    const endFrame = options?.endFrame ?? startFrame + 1;
    yield {
      startFrame,
      frameCount: endFrame - startFrame,
      sampleRate: 48_000,
      channelCount: 2,
      planes: [new Float32Array(endFrame - startFrame), new Float32Array(endFrame - startFrame)],
    };
  };
  const sync = createDrumRackBufferSync({ decodePages, createBuffer: () => buffer });
  const params = {
    ...createDefaultDrumRackParams(),
    pads: createDefaultDrumRackParams().pads.map((pad) => pad.id === "pad-36" ? { ...pad, sample } : pad),
  };

  const first = sync.syncTrack(engine, "drum-retry", params, "drum-instance");
  await firstStarted;
  const second = sync.syncTrack(engine, "drum-retry", params, "drum-instance");
  await expect(first).rejects.toBeDefined();
  await second;
  expect(calls).toBe(2);
  expect(sync.snapshotBuffers("drum-retry", {
    kind: "drum-rack",
    instanceId: "drum-instance",
    params,
  })).toEqual(new Map([["pad-36", sampled(buffer)]]));
  sync.dispose();
});

test("retries a Sampler region after the first request is aborted", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  let calls = 0;
  let firstStartedResolve: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
  const decodePages = async function* (
    _source: Blob | string | URL | Request,
    options?: { startFrame?: number; endFrame?: number; signal?: AbortSignal },
  ): AsyncGenerator<DecodedAudioPage> {
    calls += 1;
    if (calls === 1) {
      firstStartedResolve?.();
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      options?.signal?.throwIfAborted();
    }
    const startFrame = options?.startFrame ?? 0;
    const endFrame = options?.endFrame ?? startFrame + 1;
    yield {
      startFrame,
      frameCount: endFrame - startFrame,
      sampleRate: 48_000,
      channelCount: 2,
      planes: [new Float32Array(endFrame - startFrame), new Float32Array(endFrame - startFrame)],
    };
  };
  const sync = createSamplerBufferSync({ decodePages, createBuffer: () => buffer });
  const params = { ...createDefaultSamplerParams(), zones: [zone] };

  const first = sync.syncTrack(engine, "sampler-retry", params, "sampler-instance");
  await firstStarted;
  const second = sync.syncTrack(engine, "sampler-retry", params, "sampler-instance");
  await expect(first).rejects.toBeDefined();
  await second;
  expect(calls).toBe(2);
  expect(sync.snapshotSamplerBuffers("sampler-retry", {
    kind: "sampler",
    instanceId: "sampler-instance",
    params,
  })).toEqual(new Map([[zone.id, sampled(buffer)]]));
  sync.dispose();
});

test("retries a Granular region after the first request is aborted", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  let calls = 0;
  let firstStartedResolve: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
  const decodePages = async function* (
    _source: Blob | string | URL | Request,
    options?: { startFrame?: number; endFrame?: number; signal?: AbortSignal },
  ): AsyncGenerator<DecodedAudioPage> {
    calls += 1;
    if (calls === 1) {
      firstStartedResolve?.();
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      options?.signal?.throwIfAborted();
    }
    const startFrame = options?.startFrame ?? 0;
    const endFrame = options?.endFrame ?? startFrame + 1;
    yield {
      startFrame,
      frameCount: endFrame - startFrame,
      sampleRate: 48_000,
      channelCount: 2,
      planes: [new Float32Array(endFrame - startFrame), new Float32Array(endFrame - startFrame)],
    };
  };
  const sync = createSamplerBufferSync({ decodePages, createBuffer: () => buffer });
  const params = { ...createDefaultGranularParams(), zone };

  const first = sync.syncGranularTrack(engine, "granular-retry", params, "granular-instance");
  await firstStarted;
  const second = sync.syncGranularTrack(engine, "granular-retry", params, "granular-instance");
  await expect(first).rejects.toBeDefined();
  await second;
  expect(calls).toBe(2);
  expect(sync.snapshotGranularBuffer("granular-retry", {
    kind: "granular",
    instanceId: "granular-instance",
    params,
  })).toEqual({ assetKey: sampledInstrumentRegionIdentity(sample, sampledInstrumentRegion(sample.source, 0, 1)), ...sampled(buffer) });
  sync.dispose();
});

test("counts reusable Drum Rack regions in the complete resulting budget", async () => {
  const frames = 9_437_184;
  const source = { durationSec: frames, sampleRate: 1, channelCount: 1 };
  const firstSample = { ...sample, assetKey: "drum-budget-a", source };
  const secondSample = { ...sample, assetKey: "drum-budget-b", source };
  const firstPad = { ...createDefaultDrumRackParams().pads[0]!, sample: firstSample };
  const secondPad = { ...createDefaultDrumRackParams().pads[1]!, sample: secondSample };
  const firstParams = {
    ...createDefaultDrumRackParams(),
    pads: createDefaultDrumRackParams().pads.map((pad) => pad.id === firstPad.id ? firstPad : pad),
  };
  const secondParams = {
    ...firstParams,
    pads: firstParams.pads.map((pad) => pad.id === secondPad.id ? secondPad : pad),
  };
  const decodePages = async function* (
    _source: Blob | string | URL | Request,
    options?: { startFrame?: number; endFrame?: number },
  ): AsyncGenerator<DecodedAudioPage> {
    const startFrame = options?.startFrame ?? 0;
    const endFrame = options?.endFrame ?? frames;
    const frameCount = endFrame - startFrame;
    yield {
      startFrame,
      frameCount,
      sampleRate: 1,
      channelCount: 1,
      planes: [new Float32Array(frameCount)],
    };
  };
  const createBuffer = (_channels: number, length: number, sampleRate: number): AudioBuffer => ({
    duration: length / sampleRate,
    length,
    numberOfChannels: 1,
    sampleRate,
    copyFromChannel: () => {},
    copyToChannel: () => {},
    getChannelData: () => new Float32Array(length),
  });
  const engine = createEngine(new TestAudioBuffer());
  const sync = createDrumRackBufferSync({ decodePages, createBuffer });

  await sync.syncTrack(engine, "drum-budget", firstParams, "drum-instance");
  await expect(sync.syncTrack(engine, "drum-budget", secondParams, "drum-instance")).rejects.toThrow(
    `${DRUM_RACK_MAX_DECODED_BYTES} byte limit`,
  );
  sync.dispose();
});

test("permits sampler replacement after obsolete unpinned cache entries are evictable", async () => {
  const source = { durationSec: 2 / 48_000, sampleRate: 48_000, channelCount: 2 };
  const firstZone = { ...zone, id: "replace-first", sample: { ...sample, source }, startSec: 0, endSec: 1 / 48_000 };
  const secondZone = { ...zone, id: "replace-second", sample: { ...sample, source }, startSec: 1 / 48_000, endSec: 2 / 48_000 };
  const params = { ...createDefaultSamplerParams(), maxDecodedBytes: 8, zones: [firstZone] };
  const replacement = { ...params, zones: [secondZone] };
  const engine = createEngine(new TestAudioBuffer());
  const sync = createSamplerBufferSync({
    decodePages: decodeTestPages,
    createBuffer: (_channels, frames, sampleRate) => ({
      duration: frames / sampleRate,
      length: frames,
      numberOfChannels: 2,
      sampleRate,
      copyFromChannel: () => {},
      copyToChannel: () => {},
      getChannelData: () => new Float32Array(frames),
    }),
    resolveUrl: (url) => url,
  });

  await sync.syncTrack(engine, "sampler-replace", params, "sampler-instance");
  await sync.syncTrack(engine, "sampler-replace", replacement, "sampler-instance");
  expect(sync.getStatus("sampler-replace").totalBytes).toBe(8);
  expect(sync.snapshotSamplerBuffers("sampler-replace", {
    kind: "sampler",
    instanceId: "sampler-instance",
    params: replacement,
  })?.has(secondZone.id)).toBe(true);
  sync.dispose();
});

test("refuses sampler replacement while an obsolete region is pinned", async () => {
  const source = { durationSec: 2 / 48_000, sampleRate: 48_000, channelCount: 2 };
  const firstZone = { ...zone, id: "pinned-first", sample: { ...sample, source }, startSec: 0, endSec: 1 / 48_000 };
  const secondZone = { ...zone, id: "pinned-second", sample: { ...sample, source }, startSec: 1 / 48_000, endSec: 2 / 48_000 };
  const params = { ...createDefaultSamplerParams(), maxDecodedBytes: 8, zones: [firstZone] };
  const replacement = { ...params, zones: [secondZone] };
  const engine = createEngine(new TestAudioBuffer());
  const sync = createSamplerBufferSync({
    decodePages: decodeTestPages,
    createBuffer: (_channels, frames, sampleRate) => ({
      duration: frames / sampleRate,
      length: frames,
      numberOfChannels: 2,
      sampleRate,
      copyFromChannel: () => {},
      copyToChannel: () => {},
      getChannelData: () => new Float32Array(frames),
    }),
    resolveUrl: (url) => url,
  });

  await sync.syncTrack(engine, "sampler-pinned", params, "sampler-instance");
  const firstKey = sampledInstrumentRegionIdentity(
    firstZone.sample,
    sampledInstrumentRegion(firstZone.sample.source, firstZone.startSec, firstZone.endSec),
  );
  engine.emitSamplerRegionUse({ trackId: "sampler-pinned", regionKey: firstKey, voiceId: 1, active: true });
  await expect(sync.syncTrack(engine, "sampler-pinned", replacement, "sampler-instance")).rejects.toThrow("byte limit");
  sync.dispose();
});

test("refreshes the runtime sampler map when releasing pinned regions evicts them", async () => {
  const source = { durationSec: 2, sampleRate: 1, channelCount: 2 };
  const firstZone = { ...zone, id: "runtime-first", sample: { ...sample, assetKey: "runtime-first", source }, startSec: 0, endSec: 1 };
  const secondZone = { ...zone, id: "runtime-second", sample: { ...sample, assetKey: "runtime-second", source }, startSec: 1, endSec: 2 };
  const params = { ...createDefaultSamplerParams(), cachePolicy: "lazy" as const, maxDecodedBytes: 16, zones: [firstZone, secondZone] };
  const constrained = { ...params, maxDecodedBytes: 8 };
  const decodePages = async function* (
    _source: Blob | string | URL | Request,
    options?: { startFrame?: number; endFrame?: number },
  ): AsyncGenerator<DecodedAudioPage> {
    const startFrame = options?.startFrame ?? 0;
    const endFrame = options?.endFrame ?? startFrame + 1;
    yield {
      startFrame,
      frameCount: endFrame - startFrame,
      sampleRate: 1,
      channelCount: 2,
      planes: [new Float32Array(endFrame - startFrame), new Float32Array(endFrame - startFrame)],
    };
  };
  const createBuffer = (_channels: number, frames: number, sampleRate: number): AudioBuffer => ({
    duration: frames / sampleRate,
    length: frames,
    numberOfChannels: 2,
    sampleRate,
    copyFromChannel: () => {},
    copyToChannel: () => {},
    getChannelData: () => new Float32Array(frames),
  });
  const engine = createEngine(new TestAudioBuffer());
  const sync = createSamplerBufferSync({ decodePages, createBuffer });

  await sync.syncTrack(engine, "runtime-eviction", params, "sampler-instance");
  await sync.retryZone(engine, "runtime-eviction", firstZone.id);
  await sync.retryZone(engine, "runtime-eviction", secondZone.id);
  const firstKey = sampledInstrumentRegionIdentity(firstZone.sample, sampledInstrumentRegion(firstZone.sample.source, 0, 1));
  const secondKey = sampledInstrumentRegionIdentity(secondZone.sample, sampledInstrumentRegion(secondZone.sample.source, 1, 2));
  engine.emitSamplerRegionUse({ trackId: "runtime-eviction", regionKey: firstKey, voiceId: 1, active: true });
  engine.emitSamplerRegionUse({ trackId: "runtime-eviction", regionKey: firstKey, voiceId: 2, active: true });
  engine.emitSamplerRegionUse({ trackId: "runtime-eviction", regionKey: secondKey, voiceId: 3, active: true });
  await sync.syncTrack(engine, "runtime-eviction", constrained, "sampler-instance");
  expect(engine.samplerBufferIds("runtime-eviction")).toEqual([firstZone.id, secondZone.id]);
  engine.emitSamplerRegionUse({ trackId: "runtime-eviction", regionKey: firstKey, voiceId: 1, active: false });
  expect(engine.samplerBufferIds("runtime-eviction")).toEqual([firstZone.id, secondZone.id]);
  engine.emitSamplerRegionUse({ trackId: "runtime-eviction", regionKey: firstKey, voiceId: 2, active: false });
  expect(engine.samplerBufferIds("runtime-eviction")).toEqual([secondZone.id]);
  engine.emitSamplerRegionUse({ trackId: "runtime-eviction", regionKey: secondKey, voiceId: 3, active: false });
  engine.emitSamplerNoteMiss({
    trackId: "runtime-eviction",
    zoneId: firstZone.id,
    assetKey: firstZone.sample.assetKey,
    url: firstZone.sample.url,
  });
  await sync.retryZone(engine, "runtime-eviction", firstZone.id);
  expect(engine.samplerBufferIds("runtime-eviction")).toEqual([firstZone.id]);
  sync.dispose();
});

test("records a sampler note-miss load failure without an unhandled rejection", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const sync = createSamplerBufferSync({
    decodePages: async function* () {
      for (const page of [] satisfies readonly DecodedAudioPage[]) yield page;
      throw new Error("decode failed");
    },
    createBuffer: () => buffer,
  });
  const params = { ...createDefaultSamplerParams(), cachePolicy: "lazy" as const, zones: [zone] };
  const unhandled: TestRejectionReason[] = [];
  const onUnhandledRejection = (reason: TestRejectionReason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await sync.syncTrack(engine, "sampler-note-miss-error", params, "sampler-instance");
    const failed = new Promise<void>((resolve) => {
      const unsubscribe = sync.subscribe(() => {
        if (sync.getStatus("sampler-note-miss-error").zones.get(zone.id) !== "error") return;
        unsubscribe();
        resolve();
      });
    });
    engine.emitSamplerNoteMiss({
      trackId: "sampler-note-miss-error",
      zoneId: zone.id,
      assetKey: zone.sample.assetKey,
      url: zone.sample.url,
    });
    await failed;
    expect(sync.getStatus("sampler-note-miss-error").zones.get(zone.id)).toBe("error");
    expect(unhandled).toEqual([]);
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    sync.dispose();
  }
});

test("does not overwrite newer sampler state when a note-miss load is aborted", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const sync = createSamplerBufferSync({
    decodePages: async function* (
      _source: Blob | string | URL | Request,
      options?: { startFrame?: number; endFrame?: number; signal?: AbortSignal },
    ) {
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      options?.signal?.throwIfAborted();
      const startFrame = options?.startFrame ?? 0;
      const endFrame = options?.endFrame ?? startFrame + 1;
      yield {
        startFrame,
        frameCount: endFrame - startFrame,
        sampleRate: 48_000,
        channelCount: 2,
        planes: [new Float32Array(endFrame - startFrame), new Float32Array(endFrame - startFrame)],
      };
    },
    createBuffer: () => buffer,
  });
  const firstParams = { ...createDefaultSamplerParams(), cachePolicy: "lazy" as const, zones: [zone] };
  const secondZone = { ...zone, id: "newer-zone" };
  const secondParams = { ...firstParams, zones: [secondZone] };

  await sync.syncTrack(engine, "sampler-note-miss-stale", firstParams, "sampler-instance");
  engine.emitSamplerNoteMiss({
    trackId: "sampler-note-miss-stale",
    zoneId: zone.id,
    assetKey: zone.sample.assetKey,
    url: zone.sample.url,
  });
  await sync.syncTrack(engine, "sampler-note-miss-stale", secondParams, "sampler-instance");

  expect(sync.getStatus("sampler-note-miss-stale").zones).toEqual(new Map([[secondZone.id, "missing"]]));
  sync.dispose();
});

test("records a granular retry failure without an unhandled rejection", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const sync = createSamplerBufferSync({
    decodePages: async function* () {
      for (const page of [] satisfies readonly DecodedAudioPage[]) yield page;
      throw new Error("decode failed");
    },
    createBuffer: () => buffer,
  });
  const params = { ...createDefaultGranularParams(), zone };
  const unhandled: TestRejectionReason[] = [];
  const onUnhandledRejection = (reason: TestRejectionReason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await expect(sync.syncGranularTrack(engine, "granular-retry-error", params, "granular-instance")).rejects.toBeDefined();
    const failed = new Promise<void>((resolve) => {
      const unsubscribe = sync.subscribe(() => {
        if (sync.getGranularStatus("granular-retry-error").state !== "error") return;
        unsubscribe();
        resolve();
      });
    });
    sync.retryGranular(engine, "granular-retry-error");
    await failed;
    expect(sync.getGranularStatus("granular-retry-error").state).toBe("error");
    expect(unhandled).toEqual([]);
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    sync.dispose();
  }
});

test("does not reuse a Drum Rack snapshot when only the sampled region changes", async () => {
  const regionBuffer = (sourceStartFrame: number): SampledInstrumentBuffer => ({
    sourceStartFrame,
    buffer: {
      duration: 0.5,
      length: 24_000,
      numberOfChannels: 2,
      sampleRate: 48_000,
      copyFromChannel: () => {},
      copyToChannel: () => {},
      getChannelData: () => new Float32Array(24_000),
    },
  });
  const firstBuffer = regionBuffer(0);
  const secondBuffer = regionBuffer(24_000);
  const firstPad = {
    ...createDefaultDrumRackParams().pads[0]!,
    sample,
    startSec: 0,
    endSec: 0.5,
  };
  const secondPad = { ...firstPad, startSec: 0.5, endSec: 1 };
  const firstParams = {
    ...createDefaultDrumRackParams(),
    pads: createDefaultDrumRackParams().pads.map((pad) => pad.id === firstPad.id ? firstPad : pad),
  };
  const secondParams = {
    ...firstParams,
    pads: firstParams.pads.map((pad) => pad.id === secondPad.id ? secondPad : pad),
  };
  const engine = createEngine(firstBuffer.buffer);
  let decodedStartFrame = 0;
  const sync = createDrumRackBufferSync({
    decodePages: async function* (
      _source: Blob | string | URL | Request,
      options?: { startFrame?: number; endFrame?: number },
    ): AsyncGenerator<DecodedAudioPage> {
      const startFrame = options?.startFrame ?? 0;
      const endFrame = options?.endFrame ?? startFrame + 1;
      decodedStartFrame = startFrame;
      yield {
        startFrame,
        frameCount: endFrame - startFrame,
        sampleRate: 48_000,
        channelCount: 2,
        planes: [new Float32Array(endFrame - startFrame), new Float32Array(endFrame - startFrame)],
      };
    },
    createBuffer: () => decodedStartFrame === 0 ? firstBuffer.buffer : secondBuffer.buffer,
  });

  await sync.syncTrack(engine, "drum-region-snapshot", firstParams, "drum-instance");
  expect(sync.snapshotBuffers("drum-region-snapshot", {
    kind: "drum-rack",
    instanceId: "drum-instance",
    params: secondParams,
  })).toBeUndefined();
  await sync.syncTrack(engine, "drum-region-snapshot", secondParams, "drum-instance");
  expect(sync.snapshotBuffers("drum-region-snapshot", {
    kind: "drum-rack",
    instanceId: "drum-instance",
    params: secondParams,
  })).toEqual(new Map([[secondPad.id, secondBuffer]]));
  sync.dispose();
});

test("evicts inactive sampled regions across tracks within the aggregate budget", async () => {
  const source = { durationSec: 2, sampleRate: 1, channelCount: 1 };
  const firstZone = { ...zone, id: "aggregate-first", sample: { ...sample, assetKey: "aggregate-first", source }, startSec: 0, endSec: 1 };
  const secondZone = { ...zone, id: "aggregate-second", sample: { ...sample, assetKey: "aggregate-second", source }, startSec: 1, endSec: 2 };
  const decodePages = async function* (
    _source: Blob | string | URL | Request,
    options?: { startFrame?: number; endFrame?: number },
  ): AsyncGenerator<DecodedAudioPage> {
    const startFrame = options?.startFrame ?? 0;
    const endFrame = options?.endFrame ?? startFrame + 1;
    yield { startFrame, frameCount: endFrame - startFrame, sampleRate: 1, channelCount: 1, planes: [new Float32Array(endFrame - startFrame)] };
  };
  const createBuffer = (_channels: number, frames: number, sampleRate: number): AudioBuffer => ({
    duration: frames / sampleRate,
    length: frames,
    numberOfChannels: 1,
    sampleRate,
    copyFromChannel: () => {},
    copyToChannel: () => {},
    getChannelData: () => new Float32Array(frames),
  });
  const engine = createEngine(new TestAudioBuffer());
  const sync = createSamplerBufferSync({
    aggregateBudget: createSampledInstrumentRegionBudget(4),
    decodePages,
    createBuffer,
  });
  const firstParams = { ...createDefaultSamplerParams(), maxDecodedBytes: 4, zones: [firstZone] };
  const secondParams = { ...createDefaultSamplerParams(), maxDecodedBytes: 4, zones: [secondZone] };

  await sync.syncTrack(engine, "aggregate-track-a", firstParams, "instance-a");
  expect(sync.getStatus("aggregate-track-a").zones.get(firstZone.id)).toBe("ready");
  let samplerMissingNotifications = 0;
  const unsubscribe = sync.subscribe(() => {
    if (sync.getStatus("aggregate-track-a").zones.get(firstZone.id) === "missing") samplerMissingNotifications += 1;
  });
  await sync.syncTrack(engine, "aggregate-track-b", secondParams, "instance-b");

  expect(sync.getStatus("aggregate-track-a").totalBytes).toBe(0);
  expect(sync.getStatus("aggregate-track-a").zones.get(firstZone.id)).toBe("missing");
  expect(sync.getStatus("aggregate-track-b").totalBytes).toBe(4);
  expect(engine.samplerBufferIds("aggregate-track-a")).toEqual([]);
  expect(engine.samplerBufferIds("aggregate-track-b")).toEqual([secondZone.id]);
  expect(samplerMissingNotifications).toBeGreaterThan(0);
  await sync.retryZone(engine, "aggregate-track-a", firstZone.id);
  expect(sync.getStatus("aggregate-track-a").zones.get(firstZone.id)).toBe("ready");
  expect(engine.samplerBufferIds("aggregate-track-a")).toEqual([firstZone.id]);
  unsubscribe();
  sync.dispose();
});

test("clears granular state and runtime buffer when another track evicts it", async () => {
  const source = { durationSec: 2, sampleRate: 1, channelCount: 1 };
  const granularZone = { ...zone, id: "aggregate-granular", sample: { ...sample, assetKey: "aggregate-granular", source }, startSec: 0, endSec: 1 };
  const samplerZone = { ...zone, id: "aggregate-reload", sample: { ...sample, assetKey: "aggregate-reload", source }, startSec: 0, endSec: 1 };
  const decodePages = async function* (
    _source: Blob | string | URL | Request,
    options?: { startFrame?: number; endFrame?: number },
  ): AsyncGenerator<DecodedAudioPage> {
    const startFrame = options?.startFrame ?? 0;
    const endFrame = options?.endFrame ?? startFrame + 1;
    yield { startFrame, frameCount: endFrame - startFrame, sampleRate: 1, channelCount: 1, planes: [new Float32Array(endFrame - startFrame)] };
  };
  const createBuffer = (_channels: number, frames: number, sampleRate: number): AudioBuffer => ({
    duration: frames / sampleRate,
    length: frames,
    numberOfChannels: 1,
    sampleRate,
    copyFromChannel: () => {},
    copyToChannel: () => {},
    getChannelData: () => new Float32Array(frames),
  });
  const aggregate = createSampledInstrumentRegionBudget(8);
  const engine = createEngine(new TestAudioBuffer());
  const sync = createSamplerBufferSync({ aggregateBudget: aggregate, decodePages, createBuffer });
  const granularParams = { ...createDefaultGranularParams(), maxDecodedBytes: 4, zone: granularZone };
  const samplerParams = { ...createDefaultSamplerParams(), maxDecodedBytes: 4, zones: [samplerZone] };
  await sync.syncGranularTrack(engine, "aggregate-granular-track", granularParams, "granular-instance");
  expect(sync.getGranularStatus("aggregate-granular-track").state).toBe("ready");
  expect(engine.granularBuffer("aggregate-granular-track")).toBeDefined();
  let granularMissingNotifications = 0;
  const unsubscribe = sync.subscribe(() => {
    if (sync.getGranularStatus("aggregate-granular-track").state === "missing") granularMissingNotifications += 1;
  });
  await sync.syncGranularTrack(
    engine,
    "aggregate-granular-track",
    { ...granularParams, zone: undefined },
    "granular-instance",
  );
  await sync.syncTrack(engine, "aggregate-sampler-track", samplerParams, "sampler-instance");

  expect(sync.getGranularStatus("aggregate-granular-track").state).toBe("missing");
  expect(engine.granularBuffer("aggregate-granular-track")).toBeUndefined();
  expect(granularMissingNotifications).toBeGreaterThan(0);
  await sync.syncGranularTrack(engine, "aggregate-granular-track", granularParams, "granular-instance");
  expect(sync.getGranularStatus("aggregate-granular-track").state).toBe("ready");
  expect(engine.granularBuffer("aggregate-granular-track")).toBeDefined();
  unsubscribe();
  sync.dispose();
});

test("disposes pinned granular cache and aggregate handles before clearing entries", async () => {
  const source = { durationSec: 1, sampleRate: 1, channelCount: 1 };
  const granularZone = { ...zone, id: "dispose-granular", sample: { ...sample, assetKey: "dispose-granular", source }, startSec: 0, endSec: 1 };
  const buffer: AudioBuffer = {
    duration: 1,
    length: 1,
    numberOfChannels: 1,
    sampleRate: 1,
    copyFromChannel: () => {},
    copyToChannel: () => {},
    getChannelData: () => new Float32Array(1),
  };
  const aggregate = createSampledInstrumentRegionBudget(8);
  const engine = createEngine(buffer);
  const sync = createSamplerBufferSync({
    aggregateBudget: aggregate,
    decodePages: async function* (
      _source: Blob | string | URL | Request,
      options?: { startFrame?: number; endFrame?: number },
    ): AsyncGenerator<DecodedAudioPage> {
      const startFrame = options?.startFrame ?? 0;
      const endFrame = options?.endFrame ?? 1;
      yield { startFrame, frameCount: endFrame - startFrame, sampleRate: 1, channelCount: 1, planes: [new Float32Array(endFrame - startFrame)] };
    },
    createBuffer: () => buffer,
  });
  const params = { ...createDefaultGranularParams(), maxDecodedBytes: 4, zone: granularZone };

  await sync.syncGranularTrack(engine, "dispose-granular", params, "granular-instance");
  expect(aggregate.totalBytes()).toBe(8);
  sync.dispose();
  expect(aggregate.totalBytes()).toBe(0);
  sync.dispose();
  expect(aggregate.totalBytes()).toBe(0);
});

test("rejects a pinned aggregate region until release makes capacity available", async () => {
  const source = { durationSec: 2, sampleRate: 1, channelCount: 1 };
  const firstZone = { ...zone, id: "aggregate-pinned-first", sample: { ...sample, assetKey: "aggregate-pinned-first", source }, startSec: 0, endSec: 1 };
  const secondZone = { ...zone, id: "aggregate-pinned-second", sample: { ...sample, assetKey: "aggregate-pinned-second", source }, startSec: 1, endSec: 2 };
  const decodePages = async function* (
    _source: Blob | string | URL | Request,
    options?: { startFrame?: number; endFrame?: number },
  ): AsyncGenerator<DecodedAudioPage> {
    const startFrame = options?.startFrame ?? 0;
    const endFrame = options?.endFrame ?? startFrame + 1;
    yield { startFrame, frameCount: endFrame - startFrame, sampleRate: 1, channelCount: 1, planes: [new Float32Array(endFrame - startFrame)] };
  };
  const createBuffer = (_channels: number, frames: number, sampleRate: number): AudioBuffer => ({
    duration: frames / sampleRate,
    length: frames,
    numberOfChannels: 1,
    sampleRate,
    copyFromChannel: () => {},
    copyToChannel: () => {},
    getChannelData: () => new Float32Array(frames),
  });
  const engine = createEngine(new TestAudioBuffer());
  const sync = createSamplerBufferSync({
    aggregateBudget: createSampledInstrumentRegionBudget(4),
    decodePages,
    createBuffer,
  });
  const firstParams = { ...createDefaultSamplerParams(), maxDecodedBytes: 4, zones: [firstZone] };
  const secondParams = { ...createDefaultSamplerParams(), maxDecodedBytes: 4, zones: [secondZone] };
  await sync.syncTrack(engine, "aggregate-pinned-a", firstParams, "instance-a");
  const firstKey = sampledInstrumentRegionIdentity(firstZone.sample, sampledInstrumentRegion(source, 0, 1));
  engine.emitSamplerRegionUse({ trackId: "aggregate-pinned-a", regionKey: firstKey, voiceId: 1, active: true });
  await expect(sync.syncTrack(engine, "aggregate-pinned-b", secondParams, "instance-b")).rejects.toThrow("aggregate limit");
  engine.emitSamplerRegionUse({ trackId: "aggregate-pinned-a", regionKey: firstKey, voiceId: 1, active: false });
  await sync.syncTrack(engine, "aggregate-pinned-b", secondParams, "instance-b");
  expect(engine.samplerBufferIds("aggregate-pinned-a")).toEqual([]);
  expect(engine.samplerBufferIds("aggregate-pinned-b")).toEqual([secondZone.id]);
  sync.dispose();
});

test("invalidates live sampler reuse when the persisted source descriptor changes", async () => {
  const source = { durationSec: 1, sampleRate: 1, channelCount: 1 };
  const oldSample = { ...sample, assetKey: "same-asset", url: "/old.wav", source };
  const newSample = { ...oldSample, url: "/new.wav" };
  const oldZone = { ...zone, id: "identity-zone", sample: oldSample, endSec: 1 };
  const newZone = { ...oldZone, sample: newSample };
  let decodeCalls = 0;
  const decodePages = async function* (
    input: Blob | string | URL | Request,
    options?: { startFrame?: number; endFrame?: number },
  ): AsyncGenerator<DecodedAudioPage> {
    decodeCalls += 1;
    const startFrame = options?.startFrame ?? 0;
    const endFrame = options?.endFrame ?? 1;
    yield {
      startFrame,
      frameCount: endFrame - startFrame,
      sampleRate: 1,
      channelCount: 1,
      planes: [Float32Array.of(String(input).includes("new") ? 2 : 1)],
    };
  };
  const buffers = new Map<string, Float32Array>();
  const createBuffer = (_channels: number, frames: number, sampleRate: number): AudioBuffer => {
    const data = new Float32Array(frames);
    const id = `buffer-${buffers.size}`;
    buffers.set(id, data);
    return {
      duration: frames / sampleRate,
      length: frames,
      numberOfChannels: 1,
      sampleRate,
      copyFromChannel: () => {},
      copyToChannel: () => {},
      getChannelData: () => data,
    };
  };
  const engine = createEngine(new TestAudioBuffer());
  const sync = createSamplerBufferSync({ decodePages, createBuffer });
  const firstParams = { ...createDefaultSamplerParams(), zones: [oldZone] };
  const secondParams = { ...firstParams, zones: [newZone] };

  await sync.syncTrack(engine, "identity-track", firstParams, "identity-instance");
  await sync.syncTrack(engine, "identity-track", secondParams, "identity-instance");

  expect(decodeCalls).toBe(2);
  const resolved = sync.snapshotSamplerBuffers("identity-track", {
    kind: "sampler",
    instanceId: "identity-instance",
    params: secondParams,
  })?.get(newZone.id);
  expect(resolved?.buffer.getChannelData(0)[0]).toBe(2);
  sync.dispose();
});

test("shares the live aggregate budget across multiple Drum Racks and instrument kinds", async () => {
  const source = { durationSec: 2, sampleRate: 1, channelCount: 1 };
  const firstSample = { ...sample, assetKey: "rack-a", source };
  const secondSample = { ...sample, assetKey: "rack-b", source };
  const makeDrum = (sampleValue: typeof firstSample) => ({
    ...createDefaultDrumRackParams(),
    pads: createDefaultDrumRackParams().pads.map((pad) => pad.id === "pad-36" ? { ...pad, sample: sampleValue, startSec: 0, endSec: 1 } : pad),
  });
  const makeSampler = (sampleValue: typeof firstSample) => ({
    ...createDefaultSamplerParams(),
    maxDecodedBytes: 4,
    zones: [{ ...zone, sample: sampleValue, startSec: 0, endSec: 1 }],
  });
  const decodePages = async function* (
    _source: Blob | string | URL | Request,
    options?: { startFrame?: number; endFrame?: number },
  ): AsyncGenerator<DecodedAudioPage> {
    const startFrame = options?.startFrame ?? 0;
    const endFrame = options?.endFrame ?? startFrame + 1;
    yield { startFrame, frameCount: endFrame - startFrame, sampleRate: 1, channelCount: 1, planes: [new Float32Array(endFrame - startFrame)] };
  };
  const createBuffer = (_channels: number, frames: number, sampleRate: number): AudioBuffer => ({
    duration: frames / sampleRate,
    length: frames,
    numberOfChannels: 1,
    sampleRate,
    copyFromChannel: () => {},
    copyToChannel: () => {},
    getChannelData: () => new Float32Array(frames),
  });
  const aggregate = createSampledInstrumentRegionBudget(8);
  const engine = createEngine(new TestAudioBuffer());
  const samplerSync = createSamplerBufferSync({ aggregateBudget: aggregate, decodePages, createBuffer });
  const drumSync = createDrumRackBufferSync({ aggregateBudget: aggregate, decodePages, createBuffer });

  await samplerSync.syncTrack(engine, "aggregate-sampler", makeSampler(firstSample), "sampler-instance");
  await drumSync.syncTrack(engine, "aggregate-drum-a", makeDrum(secondSample), "drum-instance-a");
  expect(aggregate.totalBytes()).toBe(8);
  expect(samplerSync.snapshotSamplerBuffers("aggregate-sampler", {
    kind: "sampler",
    instanceId: "sampler-instance",
    params: makeSampler(firstSample),
  })).toBeDefined();

  await drumSync.syncTrack(engine, "aggregate-drum-b", makeDrum(firstSample), "drum-instance-b");
  expect(aggregate.totalBytes()).toBe(8);
  expect(drumSync.snapshotBuffers("aggregate-drum-a", {
    kind: "drum-rack",
    instanceId: "drum-instance-a",
    params: makeDrum(secondSample),
  })).toBeUndefined();

  samplerSync.dispose();
  drumSync.dispose();
  expect(aggregate.totalBytes()).toBe(0);
});

test("pins active Drum Rack regions in the shared aggregate budget", async () => {
  const source = { durationSec: 2, sampleRate: 1, channelCount: 1 };
  const firstSample = { ...sample, assetKey: "pinned-rack-a", source };
  const secondSample = { ...sample, assetKey: "pinned-rack-b", source };
  const makeDrum = (sampleValue: typeof firstSample) => ({
    ...createDefaultDrumRackParams(),
    pads: createDefaultDrumRackParams().pads.map((pad) => pad.id === "pad-36" ? { ...pad, sample: sampleValue, startSec: 0, endSec: 1 } : pad),
  });
  const decodePages = async function* (
    _source: Blob | string | URL | Request,
    options?: { startFrame?: number; endFrame?: number },
  ): AsyncGenerator<DecodedAudioPage> {
    const startFrame = options?.startFrame ?? 0;
    const endFrame = options?.endFrame ?? startFrame + 1;
    yield { startFrame, frameCount: endFrame - startFrame, sampleRate: 1, channelCount: 1, planes: [new Float32Array(endFrame - startFrame)] };
  };
  const createBuffer = (_channels: number, frames: number, sampleRate: number): AudioBuffer => ({
    duration: frames / sampleRate,
    length: frames,
    numberOfChannels: 1,
    sampleRate,
    copyFromChannel: () => {},
    copyToChannel: () => {},
    getChannelData: () => new Float32Array(frames),
  });
  const aggregate = createSampledInstrumentRegionBudget(4);
  const engine = createEngine(new TestAudioBuffer());
  const sync = createDrumRackBufferSync({ aggregateBudget: aggregate, decodePages, createBuffer });
  await sync.syncTrack(engine, "pinned-rack", makeDrum(firstSample), "instance");
  const regionKey = sampledInstrumentRegionIdentity(firstSample, sampledInstrumentRegion(source, 0, 1));
  engine.emitDrumRackRegionUse({ trackId: "pinned-rack", regionKey, hitId: 1, active: true });
  engine.emitDrumRackRegionUse({ trackId: "pinned-rack", regionKey, hitId: 2, active: true });
  await expect(sync.syncTrack(engine, "other-rack", makeDrum(secondSample), "other")).rejects.toThrow("aggregate limit");
  engine.emitDrumRackRegionUse({ trackId: "pinned-rack", regionKey, hitId: 1, active: false });
  await expect(sync.syncTrack(engine, "other-rack", makeDrum(secondSample), "other")).rejects.toThrow("aggregate limit");
  engine.emitDrumRackRegionUse({ trackId: "pinned-rack", regionKey, hitId: 2, active: false });
  expect(aggregate.totalBytes()).toBe(4);
  await sync.syncTrack(engine, "other-rack", makeDrum(secondSample), "other");
  expect(sync.snapshotBuffers("pinned-rack", {
    kind: "drum-rack",
    instanceId: "instance",
    params: makeDrum(firstSample),
  })).toBeUndefined();
  sync.dispose();
});
