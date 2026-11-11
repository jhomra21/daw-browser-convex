import type { ParameterSaveResult } from "./parameter-gesture-owner";
const fixtureApply = <Params,>(apply: (target: string, params: Params) => void | EngineDisposition | Promise<void | EngineDisposition>) =>
  async (target: string, params: Params): Promise<EngineDisposition> => (await apply(target, params)) ?? "applied";
const fixtureSave = <Params,>(save: (target: string, params: Params, context: { projectId?: string; userId?: string; projectGeneration?: number }) => void | ParameterSaveResult | Promise<void | ParameterSaveResult>) =>
  async (target: string, params: Params, context: { projectId?: string; userId?: string; projectGeneration?: number }): Promise<ParameterSaveResult> =>
    (await save(target, params, context)) ?? { kind: "committed-unordered" };
import { expect, spyOn, test } from "bun:test";
import "fake-indexeddb/auto";
import { createDefaultUtilityParams } from "@daw-browser/shared";
import * as outbox from "~/lib/shared-outbox";
import { batch, createRoot, createSignal } from "solid-js";
import { createPersistedEffectState } from "./create-persisted-effect-state";
import { flushRegisteredLocalProjectWrites } from "~/lib/local-project-write-flushers";
import { createParameterGestureOwner, ParameterGestureHolder, ParameterReleaseFailedError } from "./parameter-gesture-owner";
import { SampledInstrumentSyncSupersededError } from "~/lib/sampled-instrument-sync-error";
import type { EngineDisposition } from "@daw-browser/audio-engine/audio-engine";
import { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import { createLiveMixerRuntime } from "@daw-browser/audio-engine/live-mixer-runtime";
import { compressorInstance, createCountingBudget, createFxTestAudio } from "../../../packages/audio-engine/src/fx-runtime-test-audio";
import type { DeliveryRegistration, ProcessorDeliveryOutcome } from "~/lib/live-processor-control";

test("INDEPENDENT native row reconcile and reinstall publish once", async () => {
  const [engine, setEngine] = createSignal(new AudioEngine());
  const joins: number[] = [], applies: number[] = [];
  let dispose = () => {};
  const state = createRoot(end => {
    dispose = end;
    return createPersistedEffectState<undefined, number>({
      targetId: () => undefined, scopeId: () => "p", row: () => undefined,
      readQueryParams: () => undefined, createInitialParams: () => 0, serializeParams: String,
      createPersistContext: () => ({ projectId: "p" }),
      audioEngine: engine, usesLegacyAudioEngine: () => false,
      applyToEngine: (_id, value) => { applies.push(value); return "applied"; },
      registerDelivery: (_id, value) => {
        joins.push(value);
        return { receipt: { key: String(value), serial: joins.length }, settled: Promise.resolve({ state: "unavailable" }) };
      },
      persistParams: () => ({ kind: "committed-unordered" }),
    });
  });
  try {
    state.syncRemoteForTarget("t", 1);
    await state.flushPending();
    applies.length = 0; joins.length = 0;
    batch(() => { setEngine(new AudioEngine()); state.syncRemoteForTarget("t", 2); });
    await state.flushPending();
    expect(applies).toEqual([2]);
    expect(joins).toEqual([2]);
  } finally { dispose(); }
});

test("H5 reinstall-before-row acknowledges already-installed observation", async () => {
  const applies: number[] = [], rows: number[] = [];
  let dispose = () => {};
  const owner = createRoot(end => {
    dispose = end;
    return createParameterGestureOwner<string, number>({
      key: target => target, scope: () => ({ projectId: "p", generation: 0 }),
      exists: () => true, canWrite: () => true, equal: (_target, a, b) => a === b,
      initial: () => 1, committed: () => 1, rowsReachEngine: () => true,
      apply: (_target, value) => { applies.push(value); return "applied"; },
      rowApplied: (_target, value) => { rows.push(value); },
      persist: async () => ({ kind: "committed-unordered" }),
      history: () => {}, allocateEdit: () => undefined, onError: (_stage, cause) => { throw cause; },
    });
  });
  try {
    owner.external("t", 1);
    await owner.flushPending();
    applies.length = 0; rows.length = 0;
    owner.reinstall();
    owner.external("t", 2);
    await owner.flushPending();
    expect(applies).toEqual([2]);
    expect(rows).toEqual([2]);
  } finally { dispose(); }
});

test("an equal repeated initial row observation does not cancel its queued installation", async () => {
  const applies: number[] = [], rows: number[] = [];
  let dispose = () => {};
  const owner = createRoot(end => {
    dispose = end;
    return createParameterGestureOwner<string, number>({
      key: target => target, scope: () => ({ projectId: "p", generation: 0 }),
      exists: () => true, canWrite: () => true, equal: (_target, a, b) => a === b,
      initial: () => 1, committed: () => 1, rowsReachEngine: () => true,
      apply: (_target, value) => { applies.push(value); return "applied"; },
      rowApplied: (_target, value) => { rows.push(value); },
      persist: async () => ({ kind: "committed-unordered" }),
      history: () => {}, allocateEdit: () => undefined, onError: (_stage, cause) => { throw cause; },
    });
  });
  try {
    owner.external("t", 1, 1);
    owner.external("t", 1, 1);
    await owner.flushPending();
    expect(applies).toEqual([1]);
    expect(rows).toEqual([1]);
  } finally { dispose(); }
});

const createRowOwner = (hooks: {
  scope?: () => { projectId: string; generation: number };
  applies: number[];
  rows: number[];
  hold?: Promise<void>;
  entered?: () => void;
}) => {
  let dispose = () => {};
  const owner = createRoot(end => {
    dispose = end;
    return createParameterGestureOwner<string, number>({
      key: target => target, scope: hooks.scope ?? (() => ({ projectId: "p", generation: 0 })),
      exists: () => true, canWrite: () => true, equal: (_target, a, b) => a === b,
      initial: () => 1, committed: () => 1, rowsReachEngine: () => true,
      apply: async (_target, value): Promise<EngineDisposition> => {
        hooks.applies.push(value);
        hooks.entered?.();
        await hooks.hold;
        return "applied";
      },
      rowApplied: (_target, value) => { hooks.rows.push(value); },
      persist: async () => ({ kind: "committed-unordered" }),
      history: () => {}, allocateEdit: () => undefined, onError: (_stage, cause) => { throw cause; },
    });
  });
  return { owner, dispose };
};

test("a changed row observation supersedes the queued installation of the earlier one", async () => {
  const applies: number[] = [], rows: number[] = [];
  const { owner, dispose } = createRowOwner({ applies, rows });
  try {
    owner.external("t", 1, 1);
    owner.external("t", 2, 2);
    await owner.flushPending();
    expect(applies).toEqual([2]);
    expect(rows).toEqual([2]);
  } finally { dispose(); }
});

test("an equal row observation during a held apply keeps its acknowledgement", async () => {
  const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
  const applies: number[] = [], rows: number[] = [];
  const { owner, dispose } = createRowOwner({ applies, rows, hold: held.promise, entered: entered.resolve });
  try {
    owner.external("t", 1, 1);
    await entered.promise;
    owner.external("t", 1, 1);
    held.resolve();
    await owner.flushPending();
    expect(applies).toEqual([1]);
    expect(rows).toEqual([1]);
  } finally { dispose(); }
});

test("a scope replacement drops the queued installation of an observation from the old scope", async () => {
  const [scope, setScope] = createSignal({ projectId: "p", generation: 0 });
  const applies: number[] = [], rows: number[] = [];
  const { owner, dispose } = createRowOwner({ scope, applies, rows });
  try {
    owner.external("t", 1, 1);
    setScope({ projectId: "q", generation: 0 });
    await owner.flushPending();
    expect(applies).toEqual([]);
    expect(rows).toEqual([]);
  } finally { dispose(); }
});

test("a row removed and added again installs the new observation once", async () => {
  const applies: number[] = [], rows: number[] = [];
  const { owner, dispose } = createRowOwner({ applies, rows });
  try {
    owner.external("t", 1, 1);
    owner.external("t", undefined);
    owner.external("t", 1, 2);
    await owner.flushPending();
    expect(applies).toEqual([1]);
    expect(rows).toEqual([1]);
  } finally { dispose(); }
});

test("an equal repeated sampled-instrument row still announces readiness", async () => {
  const [engine] = createSignal(new AudioEngine());
  const applies: number[] = [], announced: number[] = [];
  let dispose = () => {};
  const state = createRoot(end => {
    dispose = end;
    return createPersistedEffectState<undefined, number>({
      targetId: () => undefined, scopeId: () => "p", row: () => undefined,
      readQueryParams: () => undefined, createInitialParams: () => 0, serializeParams: String,
      createPersistContext: () => ({ projectId: "p" }),
      audioEngine: engine, usesLegacyAudioEngine: () => false,
      applyToEngine: (_id, value) => { applies.push(value); return "applied"; },
      announce: (_id, value) => { announced.push(value); },
      persistParams: () => ({ kind: "committed-unordered" }),
    });
  });
  try {
    state.syncRemoteForTarget("t", 1);
    state.syncRemoteForTarget("t", 1);
    await state.flushPending();
    expect(applies).toEqual([1]);
    expect(announced).toEqual([1]);
  } finally { dispose(); }
});

// H5 controls: previews must not leave committed installation knowledge behind,
// and work already submitted to an old engine cannot satisfy a new epoch.
test("H5 control preview cancel and reinstall restores committed content", async () => {
  const applies: number[] = [], saves: number[] = [];
  let installed = -1, dispose = () => {};
  const owner = createRoot(end => {
    dispose = end;
    return createParameterGestureOwner<string, number>({
      key: target => target, scope: () => ({ projectId: "p", generation: 0 }),
      exists: () => true, canWrite: () => true, equal: (_target, a, b) => a === b,
      initial: () => 1, committed: () => 1, rowsReachEngine: () => true,
      apply: (_target, value) => { applies.push(value); installed = value; return "applied"; },
      persist: async record => { saves.push(record.latest); return { kind: "committed-unordered" }; },
      history: () => {}, allocateEdit: () => undefined, onError: (_stage, cause) => { throw cause; },
    });
  });
  try {
    owner.external("t", 1);
    await owner.settle("t");
    const handle = owner.handle(() => "t"), holder = new ParameterGestureHolder();
    handle.open(holder);
    handle.tick(holder, () => owner.write("t", () => 2));
    await owner.settle("t");
    expect(installed).toBe(2);
    handle.cancel(holder);
    owner.reinstall();
    await owner.flushPending();
    expect(installed).toBe(1);
    expect(applies.at(-1)).toBe(1);
    expect(applies).toContain(2);
    expect(saves).toEqual([]);
    expect(handle.isOpen(holder)).toBe(false);
  } finally { dispose(); }
});

test("H5 control busy old-engine lane still installs on replacement", async () => {
  const oldEngine = new AudioEngine(), replacement = new AudioEngine();
  const [engine, setEngine] = createSignal(oldEngine);
  const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
  const applies: Array<{ engine: AudioEngine; value: number }> = [];
  let dispose = () => {};
  const state = createRoot(end => {
    dispose = end;
    return createPersistedEffectState<undefined, number>({
      targetId: () => undefined, scopeId: () => "p", row: () => undefined,
      readQueryParams: () => undefined, createInitialParams: () => 0, serializeParams: String,
      createPersistContext: () => ({ projectId: "p" }),
      audioEngine: engine, usesLegacyAudioEngine: () => true,
      applyToEngine: async (_target, value): Promise<EngineDisposition> => {
        const destination = engine();
        applies.push({ engine: destination, value });
        if (destination === oldEngine) { entered.resolve(); await held.promise; }
        return "applied";
      },
      persistParams: () => ({ kind: "committed-unordered" }),
    });
  });
  try {
    state.syncRemoteForTarget("t", 1);
    await entered.promise;
    setEngine(replacement);
    held.resolve();
    await state.flushPending();
    expect(applies).toEqual([{ engine: oldEngine, value: 1 }, { engine: replacement, value: 1 }]);
  } finally { held.resolve(); dispose(); }
});

test("H6 thrown apply leaves no installation knowledge for the previous value", async () => {
  let installed: number | undefined;
  const errors: unknown[] = [];
  let dispose = () => {};
  const owner = createRoot(end => {
    dispose = end;
    return createParameterGestureOwner<string, number>({
      key: target => target, scope: () => ({ projectId: "p", generation: 0 }),
      exists: () => true, canWrite: () => true, equal: (_target, a, b) => a === b,
      initial: () => 1, committed: () => 1, rowsReachEngine: () => true,
      apply: (_target, value) => {
        installed = undefined;
        if (value === 2) throw new Error("partly destructive apply");
        installed = value;
        return "applied";
      },
      persist: async () => ({ kind: "committed-unordered" }),
      history: () => {}, allocateEdit: () => undefined, onError: (_stage, cause) => { errors.push(cause); },
    });
  });
  try {
    owner.external("t", 1);
    await owner.flushPending();
    owner.external("t", 2);
    await owner.flushPending();
    expect(errors).toHaveLength(1);
    expect(installed).toBeUndefined();
    owner.external("t", 1);
    await owner.flushPending();
    expect(installed).toBe(1);
  } finally { dispose(); }
});

test("3B1 r2 preserves a settlement wake during a pending durable read", async () => {
  const projectId = `wake-during-read-${crypto.randomUUID()}`, userId = "user";
  const originalFetch = globalThis.fetch;
  let online = false;
  globalThis.fetch = Object.assign(async () => online
    ? Response.json({ status: "applied", effectId: "row", revision: 5 })
    : new Response("offline", { status: 503 }), { preconnect: originalFetch.preconnect });
  const admission = await outbox.publishDurableEffectsOperation({
    projectId, userId, operation: { kind: "effects.setUtilityParams", payload: {
      trackId: "track", instanceId: "utility", params: { version: 1, state: createDefaultUtilityParams() },
    } },
  });
  const captured = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
  const read = outbox.readSharedOutboxOperation;
  let first = true;
  // Hold delivery of a real completed IDB pending snapshot, not the transaction
  // or the writer. The foreign flush and wake use the shipped outbox unchanged.
  const reader = spyOn(outbox, "readSharedOutboxOperation").mockImplementation(async (...args) => {
    const result = await read(...args);
    if (first && result.status === "pending") {
      first = false;
      captured.resolve();
      await held.promise;
    }
    return result;
  });
  let dispose = () => {};
  try {
    if (admission.kind !== "admitted") throw new Error("Expected actual outbox admission");
    const history: number[] = [];
    const owner = createRoot(end => {
      dispose = end;
      return createParameterGestureOwner<string, number>({
        key: value => value, scope: () => ({ projectId, userId, generation: 0 }),
        exists: () => true, canWrite: () => true, equal: (_target, a, b) => a === b,
        initial: () => 0, committed: () => 0, apply: () => "applied",
        persist: async () => admission, history: record => { history.push(record.latest); },
        allocateEdit: () => undefined, onError: (_stage, cause) => { throw cause; },
      });
    });
    owner.external("track", 0, 1);
    owner.set("track", 1);
    await captured.promise;
    online = true;
    await outbox.flushSharedOutbox(projectId, userId, { retryFailed: true });
    expect(await read(projectId, userId, admission.entryId)).toMatchObject({ status: "applied" });
    held.resolve();
    const report = await owner.flushPending();
    expect({ admitted: report.admitted.length, history }).toEqual({ admitted: 0, history: [1] });
    expect(await read(projectId, userId, admission.entryId)).toEqual({ status: "missing" });
    expect(reader.mock.calls.length).toBeGreaterThanOrEqual(2);
  } finally {
    held.resolve();
    dispose();
    reader.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("3B1 registration is synchronous, receipts do not gate saves, and drain reports unanswered work", async () => {
  await createRoot(async (dispose) => {
    let answer = (_outcome: ProcessorDeliveryOutcome) => {};
    const registration: DeliveryRegistration = {
      receipt: { key: "track:instrument", serial: 1 },
      settled: new Promise((resolve) => { answer = resolve; }),
    };
    const events: string[] = [];
    const state = createPersistedEffectState<number | undefined, number>({
      targetId: () => "track", row: () => 0, readQueryParams: (value) => value,
      createInitialParams: () => 0, serializeParams: String,
      applyToEngine: fixtureApply(() => "applied"),
      registerDelivery: (_target, value) => value === 0 ? undefined : (events.push("register"), registration),
      persistParams: fixtureSave(() => { events.push("save"); return { kind: "committed", through: 5 }; }),
      history: () => { events.push("history"); },
      announce: async () => { events.push("handoff"); },
    });
    await drain();
    state.setForTarget("track", 1);
    const report = await state.flushPending();
    expect(events.slice(-4)).toEqual(["register", "save", "history", "handoff"]);
    expect(report.unanswered.map((entry) => entry.receipt)).toEqual([registration.receipt]);
    answer({ state: "refused", reason: "native-refused" });
    await drain();
    expect((await state.flushPending()).unanswered).toEqual([]);
    expect(state.params()).toBe(1);
    dispose();
  });
});

test("3B1 positive equal stamps consume coalesced echoes and bind a newer foreign row before successor history", async () => {
  await createRoot(async (dispose) => {
    let finish = (_result: { kind: "committed"; through: number }) => {};
    const pending = new Promise<{ kind: "committed"; through: number }>((resolve) => { finish = resolve; });
    const history: string[] = [];
    const state = createPersistedEffectState<number | undefined, number>({
      targetId: () => "track", row: () => 0, readQueryParams: (value) => value,
      createInitialParams: () => 0, serializeParams: String, applyToEngine: fixtureApply(() => "applied"),
      persistParams: fixtureSave((_target, value) => value === 1 ? pending : { kind: "committed", through: 7 }),
      history: (_target, from, to) => { history.push(`${from}->${to}`); },
    });
    await drain();
    state.setForTarget("track", 1);
    await drain();
    state.syncRemoteForTarget("track", 7, 6);
    finish({ kind: "committed", through: 5 });
    await state.flushPending();
    expect(state.params()).toBe(7);
    state.setForTarget("track", 2);
    await state.flushPending();
    expect(history).toEqual(["0->1", "7->2"]);
    state.syncRemoteForTarget("track", 2, 7);
    expect(state.readProvisionalForTarget("track")).toBeUndefined();
    dispose();
  });
});

test("3B1 native terminal settlement does not block persistence", async () => {
  await createRoot(async (dispose) => {
    let release = (_result: ProcessorDeliveryOutcome) => {};
    const pending = new Promise<ProcessorDeliveryOutcome>((resolve) => { release = resolve; });
    const saved: number[] = [];
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track", row: () => undefined, readQueryParams: () => undefined,
      createInitialParams: () => undefined, serializeParams: String, applyToEngine: fixtureApply(() => undefined),
      registerDelivery: () => ({ receipt: { key: "track", serial: 1 }, settled: pending }),
      persistParams: fixtureSave((_target, value) => { saved.push(value); }),
    });
    state.setForTarget("track", 1);
    await drain();
    expect(saved).toEqual([1]);
    release({ state: "unconfirmed" });
    await state.flushPending();
    expect(saved).toEqual([1]);
    dispose();
  });
});

test("3B1 structural announce is included in the deterministic drain", async () => {
  await createRoot(async (dispose) => {
    let release = () => {};
    const handoff = new Promise<void>((resolve) => { release = resolve; });
    let handoffDone = false;
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track", row: () => undefined, readQueryParams: () => undefined,
      createInitialParams: () => undefined, serializeParams: String, applyToEngine: fixtureApply(() => undefined),
      persistParams: fixtureSave(() => undefined),
      announce: () => handoff.then(() => { handoffDone = true; }),
    });
    state.setForTarget("track", 1);
    let drained = false;
    const pending = state.flushPending().then(() => { drained = true; });
    await drain();
    expect(drained).toBe(false);
    expect(handoffDone).toBe(false);
    release();
    await pending;
    await handoff;
    await drain();
    expect(handoffDone).toBe(true);
    dispose();
  });
});

