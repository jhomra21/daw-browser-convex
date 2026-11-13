import { afterEach, beforeAll, expect, test } from "bun:test";
import "fake-indexeddb/auto";
import { readFile } from "node:fs/promises";
import { batch, createComponent, createRoot, createSignal, untrack } from "solid-js";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import { createDefaultArpeggiatorParams, createDefaultDrumRackParams, createDefaultGranularParams, createDefaultSamplerParams, createDefaultSynthParams, createDefaultUtilityParams, normalizeTrackInstrumentParams, type ArpeggiatorParams, type DecodedAudioPage, type DrumRackParams, type GranularParams, type SamplerParams, type TrackInstrumentParams } from "@daw-browser/shared";
import { createDrumRackBufferSync } from "~/lib/drum-rack-buffer-sync";
import { DRUM_RACK_MAX_DECODED_BYTES } from "@daw-browser/audio-engine/drum-rack-runtime";
import type { ExportRenderStateSnapshot } from "~/lib/export/run-export-job";
import { createEffectsPanelController, hydrateInstrumentBuffers, type EffectsPanelController, type EffectsPanelExportSnapshot } from "~/components/timeline/create-effects-panel-controller";
import { deleteLocalEffect, getLocalEffect, setLocalEffect, setLocalEffectInstance } from "~/lib/local-effects";
import { ParameterGestureHolder } from "~/components/timeline/parameter-gesture-owner";
import type { Track } from "@daw-browser/timeline-core/types";
import type { ExportEffectsProjection } from "~/lib/export/export-effect-rows";
import { compileLivePlaybackSnapshot } from "~/lib/live-playback-snapshot";
import type { LocalAssetBytesResult } from "~/lib/local-assets";
import { createSamplerBufferSync } from "~/lib/sampler-buffer-sync";
import { compileLiveNativeInstrumentConfigurations, compileLiveNativeProjection } from "@daw-browser/audio-engine/live-native-projection";
import { localizeInstrumentFx } from "@daw-browser/audio-engine/portable-export-snapshot";
import { nativeInstrumentContentKey, type PublicationJoin } from "~/lib/live-processor-control";
import { SampledInstrumentSyncSupersededError } from "~/lib/sampled-instrument-sync-error";
import { createSampledInstrumentRegionBudget } from "~/lib/sampled-instrument-region-budget";
import { sampledInstrumentRegion, sampledInstrumentRegionIdentity, type SampledInstrumentBuffer } from "@daw-browser/audio-engine/sampled-instrument-region";
import { createGranularRuntime, type GranularWorkletControlMessage } from "../../packages/audio-engine/src/granular-runtime";
import { createPendingWorkOwner } from "~/hooks/useEffectsPanelAudioSync";
import { extractTimelineBindings } from "~/lib/timeline-source-test-support";
import { createAudioPcmSourceDescriptor } from "@daw-browser/audio-engine/media-pages";
import { createNativeTimelinePageManager } from "~/lib/desktop/native-timeline-page-manager";
import { createFxTestAudio } from "../../packages/audio-engine/src/fx-runtime-test-audio";
import { createInstrumentRuntime } from "../../packages/audio-engine/src/instrument-runtime";
import { createSourceRegistry } from "../../packages/audio-engine/src/source-registry";
import { b5AgentCommit, b5CloudDatabase, b5EffectsSubscription, b5HistoryDeps, b5HistoryTransport } from "~/lib/b5-coverage-test-support";
import { execRedo, execUndo } from "~/lib/undo/exec";
import type { HistoryEntry } from "~/lib/undo/types";
import { createLocalProject, openLocalProjectDb } from "~/lib/local-project-db";
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository";
import { convexApi, convexClient } from "~/lib/convex";
import { createExportRenderStateSnapshot, resolveDesiredPlaybackFx } from "~/lib/export/run-export-job";
import { mountStep5Playback, settleStep5Playback } from "../../tools/acceptance/b5c-playback-witness-support";

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

// This suite supplies every cloud row/commit locally. Close the eager fixture
// socket before tests so its asynchronous fatal reply cannot interrupt a cell.
beforeAll(async () => { await convexClient.close(); });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

class TestAudioEngine extends AudioEngine {
  private samplerRuntimeListeners: Parameters<AudioEngine["setSamplerRuntimeListeners"]>[0] = {};
  private readonly samplerBuffers = new Map<string, ReadonlyMap<string, SampledInstrumentBuffer>>();
  private readonly drumRackBuffers = new Map<string, ReadonlyMap<string, SampledInstrumentBuffer>>();
  private readonly granularBuffers = new Map<string, Parameters<AudioEngine["setTrackGranular"]>[2]>();

  constructor(private readonly buffer: AudioBuffer) {
    super();
  }

  override decodeAudioData() {
    return Promise.resolve(this.buffer);
  }

  samplerInstalls = 0;

  override setTrackSampler(trackId: string, _params: SamplerParams, buffers?: ReadonlyMap<string, SampledInstrumentBuffer>) {
    this.samplerInstalls += 1;
    this.samplerBuffers.set(trackId, buffers ?? new Map());
  }
  override getTrackInstrumentKind(trackId: string) {
    return this.samplerBuffers.has(trackId) ? "sampler" : undefined;
  }
  override clearTrackInstrument(trackId: string) {
    this.samplerBuffers.delete(trackId);
  }
  override setTrackDrumRack(trackId: string, _params: DrumRackParams, buffers?: ReadonlyMap<string, SampledInstrumentBuffer>): ReturnType<AudioEngine["setTrackDrumRack"]> {
    this.drumRackBuffers.set(trackId, buffers ?? new Map());
    return "applied";
  }
  override setTrackGranular(trackId: string, _params: GranularParams, installedBuffer?: Parameters<AudioEngine["setTrackGranular"]>[2]): ReturnType<AudioEngine["setTrackGranular"]> {
    this.granularBuffers.set(trackId, installedBuffer);
    return Promise.resolve("applied");
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

  drumRackBufferIds(trackId: string) {
    return [...(this.drumRackBuffers.get(trackId)?.keys() ?? [])];
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

test("B5c sampled to synth clears the old cache, local track, closed and unselected", async () => {
  // Failure modes: readiness resolves before PCM, hydration omits the buffer,
  // the owner misses the unselected row, or switching leaves the sampled cache alive.
  const projectId = `project:b5c-kind-switch-${crypto.randomUUID()}`;
  const track: Track = { id: "sampled-track", kind: "instrument", name: "Unselected", volume: 1, clips: [] };
  const initial = normalizeTrackInstrumentParams({
    kind: "sampler", instanceId: "old-sampler",
    params: { ...createDefaultSamplerParams(), zones: [zone] },
  });
  if (!initial || initial.kind !== "sampler") throw new Error("Invalid B5c sampler fixture");
  const next: TrackInstrumentParams = {
    kind: "synth", instanceId: "new-synth", params: { ...createDefaultSynthParams(), gain: 0.37 },
  };
  await setLocalEffect(projectId, track.id, "instrument", initial);
  const audio = createFxTestAudio();
  const createGain = audio.context.createGain;
  const synthGains: { value: number }[] = [];
  const context = Object.assign(audio.context, {
    createStereoPanner: () => {
      const node = createGain();
      return Object.assign(node, { pan: node.gain });
    },
    createGain: () => {
      const node = createGain();
      const gain = {
        value: 1,
        cancelScheduledValues: () => {},
        setValueAtTime(value: number) { this.value = value; },
        setTargetAtTime(value: number) { this.value = value; },
      };
      synthGains.push(gain);
      return { connect: node.connect, disconnect: node.disconnect, gain };
    },
  });
  const runtime = createInstrumentRuntime({
    ensureAudio: () => {}, getAudioContext: () => context, getBpm: () => 120,
    timelineToCtxTime: value => value, ensureTrackInput: () => audio.masterInput,
    sources: createSourceRegistry(),
  });
  const calls: { family: string; disposition?: string }[] = [];
  class InstrumentEngine extends AudioEngine {
    override setTrackSampler(...args: Parameters<AudioEngine["setTrackSampler"]>) {
      calls.push({ family: "sampler", disposition: "applied" });
      runtime.setTrackSampler(...args);
    }
    override setTrackInstrument(...args: Parameters<AudioEngine["setTrackInstrument"]>) {
      const disposition = runtime.setTrackInstrument(...args);
      calls.push({ family: args[1].instrument.kind, disposition });
      return disposition;
    }
    override getTrackInstrumentKind(id: string) { return runtime.getTrackInstrumentKind(id); }
    override clearTrackInstrument(id: string) { runtime.clearTrackInstrument(id); }
    override clearTrackDrumRack(id: string) { runtime.clearTrackDrumRack(id); }
    override addSamplerRuntimeListeners(...args: Parameters<AudioEngine["addSamplerRuntimeListeners"]>) {
      return runtime.addSamplerRuntimeListeners(...args);
    }
    override setTrackFxInstances(): ReturnType<AudioEngine["setTrackFxInstances"]> { return Promise.resolve("skipped"); }
    override setMasterFxInstances(): ReturnType<AudioEngine["setMasterFxInstances"]> { return Promise.resolve("skipped"); }
  }
  const engine = new InstrumentEngine(), buffer = new TestAudioBuffer();
  const entered = Promise.withResolvers<void>(), decoded = Promise.withResolvers<void>();
  const budget = createSampledInstrumentRegionBudget(1024 * 1024);
  const sampler = createSamplerBufferSync({
    projectId: () => projectId, aggregateBudget: budget,
    decodePages: async function* (...args) {
      entered.resolve();
      await decoded.promise;
      yield* decodeTestPages(...args);
    },
    createBuffer: () => buffer,
  });
  const drum = createDrumRackBufferSync(), client = new QueryClient();
  const errors: string[] = [];
  let panel: EffectsPanelController | undefined, snapshot: EffectsPanelExportSnapshot | undefined, dispose = () => {};
  globalThis.fetch = Object.assign(async () => new Response(new ArrayBuffer(0)), { preconnect: originalFetch.preconnect });
  createRoot(end => {
    dispose = end;
    return createComponent(QueryClientProvider, { client, get children() {
      panel = createEffectsPanelController({
        isOpen: () => false, selectedFXTarget: () => "selected-elsewhere",
        tracks: () => [track], sidechainRoutes: () => [], audioEngine: () => engine,
        projectId: () => projectId, userId: () => undefined, playheadSec: () => 0,
        onClose: () => {}, usesLegacyAudioEngine: () => true,
        samplerBufferSync: sampler, drumRackBufferSync: drum,
        onExportSnapshotChange: value => { snapshot = value; },
        onEffectError: (title, message) => { errors.push(`${title}: ${message}`); },
      });
      return null;
    } });
  });
  try {
    if (!panel || !snapshot) throw new Error("Missing B5c controller");
    const device = panel.devices.instrument, effects = snapshot;
    await entered.promise;
    expect(device.readInstrumentForTarget(track.id)).toEqual(initial);
    let ready = false;
    const compiling = effects.awaitInstrumentReadiness().then(lease => { ready = true; return lease; });
    // One microtask checkpoint while the decoder's explicit latch is closed, not a polling wait.
    await Promise.resolve();
    expect(ready).toBe(false);
    decoded.resolve();
    const lease = await compiling;
    try {
      const hydrated = lease?.hydrateInstrumentBuffers({
        fx: { masterVolume: 1, masterFxInstances: [], trackFx: { [track.id]: { instances: [], instrument: initial } } },
        automationEnvelopes: [],
      });
      expect(hydrated?.fx?.trackFx?.[track.id]?.samplerBuffers?.get(zone.id)?.buffer).toBe(buffer);
    } finally { lease?.release(); }
    await effects.flushPending();
    expect(engine.getTrackInstrumentKind(track.id)).toBe("sampler");
    expect(sampler.snapshotSamplerBuffers(track.id, initial)?.get(zone.id)?.buffer).toBe(buffer);
    expect(budget.totalBytes()).toBeGreaterThan(0);
    const before = calls.length;
    await setLocalEffect(projectId, track.id, "instrument", next);
    await effects.flushPending();
    const switched = await effects.awaitInstrumentReadiness();
    switched?.release();
    expect(device.readInstrumentForTarget(track.id)).toEqual(next);
    expect(engine.getTrackInstrumentKind(track.id)).toBe("synth");
    expect(synthGains.some(gain => gain.value === next.params.gain)).toBe(true);
    expect(errors).toEqual([]);
    console.log("B5c applications", JSON.stringify({ scenario: "sampled to synth", store: "local", target: "track",
      calls: calls.slice(before), remainingSampledBytes: budget.totalBytes(),
      oldSamplerCachePresent: sampler.snapshotSamplerBuffers(track.id, initial) !== undefined }));
    expect(sampler.snapshotSamplerBuffers(track.id, initial)).toBeUndefined();
    expect(budget.totalBytes()).toBe(0);
  } finally {
    decoded.resolve();
    dispose(); client.clear(); sampler.dispose(); drum.dispose(); budget.dispose();
    runtime.clearTrackInstrument(track.id); audio.restore();
  }
});

// Failure modes for the resumed matrix: an unselected row never reaches its
// owner, readiness outruns PCM, an incompatible cache survives a switch, or a
// removed target retains an owner/runtime. Real runtime content is inspected
// through source buffers, synth AudioParams and granular install messages.
const b5c2Instrument = (kind: TrackInstrumentParams["kind"], id: string): TrackInstrumentParams => {
  const raw: TrackInstrumentParams = kind === "synth"
    ? { kind, instanceId: id, params: { ...createDefaultSynthParams(), gain: 0.37 } }
    : kind === "sampler"
      ? { kind, instanceId: id, params: { ...createDefaultSamplerParams(), zones: [zone] } }
      : kind === "granular"
        ? { kind, instanceId: id, params: { ...createDefaultGranularParams(), zone } }
        : { kind, instanceId: id, params: { ...createDefaultDrumRackParams(),
          pads: createDefaultDrumRackParams().pads.map(pad => pad.id === "pad-36" ? { ...pad, sample } : pad) } };
  const normalized = normalizeTrackInstrumentParams(raw);
  if (!normalized) throw new Error("Invalid B5c2 instrument");
  return normalized;
};

type B5c2GranularPort = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: GranularWorkletControlMessage) => void;
  close: () => void;
};

const createB5c2Fixture = async (local: boolean, initial: TrackInstrumentParams, holdSuccessor = false, arp?: ArpeggiatorParams, subscribed = false, agent = false, native = false) => {
  const initialProject = agent && local ? (await createLocalProject("B5 agent")).id
    : `${local ? "project:" : "cloud-"}b5c2-${crypto.randomUUID()}`;
  const [projectId, setProjectId] = createSignal(initialProject);
  const db = b5CloudDatabase();
  if (agent && !local) await db.withIdentity({ subject: "b5-agent" }).mutation(convexApi.projects.createOwnedRoom, { projectId: initialProject });
  const remoteTrackId = await db.run(ctx => ctx.db.insert("tracks", {
    projectId: initialProject, name: "Unselected", kind: "instrument", index: 0,
  }));
  const track: Track = { id: local ? "sampled-track" : remoteTrackId, kind: "instrument", name: "Unselected", volume: 1, clips: [] };
  if (agent) {
    if (local) {
      await createLocalTimelineRepository(initialProject).createTrack({ id: track.id, kind: "instrument" });
      const storage = await openLocalProjectDb(initialProject);
      await storage.put("assets", { id: sample.assetKey, name: "Fixture.wav", mimeType: "audio/wav", sizeBytes: 384_000,
        storagePath: "fixture.wav", sourceKind: "upload", contentHash: "a".repeat(64),
        durationSec: 1, sampleRate: 48_000, channelCount: 2, createdAt: 1, updatedAt: 1 });
    } else await db.run(async ctx => {
      await ctx.db.insert("ownerships", { projectId: initialProject, ownerUserId: "b5-agent", trackId: remoteTrackId });
      await ctx.db.insert("mixerChannels", { projectId: initialProject, trackId: remoteTrackId, volume: 1, channelRole: "track", sends: [] });
      await ctx.db.insert("samples", { projectId: initialProject, assetKey: sample.assetKey, name: "Fixture.wav",
        mimeType: "audio/wav", sizeBytes: 384_000, sourceKind: "upload", contentSha256: "a".repeat(64), r2Key: "fixture.wav",
        duration: 1, sampleRate: 48_000, channelCount: 2, ownerUserId: "b5-agent", createdAt: 1, updatedAt: 1 });
    });
  }
  const [tracks, setTracks] = createSignal<Track[]>([track]);
  const [selectedTarget, selectTarget] = createSignal("selected-elsewhere");
  const wasOnline = onlineManager.isOnline();
  onlineManager.setOnline(false);
  const client = new QueryClient();
  const readRows = () => db.run(ctx => ctx.db.query("effects").collect());
  const transport = b5EffectsSubscription(readRows);
  const subscription = subscribed ? transport : undefined;
  let mounted = false;
  const publish = async () => {
    if (subscription && mounted) await subscription.publish();
    else if (!local) client.setQueryData(["convex", "effects", "room", initialProject, subscribed ? "collaborator" : undefined], await readRows());
  };
  const write = async (instrument: TrackInstrumentParams | undefined) => {
    if (local) {
      if (instrument) await setLocalEffect(initialProject, track.id, "instrument", instrument);
      else await deleteLocalEffect(initialProject, track.id, "instrument");
    } else {
      await db.run(async ctx => {
        const rows = await ctx.db.query("effects").collect();
        for (const row of rows) await ctx.db.delete(row._id);
        if (instrument) await ctx.db.insert("effects", {
          projectId: initialProject, targetType: "track", trackId: remoteTrackId,
          type: "instrument", index: 0, params: instrument, revision: ++revision, createdAt: 1,
        });
      });
      await publish();
    }
  };
  let revision = 0;
  await write(initial);
  const writeArp = async (params: ArpeggiatorParams | undefined) => {
    if (local) {
      if (params) await setLocalEffect(initialProject, track.id, "arp", params);
      else await deleteLocalEffect(initialProject, track.id, "arp");
    } else {
      await db.run(async ctx => {
        for (const row of await ctx.db.query("effects").collect()) if (row.type === "arpeggiator") await ctx.db.delete(row._id);
        if (params) await ctx.db.insert("effects", {
          projectId: initialProject, targetType: "track", trackId: remoteTrackId,
          type: "arpeggiator", index: 1, params, revision: ++revision, createdAt: 1,
        });
      });
      await publish();
    }
  };
  const writeLegacySynth = async (params: ReturnType<typeof createDefaultSynthParams>) => {
    if (local) await setLocalEffect(initialProject, track.id, "synth", params);
    else {
      await db.run(async ctx => {
        for (const row of await ctx.db.query("effects").collect()) await ctx.db.delete(row._id);
        await ctx.db.insert("effects", { projectId: initialProject, targetType: "track", trackId: remoteTrackId,
          type: "synth", instanceId: "legacy-synth", index: 0, params, revision: ++revision, createdAt: 1 });
      });
      await publish();
    }
  };
  if (arp) await writeArp(arp);
  const audio = createFxTestAudio(), buffer = new TestAudioBuffer();
  const gains: { value: number }[] = [];
  const sources: { buffer: AudioBuffer | null; playbackRate: { value: number }; detune: { value: number } }[] = [];
  const granularInstalls: { assetKey: string; channels: readonly Float32Array[] }[] = [];
  const granularPositions: { value: number }[] = [];
  const param = (value = 0) => ({
    value, cancelScheduledValues: () => {},
    setValueAtTime(next: number) { this.value = next; },
    setTargetAtTime(next: number) { this.value = next; },
    linearRampToValueAtTime(next: number) { this.value = next; },
  });
  const gainNode = audio.context.createGain;
  const context = Object.assign(audio.context, {
    createGain: () => {
      const node = gainNode(), gain = param(1);
      gains.push(gain);
      return Object.assign(node, { gain });
    },
    createStereoPanner: () => Object.assign(gainNode(), { pan: param() }),
    createBufferSource: () => {
      const node = Object.assign(gainNode(), {
        buffer: null, playbackRate: param(1), detune: param(), start: () => {}, stop: () => {},
        addEventListener: () => {}, removeEventListener: () => {},
      });
      sources.push(node);
      return node;
    },
  });
  class GranularNode {
    readonly position = param();
    readonly parameters = new Map([["position", this.position]]);
    readonly port: B5c2GranularPort = {
      onmessage: null,
      postMessage: (message: GranularWorkletControlMessage) => {
        if (message.type !== "install") return;
        granularInstalls.push(message);
        this.port.onmessage?.(new MessageEvent("message", { data: { type: "installed", version: 1, generation: message.generation } }));
      },
      close: () => {},
    };
    connect() {}
    disconnect() {}
    constructor() { granularPositions.push(this.position); }
  }
  Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, value: GranularNode });
  const runtime = createInstrumentRuntime({
    ensureAudio: () => {}, getAudioContext: () => context, getBpm: () => 120,
    timelineToCtxTime: value => value, ensureTrackInput: () => audio.masterInput, sources: createSourceRegistry(),
  });
  const calls: { family: string; disposition?: string }[] = [];
  class InstrumentEngine extends AudioEngine {
    override setTrackSampler(...args: Parameters<AudioEngine["setTrackSampler"]>) {
      runtime.setTrackSampler(...args);
      calls.push({ family: "sampler", disposition: "applied" });
    }
    override setTrackDrumRack(...args: Parameters<AudioEngine["setTrackDrumRack"]>) {
      const disposition = runtime.setTrackDrumRack(...args);
      calls.push({ family: "drum-rack", disposition });
      return disposition;
    }
    override async setTrackGranular(...args: Parameters<AudioEngine["setTrackGranular"]>) {
      const disposition = await runtime.setTrackGranular(...args);
      calls.push({ family: "granular", disposition });
      return disposition;
    }
    override setTrackInstrument(...args: Parameters<AudioEngine["setTrackInstrument"]>) {
      const disposition = runtime.setTrackInstrument(...args);
      calls.push({ family: args[1].instrument.kind, disposition });
      return disposition;
    }
    override getTrackInstrumentKind(id: string) { return runtime.getTrackInstrumentKind(id); }
    override clearTrackInstrument(id: string) { runtime.clearTrackInstrument(id); calls.push({ family: "clear" }); }
    override clearTrackDrumRack(id: string) { runtime.clearTrackDrumRack(id); }
    override setTrackArpeggiator(id: string, params: ArpeggiatorParams): ReturnType<AudioEngine["setTrackArpeggiator"]> {
      runtime.setTrackArpeggiator(id, params);
      calls.push({ family: "arp", disposition: "applied" });
      return "applied";
    }
    override clearTrackArpeggiator(id: string) {
      runtime.clearTrackArpeggiator(id);
      calls.push({ family: "arp-clear" });
    }
    override addSamplerRuntimeListeners(...args: Parameters<AudioEngine["addSamplerRuntimeListeners"]>) { return runtime.addSamplerRuntimeListeners(...args); }
    override setTrackFxInstances(): ReturnType<AudioEngine["setTrackFxInstances"]> { return Promise.resolve("skipped"); }
    override setMasterFxInstances(): ReturnType<AudioEngine["setMasterFxInstances"]> { return Promise.resolve("skipped"); }
  }
  const engine = new InstrumentEngine();
  const [currentEngine, replaceEngine] = createSignal<AudioEngine>(engine);
  const [legacyMode, setLegacyMode] = createSignal(!native);
  const entered = Promise.withResolvers<void>(), decoded = Promise.withResolvers<void>();
  const budget = createSampledInstrumentRegionBudget(4 * 1024 * 1024);
  const decodePages = async function* (...args: Parameters<typeof decodeTestPages>) {
    entered.resolve();
    await decoded.promise;
    yield* decodeTestPages(...args);
  };
  const sampler = createSamplerBufferSync({ projectId, aggregateBudget: budget, decodePages, createBuffer: () => buffer });
  const drum = createDrumRackBufferSync({ projectId, aggregateBudget: budget, decodePages, createBuffer: () => buffer });
  const errors: string[] = [];
  const joins: PublicationJoin[] = [];
  let panel: EffectsPanelController | undefined, snapshot: EffectsPanelExportSnapshot | undefined, dispose = () => {};
  globalThis.fetch = Object.assign(async () => new Response(new ArrayBuffer(0)), { preconnect: originalFetch.preconnect });
  createRoot(end => {
    dispose = end;
    return createComponent(QueryClientProvider, { client, get children() {
      panel = untrack(() => createEffectsPanelController({
        isOpen: () => false, selectedFXTarget: selectedTarget, tracks, sidechainRoutes: () => [],
        audioEngine: currentEngine, projectId, userId: () => subscribed ? "collaborator" : undefined, playheadSec: () => 0,
        onClose: () => {}, usesLegacyAudioEngine: legacyMode, samplerBufferSync: sampler, drumRackBufferSync: drum,
        joinPublication: join => {
          joins.push(join);
          // No native host is attached. Capture the real compiled key, not a fabricated ACK.
          return { receipt: { key: join.contentKey, serial: joins.length }, settled: Promise.resolve({ state: "unavailable" }) };
        },
        onExportSnapshotChange: value => { snapshot = value; },
        onEffectError: (title, message) => { errors.push(`${title}: ${message}`); },
      }));
      return null;
    } });
  });
  mounted = true;
  if (!panel || !snapshot) throw new Error("Missing B5c2 controller");
  const device = panel.devices.instrument, effects = snapshot;
  const readiness = async (instrument?: TrackInstrumentParams) => {
    const lease = await effects.awaitInstrumentReadiness();
    try {
      if (!instrument || instrument.kind === "synth") return;
      const hydrated = lease?.hydrateInstrumentBuffers({
        fx: { masterVolume: 1, masterFxInstances: [], trackFx: { [track.id]: { instances: [], instrument } } },
        automationEnvelopes: [],
      });
      const held = hydrated?.fx.trackFx?.[track.id];
      expect(instrument.kind === "sampler" ? held?.samplerBuffers?.get(zone.id)?.buffer
        : instrument.kind === "drum-rack" ? held?.drumRackBuffers?.get("pad-36")?.buffer
          : held?.granularBuffer?.buffer).toBe(buffer);
    } finally { lease?.release(); }
  };
  const assertContent = (instrument: TrackInstrumentParams) => {
    expect(device.readInstrumentForTarget(track.id)).toEqual(instrument);
    expect(engine.getTrackInstrumentKind(track.id)).toBe(instrument.kind);
    if (instrument.kind === "synth") expect(gains.some(gain => gain.value === instrument.params.gain)).toBe(true);
    else if (instrument.kind === "granular") {
      expect(granularInstalls.at(-1)?.channels[0]?.length).toBe(buffer.length);
      expect(granularPositions.at(-1)?.value).toBe(instrument.params.position);
    }
    else {
      const before = sources.length;
      if (instrument.kind === "sampler") expect(runtime.previewSamplerNote(track.id, 60, 1)).toBe(true);
      else runtime.previewDrumRackNote(track.id, 36, 1);
      expect(sources.length).toBeGreaterThan(before);
      expect(sources.at(-1)?.buffer).toBe(buffer);
      const semitones = instrument.kind === "sampler"
        ? 60 - (instrument.params.zones[0]?.rootNote ?? 60)
        : instrument.params.pads.find(pad => pad.id === "pad-36")?.transpose ?? 0;
      if (instrument.kind === "sampler") expect(sources.at(-1)?.detune.value).toBe(semitones * 100);
      else expect(sources.at(-1)?.playbackRate.value).toBeCloseTo(2 ** (semitones / 12));
      runtime.stopAll();
    }
    expect(errors).toEqual([]);
  };
  const assertRetired = (instrument: TrackInstrumentParams) => {
    if (instrument.kind === "sampler") expect(sampler.snapshotSamplerBuffers(track.id, instrument)).toBeUndefined();
    if (instrument.kind === "granular") expect(sampler.snapshotGranularBuffer(track.id, instrument)).toBeUndefined();
    if (instrument.kind === "drum-rack") expect(drum.snapshotBuffers(track.id, instrument)).toBeUndefined();
  };
  return {
    track, device, effects, calls, write, writeArp, readiness, assertContent, assertRetired, selectedTarget, selectTarget,
    engine, initialProject, publish, db, writeLegacySynth, joins, errors,
    replaceEngine, setLegacyMode, granularInstalls, makeEngine: () => new InstrumentEngine(), restoreTrack: () => setTracks([track]),
    demote: () => setTracks([{ ...track, kind: "audio" }]),
    nativeContent: (instrument: TrackInstrumentParams) => {
      const hydrate = effects.hydrateInstrumentBuffers;
      if (!hydrate) throw new Error("Missing native buffer hydration");
      const hydrated = hydrate({
        fx: { masterVolume: 1, masterFxInstances: [], trackFx: { [track.id]: { instances: [], instrument } } },
        automationEnvelopes: [],
      });
      const compiled = compileLiveNativeInstrumentConfigurations([], localizeInstrumentFx(hydrated.fx));
      expect(compiled.reasons).toEqual([]);
      expect([...compiled.instrumentAssets.values()]).toEqual([buffer]);
      const configuration = compiled.configurations.find(entry => entry.nodeId === track.id);
      if (!configuration) throw new Error("Missing native instrument configuration");
      expect(joins.at(-1)?.contentKey).toBe(nativeInstrumentContentKey(configuration.state));
      expect(joins.at(-1)?.target).toEqual({ nodeId: track.id, instanceId: instrument.instanceId });
      expect(errors).toEqual([]);
      return joins.at(-1)?.contentKey;
    },
    removeTrack: () => setTracks([]),
    switchProject: async () => {
      const nextProject = `${initialProject}-next`;
      if (!local) client.setQueryData(["convex", "effects", "room", nextProject, undefined], []);
      batch(() => { setTracks([]); setProjectId(nextProject); });
      // Publish after the observer has changed keys, not to its old cache entry.
      await Promise.resolve();
      if (!local) client.setQueryData(["convex", "effects", "room", nextProject, undefined], []);
    },
    decodeEntered: entered.promise,
    releaseDecode: () => decoded.resolve(),
    runtimeKind: () => engine.getTrackInstrumentKind(track.id),
    canStartGranularNote: () => {
      const stop = runtime.startLiveGranularNote(track.id, 0, 0.1, "h6-note");
      stop?.();
      return stop !== undefined;
    },
    runtimeArp: () => runtime.getTrackArpeggiator(track.id),
    remainingBytes: budget.totalBytes,
    start: async () => {
      if (initial.kind !== "synth") {
        await entered.promise;
        let ready = false;
        const compiling = readiness(initial).then(() => { ready = true; });
        await Promise.resolve();
        expect(ready).toBe(false);
        decoded.resolve();
        await compiling;
      } else if (!holdSuccessor) decoded.resolve();
      await effects.flushPending();
      assertContent(initial);
    },
    close: () => {
      decoded.resolve(); dispose(); client.clear(); sampler.dispose(); drum.dispose(); budget.dispose();
      transport.close();
      onlineManager.setOnline(wasOnline);
      runtime.clearTrackInstrument(track.id); audio.restore();
    },
  };
};

