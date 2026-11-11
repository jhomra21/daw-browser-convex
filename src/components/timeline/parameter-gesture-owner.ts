import { batch, createEffect, createMemo, createSignal, getListener, on, onCleanup, untrack, type Accessor } from "solid-js";
import type { EngineDisposition } from "@daw-browser/audio-engine/audio-engine";
import type { DeliveryRegistration, LiveProcessorEditIdentity, ProcessorDelivery } from "~/lib/live-processor-control";
import { consumeSharedOutboxCompletion, readSharedOutboxOperation, subscribeToSharedOutboxSettlements, type DurableEffectsPublication } from "~/lib/shared-outbox";
import { decodeEffectsOperationResult } from "~/lib/shared-timeline-operations-api";
import { z } from "zod";

const decodedEffectsResult = z.object({
  status: z.literal("applied"), effectId: z.string(),
  revision: z.union([z.object({ kind: z.literal("committed-unordered") }), z.object({ kind: z.literal("ordered"), revision: z.number().int().positive() })]),
});

export class ParameterGestureHolder {}
export type GestureScope = { projectId: string | undefined; generation: number; userId?: string };
export type GestureLifetime = GestureScope & { incarnation: number };
export type ApplyPhase = "preview" | "final" | "row";
export type ParameterSaveResult =
  | { kind: "committed"; through: number }
  | { kind: "committed-unordered" }
  | { kind: "admitted"; entryId: string }
  | { kind: "rejected"; reason: string };

export const parameterSaveResult = (result: DurableEffectsPublication | { row: object; sequence: number }): ParameterSaveResult => {
  if ("sequence" in result) return { kind: "committed", through: result.sequence };
  if (result.kind !== "applied") return result;
  const alreadyDecoded = decodedEffectsResult.safeParse(result.result);
  const decoded = alreadyDecoded.success ? alreadyDecoded.data : decodeEffectsOperationResult(result.result);
  if (decoded.status === "invalid") return { kind: "rejected", reason: "The effect target no longer exists." };
  return decoded.revision.kind === "ordered"
    ? { kind: "committed", through: decoded.revision.revision }
    : { kind: "committed-unordered" };
};

