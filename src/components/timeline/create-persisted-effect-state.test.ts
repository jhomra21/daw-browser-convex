import { expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { createPersistedEffectState } from "./create-persisted-effect-state";

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
      applyToEngine: () => {},
      persistParams: (_targetId, value) => {
        persisted.push(value);
      },
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
      applyToEngine: async (_targetId, value) => {
        await applyPending;
        applied.push(value);
      },
      persistParams: (_targetId, value) => {
        persisted.push(value);
      },
    });

    state.setForTarget("track-1", 3);
    await Promise.resolve();
    expect(applied).toEqual([]);
    expect(persisted).toEqual([]);

    releaseApply();
    await state.flushPending();
    expect(applied).toEqual([3]);
    expect(persisted).toEqual([3]);
    dispose();
  });
});

test("notifies apply completion after asynchronous engine application", async () => {
  await createRoot(async (dispose) => {
    const events: string[] = [];
    let releaseApply = () => {};
    const applyPending = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: (value) => String(value),
      applyToEngine: async () => {
        events.push("apply-start");
        await applyPending;
        events.push("apply-complete");
      },
      persistParams: () => {},
      onParamsApplied: () => events.push("applied"),
      onApplyCompleted: () => events.push("completed"),
    });

    state.setForTarget("track-1", 1);
    await Promise.resolve();
    expect(events).toEqual(["apply-start", "applied"]);

    releaseApply();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["apply-start", "applied", "apply-complete", "completed"]);
    dispose();
  });
});

test("reports completed instrument changes, including same-instance edits, exactly once", async () => {
  await createRoot(async (dispose) => {
    const structuralChanges: string[] = [];
    let releaseApply = () => {};
    let applyPending = Promise.resolve();
    const state = createPersistedEffectState<
      undefined,
      { kind: "synth" | "sampler"; instanceId: string; value: number }
    >({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: (value) => JSON.stringify(value),
      applyToEngine: async (_targetId, next) => {
        applyPending = new Promise<void>((resolve) => {
          releaseApply = resolve;
        });
        await applyPending;
        structuralChanges.push(`${next.kind}:${next.instanceId}:${next.value}`);
      },
      persistParams: () => Promise.resolve(),
      onApplyCompleted: (_targetId, _previous, next) => structuralChanges.push(`completed:${next.kind}:${next.instanceId}:${next.value}`),
    });

    state.setForTarget("track-1", { kind: "synth", instanceId: "instrument:1", value: 0 });
    expect(structuralChanges).toEqual([]);
    releaseApply();
    await state.flushPending();
    state.setForTarget("track-1", { kind: "synth", instanceId: "instrument:1", value: 1 });
    expect(structuralChanges).toEqual(["synth:instrument:1:0", "completed:synth:instrument:1:0"]);
    releaseApply();
    await state.flushPending();
    expect(structuralChanges).toEqual([
      "synth:instrument:1:0",
      "completed:synth:instrument:1:0",
      "synth:instrument:1:1",
      "completed:synth:instrument:1:1",
    ]);
    state.setForTarget("track-1", { kind: "synth", instanceId: "instrument:1", value: 1 });
    await state.flushPending();

    expect(structuralChanges).toEqual([
      "synth:instrument:1:0",
      "completed:synth:instrument:1:0",
      "synth:instrument:1:1",
      "completed:synth:instrument:1:1",
    ]);
    dispose();
  });
});

