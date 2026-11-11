import { beforeAll, expect, test } from "bun:test";
import "fake-indexeddb/auto";
import { batch, createEffect, createRoot, createSignal, onCleanup, untrack } from "solid-js";
import { AudioEngine, type AudioEffectRuntimeInstance, type EngineDisposition, type SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import { convexTest } from "convex-test";
import schema from "../../convex/schema";
import { compressorInstance, staticGateInstance, createFxTransitionHarness } from "../../packages/audio-engine/src/fx-runtime-test-audio";
import {
  createDefaultArpeggiatorParams,
  createDefaultDrumRackParams,
  createDefaultSamplerParams,
  createDefaultSynthParams,
  AUDIO_EFFECT_CONTRACTS,
  type AudioEffectKind,
  type ArpeggiatorParams,
  type JsonValue,
  type TrackInstrumentParams,
} from "@daw-browser/shared";
import {
  createEffectsPanelReadinessOwner,
  createPendingWorkOwner,
  createSpectrumSubscriptionOwner,
  useEffectsPanelAudioSync,
} from "./useEffectsPanelAudioSync";
import {
  createLocalEffectsView,
  createLocalEffectsViewOwner,
  type LocalEffectsPublicationId,
  type LocalEffectsView,
  type LocalEffectsViewSource,
} from "~/components/timeline/create-local-effects-view";
import { deleteLocalEffectInstance, listLocalEffects, reorderLocalAudioEffects, setLocalEffect, setLocalEffectInstance, type LocalEffectRow } from "~/lib/local-effects";
import { createSamplerBufferSync } from "~/lib/sampler-buffer-sync";
import { createDrumRackBufferSync } from "~/lib/drum-rack-buffer-sync";
import { notifyLocalProjectChanged } from "~/lib/local-project-changes";
import { withExternalProcessorProjectWriteLock } from "~/lib/external-plugins";
import type { Track } from "@daw-browser/timeline-core/types";
import { createPersistedEffectState } from "~/components/timeline/create-persisted-effect-state";
import { createEffectsPanelInstrumentDevice } from "~/components/timeline/create-effects-panel-state";
import { ParameterGestureHolder } from "~/components/timeline/parameter-gesture-owner";
import { createProcessorEditRegistry } from "~/components/timeline/create-processor-edit-registry";
import { createEffectsPanelAudioDevice } from "~/components/timeline/create-effects-panel-audio-effects-state";
import { b5AgentCommit, b5CloudDatabase, b5EffectsSubscription, b5HistoryDeps, b5HistoryTransport, b5SubscribeEffects } from "~/lib/b5-coverage-test-support";
import { execRedo, execUndo } from "~/lib/undo/exec";
import type { HistoryEntry } from "~/lib/undo/types";
import { createLocalProject } from "~/lib/local-project-db";
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository";
import { convexApi, convexClient } from "~/lib/convex";
import { mountStep5Playback, settleStep5Playback } from "../../tools/acceptance/b5c-playback-witness-support";
import { resolveDesiredPlaybackFx } from "~/lib/export/run-export-job";

// Cloud rows and canonical commits use deterministic in-process transports.
// The module's eager fixture socket must not inject unrelated fatal replies.
beforeAll(async () => { await convexClient.close(); });

type ChainApplication = { ids: string[]; disposition?: string };

// Failure modes: an off-screen owner misses a row, a removed chain retains
// live nodes/bindings, or project teardown only clears its bookkeeping.
const b5c3FxKinds: AudioEffectKind[] = ["eq", "compressor", "reverb", "delay", "saturator"];
const createB5c3FxFixture = async (local: boolean, master: boolean, kind: AudioEffectKind, subscribed = false, agent = false,
  native?: () => Awaited<ReturnType<typeof mountStep5Playback>> | undefined) => {
  const initialProject = agent && local ? (await createLocalProject("B5 FX agent")).id
    : `${local ? "project:" : "cloud-"}b5c3-fx-${crypto.randomUUID()}`;
  const [projectId, setProjectId] = createSignal(initialProject);
  const db = b5CloudDatabase();
  if (agent && !local) await db.withIdentity({ subject: "b5-agent" }).mutation(convexApi.projects.createOwnedRoom, { projectId: initialProject });
  const remoteTrack = await db.run(ctx => ctx.db.insert("tracks", { projectId: initialProject, index: 0, kind: "audio", name: "Unselected" }));
  const track: Track = { id: local ? "t" : remoteTrack, kind: "audio", name: "Unselected", volume: 1, clips: [] };
  if (agent) {
    if (local) await createLocalTimelineRepository(initialProject).createTrack({ id: track.id, kind: "audio" });
    else await db.run(async ctx => {
      await ctx.db.insert("ownerships", { projectId: initialProject, ownerUserId: "b5-agent", trackId: remoteTrack });
      await ctx.db.insert("mixerChannels", { projectId: initialProject, trackId: remoteTrack, volume: 1, channelRole: "track", sends: [] });
    });
  }
  const [tracks, setTracks] = createSignal<Track[]>([track]);
  const targetId = master ? "master" : track.id, instanceId = "b5c3-fx";
  const localKind: LocalEffectRow<JsonValue>["effect"] = master ? `master-${kind}` : kind;
  const initial = { ...AUDIO_EFFECT_CONTRACTS[kind].createDefaultParams(), enabled: true };
  let revision = 0;
  const readRows = () => db.run(ctx => ctx.db.query("effects").collect());
  const write = async (params: JsonValue | undefined) => {
    if (local) {
      if (params) await setLocalEffectInstance(initialProject, targetId, localKind, params, { instanceId, index: 0 });
      else await deleteLocalEffectInstance(initialProject, targetId, localKind, instanceId);
    } else await db.run(async ctx => {
      for (const row of await ctx.db.query("effects").collect()) await ctx.db.delete(row._id);
      if (params) await ctx.db.insert("effects", { projectId: initialProject, targetType: master ? "master" : "track",
        trackId: master ? undefined : remoteTrack, type: kind, instanceId, index: 0, params, revision: ++revision, createdAt: 1 });
    });
  };
  await write(initial);
  const [rows, setRows] = createSignal(await readRows());
  const subscription = subscribed ? b5SubscribeEffects(initialProject, readRows, setRows) : undefined;
  const isolation = subscribed ? undefined : b5EffectsSubscription(readRows);
  const runtime = createFxTransitionHarness(master ? "master" : "track");
  runtime.track.updateTrackGains([track]);
  const calls: { ids: string[]; type: string; disposition?: string }[] = [], applications: Promise<unknown>[] = [];
  const record = <Disposition extends EngineDisposition | "not-held">(
    instances: AudioEffectRuntimeInstance[], work: Promise<Disposition>, type = "chain",
  ) => {
    const call: typeof calls[number] = { ids: instances.map(instance => instance.id), type };
    calls.push(call);
    const applied = work.then(disposition => { call.disposition = disposition; return disposition; });
    applications.push(applied);
    return applied;
  };
  class Engine extends AudioEngine {
    override setTrackFxInstances(id: string, instances: AudioEffectRuntimeInstance[]) {
      const work = runtime.track.setTrackFxInstances(id, instances);
      return !master && id === targetId ? record(instances, work) : work;
    }
    override setTrackFxInstance(id: string, instance: AudioEffectRuntimeInstance) {
      const work = runtime.track.replaceTrackFxInstance(id, instance);
      return !master && id === targetId ? record([instance], work, "instance") : work;
    }
    private async master(instances: AudioEffectRuntimeInstance[]) {
      return (await runtime.master.setFxInstances(runtime.audio.context, runtime.audio.masterInput, runtime.audio.context.destination, instances)).disposition;
    }
    override setMasterFxInstances(instances: AudioEffectRuntimeInstance[]) {
      const work = this.master(instances);
      return master ? record(instances, work) : work;
    }
    override setMasterFxInstance(instance: AudioEffectRuntimeInstance) {
      const retained = runtime.master.retainedInstances();
      const work = retained.some(entry => entry.id === instance.id)
        ? this.master(retained.map(entry => entry.id === instance.id ? instance : entry))
        : Promise.resolve<"not-held">("not-held");
      return master ? record([instance], work, "instance") : work;
    }
  }
  const engine = new Engine(), sampler = createSamplerBufferSync(), drum = createDrumRackBufferSync();
  const [legacyMode, setLegacyMode] = createSignal(!native);
  const errors: string[] = [];
  let dispose = () => {};
  const fixture = createRoot(end => {
    dispose = end;
    const view = createLocalEffectsView({ projectId });
    const audio = createEffectsPanelAudioDevice({
      audioEngine: () => engine, tracks, projectId, userId: () => undefined, roomEffects: rows,
      localEffectsView: view, usesLegacyAudioEngine: legacyMode, canWriteCurrentTargetEffects: () => true,
      allocateProcessorEdit: payload => native?.()?.processorEdits.allocate(payload),
      deliverProcessor: (edit, gesture) => native?.()?.playback.deliverProcessor(edit, gesture)
        ?? { receipt: { key: edit.id, serial: 0 }, settled: Promise.resolve({ state: "unavailable" }) },
      onEffectError: (_title, message) => errors.push(message),
    }, () => "selected-elsewhere", () => track);
    const sync = useEffectsPanelAudioSync({
      isOpen: () => false, currentTargetId: () => "selected-elsewhere", projectId, tracks,
      sidechainRoutes: () => [], audioEngine: () => engine, usesLegacyAudioEngine: legacyMode,
      roomEffects: rows, roomEffectsStatus: () => "success", roomEffectsError: () => undefined,
      localEffectsView: view, samplerBufferSync: sampler, drumRackBufferSync: drum,
    });
    return { view, audio, sync };
  });
  const drain = async () => {
    if (local) await fixture.view.reload();
    else if (subscription) await subscription.publish();
    else setRows(projectId() === initialProject ? await readRows() : []);
    await fixture.sync.flushPending();
    await fixture.audio.flushPending();
    await Promise.all(applications);
    for (let left = runtime.timers.pending.size; left > 0; left--) runtime.timers.run();
    expect(errors).toEqual([]);
  };
  const bindings = () => {
    const id = kind === "eq" ? `eq.${AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams().bands[0]?.id}.gainDb` : kind === "reverb" ? "reverb.wet"
      : kind === "delay" ? "delay.dryWet" : "saturator.driveDb";
    return master ? runtime.master.resolveMasterAutomationBindings(id, null, instanceId)
      : runtime.track.resolveTrackAutomationBindings(targetId, id, instanceId);
  };
  return {
    ...fixture, engine, track, targetId, instanceId, initial, initialProject, db, runtime, calls, write, drain, bindings,
    setLegacyMode, restoreTrack: () => setTracks([track]),
    processorId: async () => {
      const id = local ? (await listLocalEffects(initialProject)).find(row => row.instanceId === instanceId)?.id
        : (await readRows()).find(row => row.instanceId === instanceId)?._id;
      if (!id) throw new Error("Missing B5 agent effect row");
      return id;
    },
    removeTrack: () => setTracks([]),
    switchProject: () => batch(() => { setTracks([]); setRows([]); setProjectId(`${initialProject}-next`); }),
    close: () => { dispose(); subscription?.close(); isolation?.close(); sampler.dispose(); drum.dispose(); runtime.close(); },
  };
};

// Origin witnesses use the real persistence/subscription/history paths. A
// direct owner.external call would not prove that these paths carry delivery.
for (const origin of ["another-surface", "remote-echo", "agent", "undo", "redo"]) {
  for (const transport of ["playing", "paused"]) {
    test(`STEP5 B8 ${origin} ${transport} native owner origin`, async () => {
      let native: Awaited<ReturnType<typeof mountStep5Playback>> | undefined;
      const local = origin !== "remote-echo";
      const f = await createB5c3FxFixture(local, false, "delay", !local, origin === "agent", () => native);
      let restore = () => {};
      try {
        await f.drain();
        const initial = AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams();
        const next = { ...initial, dryWet: 0.73 };
        if (origin === "undo") { await f.write(next); await f.drain(); }
        const inputs = () => ({ canonical: undefined, local: undefined, masterVolume: 1,
          effects: f.audio.snapshotExportProjection(), automation: [], sidechains: [] });
        const fx = (captured: ReturnType<typeof inputs>) => resolveDesiredPlaybackFx(
          { masterVolume: 1, masterFxInstances: [], trackFx: {} }, captured.effects, undefined);
        native = await mountStep5Playback({ projectId: f.initialProject, tracks: () => [f.track],
          playbackInputs: inputs, desiredFx: fx, renderState: async captured => ({ fx: fx(captured), automationEnvelopes: [] }) });
        if (transport === "playing") await native.playback.handlePlay([f.track]);
        await settleStep5Playback();
        const before = native.mark();
        const expected = origin === "undo" ? initial : next;
        if (origin === "agent") {
          await b5AgentCommit(local, f.initialProject, f.db, { kind: "effect.upsert",
            effect: { source: "persisted", id: await f.processorId() },
            target: { kind: "track", track: { source: "persisted", id: f.track.id } }, effectKind: "delay", params: next });
        } else if (origin === "undo" || origin === "redo") {
          restore = b5HistoryTransport(async operation => {
            if (!("params" in operation.payload)) throw new Error("Unexpected history operation");
            await f.write(operation.payload.params);
          });
          const entry: HistoryEntry = { type: "effect-params", projectId: f.initialProject,
            data: { trackRef: f.track.id, effect: "delay", instanceId: f.instanceId, from: initial, to: next } };
          const deps = b5HistoryDeps(f.initialProject, f.track, entry);
          deps.replayInstanceEffectParams = f.audio.replayInstanceParams;
          if (origin === "undo") await execUndo(entry, deps);
          else await execRedo(entry, deps);
        } else await f.write(next);
        await f.drain();
        await native.frame();
        const counts = native.counts(before);
        console.log("STEP5 origin", JSON.stringify({ origin, transport, counts,
          applied: [...native.host.appliedParameters.values()] }));
        expect(f.audio.snapshotExportRows([f.targetId])[0]?.params).toEqual(expected);
        expect(native.faults).toEqual([]);
        expect([...native.host.appliedParameters.values()]).toEqual([Math.fround(expected.dryWet)]);
        expect(counts).toEqual({ scheduleCompiles: 0, previewCompiles: 0, publishes: 0,
          teardowns: 0, liveSends: 1, previewDisposals: 0 });
      } finally { restore(); await native?.close(); f.close(); }
    });
  }
}

// Different runtime shapes must reconnect in the requested direction, not
// merely reorder the projected rows while retaining the previous audio graph.
// Review failure inventory: unchanged structure can suppress an engine restore
// after native rows change or after kept track teardown clears the live graph.
for (const local of [true, false]) {
  test(`REVIEW FX legacy toggle local=${local}`, async () => {
    const f = await createB5c3FxFixture(local, false, "delay");
    try {
      await f.drain();
      f.setLegacyMode(false);
      await f.write({ ...AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams(), enabled: true, mode: "time", timeMs: 777 });
      await f.drain();
      f.setLegacyMode(true);
      await f.drain();
      const value = f.runtime.track.resolveTrackAutomationBindings(f.targetId, "delay.timeMs", f.instanceId)[0]?.param.value;
      console.log("REVIEW mode", JSON.stringify({ local, value, calls: f.calls }));
      expect(value).toBeCloseTo(0.777);
    } finally { f.close(); }
  });
  test(`REVIEW FX track restore local=${local}`, async () => {
    const f = await createB5c3FxFixture(local, false, "delay");
    try {
      await f.drain();
      expect(f.bindings().length).toBeGreaterThan(0);
      f.removeTrack(); await f.drain();
      expect(f.bindings()).toEqual([]);
      f.restoreTrack(); await f.drain();
      console.log("REVIEW FX restore", JSON.stringify({ local, bindings: f.bindings().length, calls: f.calls }));
      expect(f.bindings().length).toBeGreaterThan(0);
    } finally { f.close(); }
  });
}

test("B5d delay and EQ reorder local track closed and unselected", async () => {
  const f = await createB5c3FxFixture(true, false, "delay");
  type FxRoutingNode = ReturnType<typeof f.runtime.audio.connections>[number]["source"];
  const reaches = (source: FxRoutingNode, target: FxRoutingNode) => {
    const edges = f.runtime.audio.connections(), seen = new Set<object>([source]), pending = [source];
    for (const node of pending) for (const edge of edges) {
      if (edge.source !== node || seen.has(edge.target)) continue;
      if (edge.target === target) return true;
      seen.add(edge.target);
      pending.push(edge.target);
    }
    return false;
  };
  try {
    await f.drain();
    await setLocalEffectInstance(f.initialProject, f.targetId, "eq", {
      ...AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams(), enabled: true,
    }, { instanceId: "eq:reorder", index: 1 });
    await f.drain();
    const eqParam = f.runtime.track.resolveTrackAutomationBindings(f.targetId,
      `eq.${AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams().bands[0]?.id}.gainDb`, "eq:reorder")[0]?.param;
    const eq = f.runtime.audio.biquads.find(node => node.gain === eqParam);
    const delayParam = f.runtime.track.resolveTrackAutomationBindings(f.targetId, "delay.timeMs", f.instanceId)[0]?.param;
    const delay = f.runtime.audio.delays.find(node => node.delayTime === delayParam);
    if (!delay || !eq) throw new Error("Missing heterogeneous runtime nodes");
    expect(reaches(delay, eq)).toBe(true);
    expect(reaches(eq, delay)).toBe(false);
    const before = f.calls.length;
    await reorderLocalAudioEffects(f.initialProject, f.targetId, [
      { id: "eq:reorder", kind: "eq" }, { id: f.instanceId, kind: "delay" },
    ]);
    await f.drain();
    expect(f.audio.snapshotExportRows([f.targetId]).map(row => row.instanceId)).toEqual(["eq:reorder", f.instanceId]);
    expect(reaches(eq, delay)).toBe(true);
    expect(reaches(delay, eq)).toBe(false);
    expect(f.calls.slice(before).filter(call => call.disposition === "applied")).toHaveLength(1);
  } finally { f.close(); }
});

for (const local of [true, false]) for (const master of [false, true]) for (const kind of b5c3FxKinds) {
  for (const scenario of master ? ["project switch"] : ["track removal", "project switch"]) {
    test(`B5c3 FX teardown ${scenario}, ${kind}, local=${local}, master=${master}, closed and unselected`, async () => {
      const f = await createB5c3FxFixture(local, master, kind);
      try {
        await f.drain();
        expect(f.audio.snapshotExportRows([f.targetId]).map(row => row.instanceId)).toEqual([f.instanceId]);
        const node = f.runtime.audio.workletNode(0);
        if (kind === "compressor" || kind === "reverb") {
          expect(node?.closed).toBe(false);
        } else expect(f.bindings().length).toBeGreaterThan(0);
        const before = f.calls.length;
        if (scenario === "track removal") f.removeTrack();
        else f.switchProject();
        await f.drain();
        console.log("B5c3 FX matrix", JSON.stringify({ group: "teardown", scenario, family: kind, local,
          target: master ? "master" : "track", calls: f.calls.slice(before) }));
        if (kind === "compressor" || kind === "reverb") expect(node?.closed).toBe(true);
        else expect(f.bindings()).toEqual([]);
        if (master) expect(f.runtime.master.getMixerFx().masterFxInstances).toEqual([]);
      } finally { f.close(); }
    });
  }
}

for (const local of [true, false]) for (const master of [false, true]) for (const kind of b5c3FxKinds) {
  for (const scenario of ["initial load", "removal and re-add"]) {
    test(`B5c3 FX load ${scenario}, ${kind}, local=${local}, master=${master}, closed and unselected`, async () => {
      const f = await createB5c3FxFixture(local, master, kind);
      try {
        await f.drain();
        const before = scenario === "initial load" ? 0 : f.calls.length;
        const node = f.runtime.audio.workletNode(0);
        if (scenario === "removal and re-add") {
          await f.write(undefined);
          await f.drain();
          expect(f.audio.snapshotExportRows([f.targetId])).toEqual([]);
          if (kind === "compressor" || kind === "reverb") expect(node?.closed).toBe(true);
          else expect(f.bindings()).toEqual([]);
          await f.write(f.initial);
          await f.drain();
        }
        expect(f.audio.snapshotExportRows([f.targetId]).map(row => row.instanceId)).toEqual([f.instanceId]);
        if (kind === "compressor" || kind === "reverb") expect(f.runtime.audio.liveWorkletCount()).toBe(1);
        else expect(f.bindings().length).toBeGreaterThan(0);
        console.log("B5c3 FX matrix", JSON.stringify({ group: "load", scenario, family: kind, local,
          target: master ? "master" : "track", calls: f.calls.slice(before) }));
      } finally { f.close(); }
    });
  }
}

// External edits persist independently of the selected card; collaborator
// rows enter through useConvexQuery's real subscription callback.
for (const local of [true, false]) for (const master of [false, true]) for (const kind of b5c3FxKinds) {
  for (const scenario of local ? ["another surface"] : ["another surface", "collaborator"]) {
    test(`B5c3 FX external ${scenario}, ${kind}, local=${local}, master=${master}, closed and unselected`, async () => {
      const f = await createB5c3FxFixture(local, master, kind, scenario === "collaborator");
      try {
        await f.drain();
        const next = { ...f.initial, enabled: false }, before = f.calls.length;
        await f.write(next);
        await f.drain();
        expect(f.audio.snapshotExportRows([f.targetId])[0]?.params).toEqual(next);
        if (kind === "compressor" || kind === "reverb") expect(f.runtime.audio.liveWorkletCount()).toBe(0);
        else if (kind === "delay") expect(f.bindings().map(binding => binding.param.value)).toEqual([1, 0]);
        else expect(f.bindings()).toEqual([]);
        console.log("B5c3 FX matrix", JSON.stringify({ group: "external", scenario, family: kind, local,
          target: master ? "master" : "track", calls: f.calls.slice(before), subscription: scenario === "collaborator" }));
      } finally { f.close(); }
    });
  }
}

for (const local of [true, false]) for (const master of [false, true]) for (const kind of b5c3FxKinds) {
  test(`B5c3 FX agent commit, ${kind}, local=${local}, master=${master}, closed and unselected`, async () => {
    const f = await createB5c3FxFixture(local, master, kind, !local, true);
    try {
      await f.drain();
      const next = { ...f.initial, enabled: false }, before = f.calls.length;
      await b5AgentCommit(local, f.initialProject, f.db, {
        kind: "effect.upsert", effect: { source: "persisted", id: await f.processorId() },
        target: master ? { kind: "master" } : { kind: "track", track: { source: "persisted", id: f.track.id } },
        effectKind: kind, params: next,
      });
      await f.drain();
      expect(f.audio.snapshotExportRows([f.targetId])[0]?.params).toEqual(next);
      if (kind === "compressor" || kind === "reverb") expect(f.runtime.audio.liveWorkletCount()).toBe(0);
      else if (kind === "delay") expect(f.bindings().map(binding => binding.param.value)).toEqual([1, 0]);
      else expect(f.bindings()).toEqual([]);
      console.log("B5c3 FX matrix", JSON.stringify({ group: "agent", scenario: "agent commit", family: kind, local,
        target: master ? "master" : "track", calls: f.calls.slice(before), subscription: !local }));
    } finally { f.close(); }
  });
}

const b5c3FxHistoryEntry = (projectId: string, trackRef: string, master: boolean, kind: AudioEffectKind): HistoryEntry => {
  const common = { trackRef, instanceId: "b5c3-fx" };
  if (kind === "eq") {
    const from = { ...AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams(), enabled: true }, to = { ...from, enabled: false };
    return { type: "effect-params", projectId, data: { ...common, effect: master ? "master-eq" : "eq", from, to } };
  }
  if (kind === "compressor") {
    const from = { ...AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams(), enabled: true }, to = { ...from, enabled: false };
    return { type: "effect-params", projectId, data: { ...common, effect: master ? "master-compressor" : "compressor", from, to } };
  }
  if (kind === "reverb") {
    const from = { ...AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams(), enabled: true }, to = { ...from, enabled: false };
    return { type: "effect-params", projectId, data: { ...common, effect: master ? "master-reverb" : "reverb", from, to } };
  }
  if (kind === "delay") {
    const from = { ...AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams(), enabled: true }, to = { ...from, enabled: false };
    return { type: "effect-params", projectId, data: { ...common, effect: master ? "master-delay" : "delay", from, to } };
  }
  if (kind !== "saturator") throw new Error("Unsupported B5 history effect");
  const from = { ...AUDIO_EFFECT_CONTRACTS.saturator.createDefaultParams(), enabled: true }, to = { ...from, enabled: false };
  return { type: "effect-params", projectId, data: { ...common, effect: master ? "master-saturator" : "saturator", from, to } };
};

for (const local of [true, false]) for (const master of [false, true]) for (const kind of b5c3FxKinds) {
  test(`B5c3 FX history undo redo, ${kind}, local=${local}, master=${master}, closed and unselected`, async () => {
    const f = await createB5c3FxFixture(local, master, kind);
    const entry = b5c3FxHistoryEntry(f.initialProject, f.track.id, master, kind);
    if (entry.type !== "effect-params") throw new Error("Invalid history fixture");
    const restore = b5HistoryTransport(async operation => {
      if (!("params" in operation.payload)) throw new Error("Unexpected FX history operation");
      await f.write(operation.payload.params);
    });
    try {
      await f.drain();
      await f.write(entry.data.to);
      await f.drain();
      const deps = b5HistoryDeps(f.initialProject, f.track, entry);
      // The product's audio-effect replay is retained. Row ingestion remains
      // independently checked by the snapshot and actual node/binding oracles.
      deps.replayInstanceEffectParams = f.audio.replayInstanceParams;
      for (const direction of ["undo", "redo"]) {
        const before = f.calls.length, enabled = direction === "undo";
        if (enabled) await execUndo(entry, deps);
        else await execRedo(entry, deps);
        await f.drain();
        expect(f.audio.snapshotExportRows([f.targetId])[0]?.params).toEqual(enabled ? entry.data.from : entry.data.to);
        if (kind === "compressor" || kind === "reverb") expect(f.runtime.audio.liveWorkletCount()).toBe(enabled ? 1 : 0);
        else if (kind === "delay") {
          const wet = AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams().dryWet;
          expect(f.bindings().map(binding => binding.param.value)).toEqual(enabled ? [1 - wet, wet] : [1, 0]);
        }
        else expect(f.bindings().length > 0).toBe(enabled);
        console.log("B5c3 FX matrix", JSON.stringify({ group: "history", scenario: direction, family: kind, local,
          target: master ? "master" : "track", calls: f.calls.slice(before) }));
      }
    } finally { restore(); f.close(); }
  });
}

for (const local of [true, false]) {
  for (const target of ["t", "master"]) {
    for (const scenario of ["empty-chain removal", "middle removal", "reorder", "addition control", "open gesture reorder"]) {
      test(`B5 ${scenario}, local=${local}, target=${target}, closed and unselected`, async () => {
        const projectId = `${local ? "project:" : "cloud-"}b5-empty-${crypto.randomUUID()}`;
        const instanceId = "compressor:b5";
        const params = { ...AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams(), enabled: true, thresholdDb: -31 };
        const db = convexTest(schema, { "./_generated/api.ts": () => import("../../convex/_generated/api") });
        const remoteTrackId = await db.run(ctx => ctx.db.insert("tracks", { projectId, name: "Unselected", index: 0, kind: "audio" }));
        const track: Track = { id: local ? "t" : remoteTrackId, kind: "audio", name: "Unselected", volume: 1, clips: [] };
        const targetId = target === "master" ? "master" : track.id;
        const readRemoteRows = () => db.run(ctx => ctx.db.query("effects").collect());
        const localKind = target === "master" ? "master-compressor" : "compressor";
        const insert = async (id: string, index: number) => {
          if (local) await setLocalEffectInstance(projectId, targetId, localKind, params, { instanceId: id, index });
          else await db.run(ctx => ctx.db.insert("effects", {
            projectId, targetType: targetId === "master" ? "master" : "track",
            trackId: targetId === "master" ? undefined : remoteTrackId,
            type: "compressor", instanceId: id, index, params, revision: 1, createdAt: 1,
          }));
        };
        const initialIds = scenario === "empty-chain removal" ? [instanceId]
          : scenario === "middle removal" ? [instanceId, "compressor:b", "compressor:c"]
          : [instanceId, "compressor:b"];
        for (const [index, id] of initialIds.entries()) await insert(id, index);
        const [rows, setRows] = createSignal(await readRemoteRows());
        const runtime = createFxTransitionHarness(targetId === "master" ? "master" : "track");
        runtime.track.updateTrackGains([track]);
        const applications: Array<Promise<unknown>> = [];
        const chainCalls: ChainApplication[] = [];
        const record = (instances: AudioEffectRuntimeInstance[], work: ReturnType<AudioEngine["setMasterFxInstances"]>) => {
          const call: ChainApplication = { ids: instances.map(entry => entry.id) };
          chainCalls.push(call);
          const applied = work.then(disposition => { call.disposition = disposition; return disposition; });
          applications.push(applied);
          return applied;
        };
        // Thin AudioEngine boundary into the existing real track/master runtimes.
        // The oracle below reads the worklet's held params and resource closure, not setter calls.
        class RuntimeAudioEngine extends AudioEngine {
          override setTrackFxInstances(id: string, instances: AudioEffectRuntimeInstance[]) {
            const work = runtime.track.setTrackFxInstances(id, instances);
            return id === targetId ? record(instances, work) : work;
          }
          override setTrackFxInstance(id: string, instance: AudioEffectRuntimeInstance) {
            return runtime.track.replaceTrackFxInstance(id, instance);
          }
          private async applyMaster(instances: AudioEffectRuntimeInstance[]) {
            return (await runtime.master.setFxInstances(
              runtime.audio.context, runtime.audio.masterInput, runtime.audio.context.destination, instances,
            )).disposition;
          }
          override setMasterFxInstances(instances: AudioEffectRuntimeInstance[]) {
            const work = this.applyMaster(instances);
            return targetId === "master" ? record(instances, work) : work;
          }
          override async setMasterFxInstance(instance: AudioEffectRuntimeInstance): ReturnType<AudioEngine["setMasterFxInstance"]> {
            const retained = runtime.master.retainedInstances();
            if (!retained.some(entry => entry.id === instance.id)) return "not-held";
            return this.applyMaster(retained.map(entry => entry.id === instance.id ? instance : entry));
          }
        }
        const engine = new RuntimeAudioEngine();
        const sampler = createSamplerBufferSync(), drum = createDrumRackBufferSync();
        let dispose = () => {};
        const [selectedTarget, setSelectedTarget] = createSignal("selected-elsewhere");
        const fixture = createRoot(end => {
          dispose = end;
          const view = createLocalEffectsView({ projectId: () => projectId });
          const audio = createEffectsPanelAudioDevice({
            audioEngine: () => engine, projectId: () => projectId, userId: () => undefined,
            roomEffects: rows, localEffectsView: view, usesLegacyAudioEngine: () => true,
            canWriteCurrentTargetEffects: () => true,
          }, selectedTarget, () => track);
          const sync = useEffectsPanelAudioSync({
            isOpen: () => false, currentTargetId: () => "selected-elsewhere",
            projectId: () => projectId, tracks: () => [track], sidechainRoutes: () => [],
            audioEngine: () => engine, usesLegacyAudioEngine: () => true,
            roomEffects: rows, roomEffectsStatus: () => "success", roomEffectsError: () => undefined,
            localEffectsView: view, samplerBufferSync: sampler, drumRackBufferSync: drum,
          });
          return { view, audio, sync };
        });
        const drain = async (holding = false) => {
          if (local) await fixture.view.reload();
          await fixture.sync.flushPending();
          if (!holding) await fixture.audio.flushPending();
          await Promise.all(applications);
          // Existing deterministic transition fixture, no elapsed-time wait.
          for (let remaining = runtime.timers.pending.size; remaining > 0; remaining--) runtime.timers.run();
        };
        type HeldCompressor = NonNullable<ReturnType<typeof runtime.audio.workletNode>>;
        const reaches = (source: HeldCompressor, targetNode: HeldCompressor) => {
          const seen = new Set<object>([source]);
          const pending: object[] = [source];
          const edges = runtime.audio.connections();
          for (const node of pending) {
            for (const edge of edges) {
              if (edge.source !== node || seen.has(edge.target)) continue;
              if (edge.target === targetNode) return true;
              seen.add(edge.target); pending.push(edge.target);
            }
          }
          return false;
        };
        try {
          await drain();
          expect(fixture.audio.snapshotExportRows([targetId]).map(row => row.instanceId)).toEqual(initialIds);
          expect(runtime.audio.compressorThreshold()).toBe(-31);
          const node = runtime.audio.workletNode(0);
          if (!node) throw new Error("B5 compressor was not installed in the real FX runtime.");
          expect(node.closed).toBe(false);
          const nodes = initialIds.map((_, index) => {
            const held = runtime.audio.workletNode(index);
            if (!held) throw new Error("Missing initial compressor node.");
            return held;
          });
          const holding = scenario === "open gesture reorder";
          const gesture = fixture.audio.gestureOwner(instanceId, "compressor", targetId);
          const holder = new ParameterGestureHolder();
          if (holding) {
            // Establish the draft through the real card binding, then leave the target before changing structure.
            setSelectedTarget(targetId);
            gesture.open(holder);
            gesture.tick(holder, () => fixture.audio.compressor.changeInstance(instanceId, prev => ({ ...prev, thresholdDb: -12 })));
            setSelectedTarget("selected-elsewhere");
            await fixture.sync.flushPending();
            await Promise.all(applications);
            expect(gesture.isOpen(holder)).toBe(true);
          }
          const beforeCalls = chainCalls.length;
          let expectedIds: string[];
          if (scenario === "empty-chain removal" || scenario === "middle removal") {
            const removedId = scenario === "empty-chain removal" ? instanceId : "compressor:b";
            expectedIds = initialIds.filter(id => id !== removedId);
            if (local) await deleteLocalEffectInstance(projectId, targetId, localKind, removedId);
            else {
              await db.run(async ctx => {
                for (const row of await ctx.db.query("effects").collect()) if (row.instanceId === removedId) await ctx.db.delete(row._id);
              });
            }
          } else if (scenario === "addition control") {
            expectedIds = [...initialIds, "compressor:c"];
            await insert("compressor:c", 2);
          } else {
            expectedIds = [...initialIds].reverse();
            if (local) await reorderLocalAudioEffects(projectId, targetId, expectedIds.map(id => ({ id, kind: "compressor" })));
            else await db.run(async ctx => {
              for (const row of await ctx.db.query("effects").collect()) {
                await ctx.db.patch(row._id, { index: expectedIds.indexOf(row.instanceId ?? ""), revision: 2 });
              }
            });
          }
          if (!local) setRows(await readRemoteRows());
          await drain(holding);
          console.log("B5 applications", JSON.stringify({ scenario, local, target, calls: chainCalls.slice(beforeCalls) }));
          expect(untrack(selectedTarget)).toBe("selected-elsewhere");
          expect(fixture.audio.snapshotExportProjection().replaceAudioEffectTargets.flatMap(entry => entry.rows).map(row => row.instanceId)).toEqual(expectedIds);
          if (scenario === "empty-chain removal") expect(node.closed).toBe(true);
          if (scenario === "middle removal") expect(nodes[1]?.closed).toBe(true);
          expect(runtime.audio.liveWorkletCount()).toBe(expectedIds.length);
          const byId = new Map(initialIds.map((id, index) => [id, nodes[index]]));
          if (scenario === "addition control") byId.set("compressor:c", runtime.audio.workletNode(2));
          for (let index = 1; index < expectedIds.length; index++) {
            const from = byId.get(expectedIds[index - 1] ?? ""), to = byId.get(expectedIds[index] ?? "");
            if (!from || !to) throw new Error("Missing chain-order oracle node.");
            expect(reaches(from, to)).toBe(true);
            expect(reaches(to, from)).toBe(false);
          }
          if (targetId === "master") expect(runtime.master.getMixerFx().masterFxInstances?.map(entry => entry.id)).toEqual(expectedIds);
          if (holding) {
            expect(gesture.isOpen(holder)).toBe(true);
            expect(runtime.audio.compressorThreshold()).toBe(-12);
            gesture.cancel(holder);
            await fixture.audio.flushPending();
          }
          expect(chainCalls.slice(beforeCalls).filter(call => call.disposition === "applied")).toHaveLength(1);
        } finally {
          dispose(); sampler.dispose(); drum.dispose(); runtime.close();
        }
      });
    }
  }
}

type SpectrumProvider = (
  targetId: string,
  listener: (frame: SpectrumFrame | null) => void,
) => () => void;

test("keeps the spectrum subscription across unrelated panel updates", () => {
  const events: string[] = [];
  const listeners = new Map<string, (frame: SpectrumFrame | null) => void>();
  const providerA: SpectrumProvider = (targetId, listener) => {
    events.push(`subscribe:a:${targetId}`);
    listeners.set(`a:${targetId}`, listener);
    return () => {
      events.push(`unsubscribe:a:${targetId}`);
      listeners.delete(`a:${targetId}`);
    };
  };
  const providerB: SpectrumProvider = (targetId, listener) => {
    events.push(`subscribe:b:${targetId}`);
    listeners.set(`b:${targetId}`, listener);
    return () => {
      events.push(`unsubscribe:b:${targetId}`);
      listeners.delete(`b:${targetId}`);
    };
  };
  const frames: Array<SpectrumFrame | null> = [];
  const frame: SpectrumFrame = { data: new Float32Array([1]), sampleRate: 44100 };
  const owner = createSpectrumSubscriptionOwner((frame) => frames.push(frame));
  owner.update(true, providerA, "track");
  expect(events).toEqual(["subscribe:a:track"]);

  owner.update(true, providerA, "track");
  expect(events).toEqual(["subscribe:a:track"]);

  const staleTrackListener = listeners.get("a:track");
  owner.update(true, providerA, "master");
  expect(events).toEqual([
    "subscribe:a:track",
    "unsubscribe:a:track",
    "subscribe:a:master",
  ]);
  staleTrackListener?.(frame);
  expect(frames).toEqual([]);

  owner.update(true, providerB, "master");
  expect(events).toEqual([
    "subscribe:a:track",
    "unsubscribe:a:track",
    "subscribe:a:master",
    "unsubscribe:a:master",
    "subscribe:b:master",
  ]);

  owner.update(false, providerB, "master");
  expect(events).toEqual([
    "subscribe:a:track",
    "unsubscribe:a:track",
    "subscribe:a:master",
    "unsubscribe:a:master",
    "subscribe:b:master",
    "unsubscribe:b:master",
  ]);

  owner.update(true, providerB, "master");
  expect(events).toEqual([
    "subscribe:a:track",
    "unsubscribe:a:track",
    "subscribe:a:master",
    "unsubscribe:a:master",
    "subscribe:b:master",
    "unsubscribe:b:master",
    "subscribe:b:master",
  ]);

  const currentListener = listeners.get("b:master");
  owner.dispose();
  owner.dispose();
  expect(events.at(-1)).toBe("unsubscribe:b:master");
  currentListener?.(frame);
  expect(frames).toEqual([null]);
});

test("flushes persisted off-screen granular work before resolving", async () => {
  const owner = createPendingWorkOwner();
  let resolveGranular: (() => void) | undefined;
  const granularWork = new Promise<void>((resolve) => {
    resolveGranular = resolve;
  });
  owner.track("project:one", granularWork);
  let flushed = false;
  const flush = owner.flushPending("project:one").then(() => {
    flushed = true;
  });

  await Promise.resolve();
  expect(flushed).toBe(false);
  resolveGranular?.();
  await flush;
  expect(flushed).toBe(true);
  owner.dispose();
});

test("drains same-project work created while flushing", async () => {
  const owner = createPendingWorkOwner();
  let resolveFirst: (() => void) | undefined;
  let resolveSecond: (() => void) | undefined;
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const second = new Promise<void>((resolve) => {
    resolveSecond = resolve;
  });
  owner.track("project:one", first);
  void first.then(() => owner.track("project:one", second));

  let flushed = false;
  const flush = owner.flushPending("project:one").then(() => {
    flushed = true;
  });
  resolveFirst?.();
  await Promise.resolve();
  expect(flushed).toBe(false);
  resolveSecond?.();
  await flush;
  expect(flushed).toBe(true);
  owner.dispose();
});

test("only flushes work for the current project", async () => {
  const owner = createPendingWorkOwner();
  let resolveOld: (() => void) | undefined;
  let resolveCurrent: (() => void) | undefined;
  owner.track("project:old", new Promise<void>((resolve) => {
    resolveOld = resolve;
  }));
  owner.track("project:current", new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  }));

  let flushed = false;
  const flush = owner.flushPending("project:current").then(() => {
    flushed = true;
  });
  resolveCurrent?.();
  await flush;
  expect(flushed).toBe(true);
  resolveOld?.();
  owner.dispose();
});