export type ParameterDrain<Target> = {
  unanswered: Array<{ target: Target; receipt: DeliveryRegistration["receipt"] }>;
  admitted: Array<{ target: Target; entryId: string }>;
};
export type ReleaseStatus = "queued" | "applying" | "persisting" | "done" | "failed" | "invalidated";
export type ReleaseRecord<Target, Params> = {
  readonly target: Target;
  readonly key: string;
  readonly lifetime: GestureLifetime;
  baseline: Params | undefined;
  readonly latest: Params;
  readonly edit: LiveProcessorEditIdentity | undefined;
  readonly gesture?: ProcessorDelivery["gesture"];
  status: ReleaseStatus;
  failure?: { stage: "apply" | "persist"; cause: unknown };
};
type ParameterGestureAdapter<Target, Params> = {
  key: (target: Target) => string;
  scope: () => GestureScope;
  exists: (target: Target) => boolean;
  canWrite: () => boolean;
  equal: (target: Target, a: Params, b: Params) => boolean;
  initial: (target: Target) => Params | undefined;
  committed: (target: Target) => Params | undefined;
  rowsReachEngine?: () => boolean;
  apply: (target: Target, params: Params, edit: LiveProcessorEditIdentity | undefined, from: Params | undefined, phase: ApplyPhase) => EngineDisposition | undefined | Promise<EngineDisposition | undefined>;
  registerDelivery?: (target: Target, params: Params, edit: LiveProcessorEditIdentity | undefined, gesture: ProcessorDelivery["gesture"], lifetime: GestureLifetime) => DeliveryRegistration | undefined;
  rowApplied?: (target: Target, row: Params, edit: LiveProcessorEditIdentity | undefined) => void | Promise<void>;
  rowRemoved?: (target: Target) => void | Promise<void>;
  clear?: (target: Target) => void | Promise<void>;
  persist: (record: ReleaseRecord<Target, Params>) => Promise<ParameterSaveResult>;
  history: (record: ReleaseRecord<Target, Params>) => void;
  retired?: (key: string) => void;
  announce?: (record: ReleaseRecord<Target, Params>) => void | Promise<void>;
  allocateEdit: (target: Target, from: Params | undefined, to: Params) => LiveProcessorEditIdentity | undefined;
  onError: (stage: "apply" | "persist", cause: unknown, record: ReleaseRecord<Target, Params> | undefined) => void;
};
export type ParameterGestureHandle = {
  open: (holder: ParameterGestureHolder) => void;
  tick: (holder: ParameterGestureHolder, emit: () => void) => boolean;
  end: (holder: ParameterGestureHolder) => void;
  cancel: (holder: ParameterGestureHolder) => void;
  once: (emit: () => void) => void;
  isOpen: (holder?: ParameterGestureHolder) => boolean;
  closed: Accessor<number>;
};
type ParameterGestureOwner<Target, Params> = {
  handle: (target: () => Target) => ParameterGestureHandle;
  write: (target: Target, updater: (current: Params) => Params) => void;
  set: (target: Target, params: Params) => void;
  external: (target: Target, row: Params | undefined, through?: number) => void;
  reinstall: () => void;
  replay: (target: Target, params: Params) => boolean;
  settle: (target: Target) => Promise<void>;
  close: (target: Target, mode: "cancel" | "drop") => void;
  closeAll: (mode: "cancel") => void;
  discard: (target: Target) => void;
  committed: (target: Target) => Params | undefined;
  effective: (target: Target) => Params | undefined;
  provisional: (target: Target) => Params | undefined;
  flushPending: (projectId?: string) => Promise<ParameterDrain<Target>>;
  retained: () => number;
};
export class ParameterReleaseFailedError extends Error {
  constructor(readonly records: ReadonlyArray<{ key: string; stage: string; cause: unknown }>) {
    super(`A released parameter edit failed: ${records.map((record) => `${record.key} (${record.stage}${record.cause instanceof Error ? `: ${record.cause.message}` : ""})`).join(", ")}`);
  }
}
type Gesture<Target, Params> = {
  target: Target; key: string; lifetime: GestureLifetime; token: string;
  holders: Set<ParameterGestureHolder>; baseline: Params | undefined; latest: Params | undefined;
  edit: LiveProcessorEditIdentity | undefined; job: number | undefined; queued: boolean;
};
type Cell<Params> = { draft?: Params; overlay?: Params; removed?: true };
type Lane<Target> = { target: Target; tail: Promise<void>; pending: number };