// Failure inventory: committed foreign local arp has no projection carrier;
// deletion can retain stale IDB/cloud arp; an own draft echo can compile twice.
// These are separate from the six accepted Part-B measurement rows.
const step5ArpWitnesses = [
  { id: "B25-foreign-change", action: "change" },
  { id: "B25-foreign-removal", action: "remove" },
  { id: "B25-foreign-off", action: "off" },
  { id: "B25-own-gesture", action: "gesture" },
];
for (const kind of ["sampler", "drum-rack", "granular"]) {
  test(`STEP5 ${kind === "sampler" ? "B23" : kind === "drum-rack" ? "B22" : "B24"} persisted sampled structure`, async () => {
    if (kind !== "sampler" && kind !== "drum-rack" && kind !== "granular") throw new Error("Invalid sampled family");
    const initial = b5c2Instrument(kind, "step5-sampled");
    const f = await createB5c2Fixture(true, initial);
    let native: Awaited<ReturnType<typeof mountStep5Playback>> | undefined;
    try {
      await f.start();
      const inputs = () => ({ canonical: undefined, local: undefined, masterVolume: 1,
        effects: f.effects.snapshotEffectsProjection(), automation: [], sidechains: [] });
      const fx = (captured: ReturnType<typeof inputs>) => resolveDesiredPlaybackFx(
        { masterVolume: 1, masterFxInstances: [], trackFx: {} }, captured.effects, undefined);
      native = await mountStep5Playback({ projectId: f.initialProject, tracks: () => [f.track],
        playbackInputs: inputs, desiredFx: fx, renderState: async captured => {
          const lease = await f.effects.awaitInstrumentReadiness();
          try {
            const state = await createExportRenderStateSnapshot({ projectId: f.initialProject, userId: undefined, cloudRows: undefined,
              masterVolume: 1, effectsProjection: captured.effects, externalPluginPolicy: "native-playback" });
            return lease?.hydrateInstrumentBuffers(state) ?? state;
          } finally { lease?.release(); }
        } });
      await native.playback.handlePlay([f.track]);
      await settleStep5Playback();
      expect(native.playback.isPlaying()).toBeTrue();
      const before = native.mark();
      const next = b5c3ChangedInstrument(initial);
      await f.write(next);
      await f.effects.flushPending(); await f.readiness(next);
      await native.frame();
      await native.playback.awaitPlaybackPreparation();
      await createExportRenderStateSnapshot({ projectId: f.initialProject, userId: undefined, cloudRows: undefined,
        masterVolume: 1, effectsProjection: f.effects.snapshotEffectsProjection(), externalPluginPolicy: "native-playback" });
      await settleStep5Playback();
      const counts = native.counts(before);
      console.log("STEP5 sampled structure", JSON.stringify({ kind, counts, host: native.host.calls.slice(before.calls),
        projected: f.effects.snapshotEffectsProjection().upsertDeviceRows.find(row => row.effect === "instrument")?.params }));
      f.assertContent(next);
      expect(native.compilations.at(-1)?.renderState.fx.trackFx?.[f.track.id]?.instrument).toEqual(next);
      expect(native.faults).toEqual([]);
      expect(counts.scheduleCompiles).toBe(1);
      expect(counts.publishes).toBe(1);
      expect(counts.previewDisposals).toBe(0);
    } finally { await native?.close(); f.close(); }
  });
}

for (const spec of step5ArpWitnesses) for (const transport of ["playing", "paused"]) {
  test(`STEP5 ${spec.id} ${transport} local arp closed panel`, async () => {
    const initial = { ...createDefaultArpeggiatorParams(), enabled: true };
      const next = spec.action === "off" ? { ...initial, enabled: false } : { ...initial, octaves: 2 };
    const f = await createB5c2Fixture(true, b5c2Instrument("synth", "step5-arp"), false, initial);
    let native: Awaited<ReturnType<typeof mountStep5Playback>> | undefined;
    try {
      await f.start();
      expect(f.selectedTarget()).not.toBe(f.track.id);
      const snapshot = (effectsProjection = f.effects.snapshotEffectsProjection()) => createExportRenderStateSnapshot({
        projectId: f.initialProject, userId: undefined, masterVolume: 1, cloudRows: undefined,
        effectsProjection, externalPluginPolicy: "native-playback",
      });
      native = await mountStep5Playback({
        projectId: f.initialProject, tracks: () => [f.track],
        // Raw Timeline sources; the mount narrows them with the real picker.
        playbackInputs: () => ({
          canonical: undefined, local: undefined, masterVolume: 1,
          effects: f.effects.snapshotEffectsProjection(), automation: [], sidechains: [],
        }),
        desiredFx: captured => resolveDesiredPlaybackFx(
          { trackFx: {}, masterFxInstances: [], masterVolume: 1 }, captured.effects, undefined,
        ),
        renderState: captured => snapshot(captured.effects),
      });
      if (transport === "playing") await native.playback.handlePlay([f.track]);
      await settleStep5Playback();
      expect(native.playback.isPlaying()).toBe(transport === "playing");
      const before = native.mark();
      const phases = [];
      if (spec.action === "gesture") {
        // The panel remains closed. A real own control needs its selected
        // target while held; deselection otherwise cancels on lost permission.
        f.selectTarget(f.track.id);
        const holder = new ParameterGestureHolder();
        f.device.arp.gestureOwner.open(holder);
        expect(f.device.arp.gestureOwner.tick(holder, () => f.device.arp.change({ octaves: 2 }))).toBe(true);
        await native.frame();
        phases.push({ phase: "held-draft", counts: native.counts(before),
          projectedArpRows: f.effects.snapshotEffectsProjection().upsertDeviceRows.filter(row => row.effect === "arp").length,
          ownerOctaves: f.device.arp.readForTarget(f.track.id)?.octaves });
        f.device.arp.gestureOwner.end(holder);
        await f.effects.flushPending();
        f.selectTarget("selected-elsewhere");
      } else {
        await f.writeArp(spec.action === "remove" ? undefined : next);
      }
      await f.effects.flushPending();
      await settleStep5Playback();
      await native.playback.awaitPlaybackPreparation();
      await settleStep5Playback();
      const expected = spec.action === "remove" ? undefined : next;
      expect(f.device.arp.readForTarget(f.track.id)).toEqual(expected);
      expect(f.runtimeArp()).toEqual(expected);
      expect(f.selectedTarget()).not.toBe(f.track.id);
      expect(f.errors).toEqual([]);
      expect(native.faults).toEqual([]);
      const fresh = await snapshot();
      expect(fresh.fx.trackFx?.[f.track.id]?.arp).toEqual(expected);
      const counts = native.counts(before);
      const resolved = resolveDesiredPlaybackFx(
        { masterVolume: 1, masterFxInstances: [], trackFx: { [f.track.id]: { instances: [], arp: initial } } },
        f.effects.snapshotEffectsProjection(), undefined,
      );
      console.log("STEP5 arp witness", JSON.stringify({
        id: spec.id, transport, counts, phases,
        projectedArpRows: f.effects.snapshotEffectsProjection().upsertDeviceRows.filter(row => row.effect === "arp").length,
        compiledOctaves: native.compilations.at(-1)?.renderState.fx.trackFx?.[f.track.id]?.arp?.octaves ?? null,
        persistedOctaves: fresh.fx.trackFx?.[f.track.id]?.arp?.octaves ?? null,
        resolvedOctaves: resolved.trackFx?.[f.track.id]?.arp?.octaves ?? null,
      }));
      // Parent checkpoint-1 ruling: own settlement is expected red too.
      expect(counts.scheduleCompiles).toBe(transport === "playing" ? 1 : 0);
      // The arp changes the compiled notes, so a paused edit replaces the preview;
      // its single initial synth install is the one live send.
      expect(counts.previewCompiles).toBe(transport === "paused" ? 1 : 0);
      if (transport === "paused") expect(counts.liveSends).toBe(1);
      expect(counts.teardowns).toBe(transport === "paused" ? 1 : 0);
      expect(counts.previewDisposals).toBe(transport === "paused" ? 1 : 0);
      expect(counts.publishes).toBe(transport === "playing" ? 1 : 0);
      if (transport === "playing") expect(native.compilations.at(-1)?.renderState.fx.trackFx?.[f.track.id]?.arp).toEqual(expected);
      if (spec.action === "remove") expect(resolved.trackFx?.[f.track.id]?.arp).toBeUndefined();
    } finally { await native?.close(); f.close(); }
  });
}