test("inserts explicit params from a loaded missing row", async () => {
  await createRoot(async (dispose) => {
    const [row] = createSignal<number | undefined>(undefined);
    const [loaded] = createSignal(true);
    const persisted: number[] = [];
    const state = createPersistedEffectState<number | undefined, number>({
      targetId: () => "track-1",
      row,
      readQueryParams: (value) => value,
      createInitialParams: () => undefined,
      serializeParams: (value) => String(value),
      applyToEngine: fixtureApply(() => {}),
      persistParams: fixtureSave((_targetId, value) => {
        persisted.push(value);
      }),
      isMissingRowLoaded: loaded,
    });

    state.setForTarget("track-1", 2);
    await state.flushPending();
    expect(state.readForTarget("track-1")).toBe(2);
    expect(persisted).toEqual([2]);
    dispose();
  });
});

test("waits for engine application before persisting a parameter commit", async () => {
  await createRoot(async (dispose) => {
    const applied: number[] = [];
    const persisted: number[] = [];
    let releaseApply = () => {};
    const applyPending = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const state = createPersistedEffectState<number | undefined, number>({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: (value) => value,
      createInitialParams: () => undefined,
      serializeParams: (value) => String(value),
      applyToEngine: fixtureApply(async (_targetId, value) => {
        await applyPending;
        applied.push(value);
      }),
      persistParams: fixtureSave((_targetId, value) => {
        persisted.push(value);
      }),
    });

    state.setForTarget("track-1", 3);
    await drain();
    expect(applied).toEqual([]);
    expect(persisted).toEqual([]);

    releaseApply();
    await state.flushPending();
    expect(applied).toEqual([3]);
    expect(persisted).toEqual([3]);
    dispose();
  });
});

