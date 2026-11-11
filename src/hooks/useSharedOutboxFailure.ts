import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { isLocalId } from "@daw-browser/shared";
import { subscribeToLocalProjectChanges } from "~/lib/local-project-changes";
import { readSharedOutboxRetryState } from "~/lib/shared-outbox";

type SharedOutboxFailure = { reason: string; permanent: boolean };

export const useSharedOutboxFailure = (input: Accessor<{ projectId: string; userId?: string }>) => {
  const [failure, setFailure] = createSignal<SharedOutboxFailure>();
  createEffect(() => {
    const { projectId, userId } = input();
    setFailure(undefined);
    if (!projectId || isLocalId("project", projectId) || !userId) return;
    let active = true;
    let inFlight = false;
    let changedDuringRead = false;
    // Reads are serialized (one in flight, one coalesced follow-up), so results always apply in order.
    const read = () => {
      inFlight = true;
      changedDuringRead = false;
      void readSharedOutboxRetryState(projectId, userId)
        .then(
          (state) => { if (active) setFailure(state.failure); },
          () => undefined,
        )
        .finally(() => {
          inFlight = false;
          if (active && changedDuringRead) read();
        });
    };
    const refresh = () => {
      if (inFlight) {
        changedDuringRead = true;
        return;
      }
      read();
    };
    const unsubscribe = subscribeToLocalProjectChanges(projectId, refresh);
    refresh();
    onCleanup(() => {
      active = false;
      unsubscribe();
    });
  });
  return failure;
};