// Removal must clear the same stale row whether it arrived from cloud input
// or the asynchronous IDB capture. The real owner remains the only writer.
for (const stale of ["cloud", "idb"]) {
  test(`STEP5 B25-removal-stale-${stale} resolver after persisted capture`, async () => {
    const initial = { ...createDefaultArpeggiatorParams(), enabled: true };
    const f = await createB5c2Fixture(stale !== "cloud", b5c2Instrument("synth", `stale-${stale}`), false, initial);
    try {
      await f.start();
      const cloudRows = { effects: await f.db.run(ctx => ctx.db.query("effects").collect()), automationEnvelopes: [] };
      const captured = await createExportRenderStateSnapshot({ projectId: f.initialProject,
        userId: stale === "cloud" ? "fixture" : undefined, masterVolume: 1, cloudRows, externalPluginPolicy: "native-playback" });
      expect(captured.fx.trackFx?.[f.track.id]?.arp).toEqual(initial);
      await f.writeArp(undefined);
      await f.effects.flushPending();
      expect(f.device.arp.readForTarget(f.track.id)).toBeUndefined();
      expect(f.runtimeArp()).toBeUndefined();
      expect(f.selectedTarget()).not.toBe(f.track.id);
      const projection = f.effects.snapshotEffectsProjection();
      if (stale === "idb") {
        // A real pre-removal IDB capture seeds the same projection resolver.
        // This is clear-list boundary evidence, not a held native compile.
        const resolved = resolveDesiredPlaybackFx(captured.fx, projection, undefined);
        console.log("STEP5 stale arp", JSON.stringify({ stale, clearTargets: projection.clearInstrumentTargets,
          arp: resolved.trackFx?.[f.track.id]?.arp ?? null }));
        expect(resolved.trackFx?.[f.track.id]?.arp).toBeUndefined();
      } else {
        const resolved = resolveDesiredPlaybackFx({ masterVolume: 1, masterFxInstances: [], trackFx: {} }, projection, cloudRows);
        console.log("STEP5 stale arp", JSON.stringify({ stale, clearTargets: projection.clearInstrumentTargets,
          arp: resolved.trackFx?.[f.track.id]?.arp ?? null }));
        expect(resolved.trackFx?.[f.track.id]?.arp).toBeUndefined();
      }
    } finally { f.close(); }
  });
  // An instrument override replaces the instrument but must not exempt its
  // track from the clear list, or the deleted arp returns from stale input.
  test(`STEP5 B25-removal-stale-${stale} survives an instrument override`, async () => {
    const instrument = b5c2Instrument("synth", `override-${stale}`);
    const initial = { ...createDefaultArpeggiatorParams(), enabled: true };
    const f = await createB5c2Fixture(stale !== "cloud", instrument, false, initial);
    try {
      await f.start();
      const cloudRows = { effects: await f.db.run(ctx => ctx.db.query("effects").collect()), automationEnvelopes: [] };
      const captured = await createExportRenderStateSnapshot({ projectId: f.initialProject,
        userId: stale === "cloud" ? "fixture" : undefined, masterVolume: 1, cloudRows, externalPluginPolicy: "native-playback" });
      expect(captured.fx.trackFx?.[f.track.id]?.arp).toEqual(initial);
      await f.writeArp(undefined);
      await f.effects.flushPending();
      expect(f.device.arp.readForTarget(f.track.id)).toBeUndefined();
      if (instrument.kind !== "synth") throw new Error("Expected a synth fixture");
      const next: TrackInstrumentParams = { ...instrument, params: { ...instrument.params, polyphony: 8 } };
      const lease = await f.effects.awaitInstrumentReadiness({ targetId: f.track.id, instrument: next });
      try {
        const projection = lease?.projection;
        const resolved = stale === "idb"
          ? resolveDesiredPlaybackFx(captured.fx, projection, undefined)
          : resolveDesiredPlaybackFx({ masterVolume: 1, masterFxInstances: [], trackFx: {} }, projection, cloudRows);
        expect(resolved.trackFx?.[f.track.id]?.instrument).toEqual(next);
        expect(resolved.trackFx?.[f.track.id]?.arp).toBeUndefined();
        if (stale === "cloud") {
          const compiled = await createExportRenderStateSnapshot({ projectId: f.initialProject, userId: "fixture",
            masterVolume: 1, cloudRows, effectsProjection: projection, externalPluginPolicy: "native-playback" });
          expect(compiled.fx.trackFx?.[f.track.id]?.instrument).toEqual(next);
          expect(compiled.fx.trackFx?.[f.track.id]?.arp).toBeUndefined();
        }
      } finally { lease?.release(); }
    } finally { f.close(); }
  });
}

// Demotion must retire the actual instrument, arp and decoded caches even
// while the persisted rows remain. Native registration must wait for the
// owner's decode and compile the authoritative buffers, not an empty key.
// Review failure inventory: stable rows can suppress install on a new engine;
// track teardown may clear runtime without retiring the row owner's observation;
// repeated undefined observations must not queue clears.
const reviewReentryKinds: TrackInstrumentParams["kind"][] = ["sampler", "synth"];

// H5: changed observations and installation-context changes must share one delivery.
for (const local of [true, false]) {
  test(`INDEPENDENT granular reentry plus changed row installs once local=${local}`, async () => {
    const instrument = b5c2Instrument("granular", "duplicate-reentry");
    if (instrument.kind !== "granular") throw new Error("Expected granular");
    const f = await createB5c2Fixture(local, instrument);
    try {
      await f.start();
      f.setLegacyMode(false);
      await f.effects.flushPending();
      const before = f.granularInstalls.length;
      const next: TrackInstrumentParams = { ...instrument, params: { ...instrument.params, position: 0.7 } };
      batch(() => {
        f.setLegacyMode(true);
        f.device.syncRemoteInstrumentForTarget(f.track.id, next, 1_000_000);
      });
      await f.effects.flushPending();
      expect(f.granularInstalls.length - before).toBe(1);
    } finally { f.close(); }
  });

  test(`INDEPENDENT granular engine change plus changed row installs once local=${local}`, async () => {
    const instrument = b5c2Instrument("granular", "duplicate-granular");
    if (instrument.kind !== "granular") throw new Error("Expected granular");
    const f = await createB5c2Fixture(local, instrument);
    try {
      await f.start();
      const before = f.granularInstalls.length;
      const next: TrackInstrumentParams = { ...instrument, params: { ...instrument.params, position: 0.7 } };
      batch(() => {
        f.replaceEngine(f.makeEngine());
        f.device.syncRemoteInstrumentForTarget(f.track.id, next, 1_000_000);
      });
      await f.effects.flushPending();
      expect(f.granularInstalls.length - before).toBe(1);
    } finally { f.close(); }
  });

  test(`INDEPENDENT restore and new engine exactly one owner delivery local=${local}`, async () => {
    const instrument = b5c2Instrument("sampler", "restore-new-engine");
    const f = await createB5c2Fixture(local, instrument, false, undefined, false, false, true);
    class Replacement extends AudioEngine {
      override setTrackSampler() {}
      override setTrackFxInstances() { return Promise.resolve<"skipped">("skipped"); }
      override setMasterFxInstances() { return Promise.resolve<"skipped">("skipped"); }
    }
    try {
      await f.start();
      f.removeTrack(); await f.effects.flushPending();
      const joins = f.joins.length;
      batch(() => { f.restoreTrack(); f.replaceEngine(new Replacement()); });
      await f.effects.flushPending();
      expect(f.joins.length - joins).toBe(1);
    } finally { f.close(); }
  });
}

for (const local of [true, false]) {
  for (const kind of reviewReentryKinds) {
    test(`REVIEW ${kind} legacy re-entry local=${local}`, async () => {
      const instrument = b5c2Instrument(kind, "review-reentry");
      const f = await createB5c2Fixture(local, instrument);
      try {
        await f.start();
        f.setLegacyMode(false);
        await f.effects.flushPending();
        // Model portable runtime retirement while the native backend owns playback.
        f.engine.clearTrackInstrument(f.track.id);
        expect(f.runtimeKind()).toBeUndefined();
        f.setLegacyMode(true);
        await f.effects.flushPending();
        await f.readiness(instrument);
        f.assertContent(instrument);
      } finally { f.close(); }
    });
  }
  test(`REVIEW arp legacy re-entry local=${local}`, async () => {
    const instrument = b5c2Instrument("synth", "review-arp-reentry");
    const arp = { ...createDefaultArpeggiatorParams(), enabled: true };
    const f = await createB5c2Fixture(local, instrument, false, arp);
    try {
      await f.start();
      f.setLegacyMode(false);
      await f.effects.flushPending();
      // The row stays visible while the portable slot is no longer installed.
      f.engine.clearTrackArpeggiator(f.track.id);
      expect(f.runtimeArp()).toBeUndefined();
      f.setLegacyMode(true);
      await f.effects.flushPending();
      expect(f.runtimeArp()).toEqual(arp);
      expect(f.errors).toEqual([]);
    } finally { f.close(); }
  });
  test(`REVIEW engine replacement local=${local}`, async () => {
    const instrument = b5c2Instrument("sampler", "review-engine");
    const arp = { ...createDefaultArpeggiatorParams(), enabled: true };
    const f = await createB5c2Fixture(local, instrument, false, arp);
    const installed: string[] = [];
    class Replacement extends AudioEngine {
      override setTrackSampler() { installed.push("sampler"); }
      override setTrackArpeggiator(): ReturnType<AudioEngine["setTrackArpeggiator"]> { installed.push("arp"); return "applied"; }
      override setTrackFxInstances(): ReturnType<AudioEngine["setTrackFxInstances"]> { return Promise.resolve("skipped"); }
      override setMasterFxInstances(): ReturnType<AudioEngine["setMasterFxInstances"]> { return Promise.resolve("skipped"); }
    }
    try {
      await f.start();
      f.replaceEngine(new Replacement());
      await f.effects.flushPending();
      await f.readiness(instrument);
      console.log("REVIEW replacement", JSON.stringify({ local, installed }));
      expect(installed).toContain("sampler");
      expect(installed).toContain("arp");
    } finally { f.close(); }
  });
  test(`REVIEW track restore with stable rows local=${local}`, async () => {
    const instrument = b5c2Instrument("sampler", "review-track");
    const arp = { ...createDefaultArpeggiatorParams(), enabled: true };
    const f = await createB5c2Fixture(local, instrument, false, arp);
    try {
      await f.start();
      f.removeTrack();
      await f.effects.flushPending();
      expect(f.runtimeKind()).toBeUndefined();
      f.restoreTrack();
      await f.effects.flushPending();
      await f.readiness(instrument);
      console.log("REVIEW restore", JSON.stringify({ local, kind: f.runtimeKind(), arp: f.runtimeArp(), calls: f.calls }));
      expect(f.runtimeKind()).toBe("sampler");
      expect(f.runtimeArp()).toEqual(arp);
    } finally { f.close(); }
  });
  test(`REVIEW repeated audio observations local=${local}`, async () => {
    const f = await createB5c2Fixture(local, b5c2Instrument("sampler", "review-audio"));
    try {
      await f.start();
      f.demote();
      await f.effects.flushPending();
      const before = f.calls.length;
      f.demote(); await f.effects.flushPending();
      f.demote(); await f.effects.flushPending();
      console.log("REVIEW repeated audio", JSON.stringify({ local, calls: f.calls.slice(before) }));
      expect(f.calls.slice(before)).toEqual([]);
    } finally { f.close(); }
  });
}

for (const local of [true, false]) {
  test(`B5d demotion instrument to audio local=${local}`, async () => {
    const instrument = b5c2Instrument("sampler", "demotion");
    const arp = { ...createDefaultArpeggiatorParams(), enabled: true };
    const f = await createB5c2Fixture(local, instrument, false, arp);
    try {
      await f.start();
      expect(f.runtimeArp()).toEqual(arp);
      expect(f.remainingBytes()).toBe(384_000);
      f.demote();
      await f.effects.flushPending();
      await f.readiness();
      expect(f.runtimeKind()).toBeUndefined();
      expect(f.runtimeArp()).toBeUndefined();
      f.assertRetired(instrument);
      expect(f.remainingBytes()).toBe(0);
    } finally { f.close(); }
  });
  for (const kind of ["sampler", "drum-rack"]) {
    test(`B5d native registration ${kind} local=${local}`, async () => {
      if (kind !== "sampler" && kind !== "drum-rack") throw new Error("Unknown sampled instrument");
      const instrument = b5c2Instrument(kind, "native");
      const f = await createB5c2Fixture(local, instrument, false, undefined, false, false, true);
      try {
        await f.decodeEntered;
        expect(f.joins).toEqual([]);
        let ready = false;
        const compiling = f.readiness(instrument).then(() => { ready = true; });
        await Promise.resolve();
        expect(ready).toBe(false);
        f.releaseDecode();
        await compiling;
        await f.effects.flushPending();
        f.nativeContent(instrument);
        expect(f.remainingBytes()).toBe(384_000);
      } finally { f.close(); }
    });
  }
  test(`B5d native instrument history undo redo local=${local}`, async () => {
    const from = b5c2Instrument("sampler", "native-history"), to = b5c3ChangedInstrument(from);
    const f = await createB5c2Fixture(local, from, false, undefined, false, false, true);
    const restore = b5HistoryTransport(async operation => {
      if (operation.kind !== "instruments.setTrackInstrument") throw new Error("Unexpected native history operation");
      await f.write(operation.payload.instrument);
    });
    try {
      await f.start();
      const fromKey = f.nativeContent(from);
      await f.write(to);
      await f.effects.flushPending();
      const toKey = f.nativeContent(to);
      expect(toKey).not.toBe(fromKey);
      const entry: HistoryEntry = { type: "effect-params", projectId: f.initialProject,
        data: { trackRef: f.track.id, effect: "instrument", from, to } };
      const deps = b5HistoryDeps(f.initialProject, f.track, entry);
      await execUndo(entry, deps);
      await f.effects.flushPending();
      await f.readiness(from);
      expect(f.nativeContent(from)).toBe(fromKey);
      await execRedo(entry, deps);
      await f.effects.flushPending();
      await f.readiness(to);
      expect(f.nativeContent(to)).toBe(toKey);
    } finally { restore(); f.close(); }
  });
}

for (const local of [true, false]) {
  for (const [from, to] of [
    ["sampler", "drum-rack"], ["drum-rack", "granular"], ["sampler", "synth"],
    ["drum-rack", "synth"], ["granular", "synth"], ["synth", "sampler"],
    ["sampler", "granular"], ["granular", "sampler"],
  ]) {
    test(`B5c2 switch ${from} to ${to}, local=${local}, closed and unselected`, async () => {
      if (from !== "sampler" && from !== "drum-rack" && from !== "granular" && from !== "synth") throw new Error("Unknown source");
      if (to !== "sampler" && to !== "drum-rack" && to !== "granular" && to !== "synth") throw new Error("Unknown successor");
      const initial = b5c2Instrument(from, "old"), next = b5c2Instrument(to, "new");
      const fixture = await createB5c2Fixture(local, initial);
      try {
        await fixture.start();
        const before = fixture.calls.length;
        await fixture.write(next);
        await fixture.effects.flushPending();
        await fixture.readiness(next);
        fixture.assertContent(next);
        fixture.assertRetired(initial);
        console.log("B5c2 applications", JSON.stringify({ scenario: `${from} to ${to}`, local, target: "track",
          calls: fixture.calls.slice(before), remainingBytes: fixture.remainingBytes() }));
      } finally { fixture.close(); }
    });
  }
}

for (const local of [true, false]) for (const scenario of ["track removal", "project switch"]) {
  test(`B5c3 teardown ${scenario}, arp, local=${local}, closed and unselected`, async () => {
    const arp = { ...createDefaultArpeggiatorParams(), enabled: true };
    const fixture = await createB5c2Fixture(local, b5c2Instrument("synth", "synth"), false, arp);
    try {
      await fixture.start();
      expect(fixture.device.arp.readForTarget(fixture.track.id)).toEqual(arp);
      expect(fixture.runtimeArp()).toEqual(arp);
      const before = fixture.calls.length;
      if (scenario === "track removal") fixture.removeTrack();
      else await fixture.switchProject();
      await fixture.effects.flushPending();
      await fixture.readiness();
      console.log("B5c3 matrix", JSON.stringify({ group: "teardown", scenario, family: "arp", local, target: "track",
        calls: fixture.calls.slice(before), remainingBytes: fixture.remainingBytes() }));
      expect(fixture.runtimeArp()).toBeUndefined();
    } finally { fixture.close(); }
  });
}

// Failure modes: a missing row is not cleared, re-adding the same identity
// is mistaken for an equal install, or initial compilation outruns PCM.
for (const local of [true, false]) for (const kind of ["synth", "sampler", "drum-rack", "granular"]) {
  for (const scenario of ["initial load", "removal and re-add"]) {
    test(`B5c3 load ${scenario}, ${kind}, local=${local}, closed and unselected`, async () => {
      if (kind !== "synth" && kind !== "sampler" && kind !== "drum-rack" && kind !== "granular") throw new Error("Unknown instrument");
      const instrument = b5c2Instrument(kind, "same-id");
      const fixture = await createB5c2Fixture(local, instrument);
      try {
        await fixture.start();
        await fixture.readiness(instrument);
        const before = scenario === "initial load" ? 0 : fixture.calls.length;
        if (scenario === "removal and re-add") {
          await fixture.write(undefined);
          await fixture.effects.flushPending();
          await fixture.readiness();
          expect(fixture.device.readInstrumentForTarget(fixture.track.id)).toBeUndefined();
          expect(fixture.runtimeKind()).toBeUndefined();
          fixture.assertRetired(instrument);
          expect(fixture.remainingBytes()).toBe(0);
          await fixture.write(instrument);
          await fixture.effects.flushPending();
          await fixture.readiness(instrument);
          fixture.assertContent(instrument);
        }
        const expectedBytes = kind === "synth" ? 0 : 48_000 * 2 * Float32Array.BYTES_PER_ELEMENT * (kind === "granular" ? 2 : 1);
        expect(fixture.remainingBytes()).toBe(expectedBytes);
        console.log("B5c3 matrix", JSON.stringify({ group: "load", scenario, family: kind, local, target: "track",
          calls: fixture.calls.slice(before), remainingBytes: fixture.remainingBytes(), expectedBytes }));
      } finally { fixture.close(); }
    });
  }
}

for (const local of [true, false]) {
  test(`B5c3 synth to sampler held successor load, local=${local}, closed and unselected`, async () => {
    const fixture = await createB5c2Fixture(local, b5c2Instrument("synth", "old"), true);
    const successor = b5c2Instrument("sampler", "new");
    try {
      await fixture.start();
      const before = fixture.calls.length;
      await fixture.write(successor);
      await fixture.decodeEntered;
      let ready = false;
      const compilation = fixture.readiness(successor).then(() => { ready = true; });
      await Promise.resolve();
      expect(ready).toBe(false);
      fixture.releaseDecode();
      await compilation;
      await fixture.effects.flushPending();
      fixture.assertContent(successor);
      expect(fixture.remainingBytes()).toBe(384_000);
      console.log("B5c3 matrix", JSON.stringify({ group: "held-load", scenario: "synth to sampler", family: "sampler", local,
        target: "track", calls: fixture.calls.slice(before), remainingBytes: fixture.remainingBytes(), heldCheckpoint: true }));
    } finally { fixture.close(); }
  });
}

for (const local of [true, false]) for (const scenario of ["initial load", "removal and re-add"]) {
  test(`B5c3 load ${scenario}, arp, local=${local}, closed and unselected`, async () => {
    const params = { ...createDefaultArpeggiatorParams(), enabled: true };
    const fixture = await createB5c2Fixture(local, b5c2Instrument("synth", "host"), false, params);
    try {
      await fixture.start();
      const before = scenario === "initial load" ? 0 : fixture.calls.length;
      if (scenario === "removal and re-add") {
        await fixture.writeArp(undefined);
        await fixture.effects.flushPending();
        await fixture.readiness();
        expect(fixture.device.arp.readForTarget(fixture.track.id)).toBeUndefined();
        expect(fixture.runtimeArp()).toBeUndefined();
        await fixture.writeArp(params);
        await fixture.effects.flushPending();
      }
      await fixture.readiness();
      expect(fixture.device.arp.readForTarget(fixture.track.id)).toEqual(params);
      expect(fixture.runtimeArp()).toEqual(params);
      console.log("B5c3 matrix", JSON.stringify({ group: "load", scenario, family: "arp", local,
        target: "track", calls: fixture.calls.slice(before), remainingBytes: fixture.remainingBytes() }));
    } finally { fixture.close(); }
  });
}

const b5c3ChangedInstrument = (instrument: TrackInstrumentParams): TrackInstrumentParams => {
  if (instrument.kind === "synth") return { ...instrument, params: { ...instrument.params, gain: 0.61 } };
  if (instrument.kind === "sampler") return { ...instrument, params: { ...instrument.params,
    zones: instrument.params.zones.map(entry => ({ ...entry, rootNote: 72 })) } };
  if (instrument.kind === "granular") return { ...instrument, params: { ...instrument.params, position: 0.25 } };
  return { ...instrument, params: { ...instrument.params,
    pads: instrument.params.pads.map(pad => pad.id === "pad-36" ? { ...pad, transpose: 12 } : pad) } };
};

// Failure modes: history only updates a row, a direct history writer masks
// missing persisted observation, or sampled history loses hydrated PCM.
for (const local of [true, false]) for (const kind of ["synth", "sampler", "drum-rack", "granular"]) {
  test(`B5c3 history undo redo, ${kind}, local=${local}, closed and unselected`, async () => {
    if (kind !== "synth" && kind !== "sampler" && kind !== "drum-rack" && kind !== "granular") throw new Error("Unknown instrument");
    const from = b5c2Instrument(kind, "same"), to = b5c3ChangedInstrument(from);
    const f = await createB5c2Fixture(local, from);
    const restore = b5HistoryTransport(async operation => {
      if (operation.kind !== "instruments.setTrackInstrument") throw new Error("Unexpected instrument history operation");
      await f.write(operation.payload.instrument);
    });
    try {
      await f.start();
      await f.write(to);
      await f.effects.flushPending();
      await f.readiness(to);
      f.assertContent(to);
      const entry: HistoryEntry = { type: "effect-params", projectId: f.initialProject,
        data: { trackRef: f.track.id, effect: "instrument", from, to } };
      const deps = b5HistoryDeps(f.initialProject, f.track, entry);
      for (const direction of ["undo", "redo"]) {
        const before = f.calls.length, expected = direction === "undo" ? from : to;
        if (direction === "undo") await execUndo(entry, deps);
        else await execRedo(entry, deps);
        await f.effects.flushPending();
        await f.readiness(expected);
        f.assertContent(expected);
        console.log("B5c3 matrix", JSON.stringify({ group: "history", scenario: direction, family: kind, local,
          target: "track", calls: f.calls.slice(before), remainingBytes: f.remainingBytes() }));
      }
    } finally { restore(); f.close(); }
  });
}

