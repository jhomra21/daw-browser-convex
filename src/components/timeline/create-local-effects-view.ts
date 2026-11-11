import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import { isLocalId, type JsonValue } from "@daw-browser/shared";
import { listLocalEffects, type LocalEffectRow } from "~/lib/local-effects";
import { localProjectChangeSequence, subscribeToLocalProjectChanges } from "~/lib/local-project-changes";

type LocalEffectRows = LocalEffectRow<JsonValue>[];

// `through` is the project change sequence sampled before the rows were read: every change up to it is in `rows`.
export type LocalEffectsView = {
  projectId: string;
  lifetime: number;
  through: number;
  publicationId: object;
  rows: LocalEffectRows;
};

export type LocalEffectsPublicationId = LocalEffectsView["publicationId"];

type LocalEffectsViewOptions = {
  currentProjectId: () => string | undefined;
  list: (projectId: string) => Promise<LocalEffectRows>;
  publish: (view: LocalEffectsView | undefined) => void;
  // Called with the error of a failed read, and with undefined when a later read succeeds.
  fail: (error: Error | undefined) => void;
};

const toError = (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause));

// The one reader of a local project's effect rows. A lifetime is one local project from first sync to the next sync that
// leaves it (or dispose); a read belongs to the lifetime it started in, and only a read of a still-current lifetime that is
// not older than the published one becomes the view. A failed read leaves the last good view in place.
export const createLocalEffectsViewOwner = (options: LocalEffectsViewOptions) => {
  type Reload = {
    lifetime: number;
    through: number;
    publicationId: LocalEffectsPublicationId;
    promise: Promise<LocalEffectRows>;
  };
  const observers = new Set<(
    load: Promise<LocalEffectRows>,
    projectId: string,
    publicationId: LocalEffectsPublicationId,
  ) => void>();
  let lifetime = 0;
  let projectId: string | undefined;
  let unsubscribe: () => void = () => undefined;
  let publishedThrough = -1;
  let inflight: Reload | undefined;
  let disposed = false;

  const endLifetime = () => {
    lifetime += 1;
    unsubscribe();
    unsubscribe = () => undefined;
    projectId = undefined;
    publishedThrough = -1;
    inflight = undefined;
  };

  // A read that started at the current change sequence already sees every change, so a caller asking now joins it.
  const reload = (): Promise<LocalEffectRows> => {
    const id = projectId;
    if (id === undefined) return Promise.resolve([]);
    const through = localProjectChangeSequence(id);
    if (inflight && inflight.lifetime === lifetime && inflight.through === through) return inflight.promise;
    const startedIn = lifetime;
    const publicationId = {};
    const promise = options.list(id).then((rows) => {
      if (startedIn === lifetime && through >= publishedThrough) {
        publishedThrough = through;
        options.publish({ projectId: id, lifetime: startedIn, through, publicationId, rows });
        options.fail(undefined);
      }
      return rows;
    }, (cause: unknown) => {
      const error = toError(cause);
      if (startedIn === lifetime) options.fail(error);
      throw error;
    });
    const started: Reload = { lifetime: startedIn, through, publicationId, promise };
    inflight = started;
    const settled = () => {
      if (inflight === started) inflight = undefined;
    };
    promise.then(settled, settled);
    for (const observer of observers) observer(promise, id, publicationId);
    return promise;
  };

  // Failures are reported through `fail` and rejected to anyone awaiting the read; nobody is left holding an unhandled one.
  const reloadInBackground = () => {
    reload().catch(() => undefined);
  };

  const sync = () => {
    if (disposed) return;
    const next = options.currentProjectId();
    const local = next !== undefined && isLocalId("project", next) ? next : undefined;
    if (local === projectId) return;
    const hadLifetime = projectId !== undefined;
    endLifetime();
    if (hadLifetime) options.publish(undefined);
    if (local === undefined) return;
    projectId = local;
    unsubscribe = subscribeToLocalProjectChanges(local, reloadInBackground);
    reloadInBackground();
  };

  return {
    sync,
    reload,
    // Each started read is handed to every observer, so a second consumer waits on the read instead of making its own.
    watchReloads: (observer: (
      load: Promise<LocalEffectRows>,
      projectId: string,
      publicationId: LocalEffectsPublicationId,
    ) => void) => {
      observers.add(observer);
      return () => observers.delete(observer);
    },
    dispose: () => {
      disposed = true;
      endLifetime();
      observers.clear();
    },
  };
};

export const createLocalEffectsView = (input: {
  projectId: Accessor<string | undefined>;
  onError?: (title: string, message: string) => void;
}) => {
  const [view, setView] = createSignal<LocalEffectsView | undefined>();
  const owner = createLocalEffectsViewOwner({
    currentProjectId: input.projectId,
    list: listLocalEffects,
    publish: (next) => setView(next),
    fail: (error) => {
      if (error) input.onError?.("Local effects unavailable", error.message);
    },
  });
  createEffect(() => {
    input.projectId();
    untrack(owner.sync);
  });
  onCleanup(owner.dispose);
  return { view, reload: owner.reload, watchReloads: owner.watchReloads };
};

export type LocalEffectsViewSource = ReturnType<typeof createLocalEffectsView>;