test("announces a released instrument change once, after it reached the engine, and not again for its row echo", async () => {
  await createRoot(async (dispose) => {
    type Instrument = { kind: "synth" | "sampler"; instanceId: string; value: number };
    const [row, setRow] = createSignal<Instrument | undefined>({ kind: "synth", instanceId: "instrument:1", value: 0 });
    const events: string[] = [];
    const state = createPersistedEffectState<Instrument | undefined, Instrument>({
      targetId: () => "track-1",
      row,
      readQueryParams: (value) => value,
      createInitialParams: () => undefined,
      serializeParams: (value) => JSON.stringify(value),
      applyToEngine: fixtureApply((_targetId, next) => { events.push(`apply:${next.kind}:${next.instanceId}:${next.value}`); }),
      persistParams: fixtureSave(() => Promise.resolve()),
      announce: (_targetId, next) => { events.push(`announce:${next.kind}:${next.instanceId}:${next.value}`); },
    });
    await drain();
    events.length = 0;

    state.setForTarget("track-1", { kind: "sampler", instanceId: "instrument:2", value: 0 });
    await state.flushPending();
    expect(events).toEqual(["apply:sampler:instrument:2:0", "announce:sampler:instrument:2:0"]);

    setRow({ kind: "sampler", instanceId: "instrument:2", value: 0 });
    await drain();
    expect(events).toEqual(["apply:sampler:instrument:2:0", "announce:sampler:instrument:2:0"]);

    state.setForTarget("track-1", { kind: "sampler", instanceId: "instrument:2", value: 0 });
    await state.flushPending();
    expect(events).toHaveLength(2);
    dispose();
  });
});