for (const local of [true, false]) {
  test(`B5c3 history undo redo, arp, local=${local}, closed and unselected`, async () => {
    const from = { ...createDefaultArpeggiatorParams(), enabled: true };
    const to = { ...from, octaves: 2 };
    const f = await createB5c2Fixture(local, b5c2Instrument("synth", "host"), false, from);
    const restore = b5HistoryTransport(async operation => {
      if (operation.kind !== "effects.setArpeggiatorParams") throw new Error("Unexpected arp history operation");
      await f.writeArp(operation.payload.params);
    });
    try {
      await f.start();
      await f.writeArp(to);
      await f.effects.flushPending();
      const entry: HistoryEntry = { type: "effect-params", projectId: f.initialProject,
        data: { trackRef: f.track.id, effect: "arp", instanceId: "arp", from, to } };
      const deps = b5HistoryDeps(f.initialProject, f.track, entry);
      for (const direction of ["undo", "redo"]) {
        const before = f.calls.length, expected = direction === "undo" ? from : to;
        if (direction === "undo") await execUndo(entry, deps);
        else await execRedo(entry, deps);
        await f.effects.flushPending();
        await f.readiness();
        expect(f.device.arp.readForTarget(f.track.id)).toEqual(expected);
        expect(f.runtimeArp()).toEqual(expected);
        console.log("B5c3 matrix", JSON.stringify({ group: "history", scenario: direction, family: "arp", local,
          target: "track", calls: f.calls.slice(before), remainingBytes: f.remainingBytes() }));
      }
    } finally { restore(); f.close(); }
  });
}

// Failure modes: external writes only update a selected card, or a subscribed
// row is acknowledged without installing its actual portable content.
for (const local of [true, false]) for (const kind of ["synth", "sampler", "drum-rack", "granular"]) {
  for (const scenario of local ? ["another surface"] : ["another surface", "collaborator"]) {
    test(`B5c3 external ${scenario}, ${kind}, local=${local}, closed and unselected`, async () => {
      if (kind !== "synth" && kind !== "sampler" && kind !== "drum-rack" && kind !== "granular") throw new Error("Unknown instrument");
      const initial = b5c2Instrument(kind, "same"), next = b5c3ChangedInstrument(initial);
      const f = await createB5c2Fixture(local, initial, false, undefined, scenario === "collaborator");
      try {
        await f.start();
        const before = f.calls.length;
        await f.write(next);
        await f.effects.flushPending();
        await f.readiness(next);
        f.assertContent(next);
        console.log("B5c3 matrix", JSON.stringify({ group: "external", scenario, family: kind, local,
          target: "track", calls: f.calls.slice(before), remainingBytes: f.remainingBytes(),
          subscription: scenario === "collaborator" }));
      } finally { f.close(); }
    });
  }
}
for (const local of [true, false]) for (const scenario of local ? ["another surface"] : ["another surface", "collaborator"]) {
  test(`B5c3 external ${scenario}, arp, local=${local}, closed and unselected`, async () => {
    const initial = { ...createDefaultArpeggiatorParams(), enabled: true }, next = { ...initial, octaves: 2 };
    const f = await createB5c2Fixture(local, b5c2Instrument("synth", "host"), false, initial, scenario === "collaborator");
    try {
      await f.start();
      const before = f.calls.length;
      await f.writeArp(next);
      await f.effects.flushPending();
      await f.readiness();
      expect(f.device.arp.readForTarget(f.track.id)).toEqual(next);
      expect(f.runtimeArp()).toEqual(next);
      console.log("B5c3 matrix", JSON.stringify({ group: "external", scenario, family: "arp", local,
        target: "track", calls: f.calls.slice(before), remainingBytes: f.remainingBytes(),
        subscription: scenario === "collaborator" }));
    } finally { f.close(); }
  });
}

// Failure modes: a canonical commit succeeds but never publishes its row,
// a regenerated instrument identity masks stale PCM, or readiness omits it.
for (const local of [true, false]) for (const kind of ["synth", "sampler", "drum-rack", "granular", "arp"]) {
  test(`B5c3 agent commit, ${kind}, local=${local}, closed and unselected`, async () => {
    if (kind !== "synth" && kind !== "sampler" && kind !== "drum-rack" && kind !== "granular" && kind !== "arp") throw new Error("Unknown instrument");
    const initial = b5c2Instrument(kind === "arp" ? "synth" : kind, "same");
    const f = await createB5c2Fixture(local, initial, false, undefined, !local, true);
    try {
      await f.start();
      const next = b5c3ChangedInstrument(initial), before = f.calls.length;
      const params = { ...createDefaultArpeggiatorParams(), enabled: true, octaves: 2 };
      await b5AgentCommit(local, f.initialProject, f.db, kind === "arp"
        ? { kind: "arpeggiator.set", target: { kind: "track", track: { source: "persisted", id: f.track.id } }, params }
        : { kind: "instrument.set", target: { kind: "track", track: { source: "persisted", id: f.track.id } }, instrumentKind: next.kind, params: next.params });
      await f.publish();
      await f.effects.flushPending();
      if (kind === "arp") {
        await f.readiness();
        expect(f.device.arp.readForTarget(f.track.id)).toEqual(params);
        expect(f.runtimeArp()).toEqual(params);
      } else {
        const observed = f.device.readInstrumentForTarget(f.track.id);
        if (!observed) throw new Error("Agent row was not observed");
        expect(observed.kind).toBe(next.kind);
        expect(observed.params).toEqual(next.params);
        await f.readiness(observed);
        f.assertContent(observed);
      }
      console.log("B5c3 matrix", JSON.stringify({ group: "agent", scenario: "agent commit", family: kind, local,
        target: "track", calls: f.calls.slice(before), remainingBytes: f.remainingBytes(), subscription: !local }));
    } finally { f.close(); }
  });
}

for (const local of [true, false]) {
  test(`B5c3 legacy synth history undo redo, local=${local}, closed and unselected`, async () => {
    const initial = b5c2Instrument("synth", "initial"), from = { ...createDefaultSynthParams(), gain: 0.37 }, to = { ...from, gain: 0.61 };
    const f = await createB5c2Fixture(local, initial);
    const restore = b5HistoryTransport(async operation => {
      if (operation.kind !== "effects.setSynthParams") throw new Error("Unexpected legacy synth history operation");
      await f.writeLegacySynth(operation.payload.params);
    });
    try {
      await f.start();
      await f.write(undefined);
      await f.effects.flushPending();
      await f.writeLegacySynth(to);
      await f.effects.flushPending();
      const entry: HistoryEntry = { type: "effect-params", projectId: f.initialProject,
        data: { trackRef: f.track.id, effect: "synth", instanceId: "legacy-synth", from, to } };
      const deps = b5HistoryDeps(f.initialProject, f.track, entry);
      for (const direction of ["undo", "redo"]) {
        const before = f.calls.length, expected = direction === "undo" ? from : to;
        if (direction === "undo") await execUndo(entry, deps);
        else await execRedo(entry, deps);
        await f.effects.flushPending();
        await f.readiness();
        const observed = f.device.readInstrumentForTarget(f.track.id);
        if (observed?.kind !== "synth") throw new Error("Legacy synth row not observed");
        expect(observed.params).toEqual(expected);
        f.assertContent(observed);
        console.log("B5c3 matrix", JSON.stringify({ group: "legacy-history", scenario: direction, family: "synth", local,
          target: "track", calls: f.calls.slice(before), remainingBytes: f.remainingBytes() }));
      }
    } finally { restore(); f.close(); }
  });
}

test("B5c2 track removal, sampler local, closed and unselected", async () => {
  const initial = b5c2Instrument("sampler", "removed");
  const fixture = await createB5c2Fixture(true, initial);
  try {
    await fixture.start();
    const before = fixture.calls.length;
    fixture.removeTrack();
    await fixture.effects.flushPending();
    await fixture.readiness();
    fixture.assertRetired(initial);
    console.log("B5c2 teardown", JSON.stringify({ scenario: "track removal", local: true, family: "sampler",
      calls: fixture.calls.slice(before), runtimeKind: fixture.runtimeKind(),
      ownerKind: fixture.device.readInstrumentForTarget(fixture.track.id)?.kind, remainingBytes: fixture.remainingBytes() }));
    expect(fixture.runtimeKind()).toBeUndefined();
    expect(fixture.remainingBytes()).toBe(0);
  } finally { fixture.close(); }
});

// Failure modes: a removed track/project retains a live runtime, an old
// sampled cache survives, or compile readiness reloads a retired device.
for (const local of [true, false]) {
  for (const kind of ["synth", "sampler", "drum-rack", "granular"]) {
    for (const scenario of ["track removal", "project switch"]) {
      test(`B5c3 teardown ${scenario}, ${kind}, local=${local}, closed and unselected`, async () => {
        if (kind !== "synth" && kind !== "sampler" && kind !== "drum-rack" && kind !== "granular") throw new Error("Unknown instrument");
        const initial = b5c2Instrument(kind, "retired");
        const fixture = await createB5c2Fixture(local, initial);
        try {
          await fixture.start();
          const before = fixture.calls.length;
          if (scenario === "track removal") fixture.removeTrack();
          else await fixture.switchProject();
          await fixture.effects.flushPending();
          await fixture.readiness();
          fixture.assertRetired(initial);
          console.log("B5c3 matrix", JSON.stringify({ group: "teardown", scenario, family: kind, local, target: "track",
            calls: fixture.calls.slice(before), remainingBytes: fixture.remainingBytes(), runtimeKind: fixture.runtimeKind() }));
          expect(fixture.runtimeKind()).toBeUndefined();
          expect(fixture.remainingBytes()).toBe(0);
        } finally { fixture.close(); }
      });
    }
  }
}

test("3B1 r5 Retry must replace a stale missing error with the fresh decode error", async () => {
  const buffer = new TestAudioBuffer(), engine = createEngine(buffer);
  let restored = false;
  const localSample = { ...sample, url: "local-asset:asset-runtime", name: "Kick" };
  const params = { ...createDefaultDrumRackParams(), pads: [{ ...createDefaultDrumRackParams().pads[0]!, sample: localSample }] };
  const failure = new Error("fresh restored-file decode failure");
  const sync = createDrumRackBufferSync({
    nativeAudio: () => true, projectId: () => "project:review-error",
    readLocalAsset: async () => restored
      ? { status: "ready", file: new File(["restored"], "restored.wav") } : { status: "missing" },
    decodePages: async function* () { yield await Promise.reject<DecodedAudioPage>(failure); },
    createBuffer: () => buffer,
  });
  try {
    await sync.syncTrack(engine, "track", params, "drum");
    expect(sync.getNativePreparation("track")?.error).toContain("is missing");
    restored = true;
    await sync.retryTrack(engine, "track", params, "drum");
    console.log("RETRY_TERMINAL_ERROR", sync.getNativePreparation("track"));
    expect(sync.getNativePreparation("track")?.error).toBe(failure.message);
  } finally { sync.dispose(); }
});

test("3B1 r5 native preparation errors retry with the cached decode", async () => {
  const buffer = new TestAudioBuffer(), engine = createEngine(buffer);
  const params = { ...createDefaultDrumRackParams(), pads: [{ ...createDefaultDrumRackParams().pads[0]!, sample }] };
  let decodes = 0, calls = 0;
  const sync = createDrumRackBufferSync({
    nativeAudio: () => true, projectId: () => "project:review-native",
    decodePages: async function* (...args) { decodes++; yield* decodeTestPages(...args); },
    createBuffer: () => buffer,
  });
  try {
    await sync.syncTrack(engine, "track", params, "drum");
    sync.setNativePreparation("track", { state: "error", error: "mlock unavailable" });
    await sync.retryTrack(engine, "track", params, "drum", async () => { calls++; throw new Error("fresh native failure"); });
    expect(sync.getNativePreparation("track")?.error).toBe("fresh native failure");
    await sync.retryTrack(engine, "track", params, "drum", async () => {
      calls++; sync.setNativePreparation("track", { state: "ready" });
    });
    expect({ decodes, calls, state: sync.getNativePreparation("track")?.state }).toEqual({ decodes: 1, calls: 2, state: "ready" });
  } finally { sync.dispose(); }
});

test("3B1 r5 cached same-key content is not refreshed by Retry", async () => {
  class RealBuffer implements AudioBuffer {
    readonly length = 48_000; readonly numberOfChannels = 2; readonly sampleRate = 48_000; readonly duration = 1;
    planes = [new Float32Array(this.length), new Float32Array(this.length)];
    getChannelData(channel: number) { return this.planes[channel]!; }
    copyFromChannel() {} copyToChannel() {}
  }
  const engine = createEngine(new TestAudioBuffer());
  const localSample = { ...sample, url: "local-asset:asset-runtime" };
  const instrument: Extract<TrackInstrumentParams, { kind: "drum-rack" }> = { kind: "drum-rack", instanceId: "drum",
    params: { ...createDefaultDrumRackParams(), pads: [{ ...createDefaultDrumRackParams().pads[0]!, sample: localSample }] } };
  let content = 1, reads = 0, decodedContent = 0;
  const sync = createDrumRackBufferSync({
    nativeAudio: () => true, projectId: () => "project:review-replaced",
    readLocalAsset: async () => { reads++; return { status: "ready", file: new File([String(content)], "sample.wav") }; },
    decodePages: async function* (source, options) {
      if (!(source instanceof File)) throw new Error("Expected local file");
      decodedContent = Number(await source.text());
      for await (const page of decodeTestPages(source, options)) {
        yield { ...page, planes: page.planes.map(plane => { plane.fill(decodedContent); return plane; }) };
      }
    },
    createBuffer: () => new RealBuffer(),
  });
  try {
    await sync.syncTrack(engine, "track", instrument.params, "drum");
    content = 2;
    sync.setNativePreparation("track", { state: "error", error: "Native prepare failed. Retry to reload." });
    let prepared = 0;
    await sync.retryTrack(engine, "track", instrument.params, "drum", async () => {
      prepared = sync.snapshotBuffers("track", instrument)?.buffers.get("pad-36")?.buffer.getChannelData(0)[0] ?? -1;
      sync.setNativePreparation("track", { state: "ready" });
    });
    console.log("SAME_KEY_CONTENT", { diskContent: content, reads, decodedContent, prepared });
    expect({ diskContent: content, reads, decodedContent, prepared }).toEqual({ diskContent: 2, reads: 1, decodedContent: 1, prepared: 1 });
  } finally { sync.dispose(); }
});

test("3B1 r5 hydration input identities cover loader descriptors and mapping", () => {
  const sampler = createSamplerBufferSync(), drum = createDrumRackBufferSync();
  const variants: NonNullable<DrumRackParams["pads"][number]["sample"]>[] = [
    { ...sample, assetKey: "other" }, { ...sample, url: "/other.wav" },
    { ...sample, sourceKind: "recording" },
    { ...sample, source: { ...sample.source, durationSec: 2 } },
    { ...sample, source: { ...sample.source, sampleRate: 44_100 } },
    { ...sample, source: { ...sample.source, channelCount: 1 } },
  ];
  const sampledInstrument: Extract<TrackInstrumentParams, { kind: "sampler" }> = { kind: "sampler", instanceId: "sampled",
    params: { ...createDefaultSamplerParams(), zones: [zone] } };
  const granular: Extract<TrackInstrumentParams, { kind: "granular" }> = { kind: "granular", instanceId: "granular",
    params: { ...createDefaultGranularParams(), zone } };
  const pad = { ...createDefaultDrumRackParams().pads[0]!, sample };
  const drumInstrument: Extract<TrackInstrumentParams, { kind: "drum-rack" }> = { kind: "drum-rack", instanceId: "drum",
    params: { pads: [pad] } };
  const samplerKey = JSON.stringify(sampler.hydrationInputs(sampledInstrument));
  const granularKey = JSON.stringify(sampler.hydrationInputs(granular));
  const drumKey = JSON.stringify(drum.hydrationInputs(drumInstrument));
  try {
    for (const variant of variants) {
      expect(JSON.stringify(sampler.hydrationInputs({ ...sampledInstrument, params: { ...sampledInstrument.params,
        zones: [{ ...zone, sample: variant }] } }))).not.toBe(samplerKey);
      expect(JSON.stringify(sampler.hydrationInputs({ ...granular, params: { ...granular.params,
        zone: { ...zone, sample: variant } } }))).not.toBe(granularKey);
      expect(JSON.stringify(drum.hydrationInputs({ ...drumInstrument, params: { pads: [{ ...pad, sample: variant }] } }))).not.toBe(drumKey);
    }
    for (const patch of [{ id: "renamed" }, { startSec: 0.1 }, { endSec: 0.9 }]) {
      expect(JSON.stringify(sampler.hydrationInputs({ ...sampledInstrument, params: { ...sampledInstrument.params,
        zones: [{ ...zone, ...patch }] } }))).not.toBe(samplerKey);
      expect(JSON.stringify(sampler.hydrationInputs({ ...granular, params: { ...granular.params, zone: { ...zone, ...patch } } }))).not.toBe(granularKey);
      expect(JSON.stringify(drum.hydrationInputs({ ...drumInstrument, params: { pads: [{ ...pad, ...patch }] } }))).not.toBe(drumKey);
    }
    expect(JSON.stringify(sampler.hydrationInputs({ ...sampledInstrument, instanceId: "new" }))).not.toBe(samplerKey);
    expect(JSON.stringify(sampler.hydrationInputs({ ...granular, instanceId: "new" }))).not.toBe(granularKey);
    expect(JSON.stringify(drum.hydrationInputs({ ...drumInstrument, instanceId: "new" }))).not.toBe(drumKey);
    expect(JSON.stringify(sampler.hydrationInputs({ ...sampledInstrument, params: { ...sampledInstrument.params,
      maxDecodedBytes: sampledInstrument.params.maxDecodedBytes / 2 } }))).not.toBe(samplerKey);
    expect(JSON.stringify(sampler.hydrationInputs({ ...granular, params: { ...granular.params,
      maxDecodedBytes: granular.params.maxDecodedBytes / 2 } }))).not.toBe(granularKey);
    expect(JSON.stringify(sampler.hydrationInputs({ ...granular, params: { ...granular.params, zone: undefined } }))).not.toBe(granularKey);
    expect(JSON.stringify(drum.hydrationInputs({ ...drumInstrument, params: { pads: [{ ...pad, sample: undefined }] } }))).not.toBe(drumKey);
    expect(JSON.stringify(drum.hydrationInputs({ ...drumInstrument, params: { pads: [{ ...pad, transpose: 12, gain: 0.5 }] } }))).toBe(drumKey);
    expect(JSON.stringify(sampler.hydrationInputs({ ...granular, params: { ...granular.params, grainSizeMs: 200 } }))).toBe(granularKey);
  } finally { sampler.dispose(); drum.dispose(); }
});

test.each(["project", "replacement", "clear"])("3B1 r5 native Retry guard rejects stale %s", async cause => {
  const buffer = new TestAudioBuffer(), engine = createEngine(buffer);
  let project = "project:review-guards", armed = false, calls = 0;
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<LocalAssetBytesResult>();
  const localSample = { ...sample, url: "local-asset:asset-runtime" };
  const params = { pads: [{ ...createDefaultDrumRackParams().pads[0]!, sample: localSample }] };
  const sync = createDrumRackBufferSync({
    nativeAudio: () => true, projectId: () => project,
    readLocalAsset: async () => { if (!armed) return { status: "missing" }; entered.resolve(); return finish.promise; },
    decodePages: decodeTestPages, createBuffer: () => buffer,
  });
  try {
    await sync.syncTrack(engine, "track", params, "drum");
    armed = true;
    const retry = sync.retryTrack(engine, "track", params, "drum", async () => { calls++; });
    await entered.promise;
    if (cause === "project") project = "project:other";
    else if (cause === "replacement") await sync.syncTrack(engine, "track", { pads: [] }, "replacement");
    else sync.clearTrack("track");
    finish.resolve({ status: "ready", file: new File(["sample"], "sample.wav") });
    await retry;
    expect(calls).toBe(0);
  } finally { finish.resolve({ status: "missing" }); sync.dispose(); }
});

