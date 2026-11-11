// Chromium-side half of the device-control cost measurement. It mounts the real EffectsPanel over the real
// AudioEngine, the real local persistence (IndexedDB) and the real processor-edit registry, then drives the
// real device controls with DOM events. Nothing in src/ is modified: counters wrap existing injection points
// (panel props, engine methods, buffer-sync methods) and browser prototypes (IDBObjectStore.put, AudioContext
// node factories). requestAnimationFrame is replaced by a manual queue so frames are stepped explicitly.
import { createRoot, createSignal } from "solid-js";
import { render } from "solid-js/web";
import "~/index.css";
import { ColorModeProvider } from "@kobalte/core";
import { AudioEngine, type EngineDisposition } from "@daw-browser/audio-engine/audio-engine";
import { createPersistedEffectState } from "~/components/timeline/create-persisted-effect-state";
import { createEffectsPanelAudioDevice } from "~/components/timeline/create-effects-panel-audio-effects-state";
import { ParameterGestureHolder, parameterSaveResult } from "~/components/timeline/parameter-gesture-owner";
import { createNativePlaybackController } from "~/lib/desktop/native-playback-controller";
import type { DeliveryRegistration } from "~/lib/live-processor-control";
import {
  AUDIO_EFFECT_CONTRACTS,
  INSTRUMENT_CONTRACTS,
  createAudioEffectInstanceId,
  createDefaultArpeggiatorParams,
  createInstrumentInstanceId,
  EQ_FREQUENCY_MAX,
  EQ_FREQUENCY_MIN,
  EQ_GAIN_DB_MAX,
  EQ_GAIN_DB_MIN,
  normalizeEqParams,
  type AudioEffectKind,
  type TrackInstrumentParams,
} from "@daw-browser/shared";
import type { Track } from "@daw-browser/timeline-core/types";
import EffectsPanel from "~/components/timeline/EffectsPanel";
import { AppPreferencesProvider } from "~/context/app-preferences";
import { defaultAppPreferences } from "~/lib/preferences/app-preferences";
import { createProcessorEditRegistry } from "~/components/timeline/create-processor-edit-registry";
import { deleteLocalEffect, deleteLocalEffectInstance, listLocalEffects, setLocalEffect, setLocalEffectInstance } from "~/lib/local-effects";
import { createSampledInstrumentSession } from "~/lib/sampled-instrument-session";
import { z } from "zod";
import { countFactoryCalls } from "./device-control-cost-spy";

type EngineMode = "legacy" | "native";
type InstrumentDevice = "synth" | "drum-rack" | "sampler" | "granular" | "arpeggiator";
type Device = AudioEffectKind | InstrumentDevice;
type Cadence = "per-frame" | "burst" | "single";

type Counters = {
  persistenceWrites: number;
  historyEntries: number;
  historyMergeFalse: number;
  // History entries whose old (`From`) or new value has the device disabled: tells a replayed (undone) baseline from a stale one.
  historyDisabled: number;
  historyFromDisabled: number;
  legacyEngineSubmits: number;
  legacyMasterSubmits: number;
  // Single-instance engine entries (setTrackFxInstance / setMasterFxInstance), kept apart from whole-chain submits.
  legacySingleInstanceSubmits: number;
  // Buffer-sync clears made by the remaining audio-sync lifecycle reconciliation,
  // excluding the persisted instrument owner's content application.
  reconcileClears: number;
  // Synchronous reconcile turns with lifecycle cache clears, in either engine mode.
  reconcileRuns: number;
  // Engine clears of the track's instrument: a removed instrument is cleared once and never restored.
  instrumentClears: number;
  sidechainPublishes: number;
  // Sampler, granular and drum-rack calls, also included in instrumentEngineCalls.
  sampleBufferSyncs: number;
  // Times the real export/desired-processor projection differed from the one read after the previous input frame.
  projectionChanges: number;
  automationOverrides: number;
  nodeConstructions: number;
  nativePreview: number;
  nativeFlush: number;
  nativeJoin: number;
  // Live processor updates sent to the prepared portable session (the browser playback engine): its own engine.
  portableSession: number;
  instrumentEngineCalls: number;
  nativeSubmitted: number;
  instrumentPreviewCallbacks: number;
  structuralChanges: number;
  effectErrors: number;
};

type Measure = {
  device: Device;
  engine: EngineMode;
  gesture: string;
  cadence: Cadence;
};

const instrumentDevices: readonly InstrumentDevice[] = ["synth", "drum-rack", "sampler", "granular", "arpeggiator"];
const instrumentTitles = {
  synth: "Synth",
  "drum-rack": "Drum Rack",
  sampler: "Sampler",
  granular: "Granular",
  arpeggiator: "Arpeggiator",
} satisfies Record<InstrumentDevice, string>;
const graphHandles = new Map([
  ["graph-drag-delay-filter", { device: "delay", label: "Delay low cut frequency" }],
  ["graph-drag-reverb-filter", { device: "reverb", label: "Low cut frequency" }],
  ["graph-drag-reverb-space", { device: "reverb", label: "Reverb size and diffusion" }],
]);

const isInstrument = (device: Device): device is InstrumentDevice => instrumentDevices.some((entry) => entry === device);
// The device's own `enabled`, not a nested one (a compressor's sidechain also carries `enabled`).
const disabledParams = z.object({ enabled: z.literal(false) });
const topLevelDisabled = <Params,>(params: Params) => disabledParams.safeParse(params).success;
const isEffectKind = (device: string): device is AudioEffectKind => Object.keys(AUDIO_EFFECT_CONTRACTS).includes(device);

const counters: Counters = {
  persistenceWrites: 0, historyEntries: 0, historyMergeFalse: 0, historyDisabled: 0, historyFromDisabled: 0, legacyEngineSubmits: 0, legacyMasterSubmits: 0, legacySingleInstanceSubmits: 0, reconcileClears: 0, reconcileRuns: 0, instrumentClears: 0, sidechainPublishes: 0, sampleBufferSyncs: 0, projectionChanges: 0, automationOverrides: 0, nodeConstructions: 0, nativePreview: 0,
  nativeFlush: 0, nativeJoin: 0, portableSession: 0, instrumentEngineCalls: 0, nativeSubmitted: 0, instrumentPreviewCallbacks: 0, structuralChanges: 0, effectErrors: 0,
};
type BoundaryCounts = {
  calls: number; applications: number; skips: number; joins: number;
  dropped: number; superseded: number; notHeld: number; rejected: number; unproven: number;
};
const boundaryCounts = new Map<string, BoundaryCounts>();
const nativeSubmissions: string[] = [];
const nativeOutcomes = { applied: 0, superseded: 0, refused: 0, unconfirmed: 0, unavailable: 0, pending: 0 };
const registrationConsumers: Array<{ reads: number }> = [];
let registryAllocations = 0;
const boundaryCall = (name: string) => {
  const count = boundaryCounts.get(name) ?? {
    calls: 0, applications: 0, skips: 0, joins: 0, dropped: 0,
    superseded: 0, notHeld: 0, rejected: 0, unproven: 0,
  };
  boundaryCounts.set(name, count);
  count.calls++;
  return count;
};
const boundaryResult = (count: BoundaryCounts, result: EngineDisposition | "not-held" | void, installed: () => void) => {
  if (result === "applied") count.applications++;
  else if (result === "skipped") count.skips++;
  else if (result === "joined") count.joins++;
  else if (result === "dropped") count.dropped++;
  else if (result === "superseded") count.superseded++;
  else if (result === "not-held") count.notHeld++;
  else count.unproven++;
  if (result === "applied" || result === "skipped" || result === "joined") installed();
  return result;
};
const nativeSubmitted = <Value,>(value: Value) => {
  counters.nativeSubmitted++;
  nativeSubmissions.push(anonymizeIds(stableJson(value)));
};
const nodeTypes = new Map<string, number>();
const pageErrors: string[] = [];
const resetCounters = () => {
  for (const key of Object.keys(counters)) Reflect.set(counters, key, 0);
  nodeTypes.clear();
  boundaryCounts.clear();
  nativeSubmissions.length = 0;
  registrationConsumers.length = 0;
  registryAllocations = 0;
  for (const key of Object.keys(nativeOutcomes)) Reflect.set(nativeOutcomes, key, 0);
  submitCallers.clear();
  events.length = 0;
  heldAtPersist.length = 0;
  appliedValues.length = 0;
  externalMark.before = undefined;
  externalMark.after = undefined;
  externalMark.pending = false;
  switchedProject = undefined;
  pageErrors.length = 0;
};
// instrumentEngineCalls includes buffer-sync entries; sampleBufferSyncs reports that subset separately.
const dispatches = () => (
  counters.legacyEngineSubmits + counters.legacySingleInstanceSubmits + counters.nativePreview + counters.nativeFlush + counters.instrumentEngineCalls
);
// Per engine: the portable Web Audio engine and the native host are separate engines. Native joins are counted here
// (and not in the sum above, which keeps its earlier definition) because they are the native carrier for sampled instruments.
const portableDispatches = () => counters.legacyEngineSubmits + counters.legacySingleInstanceSubmits + counters.instrumentEngineCalls;
const nativeDispatches = () => counters.nativePreview + counters.nativeFlush + counters.nativeJoin;
const frameCounts = () => ({ all: dispatches(), portable: portableDispatches(), native: nativeDispatches(), portableSession: counters.portableSession });
type FrameSeries = { [Engine in keyof ReturnType<typeof frameCounts>]: number[] };