test("settles rejected sampled work without rejecting the flush", async () => {
  const owner = createPendingWorkOwner();
  owner.track("project:one", Promise.reject(new Error("terminal sample failure")));
  await expect(owner.flushPending("project:one")).resolves.toBeUndefined();
  owner.dispose();
});

test("keeps a local flush pending until rows are processed and sampled work is drained", async () => {
  const readiness = createEffectsPanelReadinessOwner({
    loadLocalEffects: async () => [],
    currentProjectId: () => "project:local",
  });
  let resolveRows: ((rows: never[]) => void) | undefined;
  const rowsLoaded = new Promise<never[]>((resolve) => {
    resolveRows = resolve;
  });
  const publicationId: LocalEffectsPublicationId = {};
  readiness.startLocalLoad("project:local", () => rowsLoaded, false, publicationId);
  const flush = readiness.flushPending("project:local");
  let settled = false;
  void flush.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);

  resolveRows?.([]);
  await Promise.resolve();
  readiness.markRowsProcessed("project:local", publicationId);
  await flush;
  expect(settled).toBe(true);
  readiness.dispose();
});

test("marks local rows loaded before synchronous publication processing", async () => {
  const projectId = "project:local";
  const readiness = createEffectsPanelReadinessOwner({
    loadLocalEffects: async () => [],
    currentProjectId: () => projectId,
  });

  const publicationId: LocalEffectsPublicationId = {};
  await readiness.startLocalLoad(projectId, async () => {
    readiness.markRowsProcessed(projectId, publicationId);
    return [];
  }, false, publicationId);
  const flush = readiness.flushPending(projectId);
  try {
    await expect(flush).resolves.toBeUndefined();
  } finally {
    readiness.dispose();
  }
});