test("3B1 r5 real float-WAV rejects non-finite PCM before caching and Retry prepares repaired content", async () => {
  const wav = (value: number) => {
    const bytes = new Uint8Array(44 + 48_000 * 2 * 4), view = new DataView(bytes.buffer);
    const text = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
    text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVE"); text(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 2, true);
    view.setUint32(24, 48_000, true); view.setUint32(28, 48_000 * 8, true); view.setUint16(32, 8, true);
    view.setUint16(34, 32, true); text(36, "data"); view.setUint32(40, bytes.length - 44, true);
    for (let offset = 44; offset < bytes.length; offset += 4) view.setFloat32(offset, value, true);
    return new File([bytes], "sample.wav");
  };
  class PcmBuffer implements AudioBuffer {
    readonly length = 48_000; readonly numberOfChannels = 2; readonly sampleRate = 48_000; readonly duration = 1;
    planes = [new Float32Array(this.length), new Float32Array(this.length)];
    getChannelData(channel: number) { return this.planes[channel]!; }
    copyFromChannel(destination: Float32Array, channel: number, offset = 0) {
      destination.set(this.getChannelData(channel).subarray(offset, offset + destination.length));
    }
    copyToChannel() {}
  }
  let file = wav(NaN), reads = 0;
  const instrument: Extract<TrackInstrumentParams, { kind: "drum-rack" }> = { kind: "drum-rack", instanceId: "drum",
    params: { pads: [{ ...createDefaultDrumRackParams().pads[0]!, sample: { ...sample, url: "local-asset:asset-runtime" } }] } };
  const engine = createEngine(new TestAudioBuffer());
  const sync = createDrumRackBufferSync({ nativeAudio: () => true, projectId: () => "project:review-wave",
    readLocalAsset: async () => { reads++; return { status: "ready", file }; },
    createBuffer: () => new PcmBuffer(),
  });
  const prepare = async () => {
    const buffer = sync.snapshotBuffers("track", instrument)?.buffers.get("pad-36")?.buffer;
    if (!buffer) throw new Error("Missing projected PCM");
    const descriptor = createAudioPcmSourceDescriptor({
      identity: "regional-buffer", durationSec: buffer.duration, frameCount: buffer.length,
      sampleRate: buffer.sampleRate, channelCount: buffer.numberOfChannels, source: buffer,
    });
    const manager = createNativeTimelinePageManager({
      sources: [{ sourceAssetKey: "asset-runtime", sessionAssetId: 1, frameCount: buffer.length,
        sampleRateHz: buffer.sampleRate, channelCount: buffer.numberOfChannels, descriptor }],
      writePage: async page => {
        // Mirrors AudioHost::WriteMappedAssetPage's std::isfinite admission, not a new product rule.
        const samples = new Float32Array(page.planarPcm.buffer, page.planarPcm.byteOffset, page.planarPcm.byteLength / 4);
        if (!samples.every(Number.isFinite)) throw new Error("invalid-asset-page");
      },
    });
    try { await manager.ensureRanges([{ sourceAssetKey: "asset-runtime", startFrame: 0, endFrame: buffer.length }]); }
    finally { await manager.dispose(); }
    sync.setNativePreparation("track", { state: "ready" });
  };
  try {
    let rejected = false;
    await sync.syncTrack(engine, "track", instrument.params, "drum").catch(() => { rejected = true; });
    const failedSnapshot = sync.snapshotBuffers("track", instrument);
    file = wav(0.25);
    await sync.retryTrack(engine, "track", instrument.params, "drum", prepare);
    console.log("REAL_WAVE_REPAIR", { reads, error: sync.getNativePreparation("track")?.error,
      sample: sync.snapshotBuffers("track", instrument)?.buffers.get("pad-36")?.buffer.getChannelData(0)[0] });
    expect(reads).toBe(2);
    expect(rejected).toBeTrue();
    expect(failedSnapshot).toBeUndefined();
    expect(sync.snapshotBuffers("track", instrument)?.buffers.get("pad-36")?.buffer.getChannelData(0)[0]).toBe(0.25);
    expect(sync.getNativePreparation("track")?.state).toBe("ready");
  } finally { sync.dispose(); }
});

test.each([NaN, Infinity, -Infinity])("3B1 r5 sampler loader rejects non-finite PCM %s without caching", async value => {
  let decodes = 0;
  let corrupt = true;
  const sync = createSamplerBufferSync({
    decodePages: async function* (...args) {
      decodes++;
      for await (const page of decodeTestPages(...args)) {
        if (corrupt) page.planes[1]![page.frameCount - 1] = value;
        yield page;
      }
    },
    createBuffer: () => new TestAudioBuffer(),
  });
  const instrument: Extract<TrackInstrumentParams, { kind: "sampler" }> = {
    kind: "sampler", instanceId: "sampled", params: { ...createDefaultSamplerParams(), zones: [zone] },
  };
  try {
    await expect(sync.loadBuffers("track", instrument)).rejects.toThrow("non-finite");
    await expect(sync.loadBuffers("track", instrument)).rejects.toThrow("non-finite");
    expect(decodes).toBe(2);
    corrupt = false;
    const repaired = await sync.loadBuffers("track", instrument);
    expect(repaired.samplerBuffers?.size).toBe(1);
    repaired.release();
    const cached = await sync.loadBuffers("track", instrument);
    cached.release();
    expect(decodes).toBe(3);
  } finally { sync.dispose(); }
});


test.each(["sampler-row", "granular-row", "sampler-draft"])("3B1 r2b compile waits for held %s decode without draining the panel owner", async (schedule) => {
  const source = await readFile(new URL("../components/Timeline.tsx", import.meta.url), "utf8");
  const { compilePrefix: prefix } = extractTimelineBindings(source);
  const compileProjection: (snapshot: () => EffectsPanelExportSnapshot) => Promise<{
    projection: ExportEffectsProjection;
    readiness: Awaited<ReturnType<EffectsPanelExportSnapshot["awaitInstrumentReadiness"]>>;
  }> =
    new Function(new Bun.Transpiler({ loader: "ts" }).transformSync(
      `return async (effectsExportSnapshot, context) => { ${prefix} return { projection: effectsProjection, readiness: instrumentReadiness }; }`,
    ))();
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const projectId = `project:3b1-r2b-${crypto.randomUUID()}`;
  const track: Track = { id: "sampled-track", kind: "instrument", name: "Sampled", volume: 1, clips: [] };
  const initial: TrackInstrumentParams = { kind: "sampler", instanceId: "sampled", params: createDefaultSamplerParams() };
  const rawLoaded: TrackInstrumentParams = schedule === "granular-row"
    ? { kind: "granular", instanceId: "sampled", params: { ...createDefaultGranularParams(), zone } }
    : { ...initial, params: { ...initial.params, zones: [zone] } };
  const loaded = normalizeTrackInstrumentParams(rawLoaded);
  if (!loaded) throw new Error("Invalid sampled fixture");
  const persisted = schedule === "sampler-draft" ? initial : loaded;
  await setLocalEffect(projectId, track.id, "instrument", persisted);
  let enter = () => {}, release = () => {};
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const sampler = createSamplerBufferSync({
    decodePages: async function* (...args) {
      enter();
      await held;
      yield* decodeTestPages(...args);
    },
    createBuffer: () => buffer,
  });
  const drum = createDrumRackBufferSync();
  const client = new QueryClient();
  let dispose = () => {};
  let panel: EffectsPanelController | undefined;
  let snapshot: EffectsPanelExportSnapshot | undefined;
  createRoot(end => {
    dispose = end;
    return createComponent(QueryClientProvider, {
      client,
      get children() {
        panel = createEffectsPanelController({
          isOpen: () => true, selectedFXTarget: () => track.id, tracks: () => [track],
          sidechainRoutes: () => [], audioEngine: () => engine, projectId: () => projectId,
          userId: () => undefined, playheadSec: () => 0, onClose: () => {},
          usesLegacyAudioEngine: () => false, samplerBufferSync: sampler, drumRackBufferSync: drum,
          onExportSnapshotChange: next => { snapshot = next; },
        });
        return null;
      },
    });
  });
  try {
    if (!panel || !snapshot) throw new Error("Panel snapshot was not published");
    const device = panel.devices.instrument;
    const effects = snapshot;
    if (schedule === "sampler-draft") {
      await effects.flushPending();
      device.setInstrumentForTarget(track.id, loaded);
    }
    await entered;
    // A real decode is held. In the draft case the old row is still authoritative in storage.
    expect((await getLocalEffect(projectId, track.id, "instrument"))?.params).toEqual(persisted);
    expect(device.readInstrumentForTarget(track.id)).toEqual(loaded);
    let compiled = false;
    const compilation = compileProjection(() => effects).then(({ projection, readiness }) => {
      try {
        const instrument = projection.upsertDeviceRows.find(row => row.effect === "instrument")?.params;
        if (!instrument || !("kind" in instrument)) throw new Error("Missing projected instrument");
        expect(instrument).toEqual(loaded);
        const hydrate = readiness?.hydrateInstrumentBuffers ?? effects.hydrateInstrumentBuffers;
        const hydrated = hydrate?.({
          fx: { masterVolume: 1, masterFxInstances: [], trackFx: { [track.id]: { instances: [], instrument: loaded } } },
          automationEnvelopes: [],
        });
        if (!hydrated) throw new Error("Missing hydration");
        const result = compileLivePlaybackSnapshot({
          revision: 1, bpm: 120,
          transport: { state: "stopped", playheadSec: 0, loopEnabled: false, loopStartSec: 0, loopEndSec: 0 },
          tracks: [track], renderState: hydrated, sidechainRoutes: [],
        });
        compiled = true;
        return result;
      } finally { readiness?.release(); }
    });
    for (let turn = 0; turn < 80; turn++) await Promise.resolve();
    const compiledBeforeDecode = compiled;
    release();
    const result = await compilation;
    // Report both facts on red: the early compile and the truthful missing-buffer rejection.
    expect({ compiledBeforeDecode, supported: result.supported }).toEqual({ compiledBeforeDecode: false, supported: true });
    if (result.supported) expect(result.snapshot.assets[0]?.buffer).toBe(buffer);
    await effects.flushPending();
  } finally {
    release();
    dispose();
    client.clear();
    sampler.dispose();
    drum.dispose();
  }
});

test.each(["sampler", "granular", "sampler-change"])("3B1 r3 queued %s successor loads without an early engine install", async (schedule) => {
  const kind = schedule === "granular" ? "granular" : "sampler";
  const source = await readFile(new URL("../components/Timeline.tsx", import.meta.url), "utf8");
  const { compilePrefix: prefix, structural: handler } = extractTimelineBindings(source);
  const compileProjection: (snapshot: () => EffectsPanelExportSnapshot) => Promise<{
    projection: ExportEffectsProjection;
    readiness: Awaited<ReturnType<EffectsPanelExportSnapshot["awaitInstrumentReadiness"]>>;
  }> =
    new Function(new Bun.Transpiler({ loader: "ts" }).transformSync(
      `return async (effectsExportSnapshot, context) => { ${prefix} return { projection: effectsProjection, readiness: instrumentReadiness }; }`,
    ))();
  const makeCallback = new Function("deps", new Bun.Transpiler({ loader: "ts" }).transformSync(`
    const { mountedProjectGeneration, awaitPlaybackPreparation, preparedInstrument, isStructuralRebuildInProgress,
      isPreparingPlayback, isPlaying, isNativePlaybackPrepared, isPortableBrowserPlaybackPrepared,
      syncPlaybackBackend, renderTracks, captureStructuralPlaybackIntent, notify } = deps;
    let instrumentPlaybackChangeTail = Promise.resolve();
    return ({ ${handler} }).onStructuralPlaybackChange;
  `));
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const projectId = `project:3b1-r3-successor-${crypto.randomUUID()}`;
  const track: Track = { id: "sampled-track", kind: "instrument", name: "Sampled", volume: 1, clips: [] };
  const initial: TrackInstrumentParams = { kind: "sampler", instanceId: "sampled", params: createDefaultSamplerParams() };
  const next = (assetKey: string): TrackInstrumentParams => kind === "granular"
    ? { kind: "granular", instanceId: "sampled", params: { ...createDefaultGranularParams(),
      zone: { ...zone, sample: { ...sample, assetKey, url: `/${assetKey}.wav` } } } }
    : { ...initial, params: { ...initial.params,
      zones: [{ ...zone, sample: { ...sample, assetKey, url: `/${assetKey}.wav` } }] } };
  const first = next("first"), second = next("successor");
  const final = schedule === "sampler-change" ? next("fresh") : second;
  await setLocalEffect(projectId, track.id, "instrument", initial);
  let decodes = 0;
  const decodingSuccessor = Promise.withResolvers<void>(), finishSuccessor = Promise.withResolvers<void>();
  const sampler = createSamplerBufferSync({ decodePages: async function* (...args) {
    decodes++;
    if (schedule === "sampler-change" && decodes === 2) {
      decodingSuccessor.resolve();
      await finishSuccessor.promise;
    }
    yield* decodeTestPages(...args);
  }, createBuffer: () => buffer });
  const drum = createDrumRackBufferSync();
  const client = new QueryClient();
  const announced = Promise.withResolvers<void>(), preparation = Promise.withResolvers<void>();
  let armed = false, dispose = () => {};
  const structural: (id: string, instrument: TrackInstrumentParams | undefined) => Promise<void> = makeCallback({
    mountedProjectGeneration: () => 0,
    awaitPlaybackPreparation: async () => { if (armed) { announced.resolve(); await preparation.promise; } },
    preparedInstrument: () => undefined, isStructuralRebuildInProgress: () => false,
    isPreparingPlayback: () => armed, isPlaying: () => false,
    isNativePlaybackPrepared: () => false, isPortableBrowserPlaybackPrepared: () => false,
    syncPlaybackBackend: async () => {}, renderTracks: () => [track],
    captureStructuralPlaybackIntent: () => ({}), notify: () => {},
  });
  let panel: EffectsPanelController | undefined;
  let snapshot: EffectsPanelExportSnapshot | undefined;
  createRoot(end => {
    dispose = end;
    return createComponent(QueryClientProvider, { client, get children() {
      panel = createEffectsPanelController({
        isOpen: () => true, selectedFXTarget: () => track.id, tracks: () => [track],
        sidechainRoutes: () => [], audioEngine: () => engine, projectId: () => projectId,
        userId: () => undefined, playheadSec: () => 0, onClose: () => {},
        usesLegacyAudioEngine: () => false, samplerBufferSync: sampler, drumRackBufferSync: drum,
        onExportSnapshotChange: next => { snapshot = next; }, onStructuralPlaybackChange: structural,
      });
      return null;
    } });
  });
  try {
    if (!panel || !snapshot) throw new Error("Missing controller");
    const device = panel.devices.instrument, effects = snapshot;
    await effects.flushPending();
    armed = true;
    device.setInstrumentForTarget(track.id, first);
    await announced.promise;
    const firstReadiness = await effects.awaitInstrumentReadiness();
    firstReadiness?.release();
    const installs = engine.samplerInstalls, previousGranular = engine.granularBuffer(track.id);
    device.setInstrumentForTarget(track.id, second);
    const compiling = compileProjection(() => effects);
    if (schedule === "sampler-change") {
      await decodingSuccessor.promise;
      device.setInstrumentForTarget(track.id, final);
      finishSuccessor.resolve();
    }
    const { projection, readiness } = await compiling;
    try {
      expect(projection.upsertDeviceRows.find(row => row.effect === "instrument")?.params).toEqual(final);
      expect(engine.samplerInstalls).toBe(installs);
      expect(engine.granularBuffer(track.id)).toBe(previousGranular);
      const hydrate = readiness?.hydrateInstrumentBuffers ?? effects.hydrateInstrumentBuffers;
      const hydrated = hydrate?.({
        fx: { masterVolume: 1, masterFxInstances: [], trackFx: { [track.id]: { instances: [], instrument: final } } },
        automationEnvelopes: [],
      });
      if (!hydrated) throw new Error("Missing hydration");
      const result = compileLivePlaybackSnapshot({
        revision: 1, bpm: 120,
        transport: { state: "stopped", playheadSec: 0, loopEnabled: false, loopStartSec: 0, loopEndSec: 0 },
        tracks: [track], renderState: hydrated, sidechainRoutes: [],
      });
      expect(result.supported).toBeTrue();
      if (result.supported) expect(result.snapshot.assets[0]?.buffer).toBe(buffer);
    } finally { readiness?.release(); }
    armed = false;
    preparation.resolve();
    await effects.flushPending();
    expect(decodes).toBe(schedule === "sampler-change" ? 3 : 2);
  } finally {
    armed = false;
    finishSuccessor.resolve();
    preparation.resolve();
    await snapshot?.flushPending();
    dispose(); client.clear(); sampler.dispose(); drum.dispose();
  }
});

test.each(["utility", "sampler", "granular"])("3B1 r4 missing sample readiness ignores %s parameter ticks and compiles fresh values", async schedule => {
  const engine = createEngine(new TestAudioBuffer());
  const projectId = `project:3b1-r4-${crypto.randomUUID()}`;
  const track: Track = { id: "track", kind: "instrument", name: "Sampled", volume: 1, clips: [] };
  const localZone = { ...zone, sample: { ...sample, url: "local-asset:asset-runtime" } };
  const instrument: TrackInstrumentParams = schedule === "granular"
    ? { kind: "granular", instanceId: "sampled", params: { ...createDefaultGranularParams(), zone: localZone } }
    : { kind: "sampler", instanceId: "sampled", params: { ...createDefaultSamplerParams(), zones: [localZone] } };
  await setLocalEffect(projectId, track.id, "instrument", instrument);
  await setLocalEffectInstance(projectId, track.id, "utility", { version: 1, state: createDefaultUtilityParams() }, { instanceId: "utility" });
  const reads: ReturnType<typeof Promise.withResolvers<LocalAssetBytesResult>>[] = [];
  let armed = false;
  const sampler = createSamplerBufferSync({ projectId: () => projectId, readLocalAsset: async () => {
    if (!armed) return { status: "missing" };
    const read = Promise.withResolvers<LocalAssetBytesResult>();
    reads.push(read);
    return read.promise;
  } });
  const drum = createDrumRackBufferSync(), client = new QueryClient();
  let panel: EffectsPanelController | undefined, snapshot: EffectsPanelExportSnapshot | undefined, dispose = () => {};
  createRoot(end => {
    dispose = end;
    return createComponent(QueryClientProvider, { client, get children() {
      panel = createEffectsPanelController({
        isOpen: () => true, selectedFXTarget: () => track.id, tracks: () => [track], sidechainRoutes: () => [],
        audioEngine: () => engine, projectId: () => projectId, userId: () => undefined, playheadSec: () => 0,
        onClose: () => {}, usesLegacyAudioEngine: () => false, samplerBufferSync: sampler, drumRackBufferSync: drum,
        onExportSnapshotChange: next => { snapshot = next; },
      });
      return null;
    } });
  });
  if (!panel || !snapshot) throw new Error("Missing controller");
  const device = panel.devices.instrument, audio = panel.devices.audioEffects, effects = snapshot;
  await effects.flushPending();
  const originalFrame = globalThis.requestAnimationFrame, originalCancel = globalThis.cancelAnimationFrame;
  // Hold the existing preview frame so parameter drafts change without starting a separate FIFO load.
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const gesture = schedule === "utility" ? audio.gestureOwner("utility", "utility") : device.gestureOwner;
  const holder = new ParameterGestureHolder();
  gesture.open(holder);
  armed = true;
  let settled = false, changes = 0;
  const compiling = effects.awaitInstrumentReadiness().then(lease => { settled = true; return lease; });
  // Finite microtask observation, with each source read explicitly held and released.
  const turns = async () => { for (let turn = 0; turn < 150; turn++) await Promise.resolve(); };
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      await turns();
      if (settled) break;
      expect(reads.length).toBe(attempt + 1);
      for (let tick = 0; tick < 5; tick++) {
        changes++;
        gesture.tick(holder, () => {
          if (schedule === "utility") audio.utility.changeInstance("utility", params => ({ ...params, state: { ...params.state, gainDb: changes } }));
          else if (schedule === "sampler") device.sampler.update({ ampEnvelope: { ...createDefaultSamplerParams().ampEnvelope, attackSec: changes } });
          else device.granular.update({ grainSizeMs: 80 + changes });
        });
      }
      reads[attempt]?.resolve({ status: "missing" });
    }
    await turns();
    expect({ reads: reads.length, settled }).toEqual({ reads: 1, settled: true });
    const lease = await compiling;
    try {
      const current = device.readInstrumentForTarget(track.id);
      expect(lease?.projection.upsertDeviceRows.find(row => row.effect === "instrument")?.params).toEqual(current);
      const utility = lease?.projection.replaceAudioEffectTargets.flatMap(target => target.rows)
        .find(row => row.effect === "utility");
      if (schedule === "utility") expect(utility?.params).toEqual({ version: 1, state: { ...createDefaultUtilityParams(), gainDb: changes } });
      if (schedule === "sampler") expect(current?.kind === "sampler" && current.params.ampEnvelope.attackSec).toBe(changes);
      if (schedule === "granular") expect(current?.kind === "granular" && current.params.grainSizeMs).toBe(80 + changes);
      const hydrated = lease?.hydrateInstrumentBuffers({
        fx: { masterVolume: 1, masterFxInstances: [], trackFx: { [track.id]: { instances: [], instrument: current } } },
        automationEnvelopes: [],
      });
      if (!hydrated) throw new Error("Missing hydration");
      expect(hydrated.fx.trackFx?.[track.id].unavailableSampleAssetKeys).toEqual([sample.assetKey]);
      const compiled = compileLivePlaybackSnapshot({
        revision: 1, bpm: 120, tracks: [track], renderState: hydrated, sidechainRoutes: [],
        transport: { state: "stopped", playheadSec: 0, loopEnabled: false, loopStartSec: 0, loopEndSec: 0 },
      });
      expect(compiled.supported).toBeTrue();
      if (compiled.supported) expect(compiled.snapshot.mixer.fx.trackFx?.[track.id].instrument).toEqual(current);
    } finally { lease?.release(); }
  } finally {
    armed = false;
    for (const read of reads) read.resolve({ status: "missing" });
    (await compiling)?.release();
    gesture.cancel(holder);
    globalThis.requestAnimationFrame = originalFrame;
    globalThis.cancelAnimationFrame = originalCancel;
    dispose(); client.clear(); sampler.dispose(); drum.dispose();
  }
});

