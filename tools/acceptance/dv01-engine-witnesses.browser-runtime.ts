// Browser side of the DV-01 step-E engine witnesses. It drives the real AudioEngine, live-mixer-runtime, master-fx-runtime,
// synth-runtime and sampler-buffer-sync over a real AudioContext and reads what the nodes hold: the last parameter message
// each compressor worklet received, the gain each EQ biquad holds, and how many nodes were constructed.
// Run through tools/acceptance/dv01-engine-witnesses.ts, which bundles this file, opens it in Chromium and writes the JSON.
import { z } from "zod";
import { AudioEngine, type EngineDisposition } from "@daw-browser/audio-engine/audio-engine";
import { AUDIO_EFFECT_CONTRACTS, createDefaultSamplerParams, createDefaultSynthParams, type DecodedAudioPage, type SamplerParams } from "@daw-browser/shared";
import { createSamplerBufferSync } from "~/lib/sampler-buffer-sync";
import { createSampledInstrumentRegionBudget } from "~/lib/sampled-instrument-region-budget";
import { createSourceRegistry } from "../../packages/audio-engine/src/source-registry";
import { createSynthRuntime } from "../../packages/audio-engine/src/synth-runtime";
import { countFactoryCalls } from "./device-control-cost-spy";
import { createRoot } from "solid-js";
import { createCompressorChainState } from "../../packages/audio-engine/src/effects/compressor-chain-state";
import { createEffectsPanelAudioDevice } from "~/components/timeline/create-effects-panel-audio-effects-state";
import { ParameterGestureHolder } from "~/components/timeline/parameter-gesture-owner";
import { createLocalEffectsView } from "~/components/timeline/create-local-effects-view";
import { setLocalEffectInstance } from "~/lib/local-effects";

// The isolated bundler redirects only live-mixer's factory import here. Hold its actual set result,
// after the real node write but before live-mixer can commit liveParams. No product seam or timer.
let compressorHold: { reached: () => void; release: Promise<void> } | undefined;
export const observeCompressorChainState = (...args: Parameters<typeof createCompressorChainState>) => {
  const state = createCompressorChainState(...args);
  return { ...state, set: async (...input: Parameters<typeof state.set>) => {
    const result = await state.set(...input);
    if (compressorHold && input[1].thresholdDb === -12) {
      const mine = compressorHold;
      mine.reached();
      await mine.release;
    }
    return result;
  } };
};

type Instance = Parameters<AudioEngine["setTrackFxInstances"]>[1][number];
type Outcome = { disposition: EngineDisposition } | { rejected: string };
type Check = { name: string; expected: string; actual: string; pass: boolean };
type RowResult = { row: string; observed: Record<string, string | number>; checks: Check[] };

// ───────────────────────── Recorders ─────────────────────────

const paramsMessage = z.object({ type: z.literal("params"), params: z.object({ thresholdDb: z.number() }) });
const compressorLogs: number[][] = [];
const compressorNodes: AudioWorkletNode[] = [];
const portLogs = new WeakMap<MessagePort, number[]>();
const biquads: BiquadFilterNode[] = [];
const factoryCalls = new Map<string, number>();
let nodeConstructions = 0;
let rejectNextCompressorModule = false;

const originalPostMessage = MessagePort.prototype.postMessage;
Object.defineProperty(MessagePort.prototype, "postMessage", {
  configurable: true,
  writable: true,
  value: function postMessage(this: MessagePort, ...args: Parameters<typeof originalPostMessage>) {
    const log = portLogs.get(this);
    const message = paramsMessage.safeParse(args[0]);
    if (log && message.success) log.push(message.data.params.thresholdDb);
    return originalPostMessage.apply(this, args);
  },
});

const OriginalWorkletNode = AudioWorkletNode;
class RecordingWorkletNode extends OriginalWorkletNode {
  constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
    super(context, name, options);
    nodeConstructions++;
    if (!name.includes("compressor")) return;
    const log: number[] = [];
    compressorLogs.push(log);
    compressorNodes.push(this);
    portLogs.set(this.port, log);
  }
}
window.AudioWorkletNode = RecordingWorkletNode;