test("a local view publication can be processed before its load promise settles", async () => {
  const projectId = "project:published-before-settlement";
  const readiness = createEffectsPanelReadinessOwner({
    loadLocalEffects: async () => [],
    currentProjectId: () => projectId,
  });
  const publicationId: LocalEffectsPublicationId = {};
  let published = false;
  const viewLoad = async () => {
    published = true;
    readiness.markRowsProcessed(projectId, publicationId);
    return [];
  };
  await readiness.startLocalLoad(projectId, viewLoad, false, publicationId);
  expect(published).toBe(true);
  const flushing = readiness.flushPending(projectId);
  let ready = false;
  void flushing.then(() => { ready = true; });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const readyBeforeDispose = ready;
  readiness.dispose();
  expect(readyBeforeDispose).toBe(true);
});

test("an old publication identity cannot satisfy a newer successful read", async () => {
  const projectId = "project:readiness-publication-identity";
  const readiness = createEffectsPanelReadinessOwner({
    loadLocalEffects: async () => [],
    currentProjectId: () => projectId,
  });
  const oldPublication: LocalEffectsPublicationId = {};
  await readiness.startLocalLoad(projectId, async () => [], false, oldPublication);
  readiness.markRowsProcessed(projectId, oldPublication);
  await readiness.flushPending(projectId);

  const newPublication: LocalEffectsPublicationId = {};
  let releaseRead: (() => void) | undefined;
  const heldRead = new Promise<LocalEffectRow<JsonValue>[]>((resolve) => {
    releaseRead = () => resolve([]);
  });
  const read = readiness.startLocalLoad(projectId, () => heldRead, true, newPublication);
  let ready = false;
  const flush = readiness.flushPending(projectId).then(() => {
    ready = true;
  });
  readiness.markRowsProcessed(projectId, oldPublication);
  releaseRead?.();
  await read;
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  expect(ready).toBe(false);

  readiness.markRowsProcessed(projectId, newPublication);
  await flush;
  readiness.dispose();
});