test("applies and announces a remote instrument identity change once", async () => {
  await createRoot(async (dispose) => {
    const applied: string[] = [];
    const announced: string[] = [];
    const state = createPersistedEffectState<undefined, { kind: string; instanceId: string }>({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: (value) => JSON.stringify(value),
      applyToEngine: fixtureApply((_targetId, next) => { applied.push(`${next.kind}:${next.instanceId}`); }),
      persistParams: fixtureSave(() => {}),
      announce: (_targetId, next) => { announced.push(`${next.kind}:${next.instanceId}`); },
    });

    state.syncRemoteForTarget("track-1", { kind: "synth", instanceId: "instrument:1" });
    await state.flushPending();
    state.syncRemoteForTarget("track-1", { kind: "synth", instanceId: "instrument:1" });
    await state.flushPending();
    expect(applied).toEqual(["synth:instrument:1"]);
    expect(announced).toEqual(["synth:instrument:1"]);
    dispose();
  });
});

test("a release whose engine apply is rejected is reported and not persisted", async () => {
  await createRoot(async (dispose) => {
    const failure = new Error("apply failed");
    const persisted: number[] = [];
    const reported: unknown[] = [];
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: fixtureApply(() => Promise.reject(failure)),
      persistParams: fixtureSave((_targetId, value) => { persisted.push(value); }),
      onReleaseFailed: (cause) => reported.push(cause),
    });

    state.setForTarget("track-1", 1);
    await state.flushPending().catch(() => {});
    expect(persisted).toEqual([]);
    expect(reported).toEqual([failure]);
    dispose();
  });
});