countFactoryCalls(BaseAudioContext.prototype, /^create(?!Buffer$|PeriodicWave$)/u, (name) => {
  nodeConstructions++;
  factoryCalls.set(name, (factoryCalls.get(name) ?? 0) + 1);
});
const originalCreateBiquad = BaseAudioContext.prototype.createBiquadFilter;
BaseAudioContext.prototype.createBiquadFilter = function createBiquadFilter(this: BaseAudioContext) {
  const filter = originalCreateBiquad.call(this);
  biquads.push(filter);
  return filter;
};

// The next load of the compressor module rejects once: the worklet failing to register.
const originalAddModule = AudioWorklet.prototype.addModule;
AudioWorklet.prototype.addModule = function addModule(this: AudioWorklet, ...args: Parameters<typeof originalAddModule>) {
  if (rejectNextCompressorModule && String(args[0]).includes("compressor")) {
    rejectNextCompressorModule = false;
    return Promise.reject(new Error("Worklet module failed to load."));
  }
  return originalAddModule.apply(this, args);
};

const resetRecorders = () => {
  compressorLogs.length = 0;
  compressorNodes.length = 0;
  biquads.length = 0;
  factoryCalls.clear();
  nodeConstructions = 0;
  rejectNextCompressorModule = false;
};

const macrotask = () => new Promise<void>((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
  channel.port2.postMessage(null);
});

// ───────────────────────── Fixtures ─────────────────────────

const compressor = (thresholdDb: number, id = "compressor-1"): Instance => ({
  id,
  kind: "compressor",
  params: { ...AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams(), enabled: true, thresholdDb },
});
// The second default band is a peaking filter, so its gain is a parameter edit that keeps the node topology.
const eq = (gainDb: number, id = "eq-1"): Instance => {
  const defaults = AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams();
  return { id, kind: "eq", params: { ...defaults, bands: defaults.bands.map((band, index) => index === 1 ? { ...band, gainDb } : band) } };
};

const track = "track-1";
const outcome = (pending: Promise<EngineDisposition>): Promise<Outcome> => pending.then(
  (disposition) => ({ disposition }),
  (error) => ({ rejected: error instanceof Error ? error.message : String(error) }),
);
const label = (result: Outcome) => "rejected" in result ? "rejected" : result.disposition;
const count = (results: readonly Outcome[], name: string) => results.filter((result) => label(result) === name).length;
const heldThreshold = (index = 0) => compressorLogs[index]?.at(-1);
const heldEqGain = () => biquads[1]?.gain.value;

const check = <Value,>(name: string, actual: Value, expected: Value): Check => ({
  name,
  expected: JSON.stringify(expected) ?? "undefined",
  actual: JSON.stringify(actual) ?? "undefined",
  pass: JSON.stringify(actual) === JSON.stringify(expected),
});

const tally = (results: readonly Outcome[]) => ({
  calls: results.length,
  applications: count(results, "applied"),
  joins: count(results, "joined"),
  skips: count(results, "skipped"),
  rejections: count(results, "rejected"),
  dispositions: results.map(label).join(","),
});

const withEngine = async (row: string, body: (engine: AudioEngine) => Promise<Omit<RowResult, "row">>): Promise<RowResult> => {
  const engine = new AudioEngine();
  engine.ensureAudio();
  await macrotask();
  resetRecorders();
  try {
    const result = await body(engine);
    return { row, observed: { ...result.observed, audioNodesConstructed: nodeConstructions, audioNodeFactories: JSON.stringify(Object.fromEntries(factoryCalls)) }, checks: result.checks };
  } finally {
    engine.close();
  }
};

// ───────────────────────── Rows ─────────────────────────

type ChainSetter = (instances: Instance[]) => Promise<EngineDisposition>;

// A pending tick B is overtaken by request A while the nodes hold A: the node must end on A and A must be applied.
const pendingBThenA = async (setter: ChainSetter, a: Instance, b: Instance, read: () => number | undefined) => {
  await setter([a]);
  const postsBefore = compressorLogs.reduce((total, log) => total + log.length, 0);
  const results = await Promise.all([outcome(setter([b])), outcome(setter([a]))]);
  await macrotask();
  const held = read();
  const postsAfterRace = compressorLogs.reduce((total, log) => total + log.length, 0);
  const again = await outcome(setter([a]));
  await macrotask();
  return { results, held, again, racePosts: postsAfterRace - postsBefore, extraPosts: compressorLogs.reduce((total, log) => total + log.length, 0) - postsAfterRace };
};