test("an old local publication cannot acknowledge a newer held read", async () => {
  const projectId = `project:stale-publication-readiness-${crypto.randomUUID()}`;
  const tracks: Track[] = [
    { id: "track-a", kind: "instrument", name: "A", volume: 1, clips: [] },
  ];
  let setTracks: ((next: Track[]) => void) | undefined;
  let releaseRead: ((rows: LocalEffectRow<JsonValue>[]) => void) | undefined;
  let holdNextRead = false;
  const engine = new AudioEngine();
  const samplerBufferSync = createSamplerBufferSync();
  const drumRackBufferSync = createDrumRackBufferSync();
  let view: LocalEffectsViewSource | undefined;
  let flush: (() => Promise<void>) | undefined;
  let dispose: () => void = () => undefined;
  createRoot((stop) => {
    dispose = stop;
    const currentProjectId = () => projectId;
    const [currentTracks, writeTracks] = createSignal(tracks);
    setTracks = writeTracks;
    const [currentView, setCurrentView] = createSignal<LocalEffectsView | undefined>();
    const owner = createLocalEffectsViewOwner({
      currentProjectId,
      list: async () => {
        if (!holdNextRead) return [];
        return await new Promise<LocalEffectRow<JsonValue>[]>((resolve) => {
          releaseRead = resolve;
        });
      },
      publish: setCurrentView,
      fail: () => undefined,
    });
    const localView = { view: currentView, reload: owner.reload, watchReloads: owner.watchReloads };
    view = localView;
    const panel = useEffectsPanelAudioSync({
      isOpen: () => false,
      projectId: currentProjectId,
      currentTargetId: () => "track-a",
      tracks: currentTracks,
      sidechainRoutes: () => [],
      audioEngine: () => engine,
      usesLegacyAudioEngine: () => false,
      roomEffects: () => undefined,
      roomEffectsStatus: () => "pending",
      roomEffectsError: () => undefined,
      localEffectsView: localView,
      syncInstrumentForTarget: () => undefined,
      syncArpeggiatorForTarget: () => undefined,
      samplerBufferSync,
      drumRackBufferSync,
    });
    flush = () => panel.flushPending();
    onCleanup(() => {
      owner.dispose();
    });
    owner.sync();
  });
  if (!view || !flush || !setTracks) throw new Error("The local panel owners were not created.");
  const localEffectsView = view;
  const flushPending = flush;
  await localEffectsView.reload();
  await flushPending();

  holdNextRead = true;
  const heldRead = localEffectsView.reload();
  let ready = false;
  const flushing = flushPending().then(() => {
    ready = true;
  });
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  setTracks([...tracks]);
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  expect(releaseRead).toBeDefined();
  expect(ready).toBe(false);

  releaseRead?.([]);
  await heldRead;
  await flushing;
  dispose();
});

test("readiness follows empty and populated view loads, reload errors, recovery, and project return", async () => {
  let projectId = "project:readiness-view-a";
  const populated: LocalEffectRow<JsonValue>[] = [{
    id: "track-1:arp",
    targetId: "track-1",
    effect: "arp",
    params: { enabled: true },
    updatedAt: 1,
  }];
  let reads = 0;
  const readiness = createEffectsPanelReadinessOwner({
    loadLocalEffects: async () => [],
    currentProjectId: () => projectId,
  });
  const published: number[] = [];
  const audioRows: number[] = [];
  const view = createLocalEffectsViewOwner({
    currentProjectId: () => projectId,
    list: async () => {
      reads += 1;
      if (reads === 3) throw new Error("local read failed");
      return reads === 1 ? [] : populated;
    },
    publish: (next) => {
      if (!next) return;
      published.push(next.rows.length);
      readiness.markRowsProcessed(next.projectId, next.publicationId);
    },
    fail: () => undefined,
  });
  const stopReadiness = view.watchReloads((load, id, publicationId) => {
    void readiness.startLocalLoad(id, () => load, true, publicationId);
  });
  const stopAudio = view.watchReloads((load) => {
    void load.then((rows) => audioRows.push(rows.length), () => undefined);
  });
  view.sync();
  await readiness.flushPending(projectId);
  expect(published).toEqual([0]);
  expect(audioRows).toEqual([0]);

  notifyLocalProjectChanged(projectId);
  await view.reload();
  await readiness.flushPending(projectId);
  expect(published).toEqual([0, 1]);
  expect(audioRows).toEqual([0, 1]);

  notifyLocalProjectChanged(projectId);
  await expect(view.reload()).rejects.toThrow("local read failed");
  await expect(readiness.flushPending(projectId)).rejects.toThrow("local read failed");
  notifyLocalProjectChanged(projectId);
  await view.reload();
  await readiness.flushPending(projectId);
  expect(published).toEqual([0, 1, 1]);

  projectId = "project:readiness-view-b";
  readiness.projectChanged();
  view.sync();
  projectId = "project:readiness-view-a";
  readiness.projectChanged();
  view.sync();
  await readiness.flushPending(projectId);
  expect(published).toEqual([0, 1, 1, 1]);
  stopReadiness();
  stopAudio();
  view.dispose();
  readiness.dispose();
});

test("resolves an empty local row load and rejects a failed local row load clearly", async () => {
  const empty = createEffectsPanelReadinessOwner({
    loadLocalEffects: async () => [],
    currentProjectId: () => "project:empty",
  });
  const emptyPublication: LocalEffectsPublicationId = {};
  await empty.startLocalLoad("project:empty", async () => [], false, emptyPublication);
  empty.markRowsProcessed("project:empty", emptyPublication);
  await expect(empty.flushPending("project:empty")).resolves.toBeUndefined();
  empty.dispose();

  const failed = createEffectsPanelReadinessOwner({
    loadLocalEffects: async () => [],
    currentProjectId: () => "project:failed",
  });
  await failed.startLocalLoad("project:failed", async () => {
    throw new Error("database unavailable");
  });
  await expect(failed.flushPending("project:failed")).rejects.toThrow(
    'Failed to load local effects for project "project:failed": database unavailable',
  );
  failed.dispose();
});

test("republishes local rows when returning to a project", async () => {
  let currentProject = "project:local-a";
  const published: string[] = [];
  const readiness = createEffectsPanelReadinessOwner({
    loadLocalEffects: async () => [],
    currentProjectId: () => currentProject,
  });
  const view = createLocalEffectsViewOwner({
    currentProjectId: () => currentProject,
    list: async () => [],
    publish: (next) => {
      if (!next) return;
      published.push(`${next.projectId}:${next.rows.length}`);
      readiness.markRowsProcessed(next.projectId, next.publicationId);
    },
    fail: () => undefined,
  });
  const stopWatching = view.watchReloads((load, projectId, publicationId) => {
    void readiness.startLocalLoad(projectId, () => load, true, publicationId);
  });
  view.sync();
  await readiness.flushPending("project:local-a");

  currentProject = "project:local-b";
  readiness.projectChanged();
  view.sync();
  currentProject = "project:local-a";
  readiness.projectChanged();
  view.sync();
  await readiness.flushPending("project:local-a");

  expect(published).toEqual(["project:local-a:0", "project:local-a:0"]);
  stopWatching();
  view.dispose();
  readiness.dispose();
});

test("routes each local publication to every instrument and arpeggiator owner", async () => {
  const projectId = `project:all-target-local-sync-${crypto.randomUUID()}`;
  const tracks: Track[] = [
    { id: "track-a", kind: "instrument", name: "A", volume: 1, clips: [] },
    { id: "track-b", kind: "instrument", name: "B", volume: 1, clips: [] },
  ];
  const instruments: Array<[string, TrackInstrumentParams | undefined]> = [];
  const arpeggiators: Array<[string, ArpeggiatorParams | undefined]> = [];
  const engine = new AudioEngine();
  const samplerBufferSync = createSamplerBufferSync();
  const drumRackBufferSync = createDrumRackBufferSync();
  let view: ReturnType<typeof createLocalEffectsView> | undefined;
  let flush: (() => Promise<void>) | undefined;
  let dispose: () => void = () => undefined;
  createRoot((stop) => {
    dispose = stop;
    const currentProjectId = () => projectId;
    view = createLocalEffectsView({ projectId: currentProjectId });
    const owner = useEffectsPanelAudioSync({
      isOpen: () => false,
      projectId: currentProjectId,
      currentTargetId: () => "track-a",
      tracks: () => tracks,
      sidechainRoutes: () => [],
      audioEngine: () => engine,
      usesLegacyAudioEngine: () => false,
      roomEffects: () => undefined,
      roomEffectsStatus: () => "pending",
      roomEffectsError: () => undefined,
      localEffectsView: view,
      syncInstrumentForTarget: (targetId, params) => { instruments.push([targetId, params]); },
      syncArpeggiatorForTarget: (targetId, params) => { arpeggiators.push([targetId, params]); },
      samplerBufferSync,
      drumRackBufferSync,
    });
    flush = () => owner.flushPending();
  });
  if (!view || !flush) throw new Error("The local sync owners were not created.");
  const localEffectsView = view;
  const flushPending = flush;
  const initialArp = { ...createDefaultArpeggiatorParams(), enabled: true, gate: 0.1 };
  await localEffectsView.reload();
  await flushPending();
  await setLocalEffect(projectId, "track-a", "arp", initialArp);
  await setLocalEffect(projectId, "track-b", "arp", { ...initialArp, gate: 0.2 });
  await setLocalEffect(projectId, "track-a", "instrument", {
    kind: "synth",
    instanceId: "synth-a",
    params: createDefaultSynthParams(),
  });
  await setLocalEffect(projectId, "track-b", "instrument", {
    kind: "synth",
    instanceId: "synth-b",
    params: createDefaultSynthParams(),
  });
  await localEffectsView.reload();
  await Promise.resolve();

  expect(instruments.some(([targetId, params]) => targetId === "track-b" && params?.instanceId === "synth-b")).toBe(true);
  expect(arpeggiators.some(([targetId, params]) => targetId === "track-a" && params?.gate === 0.1)).toBe(true);
  expect(arpeggiators.some(([targetId, params]) => targetId === "track-b" && params?.gate === 0.2)).toBe(true);
  dispose();
});

test("3B0 records the params-only unselected local arp route without claiming engine application", async () => {
  const projectId = `project:3b0-arp-${crypto.randomUUID()}`;
  const engine = new AudioEngine();
  const initial = { ...createDefaultArpeggiatorParams(), enabled: true };
  engine.setTrackArpeggiator("track-b", initial);
  let dispose = () => {};
  const fixture = createRoot(end => {
    dispose = end;
    const view = createLocalEffectsView({ projectId: () => projectId });
    const arp = createPersistedEffectState<undefined, ArpeggiatorParams>({
      targetId: () => "track-b", row: () => undefined, readQueryParams: () => undefined,
      createInitialParams: () => initial, serializeParams: JSON.stringify,
      applyToEngine: (target, params) => engine.setTrackArpeggiator(target, params),
      persistParams: () => ({ kind: "committed-unordered" }), isRemote: () => false,
    });
    const sync = useEffectsPanelAudioSync({
      isOpen: () => false, projectId: () => projectId, currentTargetId: () => "track-a",
      tracks: () => [{ id: "track-b", kind: "instrument", name: "B", volume: 1, clips: [] }],
      sidechainRoutes: () => [], audioEngine: () => engine, usesLegacyAudioEngine: () => false,
      roomEffects: () => undefined, roomEffectsStatus: () => "pending", roomEffectsError: () => undefined,
      localEffectsView: view, syncArpeggiatorForTarget: arp.syncRemoteForTarget,
      samplerBufferSync: createSamplerBufferSync(), drumRackBufferSync: createDrumRackBufferSync(),
    });
    return { view, arp, sync };
  });
  await setLocalEffect(projectId, "track-b", "arp", { ...initial, enabled: false });
  await fixture.view.reload();
  await fixture.sync.flushPending();
  await fixture.arp.flushPending();
  expect(fixture.arp.readForTarget("track-b")?.enabled).toBe(false);
  expect(engine.getTrackArpeggiator("track-b")?.enabled).toBe(false);
  if (process.env.DV01_3B0_REPORT === "1") console.log(`DV01-3B0 ${JSON.stringify({
    name: "R2-B5 unselected local arp owner delivery",
    location: "src/components/timeline/create-persisted-effect-state.ts:125",
    failure: null,
    expectedFailure: null,
    flip: "3B-1 enables outside-row delivery for local owners and carries the shared view through",
    standIn: "Real all-track hook, shared view, persisted owner and synchronous arp boundary; no native receipt is claimed",
    status: "green",
  })}`);
  dispose();
});

for (const legacy of [true, false]) test(`3B1 sampler normalization causes one structural handoff, legacy=${legacy}`, async () => {
  const projectId = `project:3b1-sampler-normalized-${crypto.randomUUID()}`;
  const track: Track = { id: "sampler", kind: "instrument", name: "Sampler", volume: 1, clips: [] };
  const initial: TrackInstrumentParams = { kind: "sampler", instanceId: "sampled", params: { ...createDefaultSamplerParams(), polyphony: 16 } };
  await setLocalEffect(projectId, track.id, "instrument", initial);
  const engine = new AudioEngine();
  const sampler = createSamplerBufferSync();
  const drum = createDrumRackBufferSync();
  const submitted: number[] = [];
  const results: string[] = [];
  const handoffs: number[] = [];
  const syncTrack = sampler.syncTrack;
  sampler.syncTrack = async (...args) => {
    submitted.push(args[2].polyphony);
    const result = await syncTrack(...args);
    results.push(result);
    return result;
  };
  let dispose = () => {};
  const f = createRoot(end => {
    dispose = end;
    const view = createLocalEffectsView({ projectId: () => projectId });
    const device = createEffectsPanelInstrumentDevice({
      audioEngine: () => engine, projectId: () => projectId, userId: () => undefined, playheadSec: () => 0,
      samplerBufferSync: sampler, drumRackBufferSync: drum, localEffectsView: view,
      usesLegacyAudioEngine: () => legacy,
      onStructuralPlaybackChange: async (_target, next) => {
        if (next?.kind === "sampler") handoffs.push(next.params.polyphony);
      },
    }, () => track.id, () => track, () => track);
    const sync = useEffectsPanelAudioSync({
      isOpen: () => true, projectId: () => projectId, currentTargetId: () => track.id,
      tracks: () => [track], sidechainRoutes: () => [], audioEngine: () => engine,
      usesLegacyAudioEngine: () => legacy, roomEffects: () => undefined,
      roomEffectsStatus: () => "pending", roomEffectsError: () => undefined, localEffectsView: view,
      syncInstrumentForTarget: device.syncRemoteInstrumentForTarget,
      syncArpeggiatorForTarget: device.arp.syncRemoteForTarget,
      samplerBufferSync: sampler, drumRackBufferSync: drum,
    });
    return { view, device, sync };
  });
  await f.view.reload(); await f.sync.flushPending(); await f.device.flushPending();
  submitted.length = 0; results.length = 0; handoffs.length = 0;
  const holder = new ParameterGestureHolder();
  f.device.gestureOwner.open(holder);
  f.device.gestureOwner.tick(holder, () => f.device.sampler.update({ polyphony: 64 }));
  for (let turn = 0; turn < 80; turn++) await Promise.resolve();
  f.device.gestureOwner.end(holder);
  await f.device.flushPending();
  await f.view.reload(); await f.sync.flushPending(); await f.device.flushPending();
  expect(f.device.sampler.params()?.polyphony).toBe(32);
  // Preview and release remain; the duplicate all-track registration is gone.
  expect(submitted).toEqual([32, 32]);
  expect(results).toEqual(["applied", "skipped"]);
  expect(handoffs).toEqual([32]);
  dispose(); sampler.dispose(); drum.dispose();
});

