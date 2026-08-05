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
    await Promise.resolve();
    await state.flushPending();
    expect(applied).toEqual([3]);
    expect(persisted).toEqual([3]);
    dispose();
  });
});