const compressorRow = (row: string, master: boolean) => withEngine(row, async (engine) => {
  const setter: ChainSetter = master ? (instances) => engine.setMasterFxInstances(instances) : (instances) => engine.setTrackFxInstances(track, instances);
  const run = await pendingBThenA(setter, compressor(-18), compressor(-12), () => heldThreshold());
  return {
    observed: { heldThresholdDb: run.held ?? "none", ...tally([...run.results, run.again]), nodesConstructed: compressorLogs.length },
    checks: [
      check("request A after the overtaken tick B is applied", label(run.results[1] ?? { rejected: "missing" }), "applied"),
      check("the overtaken tick B is superseded", label(run.results[0] ?? { rejected: "missing" }), "superseded"),
      check("the node holds A", run.held, -18),
      check("the next equal A is skipped: the proof names A", label(run.again), "skipped"),
      check("the skipped request wrote nothing", run.extraPosts, 0),
    ],
  };
});

const panelCompressorCancelRow = () => withEngine("R4-5 compressor in-place pending tick plus panel cancel", async engine => {
  const projectId = `project:held-compressor-${crypto.randomUUID()}`;
  const initial = compressor(-18);
  await setLocalEffectInstance(projectId, track, "compressor", initial.params, { instanceId: initial.id });
  await engine.setTrackFxInstances(track, [initial]);
  let dispose = () => {};
  const f = createRoot(end => {
    dispose = end;
    const view = createLocalEffectsView({ projectId: () => projectId });
    const panel = createEffectsPanelAudioDevice({ audioEngine: () => engine, projectId: () => projectId,
      userId: () => undefined, roomEffects: () => undefined, localEffectsView: view,
      canWriteCurrentTargetEffects: () => true }, () => track, () => undefined);
    return { panel, view, gesture: panel.gestureOwner(initial.id, "compressor") };
  });
  const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    await f.view.reload(); await f.panel.flushPending();
    const nodesBefore = compressorNodes.length;
    const holder = new ParameterGestureHolder();
    f.gesture.open(holder);
    compressorHold = { reached: () => reached.resolve(), release: release.promise };
    f.gesture.tick(holder, () => f.panel.compressor.changeInstance(initial.id, params => ({ ...params, thresholdDb: -12 })));
    await reached.promise;
    const heldDuringTick = heldThreshold();
    f.gesture.cancel(holder);
    let drained = false;
    const drain = f.panel.flushPending().then(() => { drained = true; });
    await Promise.resolve();
    const drainedWhileHeld = drained;
    compressorHold = undefined; release.resolve(); await drain;
    const finalHeld = heldThreshold();
    const postsBeforeEqual = compressorLogs[0]?.length;
    const again = await engine.setTrackFxInstances(track, [initial]);
    return { observed: { heldDuringTick: heldDuringTick ?? "none", finalHeld: finalHeld ?? "none",
      nodesBefore, nodesAfter: compressorNodes.length, again, drainedWhileHeld: String(drainedWhileHeld) },
      checks: [
        check("the actual in-place node holds pending tick B", heldDuringTick, -12),
        check("panel cancel waits for the held set", drainedWhileHeld, false),
        check("cancel restores actual node A", finalHeld, -18),
        check("the compressor node was reused", compressorNodes.length, nodesBefore),
        check("liveParams names A after cancel", again, "skipped"),
        check("equal A causes no hidden node write", compressorLogs[0]?.length, postsBeforeEqual),
      ] };
  } finally { compressorHold = undefined; release.resolve(); dispose(); }
});