// What each engine was last told, per device: the instance id for effects, "instrument" and "arp" for instruments.
// A value counts only once the engine took it, so a rejected apply leaves the previous value held.
const engineHeld = new Map<string, string>();
const stableJson = <Value,>(value: Value): string => JSON.stringify(value, (_key, field) => (
  field && Object.getPrototypeOf(field) === Object.prototype
    ? Object.fromEntries(Object.entries(field).sort(([left], [right]) => left.localeCompare(right)))
    : field
));
// Fault and hold switches for the lifecycle rows: a rejected next apply, and applies/terminals held until released.
class Faults {
  failNextApply = false;
  hold: Promise<void> | undefined = undefined;
}
const faults = new Faults();
// Ordered engine/persistence events of one row, so "applied before persisted" is checkable.
const events: string[] = [];
// The instrument value the engine held at each persisted write: a release must not persist while a later one already reached the engine.
const heldAtPersist: string[] = [];
// Every instrument value an engine took, in order: a value of a dead lifetime must never appear after the lifetime ended.
const appliedValues: string[] = [];
// The engine-held value around an external change, read before any further input reaches the panel.
class ExternalMark {
  before: string | undefined = undefined;
  after: string | undefined = undefined;
  pending = false;
}
const externalMark = new ExternalMark();
// Instance ids are random per run; number them by first appearance so recorded artifacts are reproducible.
const anonymizeIds = (text: string) => {
  const ids = new Map<string, string>();
  return text.replace(/(audio-effect|instrument):[0-9a-f-]{36}/g, (id, prefix) => {
    const label = ids.get(id) ?? `${prefix}:#${ids.size}`;
    ids.set(id, label);
    return label;
  });
};
const heldNow = (current: { device: Device; instanceId: string | undefined; engineMode: EngineMode }) => {
  const held = engineHeld.get(isInstrument(current.device) ? (current.device === "arpeggiator" ? "arp" : "instrument") : (current.instanceId ?? ""));
  return held === undefined ? undefined : anonymizeIds(held);
};

// What a run waits on is the completion of the real asynchronous work it started, never elapsed wall time: IndexedDB
// transactions, short real timers, and the sampled-apply promises. A row is read once all of it has reported completion.
let pendingTransactions = 0;
let pendingWork = 0;
const idleWaiters: (() => void)[] = [];
const inFlight = () => pendingTransactions + pendingWork + shortTimers.size;
const noteIdle = () => {
  if (inFlight() > 0) return;
  for (const wake of idleWaiters.splice(0)) wake();
};
const originalTransaction = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function transaction(...args: Parameters<typeof originalTransaction>) {
  const tx = originalTransaction.apply(this, args);
  pendingTransactions++;
  // Registered before the product's own listeners: it settles first, and the product's continuations still run
  // before the macrotask hop that `settle` takes before it declares the run idle.
  const done = () => { pendingTransactions--; noteIdle(); };
  tx.addEventListener("complete", done, { once: true });
  tx.addEventListener("abort", done, { once: true });
  return tx;
};
const trackWork = async <Value,>(run: () => Promise<Value>): Promise<Value> => {
  pendingWork++;
  try { return await run(); } finally { pendingWork--; noteIdle(); }
};
// A database open is in flight until its request succeeds or fails: a project switch can start one before any transaction exists.
const originalOpen = IDBFactory.prototype.open;
IDBFactory.prototype.open = function open(...args: Parameters<typeof originalOpen>) {
  const request = originalOpen.apply(this, args);
  void trackWork(() => new Promise<void>((resolve) => {
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => resolve(), { once: true });
  }));
  return request;
};
// The engine builds worklet nodes once the worklet module has loaded, decodes samples, and resumes its context on the real
// clock: each is in flight until its promise has settled, whichever way it settles.
const originalAddModule = AudioWorklet.prototype.addModule;
AudioWorklet.prototype.addModule = function addModule(...args: Parameters<typeof originalAddModule>) {
  const loading = originalAddModule.apply(this, args);
  void trackWork(() => loading.then(() => undefined, () => undefined));
  return loading;
};
const originalDecode = BaseAudioContext.prototype.decodeAudioData;
BaseAudioContext.prototype.decodeAudioData = function decodeAudioData(...args: Parameters<typeof originalDecode>) {
  const decoding = originalDecode.apply(this, args);
  void trackWork(() => decoding.then(() => undefined, () => undefined));
  return decoding;
};
const originalResume = AudioContext.prototype.resume;
AudioContext.prototype.resume = function resume(...args: Parameters<typeof originalResume>) {
  const resuming = originalResume.apply(this, args);
  void trackWork(() => resuming.then(() => undefined, () => undefined));
  return resuming;
};
const macrotask = () => new Promise<void>((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
  channel.port2.postMessage(null);
});
// Idle means: every tracked piece of work reported completion, and two task turns later nothing new had started. Work
// held by a lifecycle row is not counted until its hold is released.
const settle = async () => {
  for (let quiet = 0; quiet < 2;) {
    await macrotask();
    if (inFlight() === 0) { quiet++; continue; }
    quiet = 0;
    // The deadline only turns a hang into a failure; it is not what decides that the run is idle.
    await new Promise<void>((resolve, reject) => {
      const hang = realSetTimeout(() => reject(new Error(`The run did not settle: transactions=${pendingTransactions} work=${pendingWork} timers=${shortTimers.size}`)), 60_000);
      idleWaiters.push(() => { realClearTimeout(hang); resolve(); });
    });
  }
};

let virtualNow = 0;
// Manual frame queue. step() runs the callbacks queued so far and not those they queue.
const frameQueue = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
// ResizeObserver notifications come from the browser's own rendering step, not from the stepped frame queue. After a layout
// change, two real frames have delivered them (and so queued whatever frame work they request).
const renderTurn = () => new Promise<void>((resolve) => {
  nativeRequestAnimationFrame(() => nativeRequestAnimationFrame(() => resolve()));
});
window.requestAnimationFrame = (callback) => {
  const id = nextFrameId++;
  frameQueue.set(id, callback);
  return id;
};
window.cancelAnimationFrame = (id) => { frameQueue.delete(id); };
// Timers of 50 ms or more (the 200 ms instrument save debounce among them) run on a virtual clock that only
// advances 16 ms per stepped frame or through flushVirtualTime(), so debounce counts do not depend on wall time.
// Wall time is excluded entirely: the EQ decay loop reads performance.now, so real jitter changed its length by one frame.
performance.now = () => 1000 + virtualNow;
const realSetTimeout = window.setTimeout.bind(window);
const realClearTimeout = window.clearTimeout.bind(window);
const virtualTimers = new Map<number, { at: number; run: () => void }>();
const shortTimers = new Set<number>();
let nextTimerId = 1_000_000;
Reflect.set(window, "setTimeout", (handler: TimerHandler, delay = 0, ...args: unknown[]) => {
  if (!(handler instanceof Function)) return realSetTimeout(handler, delay, ...args);
  if (delay < 50) {
    // A short timer completes on the real clock: it is in flight until it has run or been cleared.
    const real = realSetTimeout(() => { shortTimers.delete(real); try { handler(...args); } finally { noteIdle(); } }, delay);
    shortTimers.add(real);
    return real;
  }
  const id = nextTimerId++;
  virtualTimers.set(id, { at: virtualNow + delay, run: () => handler(...args) });
  return id;
});
Reflect.set(window, "clearTimeout", (id?: number) => {
  if (id === undefined) return;
  if (virtualTimers.delete(id)) return;
  realClearTimeout(id);
  if (shortTimers.delete(id)) noteIdle();
});
const advanceVirtualTime = (ms: number) => {
  const target = virtualNow + ms;
  for (;;) {
    const due = [...virtualTimers].filter(([, timer]) => timer.at <= target).sort(([, left], [, right]) => left.at - right.at)[0];
    if (!due) break;
    virtualNow = Math.max(virtualNow, due[1].at);
    virtualTimers.delete(due[0]);
    due[1].run();
  }
  virtualNow = target;
};
const stepFrame = () => {
  advanceVirtualTime(16);
  const queued = [...frameQueue.values()];
  frameQueue.clear();
  frameCallbacksRun += queued.length;
  for (const callback of queued) callback(performance.now());
};
let frameCallbacksRun = 0;
const flushVirtualTime = async () => {
  for (let round = 0; round < 3; round++) {
    advanceVirtualTime(500);
    await settle();
  }
};

// Persistence: every put/add of an `effect` entity row on the local project database.
const effectRow = z.object({ kind: z.literal("effect") });
const originalPut = IDBObjectStore.prototype.put;
const originalAdd = IDBObjectStore.prototype.add;
IDBObjectStore.prototype.put = function put(value, key) {
  if (effectRow.safeParse(value).success) { counters.persistenceWrites++; events.push("persist"); heldAtPersist.push(anonymizeIds(engineHeld.get("instrument") ?? "null")); }
  return originalPut.call(this, value, key);
};
IDBObjectStore.prototype.add = function add(value, key) {
  if (effectRow.safeParse(value).success) { counters.persistenceWrites++; events.push("persist"); heldAtPersist.push(anonymizeIds(engineHeld.get("instrument") ?? "null")); }
  return originalAdd.call(this, value, key);
};

// Legacy node constructions: every AudioNode factory on BaseAudioContext, plus `new AudioWorkletNode`.
const countNode = (type: string) => {
  counters.nodeConstructions++;
  nodeTypes.set(type, (nodeTypes.get(type) ?? 0) + 1);
};
countFactoryCalls(BaseAudioContext.prototype, /^create(?!Buffer$|PeriodicWave$)/u, countNode);
const OriginalWorkletNode = AudioWorkletNode;
class CountedWorkletNode extends OriginalWorkletNode {
  constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
    super(context, name, options);
    countNode(`AudioWorkletNode:${name}`);
  }
}
window.AudioWorkletNode = CountedWorkletNode;

const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  pageErrors.push(`console.error:${args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(" ")}`.slice(0, 600));
  originalConsoleError(...args);
};
window.addEventListener("error", (event) => pageErrors.push(`error:${event.message}`));
window.addEventListener("unhandledrejection", (event) => pageErrors.push(`rejection:${String(event.reason)}`));