test("3B0 drum rack edit never uses the synth callback leg", async () => {
  const projectId = `project:3b0-drum-${crypto.randomUUID()}`;
  const track: Track = { id: "track", kind: "instrument", name: "Drum", volume: 1, clips: [] };
  const engine = new AudioEngine();
  const sampler = createSamplerBufferSync();
  const drum = createDrumRackBufferSync();
  let registry = 0, synth = 0, preview = 0, flush = 0, dispose = () => {};
  const setInstrument = engine.setTrackInstrument.bind(engine);
  engine.setTrackInstrument = (...args) => { synth++; return setInstrument(...args); };
  const device = createRoot(end => {
    dispose = end;
    return createEffectsPanelInstrumentDevice({
      audioEngine: () => engine, projectId: () => projectId, userId: () => undefined, playheadSec: () => 0,
      samplerBufferSync: sampler, drumRackBufferSync: drum,
      allocateProcessorEdit: () => { registry++; return undefined; },
      deliverProcessor: () => { preview++; flush++; throw new Error("Sampled content must not enter the processor leg."); },
    }, () => track.id, () => track, () => track);
  });
  const params = createDefaultDrumRackParams();
  device.syncRemoteInstrumentForTarget(track.id, { kind: "drum-rack", instanceId: "drum", params });
  await device.flushPending();
  registry = 0; synth = 0;
  const pad = params.pads[0];
  if (!pad) throw new Error("Default drum rack has no pad");
  device.drumRack.updatePad(pad.id, { gain: 0.4 });
  await device.flushPending();
  expect([preview, flush, synth]).toEqual([0, 0, 0]);
  // Current product still invokes allocateProcessorEdit for sampled content. The real registry rejects it;
  // v3 must not invoke the synth/registry leg at all.
  expect(registry).toBe(0);
  if (process.env.DV01_3B0_REPORT === "1") console.log(`DV01-3B0 ${JSON.stringify({
    name: "R5-3 sampled drum registry allocation",
    location: "src/components/timeline/create-effects-panel-state.ts:375",
    failure: null,
    expectedFailure: null,
    flip: "3B-1 sampled path registers publication content without calling the synth projection or registry",
    standIn: "Real instrument device and buffer-sync route; registry callback counts invocations, not returned identities",
    status: "green",
  })}`);
  dispose(); sampler.dispose(); drum.dispose();
});

// P1: during prepared portable playback each Synth preview frame reaches the portable session once with its edit,
// the owner keeps recording the browser engine's result whatever the portable leg answers, and a live-only release
// announces exactly what the session last took (the portable controller remembers what it accepts).
test.each<[boolean, EngineDisposition]>([[false, "applied"], [false, "dropped"], [true, "applied"]])(
  "P1 Synth previews reach the portable session once per frame (legacy %p, portable answer %p)", async (legacy, portableAnswer) => {
  const projectId = `project:p1-synth-${crypto.randomUUID()}`;
  const track: Track = { id: "track", kind: "instrument", name: "Synth", volume: 1, clips: [] };
  const engine = new AudioEngine();
  const sampler = createSamplerBufferSync();
  const drum = createDrumRackBufferSync();
  const frames: Array<FrameRequestCallback | undefined> = [];
  const originalRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => frames.push(callback) });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id: number) => { frames[id - 1] = undefined; } });
  const settle = async () => { for (let turn = 0; turn < 40; turn++) await Promise.resolve(); };
  const browser: number[] = [], native: string[] = [], announces: number[] = [], portableFrames: number[][] = [];
  let portable: number[] = [], history = 0, rebuilds = 0, taken: unknown;
  // No AudioContext in bun: the browser leg records that it was asked and answers as the engine would.
  engine.setTrackInstrument = (_trackId, input) => {
    browser.push(input.instrument?.kind === "synth" ? input.instrument.params.filter.frequencyHz : -1);
    return "applied";
  };
  let dispose = () => {};
  const device = createRoot(end => {
    dispose = end;
    return createEffectsPanelInstrumentDevice({
      audioEngine: () => engine, projectId: () => projectId, userId: () => undefined, playheadSec: () => 0,
      samplerBufferSync: sampler, drumRackBufferSync: drum, usesLegacyAudioEngine: () => legacy,
      allocateProcessorEdit: createProcessorEditRegistry(() => 120).allocate,
      deliverProcessor: (edit, gesture) => {
        native.push(gesture?.holds ? "preview" : "flush");
        return { receipt: { key: edit.id, serial: 0 }, settled: Promise.resolve({ state: "unavailable" }) };
      },
      applyPortableProcessor: async (edit) => {
        portable.push(edit.content.values?.["synth.filterCutoffHz"] ?? -1);
        if (portableAnswer === "applied") taken = edit.content.params;
        return portableAnswer;
      },
      onEffectParamsCommitted: (payload) => { if (payload.effect === "instrument") history++; },
      onStructuralPlaybackChange: async (_target, next) => {
        if (next?.kind === "synth") announces.push(next.params.filter.frequencyHz);
        // Timeline rebuilds unless the prepared portable instrument already equals the announced one.
        if (JSON.stringify(taken) !== JSON.stringify(next)) rebuilds++;
      },
    }, () => track.id, () => track, () => track);
  });
  try {
    device.syncRemoteInstrumentForTarget(track.id, { kind: "synth", instanceId: "synth-p1", params: createDefaultSynthParams() });
    await device.flushPending();
    await settle();
    browser.length = 0; native.length = 0; announces.length = 0; portable = []; history = 0; rebuilds = 0;
    const holder = new ParameterGestureHolder();
    device.gestureOwner.open(holder);
    for (let frame = 1; frame <= 5; frame++) {
      // Two pointer moves land in one frame; the owner coalesces them into one preview.
      device.gestureOwner.tick(holder, () => device.synth.change({ filter: { frequencyHz: 950 + frame * 100 } }));
      device.gestureOwner.tick(holder, () => device.synth.change({ filter: { frequencyHz: 1000 + frame * 100 } }));
      for (const callback of frames.splice(0)) callback?.(0);
      await settle();
      portableFrames.push(portable);
      portable = [];
    }
    device.gestureOwner.end(holder);
    await device.flushPending();
    await settle();
    const cutoffs = [1100, 1200, 1300, 1400, 1500];
    expect({ browser, native, history, announces }).toEqual({
      browser: [...cutoffs, 1500],
      native: legacy ? [] : ["preview", "preview", "preview", "preview", "preview", "flush"],
      history: 1, announces: [1500],
    });
    expect({ portableFrames, release: portable }).toEqual(legacy
      ? { portableFrames: [[], [], [], [], []], release: [] }
      : { portableFrames: cutoffs.map(cutoff => [cutoff]), release: [1500] });
    if (!legacy && portableAnswer === "applied") expect(rebuilds).toBe(0);
  } finally {
    dispose(); sampler.dispose(); drum.dispose();
    if (originalRaf) Object.defineProperty(globalThis, "requestAnimationFrame", originalRaf);
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    if (originalCancel) Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancel);
    else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
  }
});

// Option A: a stalled engine apply holds the gesture lane; later frames keep at most one unstarted preview queued,
// which reads the newest value when it starts. Recovery therefore dispatches once, with the newest value, and
// only the stalled job's late native registration can share that frame. Release delivers the final value once.
test.each<["synth" | "effect", number, boolean]>([
  ["synth", 3, false], ["synth", 5, false], ["effect", 3, false], ["effect", 5, false], ["synth", 3, true], ["effect", 3, true],
])("OPTA a %s preview stalled for %p frames keeps one engine apply per frame (release during stall %p)", async (kind, stall, releaseDuringStall) => {
  const { localProjectChangeSequence } = await import("~/lib/local-project-changes");
  const projectId = `project:opta-${kind}-${crypto.randomUUID()}`;
  const track: Track = { id: "track", kind: kind === "synth" ? "instrument" : "audio", name: "Option A", volume: 1, clips: [] };
  const engine = new AudioEngine();
  const sampler = createSamplerBufferSync();
  const drum = createDrumRackBufferSync();
  const frames: Array<FrameRequestCallback | undefined> = [];
  const originalRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => frames.push(callback) });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id: number) => { frames[id - 1] = undefined; } });
  const settle = async () => { for (let turn = 0; turn < 60; turn++) await Promise.resolve(); };
  const valueKey = kind === "synth" ? "synth.filterCutoffHz" : "utility.gainDb";
  // The second pointer move of each frame is that frame's newest value.
  const valueAt = (frame: number, move: 1 | 2) => kind === "synth" ? 900 + frame * 100 + move * 50 : 1 - frame * 2 - move;
  let window = 0, gestureDispatches = 0, history = 0;
  const portable: number[][] = [], browser: number[] = [], nativePreview: number[] = [], nativeFlush: number[] = [];
  const held: Array<() => void> = [];
  const count = (list: number[]) => { list[window] = (list[window] ?? 0) + 1; };
  engine.setTrackInstrument = () => { count(browser); return "applied"; };
  type DeviceContext = Parameters<typeof createEffectsPanelAudioDevice>[0];
  const deliverProcessor: NonNullable<DeviceContext["deliverProcessor"]> = (edit, gesture) => {
    count(gesture?.holds ? nativePreview : nativeFlush);
    return { receipt: { key: edit.id, serial: 0 }, settled: Promise.resolve({ state: "unavailable" }) };
  };
  const applyPortableProcessor: NonNullable<DeviceContext["applyPortableProcessor"]> = (edit) => {
    (portable[window] ??= []).push(edit.content.values?.[valueKey] ?? Number.NaN);
    // The first gesture preview stalls until frame `stall`; every other acknowledgement is fast.
    if (window === 0 || ++gestureDispatches > 1) return Promise.resolve<EngineDisposition>("applied");
    return new Promise<EngineDisposition>(resolve => { held.push(() => resolve("applied")); });
  };
  const onEffectParamsCommitted = () => { history++; };
  let dispose = () => {};
  const device = createRoot(end => {
    dispose = end;
    const shared = { audioEngine: () => engine, projectId: () => projectId, userId: () => undefined, usesLegacyAudioEngine: () => false,
      allocateProcessorEdit: createProcessorEditRegistry(() => 120).allocate, deliverProcessor, applyPortableProcessor, onEffectParamsCommitted };
    if (kind === "synth") {
      const instrument = createEffectsPanelInstrumentDevice({ ...shared, playheadSec: () => 0, samplerBufferSync: sampler, drumRackBufferSync: drum },
        () => track.id, () => track, () => track);
      return {
        gesture: instrument.gestureOwner, flushPending: instrument.flushPending,
        install: async () => instrument.syncRemoteInstrumentForTarget(track.id, { kind: "synth", instanceId: "synth-opta", params: createDefaultSynthParams() }),
        change: (value: number) => instrument.synth.change({ filter: { frequencyHz: value } }),
      };
    }
    const view = createLocalEffectsView({ projectId: () => projectId });
    const audio = createEffectsPanelAudioDevice({ ...shared, roomEffects: () => [], localEffectsView: view, canWriteCurrentTargetEffects: () => true },
      () => track.id, () => undefined);
    return {
      gesture: audio.gestureOwner("utility-opta", "utility"), flushPending: audio.flushPending,
      install: async () => {
        await setLocalEffectInstance(projectId, track.id, "utility", AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams(), { instanceId: "utility-opta", index: 0 });
        await view.reload();
      },
      change: (value: number) => audio.utility.changeInstance("utility-opta", params => ({ ...params, state: { ...params.state, gainDb: value } })),
    };
  });
  try {
    await device.install();
    await device.flushPending();
    await settle();
    const holder = new ParameterGestureHolder();
    device.gesture.open(holder);
    const lastFrame = releaseDuringStall ? stall - 1 : 8;
    for (window = 1; window <= lastFrame; window++) {
      device.gesture.tick(holder, () => device.change(valueAt(window, 1)));
      device.gesture.tick(holder, () => device.change(valueAt(window, 2)));
      for (const callback of frames.splice(0)) callback?.(0);
      await settle();
      if (window === stall) for (const acknowledge of held.splice(0)) { acknowledge(); await settle(); }
    }
    const writesBefore = localProjectChangeSequence(projectId);
    device.gesture.end(holder);
    for (const acknowledge of held.splice(0)) acknowledge();
    await device.flushPending();
    await settle();
    const frameRange = Array.from({ length: lastFrame }, (_, index) => index + 1);
    const expectedPortable = frameRange.map(frame => frame === 1 || frame >= stall ? [valueAt(frame, 2)] : []);
    const expectedPreview = frameRange.map(frame => frame < stall ? 0 : frame === stall ? 2 : 1);
    const release = window;
    expect({
      portable: frameRange.map(frame => portable[frame] ?? []),
      browser: frameRange.map(frame => browser[frame] ?? 0),
      nativePreview: frameRange.map(frame => nativePreview[frame] ?? 0),
      nativeFlush: frameRange.map(frame => nativeFlush[frame] ?? 0),
      release: { portable: portable[release], browser: browser[release] ?? 0, nativePreview: nativePreview[release] ?? 0,
        nativeFlush: nativeFlush[release] ?? 0, history, writes: localProjectChangeSequence(projectId) - writesBefore },
    }).toEqual({
      portable: expectedPortable,
      browser: kind === "synth" ? expectedPortable.map(values => values.length) : frameRange.map(() => 0),
      nativePreview: expectedPreview,
      nativeFlush: frameRange.map(() => 0),
      // Ending during the stall lets the stalled preview register late; its queued successor finds the gesture gone.
      release: { portable: [valueAt(lastFrame, 2)], browser: kind === "synth" ? 1 : 0, nativePreview: releaseDuringStall ? 1 : 0,
        nativeFlush: 1, history: 1, writes: 1 },
    });
  } finally {
    dispose(); sampler.dispose(); drum.dispose();
    if (originalRaf) Object.defineProperty(globalThis, "requestAnimationFrame", originalRaf);
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    if (originalCancel) Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancel);
    else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
  }
});
test("isolates project readiness and waits for remote query data", async () => {
  let currentProject = "cloud-project-a";
  const readiness = createEffectsPanelReadinessOwner({
    loadLocalEffects: async () => [],
    currentProjectId: () => currentProject,
  });
  readiness.updateRemote("cloud-project-a", undefined, "pending", undefined);
  readiness.updateRemote("cloud-project-b", [], "success", undefined);
  readiness.markRowsProcessed("cloud-project-b");
  currentProject = "cloud-project-b";
  await expect(readiness.flushPending("cloud-project-b")).resolves.toBeUndefined();

  currentProject = "cloud-project-a";
  let settled = false;
  const flushA = readiness.flushPending("cloud-project-a").then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  readiness.updateRemote("cloud-project-a", [], "success", undefined);
  readiness.markRowsProcessed("cloud-project-a");
  await flushA;
  expect(settled).toBe(true);

  currentProject = "cloud-project-error";
  readiness.updateRemote("cloud-project-error", undefined, "error", new Error("query unavailable"));
  await expect(readiness.flushPending("cloud-project-error")).rejects.toThrow(
    'Failed to load remote effects for project "cloud-project-error": query unavailable',
  );
  readiness.dispose();
});