const eqControlRow = () => withEngine("installed-A-pending-B-request-A-eq-control", async (engine) => {
  await engine.setTrackFxInstances(track, [eq(0)]);
  const results = await Promise.all([outcome(engine.setTrackFxInstances(track, [eq(6)])), outcome(engine.setTrackFxInstances(track, [eq(0)]))]);
  await macrotask();
  return {
    observed: { heldGainDb: heldEqGain() ?? "none", biquads: biquads.length, ...tally(results) },
    checks: [
      check("the tick is superseded and A is skipped", results.map(label), ["superseded", "skipped"]),
      check("the node holds A", heldEqGain(), 0),
    ],
  };
});

const equalPendingSuccessRow = () => withEngine("equal-pending-success", async (engine) => {
  const results = await Promise.all([outcome(engine.setTrackFxInstances(track, [compressor(-18)])), outcome(engine.setTrackFxInstances(track, [compressor(-18)]))]);
  await macrotask();
  const summary = tally(results);
  return {
    observed: { ...summary, nodesConstructed: compressorLogs.length, heldThresholdDb: heldThreshold() ?? "none" },
    checks: [
      check("calls", summary.calls, 2),
      check("applications", summary.applications, 1),
      check("joins", summary.joins, 1),
      check("skips", summary.skips, 0),
      check("one compressor node built", compressorLogs.length, 1),
    ],
  };
});

const equalPendingFailureRow = () => withEngine("equal-pending-failure", async (engine) => {
  rejectNextCompressorModule = true;
  const results = await Promise.all([outcome(engine.setTrackFxInstances(track, [compressor(-18)])), outcome(engine.setTrackFxInstances(track, [compressor(-18)]))]);
  await macrotask();
  const built = compressorLogs.length;
  const retry = await outcome(engine.setTrackFxInstances(track, [compressor(-18)]));
  await macrotask();
  const summary = tally(results);
  return {
    observed: { ...summary, nodesBuiltBeforeRetry: built, retry: label(retry), nodesBuiltAfterRetry: compressorLogs.length },
    checks: [
      check("the joined caller rejects with the first", results.map(label), ["rejected", "rejected"]),
      check("skips", summary.skips, 0),
      check("nothing installed by the failed work", built, 0),
      check("the next equal request applies", label(retry), "applied"),
      check("and builds the node once", compressorLogs.length, 1),
    ],
  };
});

const externalWholeChainThenOldRow = () => withEngine("external-whole-chain-then-old", async (engine) => {
  await engine.setTrackFxInstances(track, [compressor(-24)]);
  await engine.setTrackFxInstances(track, [compressor(-10)]);
  const single = await outcome(engine.setTrackFxInstance(track, compressor(-24)).then((result) => result === "not-held" ? "dropped" : result));
  await macrotask();
  const heldAfterSingle = heldThreshold();
  await engine.setTrackFxInstances(track, [compressor(-10)]);
  const whole = await outcome(engine.setTrackFxInstances(track, [compressor(-24)]));
  await macrotask();
  return {
    observed: { singleDisposition: label(single), heldAfterSingleDb: heldAfterSingle ?? "none", wholeDisposition: label(whole), heldAfterWholeDb: heldThreshold() ?? "none" },
    checks: [
      check("the old value is applied again by a single-instance edit", label(single), "applied"),
      check("and heard", heldAfterSingle, -24),
      check("the old value is applied again by a whole chain", label(whole), "applied"),
      check("and heard", heldThreshold(), -24),
    ],
  };
});

const resourceFaultThenEqualRow = () => withEngine("resource-fault-then-equal", async (engine) => {
  const first = await outcome(engine.setTrackFxInstances(track, [compressor(-18)]));
  await macrotask();
  const processor = compressorNodes.length;
  const node = compressorNodes[0];
  // Chromium does not route a synthetic dispatched event to the attribute handler, so the node's own handler is invoked
  // directly: the call the browser makes when a processor throws.
  node?.onprocessorerror?.call(node, new ErrorEvent("processorerror"));
  const equal = await outcome(engine.setTrackFxInstances(track, [compressor(-18)]));
  await macrotask();
  const summary = tally([first, equal]);
  return {
    observed: { ...summary, nodesBuilt: compressorLogs.length },
    checks: [
      check("a compressor node existed to fault", processor, 1),
      check("applications", summary.applications, 2),
      check("skips", summary.skips, 0),
      check("the faulted resource is replaced", compressorLogs.length, 2),
    ],
  };
});