test("coalesces a remote update that arrives during an apply and suppresses stale completion", async () => {
  await createRoot(async (dispose) => {
    const releases = new Map<number, () => void>();
    const applied: number[] = [];
    const completed: number[] = [];
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: fixtureApply(async (_targetId, next) => {
        await new Promise<void>((resolve) => releases.set(next, resolve));
        applied.push(next);
      }),
      persistParams: fixtureSave(() => {}),
      announce: (_targetId, next) => { completed.push(next); },
    });

    state.syncRemoteForTarget("track-1", 1);
    await drain();
    state.syncRemoteForTarget("track-1", 2);
    expect(applied).toEqual([]);

    releases.get(1)?.();
    await drain();
    expect(applied).toEqual([1]);
    expect(completed).toEqual([]);

    releases.get(2)?.();
    await state.flushPending();
    expect(applied).toEqual([1, 2]);
    expect(completed).toEqual([2]);
    dispose();
  });
});

test("coalesces multiple remote updates to the latest state", async () => {
  await createRoot(async (dispose) => {
    const releases = new Map<number, () => void>();
    const applied: number[] = [];
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: fixtureApply(async (_targetId, next) => {
        await new Promise<void>((resolve) => releases.set(next, resolve));
        applied.push(next);
      }),
      persistParams: fixtureSave(() => {}),
    });

    state.syncRemoteForTarget("track-1", 1);
    await drain();
    state.syncRemoteForTarget("track-1", 2);
    state.syncRemoteForTarget("track-1", 3);
    releases.get(1)?.();
    await drain();
    expect(applied).toEqual([1]);

    releases.get(3)?.();
    await state.flushPending();
    expect(applied).toEqual([1, 3]);
    dispose();
  });
});