const engine = new AudioEngine();
// The AudioContext is created on the first user gesture in the app; create it up front so track chains are built.
engine.ensureAudio();
const originalSetTrackFx = engine.setTrackFxInstances.bind(engine);
const originalSetMasterFx = engine.setMasterFxInstances.bind(engine);
const originalSetTrackInstrument = engine.setTrackInstrument.bind(engine);
const originalSetTrackArpeggiator = engine.setTrackArpeggiator.bind(engine);
// The submit's immediate caller, taken from the stack, tells the panel's own apply from the audio-sync effect.
const submitCallers = new Map<string, number>();
const noteSubmitCaller = (kind: string) => {
  const frames = (new Error().stack ?? "").split("\n").slice(3, 5).map((line) => /at (?:async )?(\S+) /u.exec(line)?.[1] ?? "?");
  const key = `${kind}<${frames.join("<")}`;
  submitCallers.set(key, (submitCallers.get(key) ?? 0) + 1);
};
const holdEngineHeld = <Value,>(key: string, value: Value) => {
  engineHeld.set(key, stableJson(value));
  if (key === "instrument") appliedValues.push(anonymizeIds(stableJson(value)));
};
engine.setTrackFxInstances = async (trackId, instances) => {
  counters.legacyEngineSubmits++;
  noteSubmitCaller("track");
  const count = boundaryCall("track.chain");
  try {
    const result = await originalSetTrackFx(trackId, instances);
    boundaryResult(count, result, () => { for (const instance of instances) holdEngineHeld(instance.id, instance.params); });
    return result;
  } catch (cause) { count.rejected++; throw cause; }
};
engine.setMasterFxInstances = async (instances) => {
  counters.legacyEngineSubmits++;
  counters.legacyMasterSubmits++;
  noteSubmitCaller("master");
  const count = boundaryCall("master.chain");
  try {
    const result = await originalSetMasterFx(instances);
    boundaryResult(count, result, () => { for (const instance of instances) holdEngineHeld(instance.id, instance.params); });
    return result;
  } catch (cause) { count.rejected++; throw cause; }
};
const originalSetTrackFxInstance = engine.setTrackFxInstance.bind(engine);
const originalSetMasterFxInstance = engine.setMasterFxInstance.bind(engine);
const originalSetSidechainRoutes = engine.setExternalSidechainRoutes.bind(engine);
engine.setTrackFxInstance = async (trackId, instance) => {
  counters.legacySingleInstanceSubmits++;
  noteSubmitCaller("trackInstance");
  const count = boundaryCall("track.instance");
  try {
    const result = await originalSetTrackFxInstance(trackId, instance);
    boundaryResult(count, result, () => holdEngineHeld(instance.id, instance.params));
    return result;
  } catch (cause) { count.rejected++; throw cause; }
};
engine.setMasterFxInstance = async (instance) => {
  counters.legacySingleInstanceSubmits++;
  noteSubmitCaller("masterInstance");
  const count = boundaryCall("master.instance");
  try {
    const result = await originalSetMasterFxInstance(instance);
    boundaryResult(count, result, () => holdEngineHeld(instance.id, instance.params));
    return result;
  } catch (cause) { count.rejected++; throw cause; }
};
engine.setExternalSidechainRoutes = (routes) => {
  counters.sidechainPublishes++;
  return originalSetSidechainRoutes(routes);
};
// A rejected apply (faults.failNextApply) leaves the engine on its previous value and is not recorded as held.
const failIfArmed = () => {
  if (!faults.failNextApply) return false;
  faults.failNextApply = false;
  events.push("apply:fail");
  return true;
};
engine.setTrackInstrument = (trackId, input) => {
  counters.instrumentEngineCalls++;
  noteSubmitCaller("setTrackInstrument");
  const count = boundaryCall("instrument");
  try {
    if (failIfArmed()) throw new Error("injected instrument apply failure");
    const result = originalSetTrackInstrument(trackId, input);
    // The generic sampled setter void-fires work. Only the synth route proves synchronous installation.
    boundaryResult(count, input.instrument?.kind === "synth" ? result : undefined, () => {
      events.push("apply:ok");
      if (input.instrument) holdEngineHeld("instrument", input.instrument);
    });
    return result;
  } catch (cause) { count.rejected++; throw cause; }
};
const originalClearTrackInstrument = engine.clearTrackInstrument.bind(engine);
engine.clearTrackInstrument = (trackId) => {
  counters.instrumentClears++;
  return originalClearTrackInstrument(trackId);
};
engine.setTrackArpeggiator = (trackId, params) => {
  counters.instrumentEngineCalls++;
  noteSubmitCaller("setTrackArpeggiator");
  const count = boundaryCall("arp");
  try {
    if (failIfArmed()) throw new Error("injected arpeggiator apply failure");
    const result = originalSetTrackArpeggiator(trackId, params);
    boundaryResult(count, result, () => holdEngineHeld("arp", params));
    return result;
  } catch (cause) { count.rejected++; throw cause; }
};

// Pointer capture needs a browser-issued pointer id; synthetic events have none.
Element.prototype.setPointerCapture = () => undefined;
Element.prototype.releasePointerCapture = () => undefined;
Element.prototype.hasPointerCapture = () => false;

type ExportSnapshot = NonNullable<Parameters<NonNullable<ComponentProps<typeof EffectsPanel>["onExportSnapshotChange"]>>[0]>;
// What the row was seeded with, by the family of device it belongs to.
type Seed =
  | { family: "effect"; params: ReturnType<typeof seedParams> }
  | { family: "instrument"; params: TrackInstrumentParams }
  | { family: "arp"; params: ReturnType<typeof createDefaultArpeggiatorParams> };
type ReplayInstanceParams = Parameters<NonNullable<ComponentProps<typeof EffectsPanel>["onEffectInstanceParamsReplayChange"]>>[0];
type Mounted = {
  device: Device;
  engineMode: EngineMode;
  projectId: string;
  trackId: string;
  card: Element;
  seed: Seed;
  instanceId: string | undefined;
  setCanWrite: (canWrite: boolean) => void;
  replay: () => ReplayInstanceParams | undefined;
  flush: () => Promise<void>;
  // The projection the desired-processor state is built from, read through the real snapshot interface.
  projection: () => ReturnType<ExportSnapshot["snapshotEffectsProjection"]> | undefined;
  switchProject: (projectId: string) => void;
  bumpGeneration: () => void;
  storedBefore: string;
  dispose: () => void;
  sessionDispose: () => void;
};
let mounted: Mounted | undefined;
// Set by the project-switch rows; its stored rows must stay empty.
let switchedProject: string | undefined;

const seedParams = (kind: AudioEffectKind) => {
  if (kind === "delay") return { ...AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams(), filterEnabled: true };
  if (kind === "reverb") return { ...AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams(), lowCutHz: 200, highCutHz: 8000 };
  return AUDIO_EFFECT_CONTRACTS[kind].createDefaultParams();
};
const seedInstrument = (device: Exclude<InstrumentDevice, "arpeggiator">): TrackInstrumentParams => {
  const instanceId = createInstrumentInstanceId();
  if (device === "synth") return { kind: "synth", instanceId, params: INSTRUMENT_CONTRACTS.synth.createDefaultParams() };
  if (device === "drum-rack") return { kind: "drum-rack", instanceId, params: INSTRUMENT_CONTRACTS["drum-rack"].createDefaultParams() };
  if (device === "sampler") return { kind: "sampler", instanceId, params: INSTRUMENT_CONTRACTS.sampler.createDefaultParams() };
  return { kind: "granular", instanceId, params: INSTRUMENT_CONTRACTS.granular.createDefaultParams() };
};

const findCard = (device: Device) => {
  if (isEffectKind(device)) return document.querySelector(`[data-effect-kind="${device}"] .effect-shell`);
  const title = instrumentTitles[device];
  return [...document.querySelectorAll(".effect-shell")].find((shell) => (
    shell.querySelector("[data-effect-shell-header] span")?.textContent === title
  )) ?? null;
};

const waitFor = async <Value,>(read: () => Value | null | undefined, what: string) => {
  await settle();
  const value = read();
  if (value) return value;
  const stored = mounted ? null : await listLocalEffects(`project:cost-${mountSequence}`).then((rows) => JSON.stringify(rows).slice(0, 400), (error) => String(error));
  const kinds = [...document.querySelectorAll("[data-effect-kind]")].map((node) => node.getAttribute("data-effect-kind"));
  throw new Error(`Nothing rendered ${what} once the run settled; rendered kinds=${JSON.stringify(kinds)}; stored=${stored}; shells=${document.querySelectorAll(".effect-shell").length}; pageErrors=${JSON.stringify(pageErrors)}; text=${document.body.innerText.slice(0, 300)}; html=${document.body.innerHTML.replace(/class="[^"]*"/gu, "").slice(0, 1800)}`);
};

const unmount = async () => {
  if (!mounted) return;
  const previous = mounted;
  mounted = undefined;
  previous.dispose();
  document.body.replaceChildren();
  frameQueue.clear();
  previous.sessionDispose();
  await originalSetTrackFx(previous.trackId, []);
  engine.clearTrackInstrument(previous.trackId);
  engine.clearTrackArpeggiator(previous.trackId);
};