const sampledZone = (assetKey: string, startSec = 0, endSec = 1): SamplerParams["zones"][number] => ({
  id: `zone-${assetKey}`,
  sample: { assetKey, url: `/${assetKey}.wav`, sourceKind: "upload", source: { durationSec: 2, sampleRate: 48_000, channelCount: 2 } },
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
  playbackMode: "one-shot",
  startSec,
  endSec,
  crossfadeSec: 0,
  chokeGroup: 0,
});
const decodePages = async function* (
  _source: Blob | string | URL | Request,
  options?: { startSec?: number; endSec?: number },
): AsyncGenerator<DecodedAudioPage> {
  const startFrame = Math.round((options?.startSec ?? 0) * 48_000);
  const frameCount = Math.round((options?.endSec ?? 1) * 48_000) - startFrame;
  yield { startFrame, frameCount, sampleRate: 48_000, channelCount: 2, planes: [new Float32Array(frameCount), new Float32Array(frameCount)] };
};
const samplerParams = () => ({ ...createDefaultSamplerParams(), zones: [sampledZone("sampled-a")] });

const sampledEqualJoinRow = () => withEngine("sampled-equal-join", async (engine) => {
  const sync = createSamplerBufferSync({ decodePages });
  const params = samplerParams();
  const results = await Promise.all([outcome(sync.syncTrack(engine, track, params, "sampler-instance")), outcome(sync.syncTrack(engine, track, { ...params }, "sampler-instance"))]);
  const settled = await outcome(sync.syncTrack(engine, track, { ...params }, "sampler-instance"));
  const summary = tally([...results, settled]);
  sync.dispose();
  return {
    observed: { ...summary, instrumentKind: engine.getTrackInstrumentKind(track) ?? "none" },
    checks: [
      check("the second equal sync joins the first", results.map(label), ["applied", "joined"]),
      check("an equal sync after a clean install is skipped", label(settled), "skipped"),
      check("joins", summary.joins, 1),
      check("applications", summary.applications, 1),
      check("the engine holds the sampler", engine.getTrackInstrumentKind(track), "sampler"),
    ],
  };
});

const sampledRemovalReaddRow = () => withEngine("sampled-removal-readd", async (engine) => {
  const sync = createSamplerBufferSync({ decodePages });
  const params = samplerParams();
  const first = await outcome(sync.syncTrack(engine, track, params, "sampler-instance"));
  sync.clearTrack(track);
  const readded = await outcome(sync.syncTrack(engine, track, { ...params }, "sampler-instance"));
  const summary = tally([first, readded]);
  sync.dispose();
  return {
    observed: { ...summary },
    checks: [
      check("applications", summary.applications, 2),
      check("skips", summary.skips, 0),
    ],
  };
});

const sampledEngineLostRow = () => withEngine("sampled-engine-lost-then-equal", async (engine) => {
  const sync = createSamplerBufferSync({ decodePages });
  const params = samplerParams();
  const first = await outcome(sync.syncTrack(engine, track, params, "sampler-instance"));
  engine.clearTrackInstrument(track);
  const kindAfterClear = engine.getTrackInstrumentKind(track) ?? "none";
  const again = await outcome(sync.syncTrack(engine, track, { ...params }, "sampler-instance"));
  const kindAfterAgain = engine.getTrackInstrumentKind(track) ?? "none";
  sync.dispose();
  return {
    observed: { first: label(first), kindAfterClear, again: label(again), kindAfterAgain },
    checks: [
      check("the engine no longer holds the sampler", kindAfterClear, "none"),
      check("an equal sync is applied, not skipped on the old proof", label(again), "applied"),
      check("the engine holds the sampler again", kindAfterAgain, "sampler"),
    ],
  };
});