test.each(["readiness", "runtime"])("3B1 r4 Drum Rack Retry preserves %s during a held unchanged-input read", async schedule => {
  const buffer = new TestAudioBuffer();
  class Engine extends TestAudioEngine {
    clears = 0;
    override clearTrackDrumRack() { this.clears++; }
  }
  const engine = new Engine(buffer), projectId = `project:r4-retry-${crypto.randomUUID()}`;
  const track: Track = { id: "track", kind: "instrument", name: "Drum", volume: 1, clips: [] };
  const missing = { ...sample, assetKey: "missing", url: "local-asset:missing" };
  const available = { ...sample, assetKey: "available", url: "local-asset:available" };
  const instrument: Extract<TrackInstrumentParams, { kind: "drum-rack" }> = {
    kind: "drum-rack", instanceId: "drum", params: { ...createDefaultDrumRackParams(),
      pads: createDefaultDrumRackParams().pads.map(pad => pad.id === "pad-36"
        ? { ...pad, sample: missing } : pad.id === "pad-37" ? { ...pad, sample: available } : pad) },
  };
  await setLocalEffect(projectId, track.id, "instrument", instrument);
  let armed = false, reads = 0, availableReads = 0;
  const entered = Promise.withResolvers<void>(), replacementEntered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<LocalAssetBytesResult>(), replacement = Promise.withResolvers<LocalAssetBytesResult>();
  const drum = createDrumRackBufferSync({
    projectId: () => projectId, nativeAudio: () => true,
    decodePages: decodeTestPages, createBuffer: () => buffer,
    readLocalAsset: async (_project, assetId) => {
      if (assetId === available.assetKey) {
        availableReads++;
        return { status: "ready", file: new File(["sample"], "available.wav") };
      }
      if (!armed) return { status: "missing" };
      reads++;
      if (reads === 1) { entered.resolve(); return held.promise; }
      replacementEntered.resolve();
      return replacement.promise;
    },
  });
  const sampler = createSamplerBufferSync(), client = new QueryClient();
  let dispose = () => {}, panel: EffectsPanelController | undefined, snapshot: EffectsPanelExportSnapshot | undefined;
  createRoot(end => {
    dispose = end;
    return createComponent(QueryClientProvider, { client, get children() {
      panel = createEffectsPanelController({
        isOpen: () => true, selectedFXTarget: () => track.id, tracks: () => [track], sidechainRoutes: () => [],
        audioEngine: () => engine, projectId: () => projectId, userId: () => undefined, playheadSec: () => 0,
        onClose: () => {}, usesLegacyAudioEngine: () => false, samplerBufferSync: sampler, drumRackBufferSync: drum,
        onExportSnapshotChange: next => { snapshot = next; },
      });
      return null;
    } });
  });
  if (!panel || !snapshot) throw new Error("Missing controller");
  const device = panel.devices.instrument, effects = snapshot;
  await effects.flushPending();
  expect(device.drumRack.nativeStatus()?.state).toBe("error");
  expect(engine.drumRackBufferIds(track.id)).toEqual(["pad-37"]);
  const clears = engine.clears, previousAvailableReads = availableReads;
  const projection = effects.snapshotEffectsProjection();
  armed = true;
  const compiling = effects.awaitInstrumentReadiness().then(
    lease => ({ lease, cause: undefined }), (cause: unknown) => ({ lease: undefined, cause }));
  try {
    await entered.promise;
    device.drumRack.retry();
    await replacementEntered.promise;
    expect(effects.snapshotEffectsProjection()).toEqual(projection);
    if (schedule === "runtime") {
      expect(engine.clears).toBe(clears);
      expect(engine.drumRackBufferIds(track.id)).toEqual(["pad-37"]);
      expect(device.drumRack.nativeStatus()).toMatchObject({ state: "error", error: expect.stringContaining("missing") });
    }
    held.resolve({ status: "missing" });
    replacement.resolve({ status: "ready", file: new File(["sample"], "restored.wav") });
    const result = await compiling;
    try {
      if (schedule === "readiness") {
        expect(result.cause).toBeUndefined();
        const hydrated = result.lease?.hydrateInstrumentBuffers({
          fx: { masterVolume: 1, masterFxInstances: [], trackFx: { [track.id]: { instances: [], instrument } } },
          automationEnvelopes: [],
        });
        expect(hydrated?.fx.trackFx?.[track.id].drumRackBuffers)
          .toEqual(new Map([["pad-36", sampled(buffer)], ["pad-37", sampled(buffer)]]));
        expect(hydrated?.fx.trackFx?.[track.id].unavailableSampleAssetKeys).toEqual([]);
      }
      await effects.flushPending();
      expect(reads).toBe(2);
      expect(availableReads).toBe(previousAvailableReads);
      expect(engine.drumRackBufferIds(track.id)).toEqual(["pad-36", "pad-37"]);
      expect(device.drumRack.nativeStatus()?.error).toBeUndefined();
    } finally { result.lease?.release(); }
  } finally {
    held.resolve({ status: "missing" }); replacement.resolve({ status: "missing" });
    (await compiling).lease?.release();
    await effects.flushPending();
    dispose(); client.clear(); sampler.dispose(); drum.dispose();
  }
});

test.each(["unchanged", "changed"])("3B1 r4 decode error retries only for %s hydration inputs", async schedule => {
  const engine = createEngine(new TestAudioBuffer()), projectId = `project:3b1-r4-error-${crypto.randomUUID()}`;
  const track: Track = { id: "track", kind: "instrument", name: "Sampled", volume: 1, clips: [] };
  const localZone = { ...zone, sample: { ...sample, url: "local-asset:asset-runtime" } };
  const instrument: TrackInstrumentParams = { kind: "sampler", instanceId: "sampled",
    params: { ...createDefaultSamplerParams(), zones: [localZone] } };
  await setLocalEffect(projectId, track.id, "instrument", instrument);
  await setLocalEffectInstance(projectId, track.id, "utility", { version: 1, state: createDefaultUtilityParams() }, { instanceId: "utility" });
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<LocalAssetBytesResult>();
  let armed = false, reads = 0;
  const failure = new Error("r4 genuine decode failure");
  const sampler = createSamplerBufferSync({
    projectId: () => projectId,
    readLocalAsset: async () => {
      if (!armed) return { status: "missing" };
      reads++;
      if (reads > 1) return { status: "missing" };
      entered.resolve();
      return finish.promise;
    },
    decodePages: async function* () { yield await Promise.reject<DecodedAudioPage>(failure); },
  });
  const drum = createDrumRackBufferSync(), client = new QueryClient();
  let panel: EffectsPanelController | undefined, snapshot: EffectsPanelExportSnapshot | undefined, dispose = () => {};
  createRoot(end => {
    dispose = end;
    return createComponent(QueryClientProvider, { client, get children() {
      panel = createEffectsPanelController({
        isOpen: () => true, selectedFXTarget: () => track.id, tracks: () => [track], sidechainRoutes: () => [],
        audioEngine: () => engine, projectId: () => projectId, userId: () => undefined, playheadSec: () => 0,
        onClose: () => {}, usesLegacyAudioEngine: () => false, samplerBufferSync: sampler, drumRackBufferSync: drum,
        onExportSnapshotChange: next => { snapshot = next; },
      });
      return null;
    } });
  });
  if (!panel || !snapshot) throw new Error("Missing controller");
  const device = panel.devices.instrument, audio = panel.devices.audioEffects, effects = snapshot;
  await effects.flushPending();
  const originalFrame = globalThis.requestAnimationFrame, originalCancel = globalThis.cancelAnimationFrame;
  // Keep the real owner draft visible while its existing preview frame is held.
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const holder = new ParameterGestureHolder(), audioHolder = new ParameterGestureHolder();
  const gesture = device.gestureOwner, audioGesture = audio.gestureOwner("utility", "utility");
  gesture.open(holder); audioGesture.open(audioHolder);
  armed = true;
  const compiling = effects.awaitInstrumentReadiness().then(lease => ({ lease, cause: undefined }),
    (cause: unknown) => ({ lease: undefined, cause }));
  try {
    await entered.promise;
    audioGesture.tick(audioHolder, () => audio.utility.changeInstance("utility", params => ({ ...params, state: { ...params.state, gainDb: 5 } })));
    gesture.tick(holder, () => {
      if (schedule === "changed") device.sampler.updateZone(zone.id, { sample: { ...localZone.sample, assetKey: "fresh", url: "local-asset:fresh" } });
      else device.sampler.update({ ampEnvelope: { ...instrument.params.ampEnvelope, attackSec: 2 } });
    });
    finish.resolve({ status: "ready", file: new File(["sample"], "sample.wav") });
    const result = await compiling;
    try {
      expect(result.cause).toBe(schedule === "changed" ? undefined : failure);
      expect(reads).toBe(schedule === "changed" ? 2 : 1);
      if (schedule === "changed") {
        expect(result.lease?.projection.upsertDeviceRows.find(row => row.effect === "instrument")?.params)
          .toEqual(device.readInstrumentForTarget(track.id));
      }
    } finally { result.lease?.release(); }
  } finally {
    armed = false; finish.resolve({ status: "missing" });
    (await compiling).lease?.release();
    gesture.cancel(holder); audioGesture.cancel(audioHolder);
    globalThis.requestAnimationFrame = originalFrame;
    globalThis.cancelAnimationFrame = originalCancel;
    dispose(); client.clear(); sampler.dispose(); drum.dispose();
  }
});

test("3B1 r3 granular processorerror settles the tracked readiness drain truthfully", async () => {
  const installed = Promise.withResolvers<void>(), faults: string[] = [];
  const node: ReturnType<NonNullable<Parameters<typeof createGranularRuntime>[0]["createNode"]>> = {
    parameters: new Map(), connect: () => {}, disconnect: () => {}, onprocessorerror: null,
    port: { onmessage: null, close: () => {}, postMessage: (message: GranularWorkletControlMessage) => {
      if (message.type === "install") installed.resolve();
    } },
  };
  const runtime = await createGranularRuntime({
    context: { currentTime: 0 }, params: createDefaultGranularParams(),
    createNode: () => node, onFault: code => { faults.push(code); },
  });
  class Engine extends TestAudioEngine {
    override setTrackGranular(_id: string, _params: GranularParams,
      buffer?: Parameters<AudioEngine["setTrackGranular"]>[2]): ReturnType<AudioEngine["setTrackGranular"]> {
      return buffer ? runtime.installSample(buffer) : Promise.resolve("applied");
    }
  }
  const engine = new Engine(new TestAudioBuffer()), owner = createPendingWorkOwner();
  const sampler = createSamplerBufferSync({ decodePages: decodeTestPages, createBuffer: () => new TestAudioBuffer() });
  const work = sampler.syncGranularTrack(engine, "track", { ...createDefaultGranularParams(), zone }, "granular");
  let failure: unknown;
  void work.catch(cause => { failure = cause; });
  owner.track("project", work);
  let drained = false;
  const drain = owner.flushPending("project").then(() => { drained = true; });
  try {
    await installed.promise;
    node.onprocessorerror?.(Object.assign(new Event("processorerror"), { message: "processor failed", filename: "", lineno: 0, colno: 0, error: null }));
    // Finite microtask observation detects a missing terminal without introducing a timer.
    for (let turn = 0; turn < 100; turn++) await Promise.resolve();
    expect({ faults, drained, error: failure instanceof Error ? failure.message : undefined })
      .toEqual({ faults: ["processor-error"], drained: true,
        error: "Granular sample installation failed: processor-error" });
  } finally {
    runtime.close(); await drain; sampler.dispose(); owner.dispose();
  }
});

test.each(["sampler", "granular", "drum-rack"])("3B1 r3 load-only %s shares its region cache and releases compile pins", async kind => {
  const buffer = new TestAudioBuffer(), engine = createEngine(buffer);
  const bytes = buffer.length * buffer.numberOfChannels * 4;
  const budget = createSampledInstrumentRegionBudget(bytes * (kind === "granular" ? 2 : 1));
  let decodes = 0;
  const options = { aggregateBudget: budget, decodePages: async function* (...args: Parameters<typeof decodeTestPages>) {
    decodes++;
    yield* decodeTestPages(...args);
  }, createBuffer: () => buffer };
  const sampler = createSamplerBufferSync(options), drum = createDrumRackBufferSync(options);
  const instrument: Exclude<TrackInstrumentParams, { kind: "synth" }> = kind === "sampler"
    ? { kind: "sampler", instanceId: "sampled", params: { ...createDefaultSamplerParams(), zones: [zone] } }
    : kind === "granular" ? { kind: "granular", instanceId: "sampled", params: { ...createDefaultGranularParams(), zone } }
      : { kind: "drum-rack", instanceId: "sampled", params: { ...createDefaultDrumRackParams(),
        pads: createDefaultDrumRackParams().pads.map(pad => pad.id === "pad-36" ? { ...pad, sample } : pad) } };
  let release = () => {};
  try {
    const loaded = instrument.kind === "drum-rack"
      ? await drum.loadBuffers("track", instrument) : await sampler.loadBuffers("track", instrument);
    release = loaded.release;
    expect(engine.samplerInstalls).toBe(0);
    expect(budget.totalBytes()).toBe(bytes * (kind === "granular" ? 2 : 1));
    expect(() => budget.ensureCapacity("competitor", bytes)).toThrow("aggregate limit");
    if (instrument.kind === "sampler") await sampler.syncTrack(engine, "track", instrument.params, instrument.instanceId);
    else if (instrument.kind === "granular") await sampler.syncGranularTrack(engine, "track", instrument.params, instrument.instanceId);
    else await drum.syncTrack(engine, "track", instrument.params, instrument.instanceId);
    expect(decodes).toBe(1);
    release();
    // Granular's runtime owns its independent playback pin until its track ends.
    if (instrument.kind === "granular") sampler.clearTrack("track");
    expect(() => budget.ensureCapacity("competitor", bytes)).not.toThrow();
  } finally { release(); sampler.dispose(); drum.dispose(); budget.dispose(); }
});

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
  })).toMatchObject({ buffers: new Map([["pad-36", sampled(buffer)]]), unavailableSampleAssetKeys: [] });
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
    if (instrument.kind === "drum-rack") {
      const snapshot = drumSync.snapshotBuffers(targetId, instrument);
      return snapshot ? { drumRackBuffers: snapshot.buffers, unavailableSampleAssetKeys: snapshot.unavailableSampleAssetKeys } : undefined;
    }
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
  })).toMatchObject({ buffers: new Map([["pad-36", sampled(buffer)]]), unavailableSampleAssetKeys: [] });
  samplerSync.dispose();
  drumSync.dispose();
});

test("reports missing sampled instruments and retries Drum Rack after asset restoration", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  let restored = false;
  const missingSample = {
    ...sample,
    assetKey: "missing-kick",
    url: "local-asset:missing-kick",
    name: "Kick",
  };
  const availableSample = {
    ...sample,
    assetKey: "available-snare",
    url: "local-asset:available-snare",
    name: "Snare",
  };
  const localDrum = {
    ...createDefaultDrumRackParams(),
    pads: createDefaultDrumRackParams().pads.map((pad) => (
      pad.id === "pad-36"
        ? { ...pad, sample: missingSample }
        : pad.id === "pad-37"
          ? { ...pad, sample: availableSample }
          : pad
    )),
  };
  const drumSync = createDrumRackBufferSync({
    nativeAudio: () => true,
    projectId: () => "project:missing",
    readLocalAsset: async (_projectId, assetId) => assetId === missingSample.assetKey && !restored
      ? { status: "missing" }
      : { status: "ready", file: new File([new Uint8Array([1])], "sample.wav") },
    decodePages: decodeTestPages,
    createBuffer: () => buffer,
  });

  await drumSync.syncTrack(engine, "missing-drum", localDrum, "drum-instance");
  expect(drumSync.getNativePreparation("missing-drum")).toEqual({
    state: "error",
    error: '"Kick" is missing. Restore the file and retry.',
  });
  drumSync.setNativePreparation("missing-drum", { state: "loading" });
  expect(drumSync.getNativePreparation("missing-drum")).toMatchObject({
    state: "error",
    error: '"Kick" is missing. Restore the file and retry.',
  });
  drumSync.setNativePreparation("missing-drum", { state: "ready" });
  expect(drumSync.getNativePreparation("missing-drum")).toMatchObject({
    state: "error",
    error: '"Kick" is missing. Restore the file and retry.',
  });
  expect(engine.drumRackBufferIds("missing-drum")).toEqual(["pad-37"]);

  restored = true;
  await drumSync.retryTrack(engine, "missing-drum", localDrum, "drum-instance", async () => {
    drumSync.setNativePreparation("missing-drum", { state: "ready" });
  });
  expect(drumSync.getNativePreparation("missing-drum")?.state).toBe("ready");
  expect(engine.drumRackBufferIds("missing-drum")).toEqual(["pad-36", "pad-37"]);
  drumSync.dispose();
});

test("reports missing Sampler and Granular assets as errors rather than loading", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const missingSample = {
    ...sample,
    assetKey: "missing-instrument",
    url: "local-asset:missing-instrument",
    name: "Missing Source",
  };
  const missingZone = { ...zone, sample: missingSample };
  const sync = createSamplerBufferSync({
    nativeAudio: () => true,
    projectId: () => "project:missing",
    readLocalAsset: async (_projectId, assetKey) => {
      if (assetKey === missingSample.assetKey && !restored) return { status: "missing" };
      return { status: "ready", file: new File([new Uint8Array([1])], "restored.wav") };
    },
    decodePages: decodeTestPages,
    createBuffer: () => buffer,
  });
  let restored = false;

  await sync.syncTrack(engine, "missing-sampler", {
    ...createDefaultSamplerParams(),
    zones: [missingZone],
  }, "sampler-instance");
  await sync.syncGranularTrack(engine, "missing-granular", {
    ...createDefaultGranularParams(),
    zone: missingZone,
  }, "granular-instance");

  expect(sync.getStatus("missing-sampler").zones.get(missingZone.id)).toBe("error");
  expect(sync.getStatus("missing-sampler").errors.get(missingZone.id)).toBe(
    '"Missing Source" is missing. Restore the file and retry.',
  );
  expect(sync.getGranularStatus("missing-granular")).toMatchObject({
    state: "error",
    error: '"Missing Source" is missing. Restore the file and retry.',
  });
  sync.setNativePreparation("missing-sampler", { state: "loading" });
  sync.setNativePreparation("missing-granular", { state: "ready" });
  expect(sync.getStatus("missing-sampler").errors.get(missingZone.id)).toBe(
    '"Missing Source" is missing. Restore the file and retry.',
  );
  expect(sync.getGranularStatus("missing-granular").error).toBe(
    '"Missing Source" is missing. Restore the file and retry.',
  );
  restored = true;
  await sync.retryZone(engine, "missing-sampler", missingZone.id, async () => {
    sync.setNativePreparation("missing-sampler", { state: "ready" });
  });
  await sync.retryGranular(engine, "missing-granular", async () => {
    sync.setNativePreparation("missing-granular", { state: "ready" });
  });
  expect(sync.getStatus("missing-sampler").errors.has(missingZone.id)).toBe(false);
  expect(sync.getStatus("missing-sampler").zones.get(missingZone.id)).toBe("ready");
  expect(sync.getGranularStatus("missing-granular")).toMatchObject({ state: "ready", error: undefined });
  sync.dispose();
});