let mountSequence = 0;
let mountNodeConstructions = 0;
const mount = async (device: Device, engineMode: EngineMode) => {
  await unmount();
  engineHeld.clear();
  mountSequence++;
  const projectId = `project:cost-${mountSequence}`;
  const trackId = `track:cost-${mountSequence}`;
  const instrumentTrack = isInstrument(device);
  let seed: Seed;
  let instanceId: string | undefined;
  if (isEffectKind(device)) {
    const params = seedParams(device);
    seed = { family: "effect", params };
    instanceId = createAudioEffectInstanceId();
    await setLocalEffectInstance(projectId, trackId, device, params, { instanceId, index: 0 });
  } else if (device === "arpeggiator") {
    await setLocalEffect(projectId, trackId, "instrument", seedInstrument("synth"));
    const params = { ...createDefaultArpeggiatorParams(), enabled: true };
    seed = { family: "arp", params };
    await setLocalEffect(projectId, trackId, "arp", params);
  } else {
    const params = seedInstrument(device);
    seed = { family: "instrument", params };
    await setLocalEffect(projectId, trackId, "instrument", params);
  }
  const track: Track = { id: trackId, name: "Cost track", volume: 1, clips: [], kind: instrumentTrack ? "instrument" : "audio" };
  const session = createSampledInstrumentSession({ projectId: () => projectId });
  const { samplerBufferSync, drumRackBufferSync } = session;
  const syncTrack = samplerBufferSync.syncTrack;
  const syncGranularTrack = samplerBufferSync.syncGranularTrack;
  const syncDrumRack = drumRackBufferSync.syncTrack;
  // One wrapper for the three buffer syncs: count, honour the hold and fault switches, and note the value the engine took.
  const tracked = <Args extends unknown[], Params, InstanceId>(name: string, kind: string, run: (...args: Args) => Promise<EngineDisposition>, params: (args: Args) => Params, instanceId: (args: Args) => InstanceId) => async (...args: Args): Promise<EngineDisposition> => {
    counters.instrumentEngineCalls++;
    counters.sampleBufferSyncs++;
    noteSubmitCaller(name);
    const count = boundaryCall(name);
    try {
      if (failIfArmed()) throw new Error("injected buffer sync failure");
      await faults.hold;
      return await trackWork(async () => {
        const result = await run(...args);
        boundaryResult(count, result, () => {
          events.push("apply:ok");
          holdEngineHeld("instrument", { kind, instanceId: instanceId(args), params: params(args) });
        });
        return result;
      });
    } catch (cause) { count.rejected++; throw cause; }
  };
  samplerBufferSync.syncTrack = tracked("sampler.syncTrack", "sampler", syncTrack, (args) => args[2], (args) => args[3]);
  samplerBufferSync.syncGranularTrack = tracked("sampler.syncGranularTrack", "granular", syncGranularTrack, (args) => args[2], (args) => args[3]);
  drumRackBufferSync.syncTrack = tracked("drumRack.syncTrack", "drum-rack", syncDrumRack, (args) => args[2], (args) => args[3]);
  const clearSamplerTrack = samplerBufferSync.clearTrack;
  const clearDrumRackTrack = drumRackBufferSync.clearTrack;
  const fromReconcile = () => {
    const stack = new Error().stack ?? "";
    return stack.includes("reconcileEffectsRows") || stack.includes("clearSyncedTrackState");
  };
  // Stale-track clears can reach both syncs more than once in a turn; count the turn once.
  let reconcileRunOpen = false;
  const noteReconcileClear = () => {
    if (!fromReconcile()) return;
    counters.reconcileClears++;
    if (reconcileRunOpen) return;
    reconcileRunOpen = true;
    counters.reconcileRuns++;
    queueMicrotask(() => { reconcileRunOpen = false; });
  };
  samplerBufferSync.clearTrack = (...args) => { noteReconcileClear(); return clearSamplerTrack(...args); };
  drumRackBufferSync.clearTrack = (...args) => { noteReconcileClear(); return clearDrumRackTrack(...args); };
  const edits = createProcessorEditRegistry(() => 120);
  const [canWrite, setCanWrite] = createSignal(true);
  let replay: ReplayInstanceParams | undefined;
  let exportSnapshot: ExportSnapshot | undefined;
  const [activeProject, setActiveProject] = createSignal(projectId);
  const [generation, setGeneration] = createSignal(0);
  // The DOM cost fixture has no desktop host. Ask the real controller, which truthfully reports unavailable.
  const nativeControl = createNativePlaybackController({ bridge: undefined, compileSnapshot: async () => ({ supported: false, reasons: ["No desktop host in the DOM cost fixture."] }) });
  const observeRegistration = (registration: DeliveryRegistration) => {
    const settled = registration.settled;
    const consumer = { reads: 0 };
    registrationConsumers.push(consumer);
    Object.defineProperty(registration, "settled", { get: () => { consumer.reads++; return settled; } });
    nativeOutcomes.pending++;
    void settled.then(outcome => { nativeOutcomes.pending--; nativeOutcomes[outcome.state]++; });
    return registration;
  };
  const dispose = render(() => (
    <ColorModeProvider initialColorMode="dark" storageManager={{ type: "localStorage", get: () => "dark", set: () => undefined }}>
    <AppPreferencesProvider initialPreferences={defaultAppPreferences}>
    <EffectsPanel
      isOpen
      showOpenButton={false}
      shell={{ heightPx: 420, onHeightPreview: () => undefined, onHeightCommit: () => undefined }}
      selectedFXTarget={trackId}
      tracks={[track]}
      sidechainRoutes={[]}
      onClose={() => undefined}
      onOpen={() => undefined}
      clipTab={{ canOpen: false, onOpen: () => undefined }}
      audioEngine={engine}
      projectId={activeProject()}
      projectGeneration={generation}
      usesLegacyAudioEngine={() => engineMode === "legacy"}
      canWriteTrackRouting={canWrite}
      onEffectInstanceParamsReplayChange={(next) => { replay = next; }}
      onExportSnapshotChange={(snapshot) => { exportSnapshot = snapshot; }}
      onManualAutomationOverride={() => { counters.automationOverrides++; }}
      allocateProcessorEdit={(payload) => { registryAllocations++; return edits.allocate(payload); }}
      onEffectParamsCommitted={(payload, _projectId, options) => { counters.historyEntries++; if (options?.mergeHistory === false) counters.historyMergeFalse++; if (topLevelDisabled(payload.to)) counters.historyDisabled++; if (topLevelDisabled(payload.from)) counters.historyFromDisabled++; }}
      deliverProcessor={(edit, gesture) => {
        if (gesture?.holds) counters.nativePreview++; else counters.nativeFlush++;
        if (edit.target.kindId === 18 && gesture?.holds) counters.instrumentPreviewCallbacks++;
        nativeSubmitted(edit.content.params);
        return observeRegistration(nativeControl.deliverProcessor(edit, gesture));
      }}
      joinPublication={(join) => {
        counters.nativeJoin++;
        nativeSubmitted(join.contentKey);
        return observeRegistration(nativeControl.joinPublication(join));
      }}
      // Same outcome as the panel's default (no prepared portable session answers), counted.
      applyPortableProcessor={() => { counters.portableSession++; return Promise.resolve(undefined); }}
      onStructuralPlaybackChange={() => { counters.structuralChanges++; return Promise.resolve(); }}
      onEffectError={(title, message) => { counters.effectErrors++; pageErrors.push(`effect-error:${title}:${message}`); }}
      samplerBufferSync={samplerBufferSync}
      drumRackBufferSync={drumRackBufferSync}
      spectrumProvider={(_targetId, listener) => { spectrumListeners.add(listener); return () => { spectrumListeners.delete(listener); }; }}
    />
    </AppPreferencesProvider>
    </ColorModeProvider>
  ), document.body);
  const card = await waitFor(() => findCard(device), `${device} card`);
  mounted = {
    device, engineMode, projectId, trackId, card, seed, instanceId, setCanWrite, replay: () => replay,
    flush: async () => { await exportSnapshot?.flushPending(); },
    projection: () => exportSnapshot?.snapshotEffectsProjection(),
    switchProject: (next) => setActiveProject(next),
    bumpGeneration: () => setGeneration((value) => value + 1),
    storedBefore: "", dispose, sessionDispose: session.dispose,
  };
  await renderTurn();
  await settle();
  await flushVirtualTime();
  mounted.storedBefore = await storedSnapshot(projectId);
  mountNodeConstructions = counters.nodeConstructions;
  resetCounters();
  return mounted;
};

const slider = (card: Element) => card.querySelector<HTMLElement>('[role="slider"]:not([aria-disabled="true"])');
const centerOf = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};
const pointer = (type: string, x: number, y: number, pointerId = 1) => new PointerEvent(type, {
  bubbles: true, cancelable: true, composed: true, pointerId, pointerType: "mouse", isPrimary: true,
  clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1,
});
const key = (type: "keydown" | "keyup", name: string, repeat = false) => new KeyboardEvent(type, {
  key: name, bubbles: true, cancelable: true, repeat,
});
const range = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

type Input = () => void;
type Plan = {
  control: Element;
  phases: Input[][];
  // Index of the phase holding an external change; the engine-held value and projection are sampled right after it.
  externalPhase?: number;
  // Armed before the first phase and undone after the last, for the rows that hold or fail engine work.
  setup?: () => void;
  teardown?: () => void;
  // Extra measurements taken after the phases, before the row settles (it may release held work itself).
  finalize?: () => Promise<RowExtra>;
};
type StageRecord = { events: string[]; persistenceWrites: number; historyEntries: number; held: string | null };
// What a lifecycle row measures beyond the common fields; each row fills its own.
type RowExtra = {
  heldAtStart?: string | null;
  stages?: Record<string, StageRecord | boolean>;
  committedParams?: string;
  defaultParams?: string;
  dispatchesAfterFlush?: number;
  valueAtFlush?: string | null;
  valueAfterLaterTicks?: string | null;
  writesWhileTerminalHeld?: number;
  writesAfterFlushWhileHeld?: number;
  flushSettledWhileTerminalHeld?: boolean;
};
// The engine-held value and projection read right after an external change, before any further input.
type AfterExternal = { engineHeldBeforeExternal?: string | null; engineHeldAfterExternal?: string | null; projectionAfterExternal?: string };
const isSkip = (plan: Plan | string): plan is string => z.string().safeParse(plan).success;

// Each phase is one frame of input. "per-frame" spreads repeated events one per frame; "burst" puts the
// whole repeated run inside a single frame.
const spread = (before: Input[], repeated: Input[], after: Input[], cadence: Cadence) => [
  ...before.map((input) => [input]),
  ...(cadence === "burst" ? [repeated] : repeated.map((input) => [input])),
  ...after.map((input) => [input]),
];