const sampledEvictionRow = () => withEngine("sampled-eviction-then-equal", async (engine) => {
  // One mono second at 8 kHz is 32 000 bytes: the aggregate budget holds one such region, so loading the second evicts the first.
  const oneRegionBytes = 8000 * 4;
  const source = { durationSec: 2, sampleRate: 8000, channelCount: 1 };
  const firstZone = { ...sampledZone("evicted-first", 0, 1), sample: { ...sampledZone("evicted-first").sample, source } };
  const secondZone = { ...sampledZone("evicted-second", 1, 2), sample: { ...sampledZone("evicted-second").sample, source } };
  const regionPages = async function* (
    _source: Blob | string | URL | Request,
    options?: { startFrame?: number; endFrame?: number },
  ): AsyncGenerator<DecodedAudioPage> {
    const startFrame = options?.startFrame ?? 0;
    const frameCount = (options?.endFrame ?? startFrame + 8000) - startFrame;
    yield { startFrame, frameCount, sampleRate: 8000, channelCount: 1, planes: [new Float32Array(frameCount)] };
  };
  const sync = createSamplerBufferSync({
    aggregateBudget: createSampledInstrumentRegionBudget(oneRegionBytes),
    decodePages: regionPages,
  });
  const firstParams: SamplerParams = { ...createDefaultSamplerParams(), cachePolicy: "preload", maxDecodedBytes: oneRegionBytes, zones: [firstZone] };
  const secondParams: SamplerParams = { ...createDefaultSamplerParams(), cachePolicy: "preload", maxDecodedBytes: oneRegionBytes, zones: [secondZone] };
  const first = await outcome(sync.syncTrack(engine, "evicted-track-a", firstParams, "instance-a"));
  await outcome(sync.syncTrack(engine, "evicted-track-b", secondParams, "instance-b"));
  const evictedState = sync.getStatus("evicted-track-a").zones.get(firstZone.id) ?? "none";
  const again = await outcome(sync.syncTrack(engine, "evicted-track-a", { ...firstParams }, "instance-a"));
  const zoneState = sync.getStatus("evicted-track-a").zones.get(firstZone.id) ?? "none";
  sync.dispose();
  return {
    observed: { first: label(first), evictedState, againAfterEviction: label(again), againDetail: "rejected" in again ? again.rejected : "", zoneState },
    checks: [
      check("the first track lost its regions to the second", evictedState === "ready", false),
      check("an equal preload sync after another track evicted its regions is applied, not skipped", label(again), "applied"),
      check("its regions are loaded again", zoneState, "ready"),
    ],
  };
});

// The master installs disabled A, is asked for enabled B (its processor still building), and is then asked for A again. The
// processor B was building must not outlive that: when an EQ is added afterwards and the master is routed, no connection
// may reach the disabled effect's processor.
const staleEnableRoutedRow = (row: string, processorName: string, make: (enabled: boolean) => Instance) => withEngine(row, async (engine) => {
  const processors = new WeakSet<AudioNode>();
  const Previous = window.AudioWorkletNode;
  const originalConnect = AudioNode.prototype.connect;
  let routing = false;
  let equalizerRouted = false;
  let processorConnections = 0;
  let finishRouting = () => {};
  const routed = new Promise<void>((resolve) => { finishRouting = resolve; });
  window.AudioWorkletNode = class extends Previous {
    constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
      super(context, name, options);
      if (name.includes(processorName)) processors.add(this);
    }
  };
  Object.defineProperty(AudioNode.prototype, "connect", {
    configurable: true,
    writable: true,
    value: function connect(this: AudioNode, ...args: Parameters<typeof originalConnect>) {
      const result = originalConnect.apply(this, args);
      const target = args[0];
      if (!routing) return result;
      if (processors.has(this) || (target instanceof AudioNode && processors.has(target))) processorConnections++;
      if (this instanceof BiquadFilterNode) equalizerRouted = true;
      // The master routing ends by connecting its last stage to the destination: that is the event the routing is done on.
      if (equalizerRouted && target instanceof AudioDestinationNode) finishRouting();
      return result;
    },
  });
  try {
    const disabled = make(false);
    await engine.setMasterFxInstances([disabled]);
    const results = await Promise.all([engine.setMasterFxInstances([make(true)]), engine.setMasterFxInstances([disabled])]);
    routing = true;
    await engine.setMasterFxInstances([disabled, eq(0)]);
    await routed;
    const equal = await engine.setMasterFxInstances([disabled, eq(0)]);
    return {
      observed: { results: results.join(","), equal, processorConnections },
      checks: [
        check("the cancelled enable is superseded and the disabled request applied", results.join(","), "superseded,applied"),
        check("the equal request to the disabled effect is skipped", equal, "skipped"),
        check("no connection reaches the disabled effect's processor", processorConnections, 0),
      ],
    };
  } finally {
    window.AudioWorkletNode = Previous;
    Object.defineProperty(AudioNode.prototype, "connect", { configurable: true, writable: true, value: originalConnect });
  }
});