test("does not retry an unchanged remote apply after failure", async () => {
  await createRoot(async (dispose) => {
    let attempts = 0;
    let errors = 0;
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: fixtureApply(() => {
        attempts += 1;
        return Promise.reject(new Error("apply failed"));
      }),
      persistParams: fixtureSave(() => {}),
      onEngineApplyError: () => {
        errors += 1;
      },
    });

    state.syncRemoteForTarget("track-1", 1);
    await drain();

    expect(attempts).toBe(1);
    expect(errors).toBe(1);
    dispose();
  });
});

test("does not report an aborted local engine apply as an effect error", async () => {
  await createRoot(async (dispose) => {
    const errors: unknown[] = [];
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: fixtureApply(() => Promise.reject(
        new DOMException("signal is aborted without reason", "AbortError"),
      )),
      persistParams: fixtureSave(() => {}),
      onEngineApplyError: (cause) => errors.push(cause),
    });

    state.setForTarget("track-1", 1);
    await drain();
    expect(errors).toEqual([]);
    dispose();
  });
});

test("continues to report non-abort engine apply failures", async () => {
  await createRoot(async (dispose) => {
    const failure = new Error("effect apply failed");
    const errors: unknown[] = [];
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: fixtureApply(() => Promise.reject(failure)),
      persistParams: fixtureSave(() => {}),
      onReleaseFailed: (cause) => errors.push(cause),
    });

    state.setForTarget("track-1", 1);
    await drain();
    expect(errors).toEqual([failure]);
    dispose();
  });
});

test("replays a newer remote state after the older apply fails", async () => {
  await createRoot(async (dispose) => {
    const applied: number[] = [];
    const completed: number[] = [];
    let errors = 0;
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: fixtureApply((_targetId, next) => {
        applied.push(next);
        return next === 1 ? Promise.reject(new Error("apply failed")) : Promise.resolve();
      }),
      persistParams: fixtureSave(() => {}),
      onEngineApplyError: () => {
        errors += 1;
      },
      announce: (_targetId, next) => { completed.push(next); },
    });

    state.syncRemoteForTarget("track-1", 1);
    await drain();
    state.syncRemoteForTarget("track-1", 2);
    await drain();

    expect(applied).toEqual([1, 2]);
    expect(errors).toBe(1);
    expect(completed).toEqual([2]);
    dispose();
  });
});

test("flushPending drains a remote replay created after its initial snapshot", async () => {
  await createRoot(async (dispose) => {
    const releases = new Map<number, () => void>();
    const applied: number[] = [];
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: fixtureApply(async (_targetId, next) => {
        await new Promise<void>((resolve) => releases.set(next, resolve));
        applied.push(next);
      }),
      persistParams: fixtureSave(() => {}),
    });

    state.syncRemoteForTarget("track-1", 1);
    await drain();
    state.syncRemoteForTarget("track-1", 2);
    let flushed = false;
    const pendingFlush = state.flushPending().then(() => {
      flushed = true;
    });

    releases.get(1)?.();
    await drain();
    expect(applied).toEqual([1]);
    expect(flushed).toBeFalse();

    releases.get(2)?.();
    await pendingFlush;
    expect(applied).toEqual([1, 2]);
    expect(flushed).toBeTrue();
    dispose();
  });
});

test("flushPending follows a superseded apply registered after the flush starts", async () => {
  await createRoot(async (dispose) => {
    const firstApply = deferred();
    const replacement = deferred();
    const otherTarget = deferred();
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-a",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: fixtureApply((targetId, value) => {
        if (targetId === "track-b") return otherTarget.promise;
        return value === 1 ? firstApply.promise : replacement.promise;
      }),
      persistParams: fixtureSave(() => {}),
    });

    state.setForTarget("track-a", 1);
    state.setForTarget("track-b", 1);
    const flush = state.flushPending();
    state.setForTarget("track-a", 2);
    firstApply.reject(new SampledInstrumentSyncSupersededError(replacement.promise.then(() => "applied")));
    await drain();
    replacement.resolve();
    otherTarget.resolve();
    await flush;
    dispose();
  });
});

test("flushPending follows a sampler replacement started outside persisted apply registration", async () => {
  await createRoot(async (dispose) => {
    const compileApply = deferred();
    const externalSync = deferred();
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-a",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: fixtureApply(() => compileApply.promise),
      persistParams: fixtureSave(() => {}),
    });

    state.setForTarget("track-a", 1);
    const flush = state.flushPending();
    compileApply.reject(new SampledInstrumentSyncSupersededError(externalSync.promise.then(() => "applied")));
    externalSync.resolve();
    await flush;
    dispose();
  });
});

test("flushPending reports failure from an undo-started Drum Rack replacement", async () => {
  await createRoot(async (dispose) => {
    const compileApply = deferred();
    const undoSync = deferred();
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-a",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: fixtureApply(() => compileApply.promise),
      persistParams: fixtureSave(() => {}),
    });

    state.setForTarget("track-a", 1);
    const flush = state.flushPending();
    const failure = new Error("Undo Drum Rack buffer sync failed.");
    compileApply.reject(new SampledInstrumentSyncSupersededError(undoSync.promise.then(() => "applied")));
    undoSync.reject(failure);
    expect(await causeOf(flush)).toBe(failure);
    dispose();
  });
});