const buildPlan = (current: Mounted, gesture: string, cadence: Cadence): Plan | string => {
  const card = current.card;
  const moves = range(20);
  // `captor` receives the moves and the release: a browser retargets them to the element holding pointer capture.
  const dragPlan = (control: Element, dx: number, dy: number, captor: Element = control): Plan => {
    const { x, y } = centerOf(control);
    return {
      control,
      phases: spread(
        [() => control.dispatchEvent(pointer("pointerdown", x, y))],
        moves.map((step) => () => captor.dispatchEvent(pointer("pointermove", x + dx * step, y + dy * step))),
        [() => captor.dispatchEvent(pointer("pointerup", x + dx * 20, y + dy * 20))],
        cadence,
      ),
    };
  };
  const target = graphHandles.get(gesture);
  if (target) {
    if (target.device !== current.device) return `no ${gesture} on ${current.device}`;
    const handle = card.querySelector(`button[aria-label="${target.label}"]`);
    return handle?.parentElement ? dragPlan(handle, 2, 0, handle.parentElement) : `handle "${target.label}" not rendered`;
  }
  if (gesture === "graph-drag-eq-band") {
    const canvas = card.querySelector("canvas");
    if (current.device !== "eq" || !canvas) return "no EQ canvas";
    const bands = normalizeEqParams(AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams()).bands;
    const band = bands.find((entry) => entry.enabled && /bell|peak|shelf/iu.test(entry.type)) ?? bands[0];
    if (!band) return "no EQ band";
    const rect = canvas.getBoundingClientRect();
    const logMin = Math.log10(EQ_FREQUENCY_MIN);
    const logMax = Math.log10(EQ_FREQUENCY_MAX);
    const t = (Math.log10(band.frequency) - logMin) / (logMax - logMin);
    const x = rect.left + (6 + t * (rect.width - 12));
    const gainT = (EQ_GAIN_DB_MAX - band.gainDb) / (EQ_GAIN_DB_MAX - EQ_GAIN_DB_MIN);
    const y = rect.top + (18 + gainT * (rect.height - 36));
    return {
      control: canvas,
      phases: spread(
        [() => canvas.dispatchEvent(pointer("pointerdown", x, y))],
        moves.map((step) => () => canvas.dispatchEvent(pointer("pointermove", x + 3 * step, y - step))),
        [() => canvas.dispatchEvent(pointer("pointerup", x + 60, y - 20))],
        cadence,
      ),
    };
  }
  const control = slider(card);
  if (["pointer-drag-20", "wheel-20", "key-hold-20", "double-click-reset", "drag-escape", "key-hold-blur", "wheel-20-idle", ...midGestures, ...lifecycleRows, "two-knobs-same-instance", "drag-plus-wheel"].includes(gesture) && !control) {
    return "no enabled Knob or value strip in this device";
  }
  if (gesture === "pointer-drag-20" && control) return dragPlan(control, 0, -3);
  if (gesture === "wheel-20" && control) {
    const wheel = () => control.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    return { control, phases: cadence === "burst" ? [moves.map(() => wheel)] : moves.map(() => [wheel]) };
  }
  if (gesture === "key-hold-20" && control) {
    return {
      control,
      phases: spread(
        [() => { control.focus(); control.dispatchEvent(key("keydown", "ArrowUp")); }],
        moves.slice(1).map(() => () => control.dispatchEvent(key("keydown", "ArrowUp", true))),
        [() => control.dispatchEvent(key("keyup", "ArrowUp"))],
        cadence,
      ),
    };
  }
  if (gesture === "drag-escape" && control) {
    const plan = dragPlan(control, 0, -3);
    const escape = () => control.dispatchEvent(key("keydown", "Escape"));
    const [down, ...rest] = plan.phases;
    const release = rest.pop();
    return { control, phases: [...(down ? [down] : []), ...rest.slice(0, 10), [escape], ...(release ? [release] : [])] };
  }
  if (midGestures.includes(gesture) && control) {
    const plan = dragPlan(control, 0, -3);
    const [down, ...rest] = plan.phases;
    const release = rest.pop();
    const effectOnly = current.instanceId === undefined && !isInstrument(current.device) ? `${gesture} needs a built-in effect instance` : isInstrument(current.device) && current.device !== "synth" ? `${gesture} needs a synth row write` : null;
    // An instrument undo is a row write the owner ingests (the direct engine write of undo/exec.ts is a recorded follow-up).
    const undoneRow = () => {
      if (isInstrument(current.device)) {
        if (current.device === "synth" && current.seed.family === "instrument" && current.seed.params.kind === "synth") void setLocalEffect(current.projectId, current.trackId, "instrument", { ...current.seed.params, params: { ...INSTRUMENT_CONTRACTS.synth.createDefaultParams(), gain: 0.33 } });
        return;
      }
      const replay = current.replay();
      if (replay && current.instanceId !== undefined && isEffectKind(current.device) && current.seed.family === "effect" && "enabled" in current.seed.params) replay({ targetId: current.trackId, effect: current.device, instanceId: current.instanceId, params: { ...current.seed.params, enabled: false } });
    };
    // The engine-held value is read before the external change and again once its phase has settled, before any further input.
    const marked = (action: () => void) => () => {
      externalMark.before = heldNow(current);
      externalMark.pending = true;
      action();
    };
    const external = new Map<string, (() => void) | string>(Object.entries({
      "drag-flush-mid-gesture": () => { void current.flush(); },
      "drag-unmount-mid-gesture": () => { void unmount(); },
      "drag-permission-revoked": () => current.setCanWrite(false),
      "drag-remove-mid-gesture": marked(() => {
        void (isEffectKind(current.device)
          ? deleteLocalEffectInstance(current.projectId, current.trackId, current.device, current.instanceId ?? "")
          : deleteLocalEffect(current.projectId, current.trackId, current.device === "arpeggiator" ? "arp" : "instrument"));
      }),
      // The undo replays and the gesture is released with no further move: the held value must still be committed.
      "drag-undo-release-no-move": effectOnly ?? marked(undoneRow),
      "project-switch-mid-gesture": () => { switchedProject = `${current.projectId}:other`; current.switchProject(switchedProject); },
      "generation-bump-mid-gesture": () => current.bumpGeneration(),
      // The replayed value differs from the gesture's baseline, as an undo of an earlier edit does.
      "drag-undo-mid-gesture": effectOnly ?? marked(undoneRow),
      "drag-remote-echo-mid-gesture": effectOnly ?? marked(() => {
        // Another client writes a different field of the same row while this drag is open.
        if (isEffectKind(current.device) && current.seed.family === "effect" && "enabled" in current.seed.params) {
          void setLocalEffectInstance(current.projectId, current.trackId, current.device, { ...current.seed.params, enabled: false }, { instanceId: current.instanceId ?? "", index: 0 });
        } else if (current.device === "synth" && current.seed.family === "instrument" && current.seed.params.kind === "synth") {
          void setLocalEffect(current.projectId, current.trackId, "instrument", { ...current.seed.params, params: { ...INSTRUMENT_CONTRACTS.synth.createDefaultParams(), pan: 0.4 } });
        }
      }),
      "drag-unrelated-row-change-mid-gesture": current.instanceId === undefined ? `${gesture} needs a built-in effect instance` : marked(() => {
        void setLocalEffectInstance(current.projectId, current.trackId, "utility", AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams(), { instanceId: createAudioEffectInstanceId(), index: 1 });
      }),
    }));
    const action = external.get(gesture);
    if (!(action instanceof Function)) return action ?? `unknown gesture ${gesture}`;
    // These end with the release: nothing moves after the external change, so a lost latest value shows up as a missing commit.
    const noMoveAfter = ["drag-undo-release-no-move", "project-switch-mid-gesture", "generation-bump-mid-gesture"].includes(gesture);
    const before = [...(down ? [down] : []), ...rest.slice(0, 10)];
    const sampled = ["drag-undo-mid-gesture", "drag-undo-release-no-move", "drag-remote-echo-mid-gesture", "drag-unrelated-row-change-mid-gesture", "drag-remove-mid-gesture"].includes(gesture);
    return {
      control,
      // The project switch removes the card, so its release goes through the window listeners the drag registered.
      phases: [...before, [action], ...(noMoveAfter ? [] : rest.slice(10)), ...(gesture === "project-switch-mid-gesture" ? [[() => document.body.dispatchEvent(pointer("pointerup", centerOf(control).x, centerOf(control).y - 30))]] : release ? [release] : [])],
      externalPhase: sampled ? before.length : undefined,
    };
  }
  if (["failed-terminal-apply", "generation-bump-queued-preview", "remote-removal-after-release", "reset-after-release", "stale-holder-tick-after-flush"].includes(gesture) && control) {
    const dragOnce = dragPlan(control, 0, -3).phases;
    const { x, y } = centerOf(control);
    const move = (step: number) => () => control.dispatchEvent(pointer("pointermove", x, y - 3 * step));
    let release: () => void = () => undefined;
    const hold = () => { faults.hold = new Promise<void>((resolve) => { release = resolve; }); };
    const unhold = () => { faults.hold = undefined; release(); };
    const instrumentRow = isInstrument(current.device) && current.device !== "arpeggiator";
    const seedParamsJson = JSON.stringify(current.seed.family === "instrument" ? current.seed.params.params : current.seed.params);
    if (gesture === "failed-terminal-apply") {
      if (!instrumentRow || current.engineMode !== "legacy" || (current.device !== "drum-rack" && current.device !== "synth")) return "legacy drum rack and synth only: the final apply is what fails";
      const heldAtStart = heldNow(current) ?? null;
      const stages: Record<string, StageRecord | boolean> = {};
      const stage = (name: string) => { stages[name] = { events: [...events], persistenceWrites: counters.persistenceWrites, historyEntries: counters.historyEntries, held: heldNow(current) ?? null }; };
      const flushRejects = (name: string) => () => { void current.flush().then(() => { stages[`${name}Rejected`] = false; }, () => { stages[`${name}Rejected`] = true; }); };
      // The first frame lands a preview. The later moves, the armed failure and the release share one frame: the release cancels
      // that frame's preview job, so the failing apply is the final one and the engine already holds the earlier preview.
      const failingDrag: Input[][] = [dragOnce[0] ?? [], range(5).map(move), [...range(20).slice(5).map((step) => move(step + 1)), () => { faults.failNextApply = true; }, () => control.dispatchEvent(pointer("pointerup", x, y - 60))]];
      return {
        control,
        phases: [...failingDrag, [flushRejects("first")], [() => stage("first")], ...dragOnce, [flushRejects("second")]],
        teardown: () => { faults.failNextApply = false; },
        finalize: async () => { await settle(); stage("second"); return { heldAtStart, stages }; },
      };
    }
    if (gesture === "generation-bump-queued-preview") {
      if (!instrumentRow || current.engineMode !== "legacy" || current.device !== "drum-rack") return "legacy drum rack only: its apply is the held asynchronous one";
      // Preview 1's apply is held, preview 2 queues behind it, then the generation moves: nothing of value 2 may reach the engine.
      return {
        control,
        phases: [dragOnce[0] ?? [], range(5).map(move), range(10).slice(5).map((step) => move(step + 1)), [() => current.bumpGeneration()], [() => document.body.dispatchEvent(pointer("pointerup", x, y - 60))]],
        setup: hold,
        teardown: unhold,
        finalize: async () => ({ committedParams: seedParamsJson }),
      };
    }
    if (gesture === "remote-removal-after-release") {
      const applicable = (instrumentRow && ((current.device === "synth" && current.engineMode === "native") || (current.device === "drum-rack" && current.engineMode === "legacy"))) || (current.device === "compressor" && current.engineMode === "native");
      if (!applicable) return "held-terminal rows only: synth native, drum rack legacy, compressor native";
      // The release is held in its apply or flush; the row is removed before it can persist.
      const removeRow = () => {
        void (isEffectKind(current.device)
          ? deleteLocalEffectInstance(current.projectId, current.trackId, current.device, current.instanceId ?? "")
          : deleteLocalEffect(current.projectId, current.trackId, "instrument"));
      };
      return { control, phases: [...dragOnce, [removeRow]], setup: hold, teardown: unhold };
    }
    if (gesture === "reset-after-release") {
      if (!(current.device === "synth" || current.device === "compressor")) return "synth and compressor only";
      const defaults = current.device === "synth" ? INSTRUMENT_CONTRACTS.synth.createDefaultParams() : AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams();
      return {
        control,
        phases: [...dragOnce, [() => control.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }))]],
        finalize: async () => ({ defaultParams: JSON.stringify(defaults) }),
      };
    }
    // The flush closes the control's holder; every later move through it must be dropped, not turned into a write.
    if (!(current.device === "synth" || current.device === "compressor")) return "synth and compressor only";
    let atFlush = 0;
    let valueAtFlush: string | null = null;
    return {
      control,
      phases: [dragOnce[0] ?? [], range(5).map(move), [() => { void current.flush(); }], [() => { atFlush = dispatches(); valueAtFlush = readValue(control); }], range(10).slice(5).map((step) => move(step + 1))],
      finalize: async () => ({ dispatchesAfterFlush: dispatches() - atFlush, valueAtFlush, valueAfterLaterTicks: readValue(control) }),
    };
  }
  if (gesture === "wheel-escape-idle" && control) {
    const wheel = () => control.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    return { control, phases: [moves.slice(0, 10).map(() => wheel), [() => control.dispatchEvent(key("keydown", "Escape"))], [() => advanceVirtualTime(400)]] };
  }
  if (gesture === "two-drags-pointercancel-then-move") {
    const [first, second] = [...card.querySelectorAll<HTMLElement>('[role="slider"]:not([aria-disabled="true"])')];
    if (!first || !second) return "needs two enabled knobs";
    const a = centerOf(first);
    const b = centerOf(second);
    const half = range(5);
    // Pointer 2 is cancelled alone: the whole shared gesture closes, and pointer 1 (still dragging) must drop its next moves.
    return {
      control: first,
      phases: [
        [() => first.dispatchEvent(pointer("pointerdown", a.x, a.y))],
        half.map((step) => () => first.dispatchEvent(pointer("pointermove", a.x, a.y - 3 * step))),
        [() => second.dispatchEvent(pointer("pointerdown", b.x, b.y, 2))],
        half.map((step) => () => second.dispatchEvent(pointer("pointermove", b.x, b.y - 3 * step, 2))),
        [() => second.dispatchEvent(pointer("pointercancel", b.x, b.y - 15, 2))],
        half.map((step) => () => first.dispatchEvent(pointer("pointermove", a.x, a.y - 15 - 3 * step))),
        [() => first.dispatchEvent(pointer("pointerup", a.x, a.y - 30))],
        [() => advanceVirtualTime(400)],
      ],
    };
  }
  if (["two-releases-slow-apply", "failed-preview-release", "flush-awaits-terminal"].includes(gesture) && control) {
    const dragOnce = dragPlan(control, 0, -3).phases;
    let release: () => void = () => undefined;
    const hold = () => { faults.hold = new Promise<void>((resolve) => { release = resolve; }); };
    const unhold = () => { faults.hold = undefined; release(); };
    if (gesture === "failed-preview-release") {
      if (!isInstrument(current.device)) return "an effect has no separately failing preview apply";
      if (current.engineMode === "native") return "the legacy engine apply is what this row fails";
      // The failure is armed just before the last move, so the final preview is the one that fails.
      const armBeforeLastMove = [...dragOnce.slice(0, -2), [() => { faults.failNextApply = true; }], ...dragOnce.slice(-2)];
      return { control, phases: armBeforeLastMove, teardown: () => { faults.failNextApply = false; } };
    }
    if (!isInstrument(current.device) || current.device === "arpeggiator") return "instrument rows only";
    if (gesture === "flush-awaits-terminal" && current.engineMode !== "native" && current.device !== "drum-rack") return "the legacy synth applies synchronously, so no terminal can be held";
    if (gesture === "two-releases-slow-apply") {
      // Two gestures are released before the first terminal finished: each must keep its own write and history entry.
      // The marker orders the second gesture's engine events against the first release's persistence.
      return { control, phases: [...dragOnce, [() => { events.push("gesture:2"); }], ...dragOnce], setup: hold, teardown: unhold };
    }
    return {
      control,
      phases: dragOnce,
      setup: hold,
      finalize: async () => {
        await settle();
        const writesWhileTerminalHeld = counters.persistenceWrites;
        let flushSettled = false;
        const flushing = current.flush().then(() => { flushSettled = true; });
        await settle();
        const settledWhileHeld = flushSettled;
        const writesAfterFlushWhileHeld = counters.persistenceWrites;
        unhold();
        await flushing;
        return { writesWhileTerminalHeld, writesAfterFlushWhileHeld, flushSettledWhileTerminalHeld: settledWhileHeld };
      },
    };
  }
  if (gesture === "two-knobs-same-instance" || gesture === "drag-plus-wheel") {
    const [first, second] = [...card.querySelectorAll<HTMLElement>('[role="slider"]:not([aria-disabled="true"])')];
    if (!first || !second) return "needs two enabled knobs";
    const a = centerOf(first);
    const b = centerOf(second);
    const wheel = () => second.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    const moveA = (step: number) => () => first.dispatchEvent(pointer("pointermove", a.x, a.y - 3 * step));
    const moveB = (step: number) => () => second.dispatchEvent(pointer("pointermove", b.x, b.y - 3 * step, 2));
    const half = range(5);
    if (gesture === "drag-plus-wheel") {
      return { control: first, phases: [[() => first.dispatchEvent(pointer("pointerdown", a.x, a.y))], half.map(moveA), half.map(() => wheel), half.map(moveA), [() => first.dispatchEvent(pointer("pointerup", a.x, a.y - 60))], [() => advanceVirtualTime(400)]] };
    }
    return { control: first, phases: [[() => first.dispatchEvent(pointer("pointerdown", a.x, a.y))], half.map(moveA), [() => second.dispatchEvent(pointer("pointerdown", b.x, b.y, 2))], half.map(moveB), [() => second.dispatchEvent(pointer("pointerup", b.x, b.y - 30, 2))], half.map(moveA), [() => first.dispatchEvent(pointer("pointerup", a.x, a.y - 60))]] };
  }
  if (gesture === "graph-key-hold-20") {
    const label = current.device === "delay" ? "Delay low cut frequency" : current.device === "reverb" ? "Low cut frequency" : undefined;
    const handle = label ? card.querySelector<HTMLElement>(`button[aria-label="${label}"]`) : null;
    if (!handle) return `no graph handle on ${current.device}`;
    return {
      control: handle,
      phases: spread(
        [() => { handle.focus(); handle.dispatchEvent(key("keydown", "ArrowRight")); }],
        moves.slice(1).map(() => () => handle.dispatchEvent(key("keydown", "ArrowRight", true))),
        [() => handle.dispatchEvent(key("keyup", "ArrowRight"))],
        cadence,
      ),
    };
  }
  if (gesture === "typed-empty" || gesture === "typed-minus-12" || gesture === "typed-16") {
    const input = card.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input) return "no number input in this device";
    const text = gesture === "typed-empty" ? "" : gesture === "typed-16" ? "16" : "-12";
    return { control: input, phases: [[() => { input.value = text; input.dispatchEvent(new Event("change", { bubbles: true })); }]] };
  }
  if (gesture === "key-hold-blur" && control) {
    return {
      control,
      phases: spread(
        [() => { control.focus(); control.dispatchEvent(key("keydown", "ArrowUp")); }],
        moves.slice(1).map(() => () => control.dispatchEvent(key("keydown", "ArrowUp", true))),
        [() => { if (control instanceof HTMLElement) control.blur(); }],
        cadence,
      ),
    };
  }
  if (gesture === "wheel-20-idle" && control) {
    const wheel = () => control.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    // The idle backstop is a 150 ms virtual timer: advancing 400 ms after the burst must close the gesture.
    return { control, phases: [moves.map(() => wheel), [() => advanceVirtualTime(400)]] };
  }
  if (gesture === "double-click-reset" && control) {
    return { control, phases: [[() => control.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }))]] };
  }
  if (gesture === "toggle-or-select") {
    const select = card.querySelector("select");
    const next = select && [...select.options].find((option) => option.value !== select.value);
    if (select && next) {
      return { control: select, phases: [[() => { select.value = next.value; select.dispatchEvent(new Event("change", { bubbles: true })); }]] };
    }
    const toggle = isEffectKind(current.device)
      ? card.querySelector<HTMLElement>('button[title^="Disable "]')
      : [...card.querySelectorAll<HTMLElement>("button")].find((button) => button.textContent?.trim() === "Down");
    return toggle ? { control: toggle, phases: [[() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))]] } : "no toggle or select found";
  }
  return `unknown gesture ${gesture}`;
};