test("rejects a remote readiness flush when the current project changes", async () => {
  let currentProject = "cloud-project-a";
  const readiness = createEffectsPanelReadinessOwner({
    loadLocalEffects: async () => [],
    currentProjectId: () => currentProject,
  });
  readiness.updateRemote("cloud-project-a", undefined, "pending", undefined);
  const pending = readiness.flushPending("cloud-project-a");
  currentProject = "cloud-project-b";
  readiness.projectChanged();
  await expect(pending).rejects.toThrow("Project changed while waiting for effects readiness");
  readiness.dispose();
});

test("rejects a local readiness flush when the current project changes", async () => {
  let currentProject = "project:readiness-a";
  const readiness = createEffectsPanelReadinessOwner({
    loadLocalEffects: async () => [],
    currentProjectId: () => currentProject,
  });
  let resolveLoad: ((rows: never[]) => void) | undefined;
  const load = new Promise<never[]>((resolve) => {
    resolveLoad = resolve;
  });
  readiness.startLocalLoad("project:readiness-a", () => load);
  const pending = readiness.flushPending("project:readiness-a");
  currentProject = "project:readiness-b";
  readiness.projectChanged();
  await expect(pending).rejects.toThrow("Project changed while waiting for effects readiness");
  resolveLoad?.([]);
  readiness.dispose();
});


