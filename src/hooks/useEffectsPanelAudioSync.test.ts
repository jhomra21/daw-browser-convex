import { expect, test } from "bun:test";
import type { SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import {
  createEffectsPanelReadinessOwner,
  createPendingWorkOwner,
  registerSampledInstrumentWork,
  createSpectrumSubscriptionOwner,
} from "./useEffectsPanelAudioSync";
import type { Track } from "@daw-browser/timeline-core/types";
import type { TrackInstrumentParams } from "@daw-browser/shared";
import {
  createDefaultDrumRackParams,
  createDefaultGranularParams,
  createDefaultSamplerParams,
} from "@daw-browser/shared";

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
  readiness.startLocalLoad("project:local", () => rowsLoaded, () => undefined);
  const flush = readiness.flushPending("project:local");
  let settled = false;
  void flush.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);

  resolveRows?.([]);
  await Promise.resolve();
  readiness.markRowsProcessed("project:local");
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

  await readiness.startLocalLoad(
    projectId,
    async () => [],
    () => readiness.markRowsProcessed(projectId),
  );
  const flush = readiness.flushPending(projectId);
  try {
    await expect(flush).resolves.toBeUndefined();
  } finally {
    readiness.dispose();
  }
});

test("resolves an empty local row load and rejects a failed local row load clearly", async () => {
  const empty = createEffectsPanelReadinessOwner({
    loadLocalEffects: async () => [],
    currentProjectId: () => "project:empty",
  });
  await empty.startLocalLoad("project:empty", async () => [], () => undefined);
  empty.markRowsProcessed("project:empty");
  await expect(empty.flushPending("project:empty")).resolves.toBeUndefined();
  empty.dispose();

  const failed = createEffectsPanelReadinessOwner({
    loadLocalEffects: async () => [],
    currentProjectId: () => "project:failed",
  });
  await failed.startLocalLoad("project:failed", async () => {
    throw new Error("database unavailable");
  }, () => undefined);
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
    onLocalEffectsLoaded: (projectId, rows) => published.push(`${projectId}:${rows.length}`),
  });

  await readiness.startLocalLoad("project:local-a", async () => [], () => undefined);
  readiness.markRowsProcessed("project:local-a");
  await readiness.flushPending("project:local-a");

  currentProject = "project:local-b";
  readiness.projectChanged();
  currentProject = "project:local-a";
  readiness.projectChanged();
  await readiness.startLocalLoad("project:local-a", async () => [], () => undefined, true);
  readiness.markRowsProcessed("project:local-a");
  await readiness.flushPending("project:local-a");

  expect(published).toEqual(["project:local-a:0", "project:local-a:0"]);
  readiness.dispose();
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
  readiness.startLocalLoad("project:readiness-a", () => load, () => undefined);
  const pending = readiness.flushPending("project:readiness-a");
  currentProject = "project:readiness-b";
  readiness.projectChanged();
  await expect(pending).rejects.toThrow("Project changed while waiting for effects readiness");
  resolveLoad?.([]);
  readiness.dispose();
});

test("registers persisted sampled work while legacy graph application is disabled", async () => {
  const tracks: Track[] = [
    { id: "drum", kind: "instrument", name: "Drum", volume: 1, clips: [] },
    { id: "sampler", kind: "instrument", name: "Sampler", volume: 1, clips: [] },
    { id: "granular", kind: "instrument", name: "Granular", volume: 1, clips: [] },
  ];
  const instruments = new Map<string, TrackInstrumentParams>([
    ["drum", { kind: "drum-rack", instanceId: "drum-instance", params: createDefaultDrumRackParams() }],
    ["sampler", { kind: "sampler", instanceId: "sampler-instance", params: createDefaultSamplerParams() }],
    ["granular", { kind: "granular", instanceId: "granular-instance", params: createDefaultGranularParams() }],
  ]);
  const registered: string[] = [];
  const pending = new Set<Promise<unknown>>();
  const trackPendingWork = (_projectId: string, work: Promise<unknown> | void) => {
    if (work) pending.add(work);
  };
  registerSampledInstrumentWork({
    projectId: "project:portable",
    tracks,
    instruments,
    clearSamplerTrack: (trackId) => registered.push(`clear-sampler:${trackId}`),
    clearDrumRackTrack: (trackId) => registered.push(`clear-drum:${trackId}`),
    syncSamplerTrack: (trackId) => {
      registered.push(`sampler:${trackId}`);
      return Promise.resolve();
    },
    syncGranularTrack: (trackId) => {
      registered.push(`granular:${trackId}`);
      return Promise.resolve();
    },
    syncDrumRackTrack: (trackId) => {
      registered.push(`drum:${trackId}`);
      return Promise.resolve();
    },
    trackPendingWork,
  });

  await Promise.all(pending);
  expect(registered).toEqual([
    "clear-sampler:drum",
    "drum:drum",
    "clear-drum:sampler",
    "sampler:sampler",
    "clear-drum:granular",
    "granular:granular",
  ]);
});