const readValue = (control: Element) => control.getAttribute("aria-valuenow") ?? (control instanceof HTMLButtonElement && control.style.left ? `${control.style.left},${control.style.top}` : null) ?? (control instanceof HTMLSelectElement || control instanceof HTMLInputElement ? control.value : null);

const storedSnapshot = async (projectId: string) => JSON.stringify(
  (await listLocalEffects(projectId)).map((row) => [row.id, row.params]).sort(([left], [right]) => String(left).localeCompare(String(right))),
);

type Inapplicable = { applicable: false; layer: "dom"; reason: string };
const inapplicable = <Base extends object>(base: Base, reason: string): Base & Inapplicable => ({ ...base, applicable: false, layer: "dom", reason });
type ApplicableInDom = { applicable: true; layer: "dom" };
const applicableInDom: ApplicableInDom = { applicable: true, layer: "dom" };

const finish = async (current: Mounted, measure: Measure, control: Element, valueBefore: string | null, series: FrameSeries) => {
  await settle();
  await flushVirtualTime();
  const storedAfter = await storedSnapshot(current.projectId);
  return {
    ...measure,
    persistedParamsChanged: storedAfter !== current.storedBefore,
    ...applicableInDom,
    control: control.getAttribute("aria-label") ?? control.tagName.toLowerCase(),
    controlValueBefore: valueBefore,
    controlValueAfter: readValue(control),
    inputFrames: series.all.length,
    persistenceWrites: counters.persistenceWrites,
    historyEntries: counters.historyEntries,
    historyMergeFalse: counters.historyMergeFalse,
    historyDisabled: counters.historyDisabled,
    historyFromDisabled: counters.historyFromDisabled,
    legacyEngineSubmits: counters.legacyEngineSubmits,
    legacyMasterSubmits: counters.legacyMasterSubmits,
    legacySingleInstanceSubmits: counters.legacySingleInstanceSubmits,
    reconcileClears: isInstrument(current.device) ? counters.reconcileClears : null,
    reconcileRuns: counters.reconcileRuns,
    instrumentClears: counters.instrumentClears,
    sidechainPublishes: counters.sidechainPublishes,
    sampleBufferSyncs: counters.sampleBufferSyncs,
    projectionChanges: counters.projectionChanges,
    automationOverrides: counters.automationOverrides,
    legacySubmitCallers: Object.fromEntries([...submitCallers].sort(([left], [right]) => left.localeCompare(right))),
    nodeConstructionsDuringMount: mountNodeConstructions,
    legacyNodeConstructions: counters.nodeConstructions,
    legacyNodeConstructionsByType: Object.fromEntries([...nodeTypes].sort(([left], [right]) => left.localeCompare(right))),
    nativePreviewCalls: counters.nativePreview,
    nativeFlushCalls: counters.nativeFlush,
    nativeJoinCalls: counters.nativeJoin,
    portableSessionCalls: counters.portableSession,
    instrumentEngineCalls: isInstrument(current.device) ? counters.instrumentEngineCalls : null,
    portableBoundaries: Object.fromEntries([...boundaryCounts].sort(([left], [right]) => left.localeCompare(right)).map(([name, count]) => [name, { ...count }])),
    nativeSubmitted: counters.nativeSubmitted,
    nativeOutcomes: { ...nativeOutcomes },
    nativeSubmissions: [...nativeSubmissions],
    instrumentPreviewCallbacks: isInstrument(current.device) ? counters.instrumentPreviewCallbacks : null,
    structuralPlaybackChanges: counters.structuralChanges,
    maxDispatchesPerFrame: Math.max(0, ...series.all),
    maxPortableDispatchesPerFrame: Math.max(0, ...series.portable),
    maxNativeDispatchesPerFrame: Math.max(0, ...series.native),
    maxPortableSessionDispatchesPerFrame: Math.max(0, ...series.portableSession),
    dispatchesPerFrame: series.all,
    effectErrors: counters.effectErrors,
    pageErrors: [...pageErrors],
  };
};