test("applies remote instrument identity changes once and ignores local persistence echoes", async () => {
  await createRoot(async (dispose) => {
    const [row, setRow] = createSignal<{ kind: "synth" | "sampler"; instanceId: string; value: number } | undefined>({
      kind: "synth",
      instanceId: "instrument:1",
      value: 0,
    });
    const applied: string[] = [];
    const structuralChanges: string[] = [];
    const state = createPersistedEffectState<
      { kind: "synth" | "sampler"; instanceId: string; value: number } | undefined,
      { kind: "synth" | "sampler"; instanceId: string; value: number }
    >({
      targetId: () => "track-1",
      row,
      readQueryParams: (value) => value,
      createInitialParams: () => undefined,
      serializeParams: (value) => JSON.stringify(value),
      applyToEngine: (_targetId, next) => {
        applied.push(`${next.kind}:${next.instanceId}`);
      },
      persistParams: () => Promise.resolve(),
      onApplyCompleted: (_targetId, previous, next) => {
        if (previous?.kind !== next.kind || previous?.instanceId !== next.instanceId) {
          structuralChanges.push(`local:${next.kind}:${next.instanceId}`);
        }
      },
      onEngineStateChanged: (_targetId, previous, next, source) => {
        if (source === "remote" && (previous?.kind !== next.kind || previous?.instanceId !== next.instanceId)) {
          structuralChanges.push(`remote:${next.kind}:${next.instanceId}`);
        }
      },
    });

    state.syncRemoteForTarget("track-1", { kind: "synth", instanceId: "instrument:1", value: 0 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual(["synth:instrument:1"]);
    expect(structuralChanges).toEqual(["remote:synth:instrument:1"]);

    state.setForTarget("track-1", { kind: "sampler", instanceId: "instrument:2", value: 0 });
    await state.flushPending();
    expect(applied).toEqual(["synth:instrument:1", "sampler:instrument:2"]);
    expect(structuralChanges).toEqual([
      "remote:synth:instrument:1",
      "local:sampler:instrument:2",
    ]);

    setRow({ kind: "sampler", instanceId: "instrument:2", value: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual(["synth:instrument:1", "sampler:instrument:2"]);
    expect(structuralChanges).toEqual([
      "remote:synth:instrument:1",
      "local:sampler:instrument:2",
    ]);
    dispose();
  });
});

test("gates remote structural completion by its captured project and generation", async () => {
  await createRoot(async (dispose) => {
    let projectId = "project-a";
    let projectGeneration = 1;
    const releases = new Map<number, () => void>();
    const structuralChanges: number[] = [];
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: async (_targetId, next) => {
        await new Promise<void>((resolve) => {
          releases.set(next, resolve);
        });
      },
      persistParams: () => {},
      createPersistContext: () => ({ projectId, projectGeneration }),
      onEngineStateChanged: (_targetId, _previous, next, _source, context) => {
        if (context?.projectId === projectId && context.projectGeneration === projectGeneration) {
          structuralChanges.push(next);
        }
      },
    });

    state.syncRemoteForTarget("track-1", 1);
    await Promise.resolve();
    projectId = "project-b";
    projectGeneration = 2;
    releases.get(1)?.();
    await state.flushPending();
    expect(structuralChanges).toEqual([]);

    state.syncRemoteForTarget("track-1", 2);
    await Promise.resolve();
    releases.get(2)?.();
    await state.flushPending();
    expect(structuralChanges).toEqual([2]);
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
      applyToEngine: async (_targetId, next) => {
        await new Promise<void>((resolve) => releases.set(next, resolve));
        applied.push(next);
      },
      persistParams: () => {},
      onEngineStateChanged: (_targetId, _previous, next) => completed.push(next),
    });

    state.syncRemoteForTarget("track-1", 1);
    state.syncRemoteForTarget("track-1", 2);
    expect(applied).toEqual([]);

    releases.get(1)?.();
    await Promise.resolve();
    await Promise.resolve();
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
      applyToEngine: async (_targetId, next) => {
        await new Promise<void>((resolve) => releases.set(next, resolve));
        applied.push(next);
      },
      persistParams: () => {},
    });

    state.syncRemoteForTarget("track-1", 1);
    state.syncRemoteForTarget("track-1", 2);
    state.syncRemoteForTarget("track-1", 3);
    releases.get(1)?.();
    await Promise.resolve();
    await Promise.resolve();
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
      applyToEngine: () => {
        attempts += 1;
        return Promise.reject(new Error("apply failed"));
      },
      persistParams: () => {},
      onPersistError: () => {
        errors += 1;
      },
    });

    state.syncRemoteForTarget("track-1", 1);
    for (let index = 0; index < 5; index += 1) await Promise.resolve();

    expect(attempts).toBe(1);
    expect(errors).toBe(1);
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
      applyToEngine: (_targetId, next) => {
        applied.push(next);
        return next === 1 ? Promise.reject(new Error("apply failed")) : Promise.resolve();
      },
      persistParams: () => {},
      onPersistError: () => {
        errors += 1;
      },
      onEngineStateChanged: (_targetId, _previous, next) => {
        completed.push(next);
      },
    });

    state.syncRemoteForTarget("track-1", 1);
    state.syncRemoteForTarget("track-1", 2);
    for (let index = 0; index < 5; index += 1) await Promise.resolve();

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
      applyToEngine: async (_targetId, next) => {
        await new Promise<void>((resolve) => releases.set(next, resolve));
        applied.push(next);
      },
      persistParams: () => {},
    });

    state.syncRemoteForTarget("track-1", 1);
    state.syncRemoteForTarget("track-1", 2);
    let flushed = false;
    const pendingFlush = state.flushPending().then(() => {
      flushed = true;
    });

    releases.get(1)?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual([1]);
    expect(flushed).toBeFalse();

    releases.get(2)?.();
    await pendingFlush;
    expect(applied).toEqual([1, 2]);
    expect(flushed).toBeTrue();
    dispose();
  });
});

test("serializes a local update after a pending remote apply and keeps it authoritative", async () => {
  await createRoot(async (dispose) => {
    const releases = new Map<number, () => void>();
    const applied: number[] = [];
    const localCompleted: number[] = [];
    const remoteCompleted: number[] = [];
    const state = createPersistedEffectState<undefined, number>({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: String,
      applyToEngine: async (_targetId, next) => {
        await new Promise<void>((resolve) => releases.set(next, resolve));
        applied.push(next);
      },
      persistParams: () => {},
      onApplyCompleted: (_targetId, _previous, next) => localCompleted.push(next),
      onEngineStateChanged: (_targetId, _previous, next) => remoteCompleted.push(next),
    });

    state.syncRemoteForTarget("track-1", 1);
    state.setForTarget("track-1", 9);
    expect(applied).toEqual([]);

    releases.get(1)?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual([1]);
    expect(remoteCompleted).toEqual([]);
    expect(releases.has(9)).toBe(true);

    releases.get(9)?.();
    await state.flushPending();
    expect(applied).toEqual([1, 9]);
    expect(remoteCompleted).toEqual([]);
    expect(localCompleted).toEqual([9]);
    expect(state.readForTarget("track-1")).toBe(9);
    dispose();
  });
});