const staleCompressorRoutedRow = () => staleEnableRoutedRow("stale-compressor-routed", "compressor", (enabled) => ({
  id: "compressor-1",
  kind: "compressor",
  params: { ...AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams(), enabled, thresholdDb: -18 },
}));

const staleReverbRoutedRow = () => staleEnableRoutedRow("stale-reverb-routed", "reverb", (enabled) => ({
  id: "reverb-1",
  kind: "reverb",
  params: { ...AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams(), enabled, wet: 0.8 },
}));

// AudioEngine creates its context on demand, so the real synth runtime is given a context only when this row says so.
const synthDroppedNoContextRow = async (): Promise<RowResult> => {
  resetRecorders();
  const context = new AudioContext();
  let available: AudioContext | null = null;
  const runtime = createSynthRuntime({
    ensureAudio: () => {},
    getAudioContext: () => available,
    getBpm: () => 60,
    timelineToCtxTime: (time) => time,
    ensureTrackInput: () => context.createGain(),
    sources: createSourceRegistry(),
  });
  const engine = new AudioEngine();
  try {
    const params = { ...createDefaultSynthParams(), gain: 0.6 };
    const dropped = runtime.setTrackSynth(track, params, "synth-instance");
    available = context;
    const equalWithContext = runtime.setTrackSynth(track, { ...params }, "synth-instance");
    const equalAgain = runtime.setTrackSynth(track, { ...params }, "synth-instance");
    const lazy = engine.setTrackSynth("lazy-track", params, "synth-instance");
    return {
      row: "synth-dropped-no-context",
      observed: { withoutContext: dropped, equalWithContext, equalAgain, engineWithoutPriorContext: lazy },
      checks: [
        check("no context: dropped", dropped, "dropped"),
        check("never counted as installed: the equal request once a context exists is applied", equalWithContext, "applied"),
        check("and only then is an equal request skipped", equalAgain, "skipped"),
        check("the engine creates its context on demand, so it never drops for lack of one", lazy, "applied"),
      ],
    };
  } finally {
    engine.close();
    await context.close();
  }
};

const rows = new Map([
  ["R4-5 compressor in-place pending tick plus panel cancel", panelCompressorCancelRow],
  ["installed-A-pending-B-request-A-compressor", () => compressorRow("installed-A-pending-B-request-A-compressor", false)],
  ["installed-A-pending-B-request-A-eq-control", eqControlRow],
  ["installed-A-pending-B-request-A-master-compressor", () => compressorRow("installed-A-pending-B-request-A-master-compressor", true)],
  ["equal-pending-success", equalPendingSuccessRow],
  ["equal-pending-failure", equalPendingFailureRow],
  ["external-whole-chain-then-old", externalWholeChainThenOldRow],
  ["resource-fault-then-equal", resourceFaultThenEqualRow],
  ["sampled-equal-join", sampledEqualJoinRow],
  ["sampled-removal-readd", sampledRemovalReaddRow],
  ["sampled-engine-lost-then-equal", sampledEngineLostRow],
  ["sampled-eviction-then-equal", sampledEvictionRow],
  ["stale-compressor-routed", staleCompressorRoutedRow],
  ["stale-reverb-routed", staleReverbRoutedRow],
  ["synth-dropped-no-context", synthDroppedNoContextRow],
]);

Object.assign(window, {
  engineRows: {
    names: [...rows.keys()],
    run: (name: string) => (rows.get(name) ?? (() => Promise.reject(new Error(`Unknown row ${name}`))))(),
    ready: true,
  },
});