const measureGesture = async (measure: Measure) => {
  let current: Mounted;
  try {
    current = await mount(measure.device, measure.engine);
  } catch (error) {
    return inapplicable(measure, `mount failed: ${String(error)}`.slice(0, 700));
  }
  const plan = buildPlan(current, measure.gesture, measure.cadence);
  if (isSkip(plan)) return inapplicable(measure, plan);
  if (measure.gesture === "double-click-reset") {
    // Reset only does work from a non-default value: take one key step first, then measure the reset alone.
    plan.control.dispatchEvent(key("keydown", "ArrowUp"));
    plan.control.dispatchEvent(key("keyup", "ArrowUp"));
    await settle();
    await flushVirtualTime();
    current.storedBefore = await storedSnapshot(current.projectId);
    resetCounters();
  }
  const valueBefore = readValue(plan.control);
  const series: FrameSeries = { all: [], portable: [], native: [], portableSession: [] };
  plan.setup?.();
  let lastProjection = stableJson(current.projection());
  const afterExternal: AfterExternal = {};
  for (const [index, phase] of plan.phases.entries()) {
    const before = frameCounts();
    for (const input of phase) input();
    await settle();
    stepFrame();
    await settle();
    const after = frameCounts();
    series.all.push(after.all - before.all);
    series.portable.push(after.portable - before.portable);
    series.native.push(after.native - before.native);
    series.portableSession.push(after.portableSession - before.portableSession);
    const projection = stableJson(current.projection());
    if (projection !== lastProjection) counters.projectionChanges++;
    lastProjection = projection;
    if (index === plan.externalPhase) {
      // Read before any further input: the engine must already hold what the panel shows after the external change.
      afterExternal.engineHeldBeforeExternal = externalMark.before ?? null;
      afterExternal.engineHeldAfterExternal = heldNow(current) ?? null;
      afterExternal.projectionAfterExternal = anonymizeIds(projection);
    }
  }
  const extra = await plan.finalize?.();
  plan.teardown?.();
  const result = await finish(current, measure, plan.control, valueBefore, series);
  return {
    ...result,
    ...afterExternal,
    ...extra,
    engineHeldFinal: heldNow(current) ?? null,
    switchedProjectRows: switchedProject === undefined ? null : await storedSnapshot(switchedProject),
    events: [...events],
    heldAtPersist: [...heldAtPersist],
    appliedValues: measure.gesture === "generation-bump-queued-preview" ? [...appliedValues] : [],
  };
};

// Typed number entry uses Chromium's real keyboard: the runner types into the input prepared here.
let typed: { current: Mounted; measure: Measure; input: HTMLInputElement; valueBefore: string } | undefined;
type Prepared = { prepared: true };
const prepareTyped = async (measure: Measure) => {
  const current = await mount(measure.device, measure.engine);
  const input = current.card.querySelector<HTMLInputElement>('input[type="number"]');
  if (!input) return inapplicable(measure, "no number input in this device");
  input.focus();
  input.select();
  typed = { current, measure, input, valueBefore: input.value };
  const prepared: Prepared = { prepared: true };
  return prepared;
};
const finishTyped = async () => {
  if (!typed) throw new Error("No typed-number measurement is prepared.");
  const { current, measure, input, valueBefore } = typed;
  typed = undefined;
  // The count is read after the entry settles; read earlier, it raced the async engine work of the commit.
  await settle();
  await flushVirtualTime();
  const counts = frameCounts();
  const result = await finish(current, measure, input, valueBefore, { all: [counts.all], portable: [counts.portable], native: [counts.native], portableSession: [counts.portableSession] });
  // Sampler voices clamp to MAX_SAMPLED_INSTRUMENT_VOICES (32), the stored default, so the runner's 64 is a no-op: 0/0.
  return { ...result, typedEntry: measure.device === "sampler" ? "clamped-no-op" : "accepted" };
};

// DP-05: after one analyser frame the EQ runs a decay loop on requestAnimationFrame. Count its frame callbacks
// while the device is expanded and again while it is folded (EffectShell hides folded content but keeps it mounted).
const spectrumListeners = new Set<(frame: { data: Float32Array; sampleRate: number } | null) => void>();
const emitSpectrumFrame = () => {
  for (const listener of spectrumListeners) listener({ data: new Float32Array(512).fill(0.5), sampleRate: 48_000 });
};
const stepFrames = async (count: number) => {
  const start = frameCallbacksRun;
  let framesWithCallbacks = 0;
  for (let index = 0; index < count; index++) {
    const before = frameCallbacksRun;
    stepFrame();
    await settle();
    if (frameCallbacksRun > before) framesWithCallbacks++;
  }
  return { callbacks: frameCallbacksRun - start, framesWithCallbacks };
};
const measureCollapsedSpectrum = async (engineMode: EngineMode) => {
  const current = await mount("eq", engineMode);
  const frames = 240;
  await stepFrames(4);
  emitSpectrumFrame();
  const expanded = await stepFrames(frames);
  emitSpectrumFrame();
  const fold = current.card.querySelector<HTMLElement>('button[aria-label="Fold device"]');
  if (!fold) return inapplicable({ device: "eq", engine: engineMode, gesture: "collapsed-spectrum-decay", cadence: "single" }, "no Fold device button");
  fold.click();
  await renderTurn();
  await settle();
  const canvas = current.card.querySelector("canvas");
  const collapsedCanvasHidden = canvas ? canvas.closest("[hidden]") !== null || canvas.getClientRects().length === 0 : null;
  const collapsed = await stepFrames(frames);
  return {
    device: "eq", engine: engineMode, gesture: "collapsed-spectrum-decay", cadence: "single", ...applicableInDom,
    framesStepped: frames,
    expandedFrameCallbacks: expanded.callbacks,
    expandedFramesWithCallbacks: expanded.framesWithCallbacks,
    collapsedFrameCallbacks: collapsed.callbacks,
    collapsedFramesWithCallbacks: collapsed.framesWithCallbacks,
    eqCanvasStillMountedWhileCollapsed: canvas !== null,
    eqCanvasNotRenderedWhileCollapsed: collapsedCanvasHidden,
    persistenceWrites: counters.persistenceWrites,
    pageErrors: [...pageErrors],
  };
};