test("flushPending rejects when a superseding apply fails", async () => {
  await createRoot(async (dispose) => {
    const firstApply = deferred();
    const replacement = deferred();
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-a",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: fixtureApply((_targetId, value) => value === 1 ? firstApply.promise : replacement.promise),
      persistParams: fixtureSave(() => {}),
    });

    state.setForTarget("track-a", 1);
    const flush = state.flushPending();
    state.setForTarget("track-a", 2);
    const failure = new Error("replacement failed");
    firstApply.reject(new SampledInstrumentSyncSupersededError(replacement.promise.then(() => "applied")));
    await drain();
    replacement.reject(failure);
    expect(await causeOf(flush)).toBe(failure);
    dispose();
  });
});

test("concurrent flushes both reject when a superseding apply fails", async () => {
  await createRoot(async (dispose) => {
    const firstApply = deferred();
    const replacement = deferred();
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-a",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: fixtureApply((_targetId, value) => value === 1 ? firstApply.promise : replacement.promise),
      persistParams: fixtureSave(() => {}),
    });

    state.setForTarget("track-a", 1);
    const firstFlush = state.flushPending();
    const secondFlush = state.flushPending();
    state.setForTarget("track-a", 2);
    const failure = new Error("replacement failed");
    const firstOutcome = causeOf(firstFlush);
    const secondOutcome = causeOf(secondFlush);
    firstApply.reject(new SampledInstrumentSyncSupersededError(replacement.promise.then(() => "applied")));
    await drain();
    replacement.reject(failure);

    expect(await firstOutcome).toBe(failure);
    expect(await secondOutcome).toBe(failure);
    dispose();
  });
});

test("flushPending follows chained supersessions to the latest apply", async () => {
  await createRoot(async (dispose) => {
    const applies = [deferred(), deferred(), deferred()];
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-a",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: fixtureApply((_targetId, value) => applies[value - 1]?.promise),
      persistParams: fixtureSave(() => {}),
    });

    state.setForTarget("track-a", 1);
    const flush = state.flushPending();
    state.setForTarget("track-a", 2);
    state.setForTarget("track-a", 3);
    applies[0]?.reject(new SampledInstrumentSyncSupersededError((applies[1]?.promise ?? Promise.resolve()).then(() => "applied")));
    await drain();
    applies[1]?.reject(new SampledInstrumentSyncSupersededError((applies[2]?.promise ?? Promise.resolve()).then(() => "applied")));
    await drain();
    applies[2]?.resolve();

    await flush;
    dispose();
  });
});

test("serializes a local update after a pending remote apply and keeps it authoritative", async () => {
  await createRoot(async (dispose) => {
    const releases = new Map<number, () => void>();
    const applied: number[] = [];
    const announced: number[] = [];
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: fixtureApply(async (_targetId, next) => {
        await new Promise<void>((resolve) => releases.set(next, resolve));
        applied.push(next);
      }),
      persistParams: fixtureSave(() => {}),
      announce: (_targetId, next) => { announced.push(next); },
    });

    state.syncRemoteForTarget("track-1", 1);
    await drain();
    state.setForTarget("track-1", 9);
    expect(applied).toEqual([]);

    releases.get(1)?.();
    await drain();
    expect(applied).toEqual([1]);
    expect(announced).toEqual([]);
    expect(releases.has(9)).toBe(true);

    releases.get(9)?.();
    await state.flushPending();
    expect(applied).toEqual([1, 9]);
    expect(announced).toEqual([9]);
    expect(state.readForTarget("track-1")).toBe(9);
    dispose();
  });
});

// A released edit that failed rejects a flush with the owner's error; its first record carries the original cause.
const causeOf = (flush: Promise<unknown>) => flush.then(
  () => undefined,
  (cause: unknown) => cause instanceof ParameterReleaseFailedError ? cause.records[0]?.cause : cause,
);