test("preserves unavailable sampler markers when retry confirms the sample is still missing", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const missingSample = {
    ...sample,
    assetKey: "retry-still-missing",
    url: "local-asset:retry-still-missing",
    name: "Retry Sample",
  };
  const missingZone = { ...zone, sample: missingSample };
  const params = { ...createDefaultSamplerParams(), zones: [missingZone] };
  const sync = createSamplerBufferSync({
    nativeAudio: () => true,
    projectId: () => "project:retry-missing",
    readLocalAsset: async (): Promise<LocalAssetBytesResult> => ({ status: "missing" }),
    decodePages: decodeTestPages,
    createBuffer: () => buffer,
  });

  await sync.syncTrack(engine, "retry-missing", params, "sampler-instance");
  expect(sync.snapshotUnavailableAssetKeys("retry-missing", {
    kind: "sampler",
    instanceId: "sampler-instance",
    params,
  })).toEqual([missingSample.assetKey]);
  await sync.retryZone(engine, "retry-missing", missingZone.id);
  expect(sync.snapshotUnavailableAssetKeys("retry-missing", {
    kind: "sampler",
    instanceId: "sampler-instance",
    params,
  })).toEqual([missingSample.assetKey]);
  expect(sync.getStatus("retry-missing").errors.get(missingZone.id)).toBe(
    '"Retry Sample" is missing. Restore the file and retry.',
  );
  sync.dispose();
});

test("clears confirmed missing state when reused instrument identities switch projects", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  let projectId = "project:a";
  const unavailableSample = {
    ...sample,
    assetKey: "reused-instrument-asset",
    url: "local-asset:reused-instrument-asset",
    name: "Reused Sample",
  };
  const missingZone = { ...zone, sample: unavailableSample };
  const drumParams = {
    ...createDefaultDrumRackParams(),
    pads: createDefaultDrumRackParams().pads.map((pad) => (
      pad.id === "pad-36" ? { ...pad, sample: unavailableSample } : pad
    )),
  };
  const samplerParams = { ...createDefaultSamplerParams(), zones: [missingZone] };
  const granularParams = { ...createDefaultGranularParams(), zone: missingZone };
  const readLocalAsset = async (): Promise<LocalAssetBytesResult> => projectId === "project:a"
    ? { status: "missing" }
    : { status: "permission-denied" };
  const drumSync = createDrumRackBufferSync({
    nativeAudio: () => true,
    projectId: () => projectId,
    readLocalAsset,
    decodePages: decodeTestPages,
    createBuffer: () => buffer,
  });
  const samplerSync = createSamplerBufferSync({
    nativeAudio: () => true,
    projectId: () => projectId,
    readLocalAsset,
    decodePages: decodeTestPages,
    createBuffer: () => buffer,
  });

  await Promise.all([
    drumSync.syncTrack(engine, "reused-drum", drumParams, "reused-instance"),
    samplerSync.syncTrack(engine, "reused-sampler", samplerParams, "reused-instance"),
    samplerSync.syncGranularTrack(engine, "reused-granular", granularParams, "reused-instance"),
  ]);
  expect(samplerSync.snapshotUnavailableAssetKeys("reused-sampler", {
    kind: "sampler",
    instanceId: "reused-instance",
    params: samplerParams,
  })).toEqual(["reused-instrument-asset"]);
  expect(samplerSync.snapshotUnavailableAssetKeys("reused-granular", {
    kind: "granular",
    instanceId: "reused-instance",
    params: granularParams,
  })).toEqual(["reused-instrument-asset"]);

  projectId = "project:b";
  await expect(drumSync.syncTrack(engine, "reused-drum", drumParams, "reused-instance"))
    .rejects.toThrow("Permission to read local audio asset");
  await expect(samplerSync.syncTrack(engine, "reused-sampler", samplerParams, "reused-instance"))
    .rejects.toThrow("Permission to read local audio asset");
  await expect(samplerSync.syncGranularTrack(engine, "reused-granular", granularParams, "reused-instance"))
    .rejects.toThrow("Permission to read local audio asset");

  expect(drumSync.getNativePreparation("reused-drum")?.error).toContain("Permission to read");
  expect(drumSync.getNativePreparation("reused-drum")?.error).not.toContain("is missing");
  expect(samplerSync.snapshotUnavailableAssetKeys("reused-sampler", {
    kind: "sampler",
    instanceId: "reused-instance",
    params: samplerParams,
  })).toEqual([]);
  expect(samplerSync.snapshotUnavailableAssetKeys("reused-granular", {
    kind: "granular",
    instanceId: "reused-instance",
    params: granularParams,
  })).toEqual([]);
  expect(samplerSync.getStatus("reused-sampler").errors.get(missingZone.id)).toContain("Permission to read");
  expect(samplerSync.getStatus("reused-sampler").errors.get(missingZone.id)).not.toContain("is missing");
  expect(samplerSync.getGranularStatus("reused-granular").error).toContain("Permission to read");
  expect(samplerSync.getGranularStatus("reused-granular").error).not.toContain("is missing");
  samplerSync.dispose();
  drumSync.dispose();
});

test("invalidates Drum Rack unavailable snapshots when revalidation fails", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  let readResult: LocalAssetBytesResult = { status: "missing" };
  const missingSample = { ...sample, assetKey: "rack-revalidation", url: "local-asset:rack-revalidation" };
  const params = {
    ...createDefaultDrumRackParams(),
    pads: createDefaultDrumRackParams().pads.map((pad) => (
      pad.id === "pad-36" ? { ...pad, sample: missingSample } : pad
    )),
  };
  const sync = createDrumRackBufferSync({
    nativeAudio: () => true,
    projectId: () => "project:rack-revalidation",
    readLocalAsset: async (): Promise<LocalAssetBytesResult> => readResult,
    decodePages: decodeTestPages,
    createBuffer: () => buffer,
  });
  await sync.syncTrack(engine, "rack-revalidation", params, "drum-instance");
  expect(sync.snapshotBuffers("rack-revalidation", {
    kind: "drum-rack",
    instanceId: "drum-instance",
    params,
  })?.unavailableSampleAssetKeys).toEqual([
    missingSample.assetKey,
  ]);
  readResult = { status: "permission-denied" };
  await expect(sync.syncTrack(engine, "rack-revalidation", params, "drum-instance"))
    .rejects.toThrow("Permission to read local audio asset");
  expect(sync.snapshotBuffers("rack-revalidation", {
    kind: "drum-rack",
    instanceId: "drum-instance",
    params,
  })).toBeUndefined();
  sync.dispose();
});

test("hydrates confirmed missing samples through native projection without dropping healthy instruments", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const missingSample = { ...sample, assetKey: "missing-rack", url: "local-asset:missing-rack", name: "Missing Rack Sample" };
  const availableSample = { ...sample, assetKey: "available-rack", url: "local-asset:available-rack" };
  const missingSamplerSample = { ...sample, assetKey: "missing-sampler", url: "local-asset:missing-sampler", name: "Missing Sampler Sample" };
  const drumParams = {
    ...createDefaultDrumRackParams(),
    pads: createDefaultDrumRackParams().pads.map((pad) => pad.id === "pad-36"
      ? { ...pad, sample: missingSample }
      : pad.id === "pad-37" ? { ...pad, sample: availableSample } : pad),
  };
  const samplerParams = { ...createDefaultSamplerParams(), zones: [{ ...zone, sample: missingSamplerSample }] };
  const samplerSync = createSamplerBufferSync({
    nativeAudio: () => true,
    projectId: () => "project:confirmed-missing",
    readLocalAsset: async (_projectId, assetKey) => {
      if (assetKey === "missing-rack" || assetKey === "missing-sampler") return { status: "missing" };
      return { status: "ready", file: new File([new Uint8Array([1])], "restored.wav") };
    },
    decodePages: decodeTestPages,
    createBuffer: () => buffer,
  });
  const drumSync = createDrumRackBufferSync({
    nativeAudio: () => true,
    projectId: () => "project:confirmed-missing",
    readLocalAsset: async (_projectId, assetKey) => {
      if (assetKey === "missing-rack") return { status: "missing" };
      return { status: "ready", file: new File([new Uint8Array([1])], "sample.wav") };
    },
    decodePages: decodeTestPages,
    createBuffer: () => buffer,
  });
  await Promise.all([
    drumSync.syncTrack(engine, "missing-rack-track", drumParams, "drum-instance"),
    samplerSync.syncTrack(engine, "missing-sampler-track", samplerParams, "sampler-instance"),
  ]);
  const renderState: ExportRenderStateSnapshot = {
    fx: {
      masterVolume: 1,
      masterFxInstances: [],
      trackFx: {
        "missing-rack-track": { instances: [], instrument: { kind: "drum-rack", instanceId: "drum-instance", params: drumParams } },
        "missing-sampler-track": { instances: [], instrument: { kind: "sampler", instanceId: "sampler-instance", params: samplerParams } },
      },
    },
    automationEnvelopes: [],
  };
  const hydrated = hydrateInstrumentBuffers(renderState, (trackId, instrument) => {
    if (instrument.kind === "drum-rack") {
      const snapshot = drumSync.snapshotBuffers(trackId, instrument);
      return snapshot
        ? { drumRackBuffers: snapshot.buffers, unavailableSampleAssetKeys: snapshot.unavailableSampleAssetKeys }
        : undefined;
    }
    if (instrument.kind === "sampler") {
      const buffers = samplerSync.snapshotSamplerBuffers(trackId, instrument);
      const unavailableSampleAssetKeys = samplerSync.snapshotUnavailableAssetKeys(trackId, instrument);
      return buffers && unavailableSampleAssetKeys
        ? { samplerBuffers: buffers, unavailableSampleAssetKeys }
        : undefined;
    }
    return undefined;
  });
  expect(hydrated.fx.trackFx?.["missing-rack-track"]?.drumRackBuffers?.has("pad-37")).toBe(true);
  expect(hydrated.fx.trackFx?.["missing-rack-track"]?.unavailableSampleAssetKeys).toEqual(["missing-rack"]);
  expect(hydrated.fx.trackFx?.["missing-sampler-track"]?.unavailableSampleAssetKeys).toEqual(["missing-sampler"]);
  const playback = compileLivePlaybackSnapshot({
    revision: 1,
    bpm: 120,
    transport: { state: "stopped", playheadSec: 0, loopEnabled: false, loopStartSec: 0, loopEndSec: 0 },
    tracks: [
      { id: "missing-rack-track", name: "Drums", volume: 1, clips: [] },
      { id: "missing-sampler-track", name: "Sampler", volume: 1, clips: [] },
    ],
    renderState: hydrated,
    sidechainRoutes: [],
  });
  expect(playback.supported).toBe(true);
  if (!playback.supported) throw new Error(playback.reasons.join(" "));
  const projection = compileLiveNativeProjection({
    tracks: playback.snapshot.tracks,
    fx: playback.snapshot.mixer.fx,
    bpm: playback.snapshot.bpm,
    sampleRateHz: 48_000,
    revision: playback.snapshot.revision,
    epoch: 1,
    firstSequence: 1,
  });
  expect(projection.supported).toBe(true);
  if (projection.supported) {
    expect(projection.graph.nodes.find((node) => node.id === "missing-rack-track")?.instrument).toMatchObject({
      kind: "drum-rack",
      zones: [{ keyLow: 37, keyHigh: 37 }],
    });
    expect(projection.graph.nodes.find((node) => node.id === "missing-sampler-track")?.instrument).toMatchObject({
      kind: "sampler",
      zones: [],
    });
  }
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
    override setTrackDrumRack(): ReturnType<AudioEngine["setTrackDrumRack"]> { return "applied"; }
    override setTrackGranular(): ReturnType<AudioEngine["setTrackGranular"]> { return Promise.resolve("applied"); }
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
  })).toMatchObject({ buffers: new Map([["pad-36", sampled(projectABuffer)]]), unavailableSampleAssetKeys: [] });

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
  })).toMatchObject({ buffers: new Map([["pad-36", sampled(projectBBuffer)]]), unavailableSampleAssetKeys: [] });

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
  const firstFailure = await first.then(() => undefined, (cause: unknown) => cause);
  expect(firstFailure).toBeInstanceOf(SampledInstrumentSyncSupersededError);
  await second;
  if (firstFailure instanceof SampledInstrumentSyncSupersededError) {
    await expect(firstFailure.replacement).resolves.toBe("applied");
  }
  expect(calls).toBe(2);
  expect(sync.snapshotBuffers("drum-retry", {
    kind: "drum-rack",
    instanceId: "drum-instance",
    params,
  })).toMatchObject({ buffers: new Map([["pad-36", sampled(buffer)]]), unavailableSampleAssetKeys: [] });
  sync.dispose();
});

