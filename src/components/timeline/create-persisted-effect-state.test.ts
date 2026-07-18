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