export function createParameterGestureOwner<Target, Params>(adapter: ParameterGestureAdapter<Target, Params>): ParameterGestureOwner<Target, Params> {
  type Rec = ReleaseRecord<Target, Params>;
  type Live = Gesture<Target, Params>;
  type Echo = { value: Params; record: Rec; write: ParameterSaveResult | { kind: "persisting" }; installed: boolean };
  const same = (target: Target, a: Params | undefined, b: Params | undefined) => a !== undefined && b !== undefined && adapter.equal(target, a, b);
  const scopeOf = () => untrack(adapter.scope);
  const sameScope = (a: GestureScope, b: GestureScope) => a.projectId === b.projectId && a.generation === b.generation && a.userId === b.userId;
  const cells = new Map<string, Cell<Params>>();
  const triggers = new Map<string, { track: Accessor<undefined>; notify: () => void; readers: number }>();
  const readCell = (key: string) => {
    if (getListener()) {
      let trigger = triggers.get(key);
      if (!trigger) {
        const [track, notify] = createSignal<undefined>(undefined, { equals: false });
        trigger = { track, notify: () => notify(undefined), readers: 0 };
        triggers.set(key, trigger);
      }
      const mine = trigger;
      mine.track();
      mine.readers++;
      onCleanup(() => {
        mine.readers--;
        if (mine.readers === 0 && triggers.get(key) === mine) triggers.delete(key);
      });
    }
    return cells.get(key);
  };
  const patchCell = (key: string, changes: Cell<Params>) => {
    const next = { ...cells.get(key), ...changes };
    if (next.draft !== undefined || next.overlay !== undefined || next.removed) cells.set(key, next);
    else cells.delete(key);
    triggers.get(key)?.notify();
  };
  const handles = new Set<{ key: () => string; bump: () => void }>();
  const bumpClosed = (key?: string) => {
    for (const entry of handles) if (key === undefined || untrack(entry.key) === key) entry.bump();
  };
  const lifetimes = new Map<string, GestureLifetime>();
  const installed = new Map<string, { lifetime: GestureLifetime; context: number; value: Params }>();
  let context = 0;
  const gestures = new Map<string, Live>();
  const holders = new Map<ParameterGestureHolder, Live>();
  const lanes = new Map<string, Lane<Target>>();
  const queue: Rec[] = [];
  const echoes = new Map<string, Echo[]>();
  type Observation = { target: Target; value: Params; through: number; lifetime: GestureLifetime; token: object };
  const observed = new Map<string, Observation>();
  const receipts = new Set<{ key: string; target: Target; lifetime: GestureLifetime; registration: DeliveryRegistration }>();
  const subscriptions = new Map<Echo, () => void>();
  const durableReads = new Map<Echo, { promise: Promise<void>; woken: boolean }>();
  let failures: Array<{ key: string; projectId: string | undefined; stage: string; cause: unknown }> = [];
  let tickKey: string | undefined;
  let incarnation = 0;
  const lifetimeFor = (key: string) => {
    let lifetime = lifetimes.get(key);
    if (!lifetime) {
      installed.delete(key);
      lifetime = { ...scopeOf(), incarnation: ++incarnation };
      lifetimes.set(key, lifetime);
    }
    return lifetime;
  };
  const live = (key: string, lifetime: GestureLifetime) => lifetimes.get(key) === lifetime && sameScope(scopeOf(), lifetime);
  const removeRecord = (record: Rec) => {
    const index = queue.indexOf(record);
    if (index >= 0) queue.splice(index, 1);
  };
  const forgetEcho = (key: string, echo: Echo) => {
    subscriptions.get(echo)?.();
    subscriptions.delete(echo);
    const list = echoes.get(key);
    const index = list?.indexOf(echo) ?? -1;
    if (list && index >= 0) list.splice(index, 1);
    if (list?.length === 0) echoes.delete(key);
  };
  const retire = (key: string) => {
    if (lanes.get(key)?.pending || gestures.has(key) || queue.some(record => record.key === key)
      || echoes.has(key) || [...receipts].some(receipt => receipt.key === key && live(key, receipt.lifetime))) return;
    lanes.delete(key);
    adapter.retired?.(key);
  };
  const enqueue = (key: string, target: Target, work: () => void | Promise<void>) => {
    let lane = lanes.get(key);
    if (!lane) {
      lane = { target, tail: Promise.resolve(), pending: 0 };
      lanes.set(key, lane);
    }
    const mine = lane;
    mine.pending++;
    mine.tail = mine.tail.then(work).catch(cause => adapter.onError("apply", cause, undefined)).then(() => {
      mine.pending--;
      retire(key);
    });
    return mine.tail;
  };
  const rowFor = (target: Target, key: string) => observed.get(key)?.value ?? untrack(() => adapter.committed(target));
  const committedView = (target: Target, key: string) => cells.get(key)?.draft ?? rowFor(target, key);
  const effective = (target: Target) => {
    const key = adapter.key(target), cell = readCell(key);
    return cell?.removed ? undefined : cell?.overlay ?? cell?.draft ?? observed.get(key)?.value ?? adapter.committed(target);
  };
  const register = (target: Target, value: Params, edit: LiveProcessorEditIdentity | undefined, gesture: ProcessorDelivery["gesture"], lifetime: GestureLifetime) => {
    const registration = adapter.registerDelivery?.(target, value, edit, gesture, lifetime);
    if (!registration) return;
    const entry = { key: adapter.key(target), target, lifetime, registration };
    receipts.add(entry);
    // Native proof is observed independently. It never gates persistence, history, or the FIFO.
    void registration.settled.then(() => {
      receipts.delete(entry);
      retire(entry.key);
    }, cause => {
      receipts.delete(entry);
      if (live(entry.key, lifetime)) adapter.onError("apply", cause, undefined);
      retire(entry.key);
    });
  };
  const deliver = async (target: Target, value: Params, edit: LiveProcessorEditIdentity | undefined, from: Params | undefined,
    phase: ApplyPhase, gesture: ProcessorDelivery["gesture"], lifetime: GestureLifetime) => {
    // An in-flight apply belongs to its submitted context, even if reinstall happens before it settles.
    // Applies are not transactional: a failed replacement may already have disposed the previous content.
    const key = adapter.key(target), installationContext = context;
    installed.delete(key);
    const outcome = await adapter.apply(target, value, edit, from, phase);
    if (live(key, lifetime) && outcome !== "dropped" && outcome !== "superseded") {
      installed.set(key, { lifetime, context: installationContext, value });
    }
    if (live(key, lifetime)) register(target, value, edit, gesture, lifetime);
    return outcome;
  };
  const isInstalled = (key: string, target: Target, lifetime: GestureLifetime) => {
    const record = installed.get(key);
    return record?.lifetime === lifetime && record.context === context && same(target, record.value, effective(target));
  };
  const deliverEffective = async (key: string, target: Target, lifetime: GestureLifetime, closedToken?: string) => {
    if (!live(key, lifetime) || cells.get(key)?.removed) return;
    const value = effective(target);
    if (value === undefined) return;
    const holding = gestures.get(key);
    const edit = adapter.allocateEdit(target, undefined, value);
    const gesture = holding ? { token: holding.token, holds: true } : closedToken ? { token: closedToken, holds: false } : undefined;
    await deliver(target, value, edit, undefined, "preview", gesture, lifetime);
  };
  const reconcileObservation = (key: string) => {
    const observation = observed.get(key), list = echoes.get(key);
    if (!observation || !live(key, observation.lifetime)) return;
    const before = effective(observation.target);
    const newest = list?.at(-1);
    let covered = -1;
    for (let index = 0; index < (list?.length ?? 0); index++) {
      const echo = list?.[index];
      if (!echo) continue;
      if (echo.write.kind === "committed" && echo.write.through <= observation.through
        || echo.write.kind === "committed-unordered" && (observation.through > 0 || same(observation.target, echo.value, observation.value))) covered = index;
    }
    const consumed = new Set(list?.slice(0, covered + 1).map(echo => echo.record));
    if (list && covered >= 0) {
      for (const echo of list.slice(0, covered + 1)) forgetEcho(key, echo);
      for (const record of queue) if (record.key === key && !consumed.has(record)) record.baseline = observation.value;
    }
    if (newest?.write.kind === "persisting" || newest?.write.kind === "admitted") return;
    if (echoes.has(key)) return;
    const gesture = gestures.get(key);
    if (gesture) gesture.baseline = observation.value;
    // A queued successor remains the displayed draft, but its undo baseline follows the committed observation.
    for (const record of queue) if (record.key === key && record.status === "queued") record.baseline = observation.value;
    if (!queue.some(record => record.key === key && record.status === "queued")) patchCell(key, { draft: undefined });
    if (list && !gestures.has(key) && !same(observation.target, before, effective(observation.target))) queueObservation(key, observation);
    retire(key);
  };
  const historyAndAnnounce = async (echo: Echo) => {
    const record = echo.record;
    if (!live(record.key, record.lifetime)) return;
    if (echo.installed) adapter.history(record);
    if (echo.installed && !queue.some(next => next.key === record.key && next !== record)) await adapter.announce?.(record);
  };
  const repairFailure = async (record: Rec, stage: "apply" | "persist", cause: unknown) => {
    record.status = "failed";
    record.failure = { stage, cause };
    removeRecord(record);
    failures.push({ key: record.key, projectId: record.lifetime.projectId, stage, cause });
    if (live(record.key, record.lifetime)) {
      const destination = echoes.get(record.key)?.at(-1)?.value ?? rowFor(record.target, record.key);
      const holding = gestures.get(record.key);
      const restored = holding?.latest ?? destination;
      const restoreEdit = restored === undefined ? undefined : adapter.allocateEdit(record.target, undefined, restored);
      if (same(record.target, cells.get(record.key)?.draft, record.latest)) patchCell(record.key, { draft: destination });
      for (const next of queue) if (next.key === record.key && same(record.target, next.baseline, record.latest)) next.baseline = destination;
      adapter.onError(stage, cause, record);
      if (!queue.some(next => next.key === record.key) && destination !== undefined) {
        try {
          await deliver(record.target, effective(record.target) ?? destination, restoreEdit, record.latest, "preview",
            holding ? { token: holding.token, holds: true } : record.gesture, record.lifetime);
        } catch { /* The original release failure is already reported; a later logical delivery still reaches the boundary. */ }
      }
    } else adapter.onError(stage, cause, record);
  };
  const readAdmission = (echo: Echo): Promise<void> => {
    const existing = durableReads.get(echo);
    if (existing) {
      existing.woken = true;
      return existing.promise;
    }
    const record = echo.record, write = echo.write;
    const { projectId, userId } = record.lifetime;
    if (write.kind !== "admitted" || !projectId || !userId || !live(record.key, record.lifetime)) return Promise.resolve();
    const pending = { promise: Promise.resolve(), woken: false };
    durableReads.set(echo, pending);
    pending.promise = (async () => {
      try {
        // Only a wake received behind a stale pending snapshot permits another
        // read. Quiesce without polling, and keep one reader for this echo.
        while (true) {
          pending.woken = false;
          const result = await readSharedOutboxOperation(projectId, userId, write.entryId);
          if (!live(record.key, record.lifetime) || echo.write !== write) return;
          if (result.status === "pending") {
            if (pending.woken) continue;
            return;
          }
          if (result.status === "rejected") {
            forgetEcho(record.key, echo);
            await repairFailure(record, "persist", new Error(result.lastError ?? "The effect could not be saved."));
            reconcileObservation(record.key);
            return;
          }
          if (result.status === "applied") echo.write = parameterSaveResult({ kind: "applied", entryId: write.entryId, result: result.result });
          else echo.write = { kind: "committed-unordered" };
          subscriptions.get(echo)?.();
          subscriptions.delete(echo);
          if (echo.write.kind === "rejected") {
            forgetEcho(record.key, echo);
            await repairFailure(record, "persist", new Error(echo.write.reason));
          } else {
            reconcileObservation(record.key);
            await historyAndAnnounce(echo);
            if (result.status === "applied" && live(record.key, record.lifetime)) await consumeSharedOutboxCompletion(projectId, userId, write.entryId);
          }
          return;
        }
      } catch (cause) {
        adapter.onError("persist", cause, record);
      } finally {
        // Remove synchronously with the last pending check, before another wake
        // can join an already-finished read.
        durableReads.delete(echo);
        retire(record.key);
      }
    })();
    return pending.promise;
  };
  const invalidated = (record: Rec) => record.status === "invalidated";
  const runRecord = async (record: Rec) => {
    if (invalidated(record)) return;
    let installed = true;
    if (live(record.key, record.lifetime)) {
      record.status = "applying";
      try {
        const result = await deliver(record.target, record.latest, record.edit, record.baseline, "final", record.gesture, record.lifetime);
        installed = result !== "dropped" && result !== "superseded";
      } catch (cause) { return repairFailure(record, "apply", cause); }
    }
    if (invalidated(record)) return;
    record.status = "persisting";
    const echo: Echo = { value: record.latest, record, write: { kind: "persisting" }, installed };
    if (live(record.key, record.lifetime)) echoes.set(record.key, [...echoes.get(record.key) ?? [], echo]);
    try {
      echo.write = await adapter.persist(record);
      if (echo.write.kind === "rejected") throw new Error(echo.write.reason);
    } catch (cause) {
      forgetEcho(record.key, echo);
      await repairFailure(record, "persist", cause);
      reconcileObservation(record.key);
      return;
    }
    if (invalidated(record)) return;
    record.status = "done";
    removeRecord(record);
    if (!live(record.key, record.lifetime)) return;
    if (echo.write.kind === "admitted") {
      const { projectId, userId } = record.lifetime;
      if (!projectId || !userId) throw new Error("An admitted effect write requires its captured project and user.");
      subscriptions.set(echo, subscribeToSharedOutboxSettlements(projectId, userId, () => { void readAdmission(echo); }));
      await readAdmission(echo);
    } else {
      reconcileObservation(record.key);
      await historyAndAnnounce(echo);
    }
  };
  const release = (target: Target, key: string, lifetime: GestureLifetime, baseline: Params | undefined, latest: Params, token?: string) => {
    const record: Rec = {
      target, key, lifetime, baseline, latest, edit: adapter.allocateEdit(target, baseline, latest),
      gesture: token ? { token, holds: false } : undefined, status: "queued",
    };
    queue.push(record);
    batch(() => patchCell(key, { draft: latest, overlay: undefined }));
    void enqueue(key, target, () => runRecord(record));
  };
  const stopJob = (gesture: Live) => {
    if (gesture.job !== undefined) cancelAnimationFrame(gesture.job);
    gesture.job = undefined;
  };
  const forgetGesture = (gesture: Live) => {
    stopJob(gesture);
    if (gestures.get(gesture.key) === gesture) gestures.delete(gesture.key);
    for (const holder of gesture.holders) if (holders.get(holder) === gesture) holders.delete(holder);
  };
  const closeGesture = (gesture: Live, mode: "end" | "cancel" | "drop", announce: boolean) => {
    if (gestures.get(gesture.key) !== gesture) return;
    forgetGesture(gesture);
    if (announce) bumpClosed(gesture.key);
    const { key, target, lifetime, latest, baseline } = gesture;
    if (mode === "drop") { patchCell(key, { overlay: undefined }); retire(key); return; }
    if (mode === "end" && latest !== undefined && !same(target, latest, baseline)) return release(target, key, lifetime, baseline, latest, gesture.token);
    // Reserve the restore before publishing it. Execution still re-evaluates effective content and the current holding token.
    const destination = committedView(target, key);
    if (destination !== undefined) adapter.allocateEdit(target, undefined, destination);
    patchCell(key, { overlay: undefined });
    void enqueue(key, target, () => deliverEffective(key, target, lifetime, gesture.token));
  };
  const schedule = (gesture: Live) => {
    if (gesture.job !== undefined) return;
    const run = () => {
      gesture.job = undefined;
      // A queued preview reads the newest value when it starts, so it already carries every later frame.
      if (gesture.queued) return;
      gesture.queued = true;
      void enqueue(gesture.key, gesture.target, async () => {
        gesture.queued = false;
        if (gestures.get(gesture.key) !== gesture || !live(gesture.key, gesture.lifetime)) return;
        const value = effective(gesture.target);
        if (value === undefined) return;
        try { await deliver(gesture.target, value, gesture.edit, gesture.baseline, "preview", { token: gesture.token, holds: true }, gesture.lifetime); }
        catch (cause) { if (live(gesture.key, gesture.lifetime)) adapter.onError("apply", cause, undefined); }
      });
    };
    // Coalesce pointer input to one existing frame job. End, cancel, removal, scope changes and cleanup cancel it.
    if (globalThis.requestAnimationFrame) gesture.job = globalThis.requestAnimationFrame(run);
    else run();
  };
  const invalidate = (key: string) => {
    for (const record of queue.slice()) if (record.key === key) { record.status = "invalidated"; removeRecord(record); }
    for (const echo of echoes.get(key)?.slice() ?? []) forgetEcho(key, echo);
    lifetimes.delete(key);
    installed.delete(key);
  };
  const queueObservation = (key: string, observation: Observation) => {
    const { target, lifetime } = observation;
    if (!(adapter.rowsReachEngine?.() ?? false)) return;
    void enqueue(key, target, async () => {
      if (!live(key, lifetime) || observed.get(key)?.token !== observation.token || gestures.has(key) || queue.some(record => record.key === key)) return;
      const next = effective(target);
      if (next === undefined) return;
      const edit = adapter.allocateEdit(target, undefined, next);
      const result = isInstalled(key, target, lifetime) ? undefined : await deliver(target, next, edit, undefined, "row", undefined, lifetime);
      if (live(key, lifetime) && observed.get(key)?.token === observation.token && !queue.some(record => record.key === key)
        && result !== "dropped" && result !== "superseded") await adapter.rowApplied?.(target, next, edit);
    });
  };
  const external: ParameterGestureOwner<Target, Params>["external"] = (target, value, through = 0) => {
    const key = adapter.key(target), previous = observed.get(key);
    if (value === undefined) {
      if (!previous) return;
      const gesture = gestures.get(key);
      if (gesture) closeGesture(gesture, "drop", true);
      invalidate(key);
      observed.delete(key);
      const lifetime = lifetimeFor(key);
      patchCell(key, { draft: undefined, overlay: undefined, removed: true });
      void enqueue(key, target, async () => {
        if (!live(key, lifetime)) return;
        await adapter.clear?.(target);
        if (live(key, lifetime)) await adapter.rowRemoved?.(target);
      });
      return;
    }
    if (cells.get(key)?.removed) { lifetimes.delete(key); patchCell(key, { removed: undefined }); }
    const lifetime = lifetimeFor(key);
    if (previous && previous.lifetime === lifetime && through < previous.through) return;
    const before = effective(target), hadEcho = echoes.has(key);
    // An equivalent re-observation keeps the token so work queued for the earlier one stays valid.
    const equivalent = previous !== undefined && previous.lifetime === lifetime && same(target, previous.value, value);
    const observation = { target, value, through, lifetime, token: equivalent ? previous.token : {} };
    observed.set(key, observation);
    reconcileObservation(key);
    for (const echo of echoes.get(key) ?? []) if (echo.write.kind === "admitted") void readAdmission(echo);
    if (hadEcho || gestures.has(key) || same(target, before, effective(target)) && previous !== undefined) return;
    queueObservation(key, observation);
  };
  let lastScope = scopeOf();
  const scopeKey = createMemo(() => {
    const scope = adapter.scope();
    return `${scope.projectId}:${scope.userId}:${scope.generation}`;
  });
  createEffect(on(scopeKey, () => {
    const scope = scopeOf(), repair = scope.projectId === lastScope.projectId;
    lastScope = scope;
    const targets = new Map<string, Target>();
    for (const [key, observation] of observed) targets.set(key, observation.target);
    for (const [key, lane] of lanes) targets.set(key, lane.target);
    for (const gesture of gestures.values()) closeGesture(gesture, "drop", true);
    for (const [key, list] of echoes) for (const echo of list.slice()) forgetEcho(key, echo);
    lifetimes.clear();
    installed.clear();
    observed.clear();
    failures = [];
    const keys = [...cells.keys()];
    cells.clear();
    for (const key of keys) triggers.get(key)?.notify();
    if (repair) for (const [key, target] of targets) {
      const lifetime = lifetimeFor(key);
      void enqueue(key, target, () => deliverEffective(key, target, lifetime));
    }
    bumpClosed();
  }, { defer: true }));
  onCleanup(() => {
    for (const gesture of gestures.values()) forgetGesture(gesture);
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
    lifetimes.clear();
    installed.clear();
  });
  const writeOne = (target: Target, value: Params) => {
    const key = adapter.key(target), baseline = committedView(target, key);
    if (!same(target, baseline, value)) release(target, key, lifetimeFor(key), baseline, value);
  };
  const handle: ParameterGestureOwner<Target, Params>["handle"] = (resolve) => {
    const [closed, setClosed] = createSignal(0);
    const entry = { key: () => adapter.key(resolve()), bump: () => setClosed(value => value + 1) };
    handles.add(entry);
    onCleanup(() => handles.delete(entry));
    return {
      open: holder => {
        const target = resolve(), key = adapter.key(target);
        if (!adapter.canWrite() || !adapter.exists(target) || cells.get(key)?.removed) return;
        let gesture = gestures.get(key);
        if (!gesture) {
          const baseline = committedView(target, key);
          gesture = { target, key, lifetime: lifetimeFor(key), token: crypto.randomUUID(), holders: new Set(), baseline, latest: baseline, edit: undefined, job: undefined, queued: false };
          gestures.set(key, gesture);
        }
        gesture.holders.add(holder); holders.set(holder, gesture);
      },
      tick: (holder, emit) => {
        const gesture = holders.get(holder);
        if (!gesture) return false;
        const previous = tickKey; tickKey = gesture.key;
        try { emit(); } finally { tickKey = previous; }
        return true;
      },
      end: holder => {
        const gesture = holders.get(holder);
        if (!gesture) return;
        holders.delete(holder); gesture.holders.delete(holder);
        if (gesture.holders.size === 0) closeGesture(gesture, "end", false);
      },
      cancel: holder => { const gesture = holders.get(holder); if (gesture) closeGesture(gesture, "cancel", true); },
      once: emit => { const previous = tickKey; tickKey = undefined; try { emit(); } finally { tickKey = previous; } },
      isOpen: holder => holder ? holders.has(holder) : gestures.has(adapter.key(resolve())),
      closed,
    };
  };
  const write: ParameterGestureOwner<Target, Params>["write"] = (target, updater) => {
    const key = adapter.key(target);
    if (cells.get(key)?.removed) return;
    const gesture = gestures.get(key);
    if (gesture && tickKey === key) {
      const current = effective(target) ?? adapter.initial(target);
      if (current === undefined) return;
      const next = updater(current);
      if (same(target, gesture.latest, next)) return;
      gesture.edit = adapter.allocateEdit(target, gesture.latest, next);
      gesture.latest = next;
      patchCell(key, { overlay: next });
      schedule(gesture);
      return;
    }
    const current = (gesture ? committedView(target, key) : effective(target)) ?? adapter.initial(target);
    if (current !== undefined) writeOne(target, updater(current));
  };
  const drains = new Map<string | undefined, Promise<ParameterDrain<Target>>>();
  const drain: ParameterGestureOwner<Target, Params>["flushPending"] = async projectId => {
    for (const gesture of gestures.values()) if (!projectId || gesture.lifetime.projectId === projectId) closeGesture(gesture, "end", true);
    for (;;) {
      const tails = [...lanes.values()].map(lane => lane.tail);
      const reads = [...durableReads.values()].map(read => read.promise);
      await Promise.all([...tails, ...reads]);
      if ([...lanes.values()].every(lane => tails.includes(lane.tail)) && durableReads.size === 0) break;
    }
    const surfaced = failures.filter(failure => !projectId || failure.projectId === projectId);
    failures = failures.filter(failure => projectId && failure.projectId !== projectId);
    if (surfaced.length) throw new ParameterReleaseFailedError(surfaced);
    return {
      unanswered: [...receipts].filter(entry => live(entry.key, entry.lifetime) && (!projectId || entry.lifetime.projectId === projectId))
        .map(entry => ({ target: entry.target, receipt: entry.registration.receipt })),
      admitted: [...echoes.values()].flatMap(list => list.flatMap(echo => echo.write.kind === "admitted"
        ? [{ target: echo.record.target, entryId: echo.write.entryId }] : [])),
    };
  };
  const flushPending: ParameterGestureOwner<Target, Params>["flushPending"] = projectId => {
    const existing = drains.get(projectId);
    if (existing) return existing;
    const pending = drain(projectId).finally(() => { drains.delete(projectId); });
    drains.set(projectId, pending);
    return pending;
  };
  return {
    handle, write, external, effective, flushPending,
    // Installation context changed, not the row or gesture lifetime.
    reinstall: () => {
      context++;
      for (const [key, { target, lifetime }] of observed) {
        void enqueue(key, target, () => {
          if (!isInstalled(key, target, lifetime)) return deliverEffective(key, target, lifetime);
        });
      }
    },
    set: (target, params) => {
      const key = adapter.key(target);
      if (cells.get(key)?.removed) { lifetimes.delete(key); patchCell(key, { removed: undefined }); }
      writeOne(target, params);
    },
    replay: (target, params) => {
      const key = adapter.key(target);
      adapter.allocateEdit(target, params, params);
      patchCell(key, { draft: params });
      const gesture = gestures.get(key);
      if (gesture) { gesture.baseline = params; return true; }
      const lifetime = lifetimeFor(key);
      void enqueue(key, target, () => deliverEffective(key, target, lifetime));
      return false;
    },
    settle: target => lanes.get(adapter.key(target))?.tail ?? Promise.resolve(),
    close: (target, mode) => { const gesture = gestures.get(adapter.key(target)); if (gesture) closeGesture(gesture, mode, true); },
    closeAll: mode => { for (const gesture of gestures.values()) closeGesture(gesture, mode, true); bumpClosed(); },
    discard: target => {
      const key = adapter.key(target), gesture = gestures.get(key);
      if (gesture) closeGesture(gesture, "drop", true);
      invalidate(key); observed.delete(key); patchCell(key, { draft: undefined, overlay: undefined }); retire(key);
    },
    committed: target => cells.get(adapter.key(target))?.removed ? undefined : committedView(target, adapter.key(target)),
    provisional: target => { const cell = readCell(adapter.key(target)); return cell?.removed ? undefined : cell?.overlay ?? cell?.draft; },
    // Observed rows are model bookkeeping, not retained delivery lanes or installed-content knowledge.
    retained: () => new Set([...lanes.keys(), ...echoes.keys(), ...gestures.keys(), ...queue.map(record => record.key),
      ...[...receipts].filter(entry => live(entry.key, entry.lifetime)).map(entry => entry.key)]).size,
  };
}