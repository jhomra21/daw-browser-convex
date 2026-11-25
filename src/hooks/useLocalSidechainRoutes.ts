import { createEffect, createSignal, type Accessor } from "solid-js";
import { isLocalId } from "@daw-browser/shared";
import type { ExternalSidechainRoute } from "@daw-browser/timeline-core/types";
import { replaceEqualDeep } from "@tanstack/solid-query";
import { subscribeToLocalProjectChanges } from "~/lib/local-project-changes";
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository";

// A local project's sidechain routes, re-read on every committed local change so route writes, undo and track deletion show up.
export const useLocalSidechainRoutes = (projectId: Accessor<string>) => {
  const [routes, setRoutes] = createSignal<ExternalSidechainRoute[]>([], {
    equals: (previous, next) => replaceEqualDeep(previous, next) === previous,
  });

  createEffect(projectId, (id) => {
    setRoutes([]);

    if (!isLocalId("project", id)) return;
    const repository = createLocalTimelineRepository(id);
    let active = true;
    let latestRead = 0;

    const reload = () => {
      const read = ++latestRead;

      repository.loadSidechainRoutes().then((next) => {
        if (active && read === latestRead) setRoutes(next);
      }, () => undefined);
    };

    reload();
    const unsubscribe = subscribeToLocalProjectChanges(id, reload);

    return () => {
      active = false;
      unsubscribe();
    };
  });

  return routes;
};