test("clearing a Drum Rack track uses ordinary cancellation", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  let firstStartedResolve: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
  const decodePages = async function* (
    _source: Blob | string | URL | Request,
    options?: { startFrame?: number; endFrame?: number; signal?: AbortSignal },
  ): AsyncGenerator<DecodedAudioPage> {
    firstStartedResolve?.();
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
  };
  const sync = createDrumRackBufferSync({ decodePages, createBuffer: () => buffer });
  const params = {
    ...createDefaultDrumRackParams(),
    pads: createDefaultDrumRackParams().pads.map((pad) => pad.id === "pad-36" ? { ...pad, sample } : pad),
  };
  const request = sync.syncTrack(engine, "drum-clear-cancel", params, "drum-instance");
  await firstStarted;
  sync.clearTrack("drum-clear-cancel");
  await expect(request).resolves.toBe("dropped");
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
  // An equal request would join the load in flight, so only a changed one supersedes and retries it.
  const changed = { ...params, polyphony: params.polyphony - 1 };
  const second = sync.syncTrack(engine, "sampler-retry", changed, "sampler-instance");
  const firstFailure = await first.then(() => undefined, (cause: unknown) => cause);
  expect(firstFailure).toBeInstanceOf(SampledInstrumentSyncSupersededError);
  if (firstFailure instanceof SampledInstrumentSyncSupersededError) {
    expect(firstFailure.replacement).toBe(second);
  }
  await expect(second).resolves.toBe("applied");
  if (firstFailure instanceof SampledInstrumentSyncSupersededError) {
    await expect(firstFailure.replacement).resolves.toBe("applied");
  }
  expect(calls).toBe(2);
  expect(sync.snapshotSamplerBuffers("sampler-retry", {
    kind: "sampler",
    instanceId: "sampler-instance",
    params: changed,
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
  const firstFailure = await first.then(() => undefined, (cause: unknown) => cause);
  expect(firstFailure).toBeInstanceOf(SampledInstrumentSyncSupersededError);
  if (firstFailure instanceof SampledInstrumentSyncSupersededError) {
    expect(firstFailure.replacement).toBe(second);
  }
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

test("reports the disposition that the sampled runtime installed", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const sync = createSamplerBufferSync({ decodePages: decodeTestPages, createBuffer: () => buffer });
  const granular = { ...createDefaultGranularParams(), zone };
  const drumRack = createDefaultDrumRackParams();

  expect(await sync.syncGranularTrack(engine, "disposition-granular", granular, "granular-instance")).toBe("applied");
  const drums = createDrumRackBufferSync({ decodePages: decodeTestPages, createBuffer: () => buffer });
  expect(await drums.syncTrack(engine, "disposition-drum-rack", drumRack, "drum-instance")).toBe("applied");
  const nativeSync = createSamplerBufferSync({
    nativeAudio: () => true,
    decodePages: decodeTestPages,
    createBuffer: () => buffer,
  });
  expect(await nativeSync.syncGranularTrack(engine, "disposition-native-granular", granular, "granular-instance")).toBe("dropped");

  sync.dispose();
  drums.dispose();
  nativeSync.dispose();
});

test("forwards Drum Rack equality skips and drops work outside its project", async () => {
  const buffer = new TestAudioBuffer();
  class SkippedDrumEngine extends TestAudioEngine {
    override setTrackDrumRack(
      trackId: string,
      params: DrumRackParams,
      buffers?: ReadonlyMap<string, SampledInstrumentBuffer>,
    ): ReturnType<AudioEngine["setTrackDrumRack"]> {
      super.setTrackDrumRack(trackId, params, buffers);
      return "skipped";
    }
  }
  const engine = new SkippedDrumEngine(buffer);
  const params = createDefaultDrumRackParams();
  const sync = createDrumRackBufferSync({ decodePages: decodeTestPages, createBuffer: () => buffer });
  expect(await sync.syncTrack(engine, "disposition-skipped-drum-rack", params, "drum-instance")).toBe("skipped");
  sync.dispose();

  const unavailable = createDrumRackBufferSync({
    isCurrentProject: () => false,
    decodePages: decodeTestPages,
    createBuffer: () => buffer,
  });
  expect(await unavailable.syncTrack(engine, "disposition-unavailable-drum-rack", params, "drum-instance")).toBe("dropped");
  unavailable.dispose();
});

test("reports dropped when granular buffer work is disposed before installation", async () => {
  const buffer = new TestAudioBuffer();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const sync = createSamplerBufferSync({
    decodePages: async function* (_source, options) {
      entered.resolve();
      await release.promise;
      yield* decodeTestPages(_source, options);
    },
    createBuffer: () => buffer,
  });
  const request = sync.syncGranularTrack(
    createEngine(buffer),
    "disposed-granular",
    { ...createDefaultGranularParams(), zone },
    "granular-instance",
  );

  await entered.promise;
  sync.dispose();
  release.resolve();
  await expect(request).resolves.toBe("dropped");
});

test("reports dropped when Drum Rack work is cleared during a region load", async () => {
  const buffer = new TestAudioBuffer();
  const entered = Promise.withResolvers<void>();
  const sync = createDrumRackBufferSync({
    decodePages: async function* (_source, options) {
      entered.resolve();
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      options?.signal?.throwIfAborted();
      yield* decodeTestPages(_source, options);
    },
    createBuffer: () => buffer,
  });
  const request = sync.syncTrack(
    createEngine(buffer),
    "cleared-drum-rack",
    {
      ...createDefaultDrumRackParams(),
      pads: createDefaultDrumRackParams().pads.map((pad) =>
        pad.id === "pad-36" ? { ...pad, sample } : pad,
      ),
    },
    "drum-instance",
  );

  await entered.promise;
  sync.clearTrack("cleared-drum-rack");
  await expect(request).resolves.toBe("dropped");
  sync.dispose();
});

test("loads long native regions without the install duration diagnostic and waits for native readiness", async () => {
  const buffer: AudioBuffer = {
    ...new TestAudioBuffer(), length: 384_000, duration: 8, numberOfChannels: 2, sampleRate: 48_000,
    copyFromChannel: () => {}, copyToChannel: () => {}, getChannelData: () => new Float32Array(384_000),
  };
  const sync = createSamplerBufferSync({ nativeAudio: () => true, decodePages: decodeTestPages, createBuffer: () => buffer });
  const engine = createEngine(buffer);
  const durationSec = 8;
  const oversizedZone = {
    ...zone,
    sample: { ...sample, source: { ...sample.source, durationSec } },
    endSec: durationSec,
  };
  const samplerParams = { ...createDefaultSamplerParams(), zones: [oversizedZone] };
  const granularParams = {
    ...createDefaultGranularParams(),
    zone: { ...oversizedZone, keyLow: 0, keyHigh: 127 },
  };

  await sync.syncTrack(engine, "native-sampler-limit", samplerParams, "sampler-instance");
  expect(sync.getStatus("native-sampler-limit").zones.get(oversizedZone.id)).toBe("loading");
  sync.setNativePreparation("native-sampler-limit", { state: "ready" });
  expect(sync.getStatus("native-sampler-limit").zones.get(oversizedZone.id)).toBe("ready");
  await sync.syncGranularTrack(engine, "native-granular-limit", granularParams, "granular-instance");
  expect(sync.getGranularStatus("native-granular-limit").state).toBe("loading");
  sync.setNativePreparation("native-granular-limit", { state: "error", error: "Sample memory locking unavailable. Free memory and retry." });
  expect(sync.getGranularStatus("native-granular-limit").state).toBe("error");
  expect(sync.getGranularStatus("native-granular-limit").error).toContain("memory locking unavailable");
  sync.dispose();
});

test("native readiness acknowledgement survives a later same-identity region decode", async () => {
  for (const kind of ["sampler", "granular"] satisfies readonly string[]) {
    const buffer = new TestAudioBuffer();
    const engine = createEngine(buffer);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sync = createSamplerBufferSync({
      nativeAudio: () => true,
      decodePages: async function* (source, options) {
        entered.resolve();
        await release.promise;
        yield* decodeTestPages(source, options);
      },
      createBuffer: () => buffer,
    });
    const status = () => kind === "sampler"
      ? sync.getStatus(kind).zones.get(zone.id)
      : sync.getGranularStatus(kind).state;
    try {
      const decoding = kind === "sampler"
        ? sync.syncTrack(engine, kind, { ...createDefaultSamplerParams(), zones: [zone] }, kind)
        : sync.syncGranularTrack(engine, kind, { ...createDefaultGranularParams(), zone }, kind);
      await entered.promise;
      sync.setNativePreparation(kind, { state: "ready" });
      expect(status()).toBe("loading");
      release.resolve();
      await decoding;
      expect(status()).toBe("ready");
      // Identity changes still invalidate the old acknowledgement before decoding.
      const changedZone = { ...zone, endSec: 0.5 };
      const changed = kind === "sampler"
        ? sync.syncTrack(engine, kind, { ...createDefaultSamplerParams(), zones: [changedZone] }, kind)
        : sync.syncGranularTrack(engine, kind, { ...createDefaultGranularParams(), zone: changedZone }, kind);
      await changed;
      expect(status()).toBe("loading");
      sync.setNativePreparation(kind, { state: "ready" });
      expect(status()).toBe("ready");
    } finally {
      release.resolve();
      sync.dispose();
    }
  }
});

test("native sampler retry clears pane error and waits for successful native preparation", async () => {
  const buffer = new TestAudioBuffer();
  const retryDecodeEntered = Promise.withResolvers<void>();
  const retryDecodeRelease = Promise.withResolvers<void>();
  const preparationAck = Promise.withResolvers<void>();
  const releasePreparationAck = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  const releaseCommit = Promise.withResolvers<void>();
  let decodeCount = 0;
  const sync = createSamplerBufferSync({
    nativeAudio: () => true,
    decodePages: async function* (
      source: Blob | string | URL | Request,
      options?: { startSec?: number; endSec?: number },
    ) {
      decodeCount += 1;
      if (decodeCount === 2) {
        retryDecodeEntered.resolve();
        await retryDecodeRelease.promise;
      }
      yield* decodeTestPages(source, options);
    },
    createBuffer: () => buffer,
  });
  const engine = createEngine(buffer);
  const params = { ...createDefaultSamplerParams(), zones: [zone] };
  await sync.syncTrack(engine, "native-retry", params, "sampler-instance");
  sync.setNativePreparation("native-retry", {
    state: "error",
    error: "Sample memory locking unavailable. Free memory and retry.",
  });
  expect(sync.getStatus("native-retry").zones.get(zone.id)).toBe("error");

  let nativePrepareCount = 0;
  const retry = sync.retryZone(engine, "native-retry", zone.id, async () => {
    nativePrepareCount += 1;
    preparationAck.resolve();
    await releasePreparationAck.promise;
    expect(sync.getStatus("native-retry").zones.get(zone.id)).toBe("loading");
    expect(sync.getStatus("native-retry").errors.has(zone.id)).toBe(false);
    commit.resolve();
    await releaseCommit.promise;
    sync.setNativePreparation("native-retry", { state: "ready" });
  });

  await retryDecodeEntered.promise;
  expect(sync.getStatus("native-retry").zones.get(zone.id)).toBe("loading");
  retryDecodeRelease.resolve();
  await preparationAck.promise;
  expect(sync.getStatus("native-retry").zones.get(zone.id)).toBe("loading");
  releasePreparationAck.resolve();
  await commit.promise;
  expect(sync.getStatus("native-retry").zones.get(zone.id)).toBe("loading");
  releaseCommit.resolve();
  await retry;

  expect(nativePrepareCount).toBe(1);
  expect(sync.getStatus("native-retry").zones.get(zone.id)).toBe("ready");
  expect(sync.getStatus("native-retry").errors.has(zone.id)).toBe(false);
  sync.dispose();
});

test("does not rebuild a same-project replacement device after granular retry", async () => {
  const buffer = new TestAudioBuffer();
  const retryDecodeEntered = Promise.withResolvers<void>();
  const retryDecodeRelease = Promise.withResolvers<void>();
  let decodeCount = 0;
  const sync = createSamplerBufferSync({
    nativeAudio: () => true,
    projectId: () => "project:retry-origin",
    decodePages: async function* (
      source: Blob | string | URL | Request,
      options?: { startSec?: number; endSec?: number; signal?: AbortSignal },
    ) {
      decodeCount += 1;
      if (decodeCount === 1) throw new Error("Initial decode failed.");
      if (decodeCount === 2) {
        retryDecodeEntered.resolve();
        await retryDecodeRelease.promise;
      }
      yield* decodeTestPages(source, options);
    },
    createBuffer: () => buffer,
  });
  const engine = createEngine(buffer);
  const params = { ...createDefaultGranularParams(), zone };
  await expect(sync.syncGranularTrack(engine, "granular-retry-stale", params, "granular-instance")).rejects.toThrow("Initial decode failed.");
  sync.setNativePreparation("granular-retry-stale", { state: "error", error: "Prepare failed." });
  let rebuildCount = 0;
  const retry = sync.retryGranular(engine, "granular-retry-stale", async () => { rebuildCount += 1; });
  await retryDecodeEntered.promise;
  await sync.syncGranularTrack(engine, "granular-retry-stale", params, "replacement-instance");
  retryDecodeRelease.resolve();
  await retry;

  expect(rebuildCount).toBe(0);
  sync.dispose();
});

test("does not rebuild after a project switch during granular retry", async () => {
  const buffer = new TestAudioBuffer();
  const retryDecodeEntered = Promise.withResolvers<void>();
  const retryDecodeRelease = Promise.withResolvers<void>();
  let decodeCount = 0;
  let projectId = "project:retry-origin";
  const sync = createSamplerBufferSync({
    nativeAudio: () => true,
    projectId: () => projectId,
    decodePages: async function* (
      source: Blob | string | URL | Request,
      options?: { startSec?: number; endSec?: number; signal?: AbortSignal },
    ) {
      decodeCount += 1;
      if (decodeCount === 1) throw new Error("Initial decode failed.");
      if (decodeCount === 2) {
        retryDecodeEntered.resolve();
        await retryDecodeRelease.promise;
      }
      yield* decodeTestPages(source, options);
    },
    createBuffer: () => buffer,
  });
  const engine = createEngine(buffer);
  const params = { ...createDefaultGranularParams(), zone };
  await expect(sync.syncGranularTrack(engine, "granular-retry-project", params, "granular-instance")).rejects.toThrow("Initial decode failed.");
  sync.setNativePreparation("granular-retry-project", { state: "error", error: "Prepare failed." });
  let rebuildCount = 0;
  const retry = sync.retryGranular(engine, "granular-retry-project", async () => { rebuildCount += 1; });
  await retryDecodeEntered.promise;
  projectId = "project:retry-new";
  retryDecodeRelease.resolve();
  await retry;

  expect(rebuildCount).toBe(0);
  sync.dispose();
});

test("native Drum Rack retry reuses loaded regions and requests guarded native preparation", async () => {
  const buffer = new TestAudioBuffer();
  let decodeCount = 0;
  const sync = createDrumRackBufferSync({
    nativeAudio: () => true,
    decodePages: async function* (source, options) {
      decodeCount += 1;
      yield* decodeTestPages(source, options);
    },
    createBuffer: () => buffer,
    projectId: () => "project:drum-retry",
  });
  const engine = createEngine(buffer);
  const pad = { ...createDefaultDrumRackParams().pads[0]!, sample };
  const params = { ...createDefaultDrumRackParams(), pads: [pad] };
  await sync.syncTrack(engine, "native-drum-retry", params, "drum-instance");
  sync.setNativePreparation("native-drum-retry", {
    state: "error",
    error: "Sample memory locking unavailable. Retry to reload.",
  });
  const previousDecodeCount = decodeCount;
  let retryIdentity: { trackId: string; projectId: string; version: number; instanceId?: string } | undefined;

  await sync.retryTrack(engine, "native-drum-retry", params, "drum-instance", async (identity) => {
    retryIdentity = identity;
    sync.setNativePreparation("native-drum-retry", { state: "ready" });
  });

  expect(decodeCount).toBe(previousDecodeCount);
  expect(retryIdentity).toEqual({
    trackId: "native-drum-retry",
    projectId: "project:drum-retry",
    version: expect.any(Number),
    instanceId: "drum-instance",
  });
  expect(sync.getNativePreparation("native-drum-retry")?.state).toBe("ready");
  sync.dispose();
});

test("native-only decoded ceilings admit three-minute regions while portable granular and drum limits remain unchanged", async () => {
  const frameCount = 180 * 48_000;
  const buffer: AudioBuffer = {
    length: frameCount, duration: 180, numberOfChannels: 2, sampleRate: 48_000,
    copyFromChannel: () => {}, copyToChannel: () => {}, getChannelData: () => new Float32Array(frameCount),
  };
  const longSample = { ...sample, source: { ...sample.source, durationSec: 180 } };
  const longZone = { ...zone, sample: longSample, endSec: 180 };
  const granular = { ...createDefaultGranularParams(), zone: longZone };
  const drums = { ...createDefaultDrumRackParams(),
    pads: [{ ...createDefaultDrumRackParams().pads[0]!, sample: longSample, endSec: 180 }] };
  const options = { decodePages: decodeTestPages, createBuffer: () => buffer };
  const engine = createEngine(buffer);
  const portableSampler = createSamplerBufferSync(options);
  const portableDrums = createDrumRackBufferSync(options);
  await expect(portableSampler.syncGranularTrack(engine, "portable-granular", granular)).rejects.toThrow("limit");
  await expect(portableDrums.syncTrack(engine, "portable-drums", drums)).rejects.toThrow("limit");
  const nativeSampler = createSamplerBufferSync({ ...options, nativeAudio: () => true });
  const nativeDrums = createDrumRackBufferSync({ ...options, nativeAudio: () => true });
  try {
    await nativeSampler.syncGranularTrack(engine, "native-granular", granular, "granular-instance");
    expect(nativeSampler.snapshotGranularBuffer("native-granular", { kind: "granular", instanceId: "granular-instance", params: granular })?.buffer).toBe(buffer);
    await nativeDrums.syncTrack(engine, "native-drums", drums, "drum-instance");
    expect(nativeDrums.snapshotBuffers("native-drums", { kind: "drum-rack", instanceId: "drum-instance", params: drums })?.buffers.size).toBe(1);
    expect(granular.maxDecodedBytes).toBe(64 * 1024 ** 2);
    expect(createDefaultSamplerParams().maxDecodedBytes).toBe(256 * 1024 ** 2);
  } finally {
    portableSampler.dispose();
    portableDrums.dispose();
    nativeSampler.dispose();
    nativeDrums.dispose();
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
  })).toMatchObject({ buffers: new Map([[secondPad.id, secondBuffer]]), unavailableSampleAssetKeys: [] });
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

test("joins an equal sampler sync that is still loading", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const sync = createSamplerBufferSync({ decodePages: decodeTestPages, createBuffer: () => buffer });
  const params = { ...createDefaultSamplerParams(), zones: [zone] };

  const first = sync.syncTrack(engine, "sampler-join", params, "sampler-instance");
  const second = sync.syncTrack(engine, "sampler-join", { ...params }, "sampler-instance");

  expect(await Promise.all([first, second])).toEqual(["applied", "joined"]);
  expect(engine.samplerBufferIds("sampler-join")).toEqual(["zone-runtime"]);
});

test("skips an equal sampler sync once it installed cleanly", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const sync = createSamplerBufferSync({ decodePages: decodeTestPages, createBuffer: () => buffer });
  const params = { ...createDefaultSamplerParams(), zones: [zone] };
  expect(await sync.syncTrack(engine, "sampler-skip", params, "sampler-instance")).toBe("applied");
  const installs = engine.samplerInstalls;

  expect(await sync.syncTrack(engine, "sampler-skip", { ...params }, "sampler-instance")).toBe("skipped");
  expect(engine.samplerInstalls).toBe(installs);
  expect(await sync.syncTrack(engine, "sampler-skip", { ...params, polyphony: params.polyphony - 1 }, "sampler-instance")).toBe("applied");
});

test("applies an equal sampler sync again after the track was cleared", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const sync = createSamplerBufferSync({ decodePages: decodeTestPages, createBuffer: () => buffer });
  const params = { ...createDefaultSamplerParams(), zones: [zone] };
  await sync.syncTrack(engine, "sampler-readd", params, "sampler-instance");
  sync.clearTrack("sampler-readd");
  const installs = engine.samplerInstalls;

  expect(await sync.syncTrack(engine, "sampler-readd", { ...params }, "sampler-instance")).toBe("applied");
  expect(engine.samplerInstalls).toBeGreaterThan(installs);
});

test("applies an equal sampler sync again after the engine lost the instrument", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const sync = createSamplerBufferSync({ decodePages: decodeTestPages, createBuffer: () => buffer });
  const params = { ...createDefaultSamplerParams(), zones: [zone] };
  expect(await sync.syncTrack(engine, "sampler-engine-lost", params, "sampler-instance")).toBe("applied");
  engine.clearTrackInstrument("sampler-engine-lost");

  expect(await sync.syncTrack(engine, "sampler-engine-lost", { ...params }, "sampler-instance")).toBe("applied");
  expect(engine.samplerBufferIds("sampler-engine-lost")).toEqual(["zone-runtime"]);
});

test("a joined sampler sync fails together with the load it joined when the track was cleared", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const sync = createSamplerBufferSync({ decodePages: decodeTestPages, createBuffer: () => buffer });
  const params = { ...createDefaultSamplerParams(), zones: [zone] };

  const first = sync.syncTrack(engine, "sampler-join-cleared", params, "sampler-instance");
  const second = sync.syncTrack(engine, "sampler-join-cleared", { ...params }, "sampler-instance");
  sync.clearTrack("sampler-join-cleared");

  const settled = await Promise.allSettled([first, second]);
  expect(settled.map((entry) => entry.status)).toEqual(["rejected", "rejected"]);
  for (const entry of settled) {
    if (entry.status === "rejected") expect(entry.reason).toBeInstanceOf(DOMException);
  }
});

test("an equal sampler sync joins a failing load and the next equal sync loads again", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  let failNext = true;
  const decodePages = async function* (
    source: Blob | string | URL | Request,
    options?: { startSec?: number; endSec?: number },
  ): AsyncGenerator<DecodedAudioPage> {
    if (failNext) {
      failNext = false;
      throw new Error("decode failed");
    }
    yield* decodeTestPages(source, options);
  };
  const sync = createSamplerBufferSync({ decodePages, createBuffer: () => buffer });
  const params = { ...createDefaultSamplerParams(), cachePolicy: "preload" as const, zones: [zone] };

  const first = sync.syncTrack(engine, "sampler-failure-join", params, "sampler-instance");
  const second = sync.syncTrack(engine, "sampler-failure-join", { ...params }, "sampler-instance");
  expect((await Promise.allSettled([first, second])).map((entry) => entry.status)).toEqual(["rejected", "rejected"]);

  expect(await sync.syncTrack(engine, "sampler-failure-join", { ...params }, "sampler-instance")).toBe("applied");
  expect(engine.samplerBufferIds("sampler-failure-join")).toEqual(["zone-runtime"]);
});

test("a joined sampler sync is superseded together with the load it joined", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const sync = createSamplerBufferSync({ decodePages: decodeTestPages, createBuffer: () => buffer });
  const params = { ...createDefaultSamplerParams(), zones: [zone] };

  const first = sync.syncTrack(engine, "sampler-join-superseded", params, "sampler-instance");
  const second = sync.syncTrack(engine, "sampler-join-superseded", { ...params }, "sampler-instance");
  const third = sync.syncTrack(engine, "sampler-join-superseded", { ...params, polyphony: params.polyphony - 1 }, "sampler-instance");

  const [firstResult, secondResult] = await Promise.allSettled([first, second]);
  expect(firstResult.status).toBe("rejected");
  expect(secondResult.status).toBe("rejected");
  for (const result of [firstResult, secondResult]) {
    if (result.status === "rejected") expect(result.reason).toBeInstanceOf(SampledInstrumentSyncSupersededError);
  }
  expect(await third).toBe("applied");
});

// Two one-byte regions under a one-region aggregate budget: loading the second evicts the first.
const createEvictionFixture = (cachePolicy: SamplerParams["cachePolicy"]) => {
  const source = { durationSec: 2, sampleRate: 1, channelCount: 1 };
  const firstZone = { ...zone, id: "evicted-first", sample: { ...sample, assetKey: "evicted-first", source }, startSec: 0, endSec: 1 };
  const secondZone = { ...zone, id: "evicted-second", sample: { ...sample, assetKey: "evicted-second", source }, startSec: 1, endSec: 2 };
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
  const sync = createSamplerBufferSync({ aggregateBudget: createSampledInstrumentRegionBudget(4), decodePages, createBuffer });
  const firstParams = { ...createDefaultSamplerParams(), cachePolicy, maxDecodedBytes: 4, zones: [firstZone] };
  const secondParams = { ...createDefaultSamplerParams(), cachePolicy, maxDecodedBytes: 4, zones: [secondZone] };
  // A lazy track loads a region only when asked to.
  const load = async (trackId: string, params: SamplerParams, instanceId: string) => {
    await sync.syncTrack(engine, trackId, params, instanceId);
    if (cachePolicy === "lazy") await sync.retryZone(engine, trackId, params.zones[0].id);
  };
  return { engine, sync, firstZone, firstParams, secondParams, load };
};

test("applies an equal preload sync again after another track evicted its regions", async () => {
  const { engine, sync, firstZone, firstParams, secondParams } = createEvictionFixture("preload");
  await sync.syncTrack(engine, "evicted-track-a", firstParams, "instance-a");
  await sync.syncTrack(engine, "evicted-track-b", secondParams, "instance-b");
  expect(engine.samplerBufferIds("evicted-track-a")).toEqual([]);

  expect(await sync.syncTrack(engine, "evicted-track-a", { ...firstParams }, "instance-a")).toBe("applied");
  expect(sync.getStatus("evicted-track-a").zones.get(firstZone.id)).toBe("ready");
  expect(engine.samplerBufferIds("evicted-track-a")).toEqual([firstZone.id]);
  sync.dispose();
});

for (const cachePolicy of ["preload", "lazy"] satisfies SamplerParams["cachePolicy"][]) {
  test(`a ${cachePolicy} region evicted after a parameter-only sync leaves neither the proof nor the engine buffer`, async () => {
    const { engine, sync, firstZone, firstParams, secondParams, load } = createEvictionFixture(cachePolicy);
    await load("evicted-track-a", firstParams, "instance-a");
    const changed = { ...firstParams, zones: [{ ...firstZone, gain: 0.5 }] };
    await sync.syncTrack(engine, "evicted-track-a", changed, "instance-a");
    expect(engine.samplerBufferIds("evicted-track-a")).toEqual([firstZone.id]);
    await load("evicted-track-b", secondParams, "instance-b");

    expect(sync.getStatus("evicted-track-a").totalBytes).toBe(0);
    expect(engine.samplerBufferIds("evicted-track-a")).toEqual([]);
    expect(sync.getStatus("evicted-track-a").zones.get(firstZone.id)).toBe("missing");
    expect(await sync.syncTrack(engine, "evicted-track-a", { ...changed }, "instance-a")).toBe("applied");
    sync.dispose();
  });
}

test("a cached sampler load joined by an equal request resolves superseded for both when the track is cleared", async () => {
  const buffer = new TestAudioBuffer();
  const engine = createEngine(buffer);
  const sync = createSamplerBufferSync({ decodePages: decodeTestPages, createBuffer: () => buffer });
  const params: SamplerParams = { ...createDefaultSamplerParams(), cachePolicy: "preload", zones: [zone] };
  await sync.syncTrack(engine, "sampler-cached-join-cleared", params, "sampler-instance");
  const changed: SamplerParams = { ...params, zones: [{ ...zone, gain: 0.5 }] };

  const first = sync.syncTrack(engine, "sampler-cached-join-cleared", changed, "sampler-instance");
  const second = sync.syncTrack(engine, "sampler-cached-join-cleared", { ...changed }, "sampler-instance");
  sync.clearTrack("sampler-cached-join-cleared");

  expect(await Promise.all([first, second])).toEqual(["superseded", "superseded"]);
  sync.dispose();
});

for (const local of [true, false]) {
  test(`H6 granular failed replacement then original row recovers local=${local}`, async () => {
    // The runtime disposes A before constructing B; a later A row must not trust the earlier A installation.
    const original = b5c2Instrument("granular", "h6-throw");
    if (original.kind !== "granular") throw new Error("Expected granular");
    const f = await createB5c2Fixture(local, original);
    const node = globalThis.AudioWorkletNode;
    try {
      await f.start();
      const before = f.granularInstalls.length;
      expect(f.canStartGranularNote()).toBe(true);
      Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, value: class {
        constructor() { throw new Error("H6 injected worklet construction failure"); }
      } });
      await f.write({ ...original, params: { ...original.params, position: 0.7 } });
      await f.effects.flushPending();
      expect(f.errors.some(error => error.includes("H6 injected"))).toBe(true);
      expect(f.canStartGranularNote()).toBe(false);
      Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, value: node });
      await f.write(original);
      await f.effects.flushPending();
      expect(f.canStartGranularNote()).toBe(true);
      expect(f.granularInstalls.length - before).toBe(1);
    } finally {
      Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, value: node });
      f.close();
    }
  });
}