const drain = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const deferred = () => {
  let resolve = () => {};
  let reject = (_cause: Error) => {};
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const settled = async (promise: Promise<unknown>) => {
  let outcome = "pending";
  void promise.then(() => { outcome = "resolved"; }, (cause: unknown) => { outcome = `rejected:${String(cause)}`; });
  for (let i = 0; i < 20; i++)    await drain();
  return outcome;
};

const createProjectWriteState = (projectId: () => string | undefined, writes: {
  persist: () => Promise<void>;
  errors: Array<{ cause: unknown; projectId: string | undefined }>;
}) => {
  const state = createPersistedEffectState<undefined, number>({
    targetId: () => "track-1",
    row: () => undefined,
    readQueryParams: () => undefined,
    createInitialParams: () => undefined,
    serializeParams: String,
    applyToEngine: fixtureApply(() => {}),
    persistParams: fixtureSave(writes.persist),
    createPersistContext: () => ({ projectId: projectId() }),
    onPersistError: (cause, context) => writes.errors.push({ cause, projectId: context?.projectId }),
  });
  return {
    ...state,
    flushPending: (projectId?: string) => projectId
      ? flushRegisteredLocalProjectWrites(projectId)
      : state.flushPending(),
  };
};

test("flushPending waits for a pending update write of its project only, then stops tracking it", async () => {
  await createRoot(async (dispose) => {
    let projectId: string | undefined = "project:a";
    const write = deferred();
    const errors: Array<{ cause: unknown; projectId: string | undefined }> = [];
    const state = createProjectWriteState(() => projectId, { persist: () => write.promise, errors });
    state.setForTarget("track-1", 1);
    projectId = "project:b";

    expect(await settled(state.flushPending("project:b"))).toBe("resolved");
    const projectFlush = state.flushPending("project:a");
    const globalFlush = state.flushPending();
    expect(await settled(projectFlush)).toBe("pending");
    expect(await settled(globalFlush)).toBe("pending");

    write.resolve();
    expect(await settled(projectFlush)).toBe("resolved");
    expect(await settled(globalFlush)).toBe("resolved");
    expect(errors).toEqual([]);
    dispose();
  });
});

test("a failed update write rejects flushPending once, reports once with its context, and is then untracked", async () => {
  await createRoot(async (dispose) => {
    const write = deferred();
    let persists = 0;
    const errors: Array<{ cause: unknown; projectId: string | undefined }> = [];
    // Only the first write fails.
    const state = createProjectWriteState(() => "project:a", { persist: () => persists++ === 0 ? write.promise : Promise.resolve(), errors });
    state.setForTarget("track-1", 1);
    const flush = state.flushPending("project:a");
    const cause = new Error("update failed");
    write.reject(cause);

    expect(await settled(flush)).toBe(`rejected:Error: A released parameter edit failed: track-1 (persist: ${cause.message})`);
    expect(errors).toEqual([{ cause, projectId: "project:a" }]);
    // The failed write is no longer awaited, and a rejected update is rolled back instead of retried.
    expect(await settled(state.flushPending("project:a"))).toBe("resolved");
    expect(persists).toBe(1);
    expect(errors).toHaveLength(1);
    dispose();
  });
});

// A release the engine did not install is saved, but never described to history or playback as installed.
const releaseWithApply = async (applyToEngine: (targetId: string, value: number) => Promise<void | EngineDisposition>) => {
  const persisted: number[] = [];
  const history: number[] = [];
  const announced: number[] = [];
  await createRoot(async (dispose) => {
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: fixtureApply(applyToEngine),
      persistParams: fixtureSave((_targetId, value) => { persisted.push(value); }),
      history: (_targetId, _previous, next) => { history.push(next); },
      announce: (_targetId, next) => { announced.push(next); },
    });
    state.setForTarget("track-1", 1);
    await state.flushPending();
    dispose();
  });
  return { persisted, history, announced };
};

test("a release whose apply was replaced by another request is not described as installed, even when the replacement installs", async () => {
  const written = await releaseWithApply(() => Promise.reject(new SampledInstrumentSyncSupersededError(Promise.resolve("applied"))));
  expect(written).toEqual({ persisted: [1], history: [], announced: [] });
});

test("a release whose apply was aborted is not described as installed", async () => {
  const written = await releaseWithApply(() => Promise.reject(new DOMException("cleared", "AbortError")));
  expect(written).toEqual({ persisted: [1], history: [], announced: [] });
});

test("after the engine did not install a value, an equal request to the previously delivered value is sent again", async () => {
  const audio = createFxTestAudio();
  const runtime = createLiveMixerRuntime({
    ensureAudio: () => {},
    getAudioContext: () => audio.context,
    getMasterInput: () => audio.masterInput,
    getDestination: () => null,
    reconnectTrackMeters: () => {},
    disposeTrackMeters: () => {},
    disposeSynthTrack: () => {},
    getMasterFx: () => ({}),
    getFaultGeneration: () => 0,
    workletBudget: createCountingBudget().budget,
  });
  try {
    await createRoot(async (dispose) => {
      const calls: number[] = [];
      let external: Promise<EngineDisposition> = Promise.resolve("skipped");
      const state = createPersistedEffectState<undefined, number>({
        targetId: () => "track-1",
        row: () => undefined,
        readQueryParams: () => undefined,
        createInitialParams: () => undefined,
        serializeParams: String,
        applyToEngine: fixtureApply((_targetId, value) => {
          calls.push(value);
          const work = runtime.setTrackFxInstances("track-1", [compressorInstance(value)]);
          if (value === -10) external = runtime.setTrackFxInstances("track-1", [compressorInstance(-6)]);
          return work;
        }),
        persistParams: fixtureSave(() => {}),
      });
      state.setForTarget("track-1", -24);
      await state.flushPending();
      state.setForTarget("track-1", -10);
      await state.flushPending();
      await external;
      expect(audio.compressorThreshold()).toBe(-6);

      state.setForTarget("track-1", -24);
      await state.flushPending();
      expect(calls).toEqual([-24, -10, -24]);
      expect(audio.compressorThreshold()).toBe(-24);
      dispose();
    });
  } finally {
    runtime.clear();
    audio.restore();
  }
});

for (const [outcome, entries] of [["dropped", 0], ["superseded", 0], ["applied", 1], ["joined", 1]] as const) {
  test(`a released change the engine answered ${outcome} is persisted and enters history ${entries} times`, async () => {
    await createRoot(async (dispose) => {
      const persisted: number[] = [];
      const history: number[] = [];
      const announced: number[] = [];
      const state = createPersistedEffectState<number | undefined, number>({
        targetId: () => "track-1",
        row: () => undefined,
        readQueryParams: (value) => value,
        createInitialParams: () => undefined,
        serializeParams: (value) => String(value),
        applyToEngine: fixtureApply(() => Promise.resolve(outcome)),
        persistParams: fixtureSave((_targetId, value) => { persisted.push(value); }),
        history: (_targetId, _previous, next) => { history.push(next); },
        announce: (_targetId, next) => { announced.push(next); },
      });

      state.setForTarget("track-1", 3);
      await state.flushPending();
      expect(persisted).toEqual([3]);
      expect(history).toHaveLength(entries);
      expect(announced).toHaveLength(entries);
      dispose();
    });
  });
}
