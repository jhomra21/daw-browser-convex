import { createEffect, createSignal, type Accessor } from "solid-js";
import { isLocalId } from "@daw-browser/shared";
import type { ExternalSidechainRoute } from "@daw-browser/timeline-core/types";
import { replaceEqualDeep } from "@tanstack/solid-query";
import { subscribeToLocalProjectChanges } from "~/lib/local-project-changes";
import type { TimelineSnapshot } from "~/lib/timeline-repository/types";
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository";

// A local project's sidechain routes, re-read on every committed local change so route writes, undo and track deletion show up.
// Until the first read of a project lands, the routes of the timeline snapshot already loaded for it stand in, so a keyed
// processor does not render unkeyed for a frame after the project opens.
export const useLocalSidechainRoutes = (
  projectId: Accessor<string>,
  snapshot: Accessor<Pick<TimelineSnapshot, "projectId" | "sidechainRoutes"> | null>,
) => {
  const [read, setRead] = createSignal<ExternalSidechainRoute[] | undefined>(undefined, {
    equals: (previous, next) => replaceEqualDeep(previous, next) === previous,
  });

  createEffect(projectId, (id) => {
    setRead(undefined);

    if (!isLocalId("project", id)) return;
    const repository = createLocalTimelineRepository(id);
    let active = true;
    let latestRead = 0;

    const reload = () => {
      const current = ++latestRead;

      repository.loadSidechainRoutes().then((next) => {
        if (active && current === latestRead) setRead(next);
      }, (error) => {
        console.error("[Timeline] reading the local sidechain routes failed", error);
      });
    };

    reload();
    const unsubscribe = subscribeToLocalProjectChanges(id, reload);

    return () => {
      active = false;
      unsubscribe();
    };
  });

  return (): ExternalSidechainRoute[] => {
    const routes = read();

    if (routes) return routes;
    const seed = snapshot();

    return seed?.projectId === projectId() ? seed.sidechainRoutes ?? [] : [];
  };
};