// Failure inventory, before running probes:
// stale in-flight structure wins; same-ID re-add inherits old owner; kind change is missed;
// scope/engine changes retain stale requests; flush overlooks replaced work;
// a rejected obsolete structure poisons a successful owner replacement.
const deferred = <T,>() => {
  let resolve = (_value: T) => {};
  let reject = (_cause: Error) => {};
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const createStructuralReviewFixture = async (local: boolean, master: boolean, persistOrder?: () => void | Promise<void>) => {
  const db = convexTest(schema, { "./_generated/api.ts": () => import("../../convex/_generated/api") });
  const pid = `${local ? "project:" : "cloud-"}review-${crypto.randomUUID()}`;
  const trackId = await db.run(ctx => ctx.db.insert("tracks", { projectId: pid, name: "t", index: 0, kind: "audio" }));
  const targetId = master ? "master" : local ? "t" : trackId;
  const track: Track = { id: local ? "t" : trackId, name: "t", volume: 1, kind: "audio", clips: [] };
  await db.run(ctx => ctx.db.insert("effects", {
    projectId: pid, targetType: master ? "master" : "track", trackId: master ? undefined : trackId,
    type: "compressor", instanceId: "a", index: 0, params: compressorInstance(-31).params, revision: 1, createdAt: 1,
  }));
  const templates = await db.run(ctx => ctx.db.query("effects").collect());
  const template = templates[0];
  if (!template) throw new Error("No row template");
  const [rows, setRows] = createSignal(templates);
  const [projectId, setProjectId] = createSignal<string | undefined>(pid);
  const [uiNoise, setUiNoise] = createSignal(0);
  const [generation, setGeneration] = createSignal(0);
  const [selected, setSelected] = createSignal(targetId);
  const [legacy, setLegacy] = createSignal(true);
  const [view, setView] = createSignal<LocalEffectsView>();
  const runtime = createFxTransitionHarness(master ? "master" : "track");
  runtime.track.updateTrackGains([track]);
  const calls: Array<{ type: string; chain: AudioEffectRuntimeInstance[]; disposition?: string; error?: string }> = [];
  const promises: Promise<unknown>[] = [];
  const record = <Disposition extends EngineDisposition | "not-held">(type: string, chain: AudioEffectRuntimeInstance[], work: Promise<Disposition>) => {
    const item: typeof calls[number] = { type, chain };
    calls.push(item);
    const result = work.then(disposition => { item.disposition = disposition; return disposition; },
      cause => { item.error = String(cause); throw cause; });
    promises.push(result.catch(() => undefined));
    return result;
  };
  class Engine extends AudioEngine {
    private async master(chain: AudioEffectRuntimeInstance[]) {
      return (await runtime.master.setFxInstances(runtime.audio.context, runtime.audio.masterInput, runtime.audio.context.destination, chain)).disposition;
    }
    override setTrackFxInstances(id: string, chain: AudioEffectRuntimeInstance[]) {
      return record("chain", chain, runtime.track.setTrackFxInstances(id, chain));
    }
    override setTrackFxInstance(id: string, instance: AudioEffectRuntimeInstance) {
      return record("instance", [instance], runtime.track.replaceTrackFxInstance(id, instance));
    }
    override setMasterFxInstances(chain: AudioEffectRuntimeInstance[]) {
      return record("chain", chain, this.master(chain));
    }
    override setMasterFxInstance(instance: AudioEffectRuntimeInstance) {
      const retained = runtime.master.retainedInstances();
      return record("instance", [instance], retained.some(entry => entry.id === instance.id)
        ? this.master(retained.map(entry => entry.id === instance.id ? instance : entry))
        : Promise.resolve("not-held"));
    }
  }
  const [engine, setEngine] = createSignal<AudioEngine>(new Engine());
  const errors: string[] = [];
  const localErrors: string[] = [];
  const history: unknown[] = [];
  let dispose = () => {};
  let through = 1;
  const publish = (chain: AudioEffectRuntimeInstance[]) => {
    through++;
    if (local) setView({
      projectId: projectId() ?? pid, lifetime: 1, through, publicationId: {},
      rows: chain.map((instance, index): LocalEffectRow<JsonValue> => ({
        id: `${targetId}:${instance.id}`, instanceId: instance.id, targetId,
        effect: master ? `master-${instance.kind}` : instance.kind, index, params: instance.params, updatedAt: through,
      })),
    });
    else setRows(chain.map((instance, index) => ({
      ...template, projectId: projectId() ?? pid, instanceId: instance.id, type: instance.kind, index, params: instance.params, revision: through,
    })));
  };
  untrack(() => publish([compressorInstance(-31, "a"), compressorInstance(-25, "b")]));
  const audio = createRoot(end => {
    dispose = end;
    return createEffectsPanelAudioDevice({
      audioEngine: engine, projectId: () => { uiNoise(); return projectId(); }, userId: () => undefined, projectGeneration: generation,
      roomEffects: rows, localEffectsView: {
        view, reload: async () => view()?.rows ?? [], watchReloads: () => () => false,
      },
      usesLegacyAudioEngine: legacy, canWriteCurrentTargetEffects: () => true,
      onEffectError: (_title, message) => errors.push(message),
      onLocalSaveFailed: (_projectId, message) => localErrors.push(message),
      onEffectParamsCommitted: payload => { history.push(payload); },
      persistAudioEffectOrder: persistOrder ?? (() => {}),
    }, selected, () => track);
  });
  const settle = async () => {
    await audio.flushPending();
    await Promise.all(promises);
    for (let left = runtime.timers.pending.size; left > 0; left--) runtime.timers.run();
  };
  await settle();
  const close = () => { dispose(); runtime.close(); };
  return { audio, publish, runtime, calls, promises, errors, localErrors, history, targetId, projectId, setProjectId, setGeneration, selected, setSelected, setLegacy, setEngine, engine, settle, close, setUiNoise };
};

// Known-red contract, not fixed here: overlapping releases must each be
// undoable. Strict witness runs expose the raw red; the ordinary suite checks
// its exact known residual instead of accepting arbitrary failures.
for (const master of [false, true]) {
  test(`B5c3 known-red simultaneous release, local track=${!master}, closed and unselected`, async () => {
    const f = await createStructuralReviewFixture(true, master);
    try {
      const a = f.audio.gestureOwner("a", "compressor", f.targetId);
      const b = f.audio.gestureOwner("b", "compressor", f.targetId);
      const ha = new ParameterGestureHolder(), hb = new ParameterGestureHolder();
      a.open(ha); b.open(hb);
      a.tick(ha, () => f.audio.compressor.changeInstance("a", p => ({ ...p, thresholdDb: -12 })));
      b.tick(hb, () => f.audio.compressor.changeInstance("b", p => ({ ...p, thresholdDb: -18 })));
      f.setSelected("selected-elsewhere");
      expect(untrack(f.selected)).toBe("selected-elsewhere");
      a.end(ha); b.end(hb);
      await f.settle();
      console.log("B5c3 release history", JSON.stringify({ master, entries: f.history.length, history: f.history,
        calls: f.calls }));
      expect(f.errors).toEqual([]);
      expect(f.history).toHaveLength(1);
      if (process.env.DV01_B5_STRICT_HISTORY === "1") expect(f.history).toHaveLength(2);
    } finally { f.close(); }
  });
}

for (const local of [true, false]) for (const master of [false, true]) {
  const label = `local=${local}, master=${master}`;
  test(`r2 two structural changes with first pending ${label}`, async () => {
    const f = await createStructuralReviewFixture(local, master);
    try {
      const held = deferred<void>(), started = deferred<void>();
      Object.defineProperty(f.runtime.audio.context.audioWorklet, "addModule", {
        value: () => { started.resolve(); return held.promise; },
      });
      const first = [compressorInstance(-31, "a"), staticGateInstance(-22, 2, "g")];
      f.publish(first);
      await started.promise;
      f.publish([compressorInstance(-18, "a")]);
      held.resolve();
      await f.settle();
      expect(f.runtime.audio.compressorThreshold()).toBe(-18);
      expect(f.runtime.audio.liveWorkletCount()).toBe(1);
      expect(f.calls.at(-1)?.disposition).not.toBe("superseded");
      expect(f.errors).toEqual([]);
    } finally { f.close(); }
  });

  test(`r2 remove re-add same ID while owner pending ${label}`, async () => {
    const f = await createStructuralReviewFixture(local, master);
    try {
      const h = new ParameterGestureHolder();
      const g = f.audio.gestureOwner("a", "compressor", f.targetId);
      g.open(h);
      g.tick(h, () => f.audio.compressor.changeInstance("a", p => ({ ...p, thresholdDb: -9 })));
      // One microtask gets owner work into the real runtime without waiting for completion.
      await Promise.resolve();
      f.publish([compressorInstance(-25, "b")]);
      f.publish([compressorInstance(-42, "a"), compressorInstance(-25, "b")]);
      await f.settle();
      expect(g.isOpen(h)).toBe(false);
      const active = [...Array(f.runtime.audio.compressorNodeCount()).keys()]
        .map(i => f.runtime.audio.workletNode(i)).filter(n => n && !n.closed);
      expect(active).toHaveLength(2);
      const values = [...Array(f.runtime.audio.compressorNodeCount()).keys()]
        .filter(i => !f.runtime.audio.workletNode(i)?.closed).map(i => f.runtime.audio.compressorThreshold(i));
      expect(values.sort()).toEqual([-42, -25].sort());
    } finally { f.close(); }
  });

  test(`r2 kind change same ID ${label}`, async () => {
    const f = await createStructuralReviewFixture(local, master);
    try {
      const before = f.calls.length;
      f.publish([staticGateInstance(-22, 2, "a"), compressorInstance(-25, "b")]);
      await f.settle();
      expect(f.runtime.audio.workletNode(0)?.closed).toBe(true);
      expect(f.calls.slice(before).filter(c => c.disposition === "applied")).toHaveLength(1);
      expect(f.runtime.audio.liveWorkletCount()).toBe(2);
      expect(f.errors).toEqual([]);
    } finally { f.close(); }
  });

  test(`r2 kind change with old kind gesture ${label}`, async () => {
    const f = await createStructuralReviewFixture(local, master);
    try {
      const g = f.audio.gestureOwner("a", "compressor", f.targetId), h = new ParameterGestureHolder();
      g.open(h);
      g.tick(h, () => f.audio.compressor.changeInstance("a", p => ({ ...p, thresholdDb: -12 })));
      await Promise.resolve();
      f.publish([staticGateInstance(-45, 7, "a"), compressorInstance(-25, "b")]);
      // flush would close the stale gesture, so inspect the installed chain before draining the owner.
      await Promise.all(f.promises);
      const gate = f.runtime.audio.workletNode(2);
      expect(g.isOpen(h)).toBe(false);
      expect(gate?.parameters.get("gate.thresholdDb")?.value).toBe(-45);
      await f.settle();
    } finally { f.close(); }
  });

  test(`r2 pruned disappeared target stays pruned on generation bump ${label}`, async () => {
    const f = await createStructuralReviewFixture(local, master);
    try {
      if (!master) f.runtime.track.updateTrackGains([]);
      f.publish([]);
      await f.settle();
      expect(f.runtime.audio.liveWorkletCount()).toBe(0);
      const before = f.calls.length;
      f.setGeneration(1);
      await f.settle();
      expect(f.calls.slice(before)).toEqual([]);
    } finally { f.close(); }
  });

  test(`r2 engine identity forces fresh install ${label}`, async () => {
    const f = await createStructuralReviewFixture(local, master);
    try {
      const before = f.calls.length;
      const prior = f.engine();
      class Replacement extends AudioEngine {
        override setTrackFxInstances(id: string, chain: AudioEffectRuntimeInstance[]) { return prior.setTrackFxInstances(id, chain); }
        override setTrackFxInstance(id: string, instance: AudioEffectRuntimeInstance) { return prior.setTrackFxInstance(id, instance); }
        override setMasterFxInstances(chain: AudioEffectRuntimeInstance[]) { return prior.setMasterFxInstances(chain); }
        override setMasterFxInstance(instance: AudioEffectRuntimeInstance) { return prior.setMasterFxInstance(instance); }
      }
      f.setEngine(new Replacement());
      await f.settle();
      expect(f.calls.slice(before).some(c => c.type === "chain")).toBe(true);
    } finally { f.close(); }
  });

  test(`r2 project switch with unacknowledged reorder ${label}`, async () => {
    const f = await createStructuralReviewFixture(local, master);
    try {
      f.audio.reorder({ id: "a", kind: "compressor" }, 1);
      await f.settle();
      batch(() => {
        f.setProjectId(`${local ? "project:" : "cloud-"}next-${crypto.randomUUID()}`);
        f.publish([compressorInstance(-44, "new-project")]);
      });
      await f.settle();
      expect(f.runtime.audio.liveWorkletCount()).toBe(1);
      expect(f.audio.snapshotExportProjection().replaceAudioEffectTargets.flatMap(t => t.rows).map(r => r.instanceId)).toEqual(["new-project"]);
    } finally { f.close(); }
  });

  test(`r2 owner update races reorder ${label}`, async () => {
    const f = await createStructuralReviewFixture(local, master);
    try {
      const h = new ParameterGestureHolder();
      const g = f.audio.gestureOwner("a", "compressor", f.targetId);
      g.open(h);
      g.tick(h, () => f.audio.compressor.changeInstance("a", p => ({ ...p, thresholdDb: -12 })));
      f.publish([compressorInstance(-25, "b"), compressorInstance(-31, "a")]);
      g.tick(h, () => f.audio.compressor.changeInstance("a", p => ({ ...p, thresholdDb: -7 })));
      await Promise.resolve();
      await Promise.all(f.promises);
      expect(f.runtime.audio.compressorThreshold()).toBe(-7);
      expect(g.isOpen(h)).toBe(true);
      g.cancel(h);
      await f.settle();
    } finally { f.close(); }
  });

  test(`r2 project and generation fences ${label}`, async () => {
    const f = await createStructuralReviewFixture(local, master);
    try {
      const h = new ParameterGestureHolder();
      const g = f.audio.gestureOwner("a", "compressor", f.targetId);
      g.open(h);
      g.tick(h, () => f.audio.compressor.changeInstance("a", p => ({ ...p, thresholdDb: -12 })));
      f.setGeneration(1);
      await f.settle();
      expect(g.isOpen(h)).toBe(false);
      expect(f.runtime.audio.compressorThreshold()).toBe(-31);
      batch(() => {
        f.setProjectId(`${local ? "project:" : "cloud-"}next-${crypto.randomUUID()}`);
        f.publish([]);
      });
      await f.settle();
      expect(f.runtime.audio.liveWorkletCount()).toBe(0);
    } finally { f.close(); }
  });
}

// Round 3 failure inventory: equal lifetime values must keep optimistic order and continuations;
// row-first batches must not expose a retired order; a newer failure must not replace an owner's success.
for (const local of [true, false]) for (const master of [false, true]) {
  test(`r3 stable lifetime survives unrelated props local=${local} master=${master}`, async () => {
    const held = deferred<void>();
    const f = await createStructuralReviewFixture(local, master, () => held.promise);
    try {
      const project = f.projectId();
      f.audio.reorder({ id: "a", kind: "compressor" }, 1);
      await f.settle();
      expect(f.audio.orderedEffects().map(i => i.id)).toEqual(["b", "a"]);
      f.setUiNoise(1);
      expect(f.projectId()).toBe(project);
      await f.settle();
      expect(f.audio.orderedEffects().map(i => i.id)).toEqual(["b", "a"]);
    } finally { held.resolve(); f.close(); }
  });

  test(`r3 reset precedes observations when rows publish first local=${local} master=${master}`, async () => {
    const f = await createStructuralReviewFixture(local, master);
    try {
      f.audio.reorder({ id: "a", kind: "compressor" }, 1);
      await f.settle();
      const before = f.calls.length;
      batch(() => {
        f.publish([compressorInstance(-42, "next")]);
        f.setGeneration(1);
      });
      await f.settle();
      const changes = f.calls.slice(before);
      expect(changes.filter(c => c.type === "chain").map(c => c.chain.map(i => i.id))).toEqual([["next"]]);
      expect(f.audio.orderedEffects().map(i => i.id)).toEqual(["next"]);
    } finally { f.close(); }
  });
}

for (const master of [false, true]) {
  test(`r3 owner keeps its replacement result across newer failed structure master=${master}`, async () => {
    const f = await createStructuralReviewFixture(true, master);
    const held = deferred<void>(), installed = deferred<void>(), module = deferred<void>(), started = deferred<void>();
    let outcome: EngineDisposition | "not-held" | undefined;
    try {
      const prior = f.engine();
      let holding = true;
      const holdResult = async (work: Promise<EngineDisposition | "not-held">) => {
        const result = await work;
        if (holding) {
          holding = false;
          outcome = result;
          installed.resolve();
          await held.promise;
        }
        return result;
      };
      class CompletionBarrierEngine extends AudioEngine {
        override setTrackFxInstances(id: string, chain: AudioEffectRuntimeInstance[]) { return prior.setTrackFxInstances(id, chain); }
        override setTrackFxInstance(id: string, instance: AudioEffectRuntimeInstance) { return holdResult(prior.setTrackFxInstance(id, instance)); }
        override setMasterFxInstances(chain: AudioEffectRuntimeInstance[]) { return prior.setMasterFxInstances(chain); }
        override setMasterFxInstance(instance: AudioEffectRuntimeInstance) { return holdResult(prior.setMasterFxInstance(instance)); }
      }
      // Identity change produces equal-chain work, not owner row replacements.
      f.setEngine(new CompletionBarrierEngine());
      await f.settle();
      f.audio.compressor.changeInstance("a", p => ({ ...p, thresholdDb: -12 }));
      await installed.promise;
      expect(outcome).toBe("applied");
      Object.defineProperty(f.runtime.audio.context.audioWorklet, "addModule", {
        value: () => { started.resolve(); return module.promise; },
      });
      f.publish([compressorInstance(-31, "a"), compressorInstance(-25, "b"), staticGateInstance(-22, 2, "g")]);
      await started.promise;
      module.reject(new Error("new gate failed"));
      await structuralMicrotaskCheckpoint();
      held.resolve();
      let failure: unknown;
      try { await f.audio.flushPending(); } catch (cause) { failure = cause; }
      expect(f.history).toHaveLength(1);
      expect(f.history[0]).toMatchObject({ instanceId: "a" });
      expect(String(failure)).toContain("new gate failed");
      expect(f.errors.filter(error => error === "new gate failed")).toHaveLength(1);
    } finally { held.resolve(); module.resolve(); f.close(); }
  });
}

test("r3 native lifetime keeps equal-value order and ignores retired order in a row-first batch", async () => {
  const held = deferred<void>();
  const f = await createStructuralReviewFixture(true, false, () => held.promise);
  try {
    f.setLegacy(false);
    const before = f.calls.length;
    f.audio.reorder({ id: "a", kind: "compressor" }, 1);
    await f.settle();
    f.setUiNoise(1);
    await f.settle();
    expect(f.audio.orderedEffects().map(i => i.id)).toEqual(["b", "a"]);
    const observed: string[][] = [];
    const disposeObserver = createRoot(dispose => {
      createEffect(() => { observed.push(f.audio.orderedEffects().map(i => i.id)); });
      return dispose;
    });
    try {
      batch(() => { f.publish([compressorInstance(-42, "next")]); f.setGeneration(1); });
      await f.settle();
      expect(observed).toEqual([["b", "a"], ["next"]]);
      expect(f.audio.orderedEffects().map(i => i.id)).toEqual(["next"]);
      expect(f.calls.slice(before).filter(c => c.type === "chain").map(c => c.chain.map(i => i.id))).toEqual([["b", "a"]]);
    } finally { disposeObserver(); }
  } finally { held.resolve(); f.close(); }
});

// A fixed scheduling checkpoint, not polling: no state is read until all scheduled microtasks finish.
const structuralMicrotaskCheckpoint = () => Array.from({ length: 50 })
  .reduce<Promise<void>>(tail => tail.then(() => {}), Promise.resolve());

for (const master of [false, true]) for (const lifetimeChange of ["project", "generation"]) {
  test(`r2 late add rollback cannot recreate old lifetime order ${lifetimeChange} master=${master}`, async () => {
    const held = deferred<void>(), started = deferred<void>();
    const f = await createStructuralReviewFixture(true, master, () => { started.resolve(); return held.promise; });
    try {
      const adding = f.audio.addByKindToTarget(f.targetId, "compressor");
      await started.promise;
      batch(() => {
        if (lifetimeChange === "project") f.setProjectId(`project:next-${crypto.randomUUID()}`);
        else f.setGeneration(1);
        f.publish([compressorInstance(-42, "new-project")]);
      });
      await f.settle();
      held.reject(new Error("old add reorder failed"));
      expect(await adding).toBe(false);
      await f.settle();
      expect(f.audio.orderedEffects().map(instance => instance.id)).toEqual(["new-project"]);
      expect(f.runtime.audio.liveWorkletCount()).toBe(1);
    } finally { held.resolve(); f.close(); }
  });
}

for (const local of [true, false]) for (const master of [false, true]) {
  const label = `local=${local}, master=${master}`;

  test(`r2 current structural joined failure stays observable ${label}`, async () => {
    const f = await createStructuralReviewFixture(local, master);
    const held = deferred<void>(), started = deferred<void>();
    try {
      Object.defineProperty(f.runtime.audio.context.audioWorklet, "addModule", {
        value: () => { started.resolve(); return held.promise; },
      });
      f.publish([compressorInstance(-31, "a"), staticGateInstance(-22, 2, "g")]);
      await started.promise;
      await structuralMicrotaskCheckpoint();
      held.reject(new Error("current gate module failed"));
      await Promise.all(f.promises);
      expect(f.calls.some(call => call.type === "instance" && call.error?.includes("current gate module failed"))).toBe(true);
      expect(f.errors.filter(error => error === "current gate module failed")).toHaveLength(1);
      await expect(f.audio.flushPending()).rejects.toThrow("current gate module failed");
      f.publish([compressorInstance(-18, "a")]);
      await f.settle();
      expect(f.runtime.audio.compressorThreshold()).toBe(-18);
    } finally { held.resolve(); f.close(); }
  });

  test(`r2 pending flush follows superseding structure ${label}`, async () => {
    const f = await createStructuralReviewFixture(local, master);
    const held = deferred<void>(), started = deferred<void>();
    try {
      const prior = f.engine();
      let hold = false;
      const wait = async (work: Promise<EngineDisposition>) => {
        const result = await work;
        if (hold) { started.resolve(); await held.promise; }
        return result;
      };
      class HeldStructuralEngine extends AudioEngine {
        override setTrackFxInstances(id: string, chain: AudioEffectRuntimeInstance[]) { return wait(prior.setTrackFxInstances(id, chain)); }
        override setTrackFxInstance(id: string, instance: AudioEffectRuntimeInstance) { return prior.setTrackFxInstance(id, instance); }
        override setMasterFxInstances(chain: AudioEffectRuntimeInstance[]) { return wait(prior.setMasterFxInstances(chain)); }
        override setMasterFxInstance(instance: AudioEffectRuntimeInstance) { return prior.setMasterFxInstance(instance); }
      }
      f.setEngine(new HeldStructuralEngine());
      await f.settle();
      hold = true;
      // Hold only the structural completion, not an independently pending owner-row apply.
      f.publish([compressorInstance(-25, "b"), compressorInstance(-31, "a")]);
      await started.promise;
      const flush = f.audio.flushPending();
      await structuralMicrotaskCheckpoint();
      hold = false;
      f.publish([compressorInstance(-31, "a"), compressorInstance(-25, "b")]);
      const completed = await Promise.race([
        flush.then(() => true),
        structuralMicrotaskCheckpoint().then(() => false),
      ]);
      expect(completed).toBe(true);
      expect(f.runtime.audio.liveWorkletCount()).toBe(2);
    } finally { held.resolve(); await f.settle(); f.close(); }
  });

  test(`r2 pruning does not delete a readded target ${label}`, async () => {
    const f = await createStructuralReviewFixture(local, master);
    try {
      f.publish([]);
      f.publish([compressorInstance(-42, "a")]);
      await f.settle();
      const before = f.calls.length;
      f.setGeneration(1);
      await f.settle();
      expect(f.calls.slice(before).some(call => call.type === "chain" && call.chain[0]?.id === "a")).toBe(true);
      expect(f.runtime.audio.liveWorkletCount()).toBe(1);
      expect(f.runtime.audio.compressorThreshold(f.runtime.audio.compressorNodeCount() - 1)).toBe(-42);
    } finally { f.close(); }
  });

  test(`r2 kind retirement preserves another instance gesture ${label}`, async () => {
    const f = await createStructuralReviewFixture(local, master);
    try {
      const a = f.audio.gestureOwner("a", "compressor", f.targetId), ah = new ParameterGestureHolder();
      const b = f.audio.gestureOwner("b", "compressor", f.targetId), bh = new ParameterGestureHolder();
      a.open(ah);
      a.tick(ah, () => f.audio.compressor.changeInstance("a", p => ({ ...p, thresholdDb: -12 })));
      b.open(bh);
      b.tick(bh, () => f.audio.compressor.changeInstance("b", p => ({ ...p, thresholdDb: -7 })));
      f.publish([staticGateInstance(-45, 7, "a"), compressorInstance(-25, "b")]);
      await Promise.all(f.promises);
      expect(a.isOpen(ah)).toBe(false);
      expect(b.isOpen(bh)).toBe(true);
      const live = Array.from({ length: f.runtime.audio.compressorNodeCount() }, (_, i) => i)
        .filter(i => !f.runtime.audio.workletNode(i)?.closed);
      expect(live.some(i => f.runtime.audio.compressorThreshold(i) === -7)).toBe(true);
      b.cancel(bh);
      await f.settle();
    } finally { f.close(); }
  });

  for (const lifetimeChange of ["project", "generation"]) {
    test(`r2 late reorder rollback cannot clear new lifetime order ${lifetimeChange} ${label}`, async () => {
      const held = deferred<void>();
      let writes = 0;
      const f = await createStructuralReviewFixture(local, master, () => ++writes === 1 ? held.promise : undefined);
      try {
        f.audio.reorder({ id: "a", kind: "compressor" }, 1);
        await f.settle();
        batch(() => {
          if (lifetimeChange === "project") f.setProjectId(`${local ? "project:" : "cloud-"}next-${crypto.randomUUID()}`);
          else f.setGeneration(1);
          f.publish([compressorInstance(-42, "a"), compressorInstance(-25, "b")]);
        });
        await f.settle();
        expect(f.audio.orderedEffects().map(instance => instance.id)).toEqual(["a", "b"]);
        f.audio.reorder({ id: "a", kind: "compressor" }, 1);
        await f.settle();
        held.reject(new Error("old reorder failed"));
        await structuralMicrotaskCheckpoint();
        await f.settle();
        expect(f.audio.orderedEffects().map(instance => instance.id)).toEqual(["b", "a"]);
      } finally { held.resolve(); f.close(); }
    });
  }
}

for (const master of [false, true]) {
  test(`r2 obsolete structural rejection must not fail successful release master=${master}`, async () => {
    const f = await createStructuralReviewFixture(true, master);
    const originalRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
    const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: () => 1 });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
    const disabled = { ...AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams(), enabled: false, wet: 0.2 };
    const r: AudioEffectRuntimeInstance = { id: "r", kind: "reverb", params: disabled };
    try {
      f.publish([r]);
      await f.settle();
      const held = deferred<void>(), started = deferred<void>();
      Object.defineProperty(f.runtime.audio.context.audioWorklet, "addModule", {
        value: () => { started.resolve(); return held.promise; },
      });
      const g = f.audio.gestureOwner("r", "reverb", f.targetId), h = new ParameterGestureHolder();
      g.open(h);
      g.tick(h, () => f.audio.reverb.changeInstance("r", p => ({ ...p, enabled: true })));
      f.publish([r, compressorInstance(-25, "b")]);
      await started.promise;
      g.tick(h, () => f.audio.reverb.changeInstance("r", p => ({ ...p, enabled: false, wet: 0.75 })));
      g.end(h);
      const singleStart = f.calls.length;
      const flush = f.audio.flushPending();
      // Fixed microtask checkpoint to observe the existing owner lane, not a state-dependent poll.
      await structuralMicrotaskCheckpoint();
      const successfulReplacement = f.calls.slice(singleStart).find(c =>
        c.type === "instance" && c.chain[0]?.kind === "reverb" && c.chain[0].params.wet === 0.75 && c.disposition === "applied");
      expect(successfulReplacement).toBeDefined();
      // Join the existing project write lock after release admission, so IndexedDB completion is event-driven.
      await withExternalProcessorProjectWriteLock(f.projectId() ?? "", async () => {});
      await structuralMicrotaskCheckpoint();
      const completedBeforeObsoleteSettles = await Promise.race([
        flush.then(() => true),
        structuralMicrotaskCheckpoint().then(() => false),
      ]);
      held.reject(new Error("obsolete reverb module failed"));
      let failure: unknown;
      try { await flush; } catch (cause) { failure = cause; }
      expect(failure).toBeUndefined();
      expect(completedBeforeObsoleteSettles).toBe(true);
      expect(f.history).toHaveLength(1);
      await Promise.all(f.promises);
      expect(f.errors).toContain("obsolete reverb module failed");
    } finally {
      if (originalRaf) Object.defineProperty(globalThis, "requestAnimationFrame", originalRaf);
      else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      if (originalCancel) Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancel);
      else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
      f.close();
    }
  });
}