const repeated = ["pointer-drag-20", "wheel-20", "key-hold-20"];
// Lifecycle witnesses (DV-01 phase 2): one cadence, run on a representative subset to bound matrix time.
const lifecycle = ["drag-escape", "key-hold-blur", "wheel-20-idle", "two-knobs-same-instance", "drag-plus-wheel"];
const midGestures = ["drag-flush-mid-gesture", "drag-unmount-mid-gesture", "drag-permission-revoked", "drag-remove-mid-gesture", "drag-undo-mid-gesture", "drag-remote-echo-mid-gesture", "drag-unrelated-row-change-mid-gesture", "drag-undo-release-no-move", "project-switch-mid-gesture", "generation-bump-mid-gesture"];
// The sampler has no draggable control, so the asynchronous sampled-instrument apply is witnessed through the drum rack, which has the same buffer-sync apply and real knobs.
const lifecycleDevices: readonly Device[] = ["compressor", "delay", "eq", "synth", "drum-rack"];
// Lifecycle rows: each guards one guarantee of the shared gesture owner (round 2, then round 3).
const lifecycleRows = [
  "wheel-escape-idle", "two-drags-pointercancel-then-move", "two-releases-slow-apply", "failed-preview-release", "flush-awaits-terminal",
  "failed-terminal-apply", "generation-bump-queued-preview", "remote-removal-after-release", "reset-after-release", "stale-holder-tick-after-flush",
];
const singles = ["double-click-reset", "toggle-or-select"];
const graphGestures = ["graph-drag-delay-filter", "graph-drag-reverb-filter", "graph-drag-reverb-space", "graph-drag-eq-band"];
const records: unknown[] = [];
let matrixDone = false;
const runMatrix = async (engineMode: EngineMode, only: readonly string[]) => {
  matrixDone = false;
  const devices: Device[] = [...Object.keys(AUDIO_EFFECT_CONTRACTS).filter(isEffectKind), ...instrumentDevices]
    .filter((device) => only.length === 0 || only.includes(device));
  for (const device of devices) {
    for (const gesture of [...repeated, ...singles, ...graphGestures]) {
      if (gesture.startsWith("graph-drag") && !(device === "eq" ? gesture === "graph-drag-eq-band" : device === "delay" || device === "reverb")) continue;
      for (const cadence of repeated.includes(gesture) || gesture.startsWith("graph-drag") ? ["per-frame", "burst"] as const : ["single"] as const) {
        records.push(await measureGesture({ device, engine: engineMode, gesture, cadence }));
      }
    }
    if (lifecycleDevices.includes(device)) {
      for (const gesture of [...lifecycle, ...midGestures, ...lifecycleRows]) records.push(await measureGesture({ device, engine: engineMode, gesture, cadence: "single" }));
    }
    if (device === "delay" || device === "reverb") {
      for (const cadence of ["per-frame", "burst"] as const) records.push(await measureGesture({ device, engine: engineMode, gesture: "graph-key-hold-20", cadence }));
    }
    if (device === "sampler" || device === "granular") {
      for (const gesture of ["typed-empty", "typed-minus-12", ...(device === "sampler" ? ["typed-16"] : [])]) records.push(await measureGesture({ device, engine: engineMode, gesture, cadence: "single" }));
    }
    if (device === "eq") records.push(await measureCollapsedSpectrum(engineMode));
  }
  matrixDone = true;
};

// Round-2 rows only (failure-first and quick re-runs): the lifecycle guarantees on a small device set.
const runLifecycle = async (engineMode: EngineMode, only: readonly string[]) => {
  matrixDone = false;
  const rows = ["drag-undo-release-no-move", "drag-undo-mid-gesture", "drag-remove-mid-gesture", "drag-remote-echo-mid-gesture", "project-switch-mid-gesture", "generation-bump-mid-gesture", ...lifecycleRows, "double-click-reset", "pointer-drag-20"];
  for (const device of lifecycleDevices.filter((candidate) => only.length === 0 || only.includes(candidate))) {
    for (const gesture of rows) {
      records.push(await measureGesture({ device, engine: engineMode, gesture, cadence: gesture === "pointer-drag-20" ? "per-frame" : "single" }));
    }
  }
  matrixDone = true;
};

// A8 isolates the panel's engine boundary from the all-track reconcile. Setup is outside the window;
// every tick is awaited before the next one, so a join cannot hide a suppressed equal-content close.
const runA8 = async () => {
  await unmount();
  const rows = [];
  for (const ticks of [3, 20]) {
    for (const targetId of ["a8-track", "master"]) {
      const projectId = `project:a8-${ticks}-${targetId}`;
      const instanceId = `audio-effect:a8-${ticks}-${targetId}`;
      const initial = AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams();
      await setLocalEffectInstance(projectId, targetId, "compressor", initial, { instanceId });
      const instance = { id: instanceId, kind: "compressor", params: initial } satisfies Parameters<AudioEngine["setTrackFxInstances"]>[1][number];
      if (targetId === "master") await engine.setMasterFxInstances([instance]);
      else await engine.setTrackFxInstances(targetId, [instance]);
      let dispose = () => {};
      const state = createRoot((end) => {
        dispose = end;
        return createEffectsPanelAudioDevice({
          audioEngine: () => engine, projectId: () => projectId, userId: () => undefined,
          roomEffects: () => [], canWriteCurrentTargetEffects: () => true,
        }, () => targetId, () => undefined);
      });
      await settle();
      resetCounters();
      const handle = state.gestureOwner(instanceId, "compressor");
      const holder = new ParameterGestureHolder();
      handle.open(holder);
      for (let tick = 1; tick <= ticks; tick++) {
        handle.tick(holder, () => state.compressor.changeInstance(instanceId, (params) => ({ ...params, thresholdDb: -20 - tick })));
        stepFrame();
        await settle();
      }
      handle.end(holder);
      await state.flushPending();
      await settle();
      const actual = boundaryCounts.get(targetId === "master" ? "master.instance" : "track.instance");
      const expected = { calls: ticks + 1, applications: ticks, skips: 1, joins: 0 };
      rows.push({
        name: `A8-audio-${targetId === "master" ? "master" : "track"}-${ticks}`,
        ticks, expected, actual: actual ? { ...actual } : null,
        status: actual?.calls === ticks + 1 && actual.applications === ticks && actual.skips === 1 && actual.joins === 0 ? "green" : "expected-red",
        failure: "equal final content is suppressed by the panel lane before the runtime can return skipped",
        flip: "3B-1 offers the logical close to the runtime: calls N+1, applications N, skips 1, joins 0",
      });
      dispose();
    }
    const projectId = `project:a8-synth-${ticks}`;
    const instrument = seedInstrument("synth");
    const trackId = `a8-synth-${ticks}`;
    engine.setTrackInstrument(trackId, { instrument });
    let dispose = () => {};
    const state = createRoot((end) => {
      dispose = end;
      return createPersistedEffectState<TrackInstrumentParams, TrackInstrumentParams>({
        targetId: () => trackId, row: () => instrument, readQueryParams: (row) => row,
        createInitialParams: () => instrument, serializeParams: stableJson,
        applyToEngine: (target, next) => engine.setTrackInstrument(target, { instrument: next }),
        persistParams: async (target, next) => parameterSaveResult(await setLocalEffect(projectId, target, "instrument", next)),
      });
    });
    await settle();
    resetCounters();
    const holder = new ParameterGestureHolder();
    state.gestureOwner.open(holder);
    for (let tick = 1; tick <= ticks; tick++) {
      state.gestureOwner.tick(holder, () => state.update((current) => current.kind === "synth"
        ? { ...current, params: { ...current.params, gain: 0.5 + tick / 100 } } : current));
      stepFrame();
      await settle();
    }
    state.gestureOwner.end(holder);
    await state.flushPending();
    await settle();
    const actual = boundaryCounts.get("instrument");
    rows.push({
      name: `A8-persisted-synth-${ticks}`, ticks,
      expected: { calls: ticks + 1, applications: ticks, skips: 1, joins: 0 },
      actual: actual ? { ...actual } : null,
      status: actual?.calls === ticks + 1 && actual.applications === ticks && actual.skips === 1 && actual.joins === 0 ? "green" : "expected-red",
      failure: "equal final content is suppressed by the panel lane before the synth runtime can return skipped",
      flip: "3B-1 offers the logical close to the synth runtime",
    });
    dispose();
    engine.clearTrackInstrument(trackId);
  }
  return rows;
};

const runPublicationCallbacks = async () => {
  const results = [];
  for (const device of ["sampler", "granular", "drum-rack"] satisfies Device[]) {
    const row = await measureGesture({ device, engine: "native", gesture: "toggle-or-select", cadence: "single" });
    await settle();
    results.push({ device, applicable: row.applicable, nativeSubmitted: counters.nativeSubmitted,
      outcomes: { ...nativeOutcomes }, consumerReads: registrationConsumers.map(consumer => consumer.reads),
      synthCallbacks: counters.instrumentPreviewCallbacks, registryAllocations });
  }
  await unmount();
  return results;
};

Object.assign(window, {
  costFixture: {
    runMatrix,
    runLifecycle,
    runA8,
    runPublicationCallbacks,
    devices: [...Object.keys(AUDIO_EFFECT_CONTRACTS), ...instrumentDevices],
    isDone: () => matrixDone,
    takeRecords: () => records.splice(0),
    measureGesture,
    prepareTyped,
    finishTyped,
    unmount,
    ready: true,
  },
});