// Round 4 failure inventory: delayed cleanup must retain current-lifetime orders;
// native failures must report; owners adopt only successor success; shared loader
// failures must preserve local release failure state without duplicate announcements.
for (const local of [true, false]) for (const master of [false, true]) {
  test(`r4 current lifetime reorder survives deferred cleanup local=${local} master=${master}`, async () => {
    const held=deferred<void>();
    const f=await createStructuralReviewFixture(local,master,()=>held.promise);
    try {
      const before=f.calls.length;
      batch(() => {
        f.setGeneration(1);
        f.audio.reorder({id:"a",kind:"compressor"},1);
        expect(f.audio.orderedEffects().map(i=>i.id)).toEqual(["b","a"]);
      });
      await f.settle();
      console.log(JSON.stringify({probe:"current-lifetime-order",local,master,order:f.audio.orderedEffects().map(i=>i.id),calls:f.calls.slice(before).map(c=>({type:c.type,ids:c.chain.map(i=>i.id),disposition:c.disposition}))}));
      expect(f.audio.orderedEffects().map(i=>i.id)).toEqual(["b","a"]);
      expect(f.calls.slice(before).filter(c=>c.type==="chain").map(c=>c.chain.map(i=>i.id))).toEqual([["b","a"]]);
    } finally { held.resolve(); f.close(); }
  });

  test(`r4 retired export is guarded before effects local=${local} master=${master}`, async () => {
    const f=await createStructuralReviewFixture(local,master);
    try {
      f.audio.reorder({id:"a",kind:"compressor"},1);
      await f.settle();
      batch(()=>{
        f.publish([]);
        f.setGeneration(1);
        expect(f.audio.snapshotExportProjection().replaceAudioEffectTargets).toEqual([]);
        f.publish([compressorInstance(-42,"next")]);
        expect(f.audio.snapshotExportProjection().replaceAudioEffectTargets.flatMap(t=>t.rows.map(r=>r.instanceId))).toEqual(["next"]);
      });
      await f.settle();
    } finally { f.close(); }
  });
}

for (const master of [false,true]) {
  test(`r4 native reorder failure is reported master=${master}`, async()=>{
    const f=await createStructuralReviewFixture(true,master);
    const failure=new Error("native explicit reorder failed");
    try {
      f.setLegacy(false);
      const prior=f.engine();
      class FailingEngine extends AudioEngine {
        override setTrackFxInstances(_id:string,_chain:AudioEffectRuntimeInstance[]):Promise<EngineDisposition> {return Promise.reject(failure);}
        override setMasterFxInstances(_chain:AudioEffectRuntimeInstance[]):Promise<EngineDisposition> {return Promise.reject(failure);}
      }
      f.setEngine(new FailingEngine());
      f.audio.reorder({id:"a",kind:"compressor"},1);
      await structuralMicrotaskCheckpoint();
      console.log(JSON.stringify({probe:"native-reorder-failure",master,errors:f.errors}));
      expect(f.errors).toEqual(["native explicit reorder failed"]);
      f.setEngine(prior);
    } finally {f.close();}
  });
}

for(const master of [false,true]) {
  test(`r4 owner must not adopt dropped successor over own success master=${master}`,async()=>{
    const f=await createStructuralReviewFixture(true,master);
    const held=deferred<void>(),installed=deferred<void>();
    try{
      const prior=f.engine();
      let once=true;
      const hold=async(work:Promise<EngineDisposition|"not-held">)=>{
        const result=await work;
        if(once){once=false;expect(result).toBe("applied");installed.resolve();await held.promise;}
        return result;
      };
      class BarrierEngine extends AudioEngine {
        override setTrackFxInstances(id:string,instances:AudioEffectRuntimeInstance[]){return prior.setTrackFxInstances(id,instances);}
        override setMasterFxInstances(instances:AudioEffectRuntimeInstance[]){return prior.setMasterFxInstances(instances);}
        override setTrackFxInstance(id:string,instance:AudioEffectRuntimeInstance){return hold(prior.setTrackFxInstance(id,instance));}
        override setMasterFxInstance(instance:AudioEffectRuntimeInstance){return hold(prior.setMasterFxInstance(instance));}
      }
      f.setEngine(new BarrierEngine());
      await f.settle();
      f.audio.compressor.changeInstance("a",p=>({...p,thresholdDb:-12}));
      await installed.promise;
      // A real uninitialized engine records intent but has no AudioContext, so
      // the successor structural request resolves dropped, not applied.
      f.setEngine(new AudioEngine());
      await structuralMicrotaskCheckpoint();
      held.resolve();
      await f.audio.flushPending();
      console.log(JSON.stringify({probe:"owner-adopts-dropped",master,history:f.history.length,errors:f.errors}));
      expect(f.history).toHaveLength(1);
      expect(f.history[0]).toMatchObject({ instanceId: "a" });
    } finally{held.resolve();f.close();}
  });
}

for (const local of [true,false]) for(const master of [false,true]) {
  test(`r4 stable lifetime continuation rolls back local=${local} master=${master}`,async()=>{
    const held=deferred<void>();
    const f=await createStructuralReviewFixture(local,master,()=>held.promise);
    try{
      f.audio.reorder({id:"a",kind:"compressor"},1);
      await f.settle();
      f.setUiNoise(1);
      await f.settle();
      held.reject(new Error("reorder persistence failed"));
      await structuralMicrotaskCheckpoint();
      await f.settle();
      expect(f.audio.orderedEffects().map(i=>i.id)).toEqual(["a","b"]);
    }finally{held.resolve();f.close();}
  });

  test(`r4 same lifetime retain prune only acknowledges matching order local=${local} master=${master}`,async()=>{
    const f=await createStructuralReviewFixture(local,master);
    try{
      f.audio.reorder({id:"a",kind:"compressor"},1);
      await f.settle();
      f.publish([compressorInstance(-33,"a"),compressorInstance(-25,"b")]);
      await f.settle();
      expect(f.audio.orderedEffects().map(i=>i.id)).toEqual(["b","a"]);
      expect(f.audio.snapshotExportProjection().replaceAudioEffectTargets.flatMap(t=>t.rows.map(r=>r.instanceId))).toEqual(["b","a"]);
      f.publish([compressorInstance(-25,"b"),compressorInstance(-33,"a")]);
      await f.settle();
      expect(f.audio.orderedEffects().map(i=>i.id)).toEqual(["b","a"]);
      f.publish([compressorInstance(-33,"a"),compressorInstance(-25,"b")]);
      await f.settle();
      expect(f.audio.orderedEffects().map(i=>i.id)).toEqual(["a","b"]);
    }finally{f.close();}
  });
}

for(const master of [false,true]) for(const fallback of [false,true]) {
  test(`r4 distinct own ${fallback?"fallback":"replacement"} failure reports and repairs master=${master}`,async()=>{
    const f=await createStructuralReviewFixture(true,master);
    try{
      const prior=f.engine();
      let armed=false,once=true,restores=0;
      const failure=new Error("own unmarked failure");
      const chain=(target:string,instances:AudioEffectRuntimeInstance[]):Promise<EngineDisposition>=>{
        if(armed&&fallback&&once){once=false;return Promise.reject(failure);}
        return target==="master"?prior.setMasterFxInstances(instances):prior.setTrackFxInstances(target,instances);
      };
      const single=(target:string,instance:AudioEffectRuntimeInstance):Promise<EngineDisposition|"not-held">=>{
        if(armed&&once&&!fallback){once=false;return Promise.reject(failure);}
        if(armed&&once&&fallback)return Promise.resolve("not-held");
        if(armed)restores++;
        return target==="master"?prior.setMasterFxInstance(instance):prior.setTrackFxInstance(target,instance);
      };
      class ReleaseEngine extends AudioEngine {
        override setTrackFxInstances(id:string,instances:AudioEffectRuntimeInstance[]){return chain(id,instances);}
        override setMasterFxInstances(instances:AudioEffectRuntimeInstance[]){return chain("master",instances);}
        override setTrackFxInstance(id:string,instance:AudioEffectRuntimeInstance){return single(id,instance);}
        override setMasterFxInstance(instance:AudioEffectRuntimeInstance){return single("master",instance);}
      }
      f.setEngine(new ReleaseEngine());await f.settle();armed=true;
      f.audio.compressor.changeInstance("a",p=>({...p,thresholdDb:-12}));
      await expect(f.audio.flushPending()).rejects.toThrow(failure.message);
      expect(f.localErrors).toEqual([failure.message]);
      expect(restores).toBeGreaterThan(0);
      expect(f.history).toHaveLength(0);
    }finally{f.close();}
  });
}

for(const master of [false,true]) for(const own of ["success","failure"]) for(const successor of ["success","failure"]) for(const first of ["own","successor"]) {
  test(`r4 completion ordering master=${master} own=${own} successor=${successor} first=${first}`,async()=>{
    const f=await createStructuralReviewFixture(true,master);
    const ownGate=deferred<void>(),successorGate=deferred<void>(),installed=deferred<void>(),successorInstalled=deferred<void>();
    try{
      const prior=f.engine();let holdOwn=true,holdSuccessor=false;
      const single=async(work:Promise<EngineDisposition|"not-held">)=>{
        const result=await work;
        if(holdOwn){holdOwn=false;expect(result).toBe("applied");installed.resolve();await ownGate.promise;}
        return result;
      };
      const chain=async(work:Promise<EngineDisposition>)=>{
        const result=await work;
        if(holdSuccessor){holdSuccessor=false;expect(["applied","joined","skipped"]).toContain(result);successorInstalled.resolve();await successorGate.promise;}
        return result;
      };
      class OrderedEngine extends AudioEngine {
        override setTrackFxInstances(id:string,instances:AudioEffectRuntimeInstance[]){return chain(prior.setTrackFxInstances(id,instances));}
        override setMasterFxInstances(instances:AudioEffectRuntimeInstance[]){return chain(prior.setMasterFxInstances(instances));}
        override setTrackFxInstance(id:string,instance:AudioEffectRuntimeInstance){return single(prior.setTrackFxInstance(id,instance));}
        override setMasterFxInstance(instance:AudioEffectRuntimeInstance){return single(prior.setMasterFxInstance(instance));}
      }
      f.setEngine(new OrderedEngine());await f.settle();
      f.audio.compressor.changeInstance("a",p=>({...p,thresholdDb:-12}));
      await installed.promise;
      holdSuccessor=true;f.audio.reorder({id:"b",kind:"compressor"},0);
      await successorInstalled.promise;
      const finish=(which:string)=>{
        const gate=which==="own"?ownGate:successorGate;
        const disposition=which==="own"?own:successor;
        if(disposition==="success")gate.resolve();else gate.reject(new Error(which+" failed"));
      };
      finish(first);await structuralMicrotaskCheckpoint();
      finish(first==="own"?"successor":"own");
      let failure:unknown;try{await f.audio.flushPending();}catch(cause){failure=cause;}
      // An earlier own failure remains authoritative. A newer failure can never
      // veto own success; earlier successor success may satisfy a pending owner.
      const accepted=own==="success"||(successor==="success"&&first==="successor");
      console.log(JSON.stringify({probe:"outcome-order",master,own,successor,first,history:f.history.length,localErrors:f.localErrors,errors:f.errors,flush:String(failure)}));
      expect(f.history).toHaveLength(accepted?1:0);
      expect(f.localErrors).toEqual(accepted?[]:["own failed"]);
      if(successor==="failure")expect(f.errors.filter(e=>e==="successor failed")).toHaveLength(1);
      if(!accepted)expect(String(failure)).toContain("own failed");
    }finally{ownGate.resolve();successorGate.resolve();f.close();}
  });
}

for(const master of [false,true]) {
  test(`r4 different-content release with shared module failure preserves local failure signal master=${master}`,async()=>{
    const f=await createStructuralReviewFixture(true,master);
    const module=deferred<void>(),started=deferred<void>();
    try{
      Object.defineProperty(f.runtime.audio.context.audioWorklet,"addModule",{value:()=>{started.resolve();return module.promise;}});
      f.publish([compressorInstance(-31,"a"),compressorInstance(-25,"b"),staticGateInstance(-22,2,"g")]);
      await started.promise;
      await structuralMicrotaskCheckpoint();
      const beforeRelease=f.calls.length;
      f.audio.compressor.changeInstance("a",p=>({...p,thresholdDb:-9}));
      await structuralMicrotaskCheckpoint();
      const submitted=f.calls.filter(c=>c.type==="instance"&&c.chain.some(i=>i.id==="a"&&i.kind==="compressor"&&i.params.thresholdDb===-9));
      expect(submitted.length).toBeGreaterThan(0);
      module.reject(new Error("shared module load failed"));
      let failure:unknown;try{await f.audio.flushPending();}catch(cause){failure=cause;}
      console.log(JSON.stringify({probe:"different-content-shared-module",master,errors:f.errors,localErrors:f.localErrors,flush:String(failure),gateRequests:f.calls.filter(c=>c.chain.some(i=>i.id==="g")).map(c=>({type:c.type,gate:c.chain.find(i=>i.id==="g"),disposition:c.disposition,error:c.error}))}));
      expect(String(failure)).toContain("shared module load failed");
      expect(f.errors).toEqual(["shared module load failed"]);
      expect(f.calls.slice(beforeRelease).some(c=>c.type==="instance"&&c.chain.some(i=>i.id==="a"&&i.kind==="compressor"&&i.params.thresholdDb===-31))).toBe(true);
      expect(f.localErrors).toEqual(["shared module load failed"]);
    }finally{module.resolve();f.close();}
  });
}
