import { expect, test } from "bun:test";
import "fake-indexeddb/auto";
import { createRoot, createSignal } from "solid-js";
import { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import { createDefaultSynthParams, createDefaultUtilityParams, type TrackInstrumentParams } from "@daw-browser/shared";
import type { Track } from "@daw-browser/timeline-core/types";
import type { HistoryEntry, EffectParamsCommitPayload } from "~/lib/undo/types";
import { setLocalEffectInstance, listLocalEffects } from "~/lib/local-effects";
import { createProcessorEditRegistry } from "./timeline/create-processor-edit-registry";
import { createEffectsPanelAudioDevice } from "./timeline/create-effects-panel-audio-effects-state";
import { createLocalEffectsView } from "./timeline/create-local-effects-view";
import createTimelineEffectCommit from "./timeline/create-timeline-effect-commit";
import { createInstrumentPlaybackChange } from "./timeline/timeline-playback-wiring";
import {
  createCapturedEditorStatePersister,
  createExternalProcessorEditorRequests,
} from "./timeline/external-processor-editor-requests";
import { addInstanceLimit, clearInstanceLimits, clearVstInstanceFailures, markVstInstanceFailed } from "~/lib/desktop/vst-instance-failures";
import type { TimelinePlaybackRebuildIntent } from "~/hooks/timeline-playback-types";

// Failure-first B6 seam inventory: stale/missing project history, captured
// tracks, incorrect merge key/window, no-merge ignored, native refusal vetoing
// a durable panel commit, and a fixture copy bypassing the production callback.
test("B6 production effect commit reads current project/tracks and preserves merge history", () => {
  let projectId: string | undefined;
  let tracks: Track[] = [];
  const calls: { entry: HistoryEntry; mergeKey?: string; mergeWindowMs?: number }[] = [];
  const commit = createTimelineEffectCommit({ projectId: () => projectId, tracks: () => tracks,
    pushHistory: (entry, mergeKey, mergeWindowMs) => calls.push({ entry, mergeKey, mergeWindowMs }) });
  const from = createDefaultUtilityParams();
  const payload: EffectParamsCommitPayload = { effect: "utility", targetId: "track", instanceId: "utility:1",
    from: { version: 1, state: from }, to: { version: 1, state: { ...from, gainDb: -6 } } };
  commit.committed(payload);
  expect(calls).toHaveLength(0);
  projectId = "project:current";
  tracks = [{ id: "track", historyRef: "history:current", name: "Current", volume: 1, clips: [] }];
  commit.committed(payload, "project:previous");
  expect(calls).toHaveLength(0);
  commit.committed(payload);
  expect(calls[0]).toMatchObject({ entry: { type: "effect-params", projectId: "project:current",
    data: { effect: "utility", instanceId: "utility:1", trackRef: "history:current", from: payload.from, to: payload.to } },
    mergeKey: "fx:utility:track:utility:1", mergeWindowMs: 600 });
  tracks = [{ id: "track", historyRef: "history:new", name: "New", volume: 1, clips: [] }];
  commit.committed(payload, projectId, { mergeHistory: false });
  expect(calls[1]).toMatchObject({ entry: { data: { trackRef: "history:new" } } });
  expect(calls[1]?.mergeKey).toBeUndefined();
  expect(calls[1]?.mergeWindowMs).toBeUndefined();
  projectId = "project:navigated";
  commit.committed(payload, "project:current");
  expect(calls).toHaveLength(2);
});

test("B6 panel release records production history despite native refusal without duplicate delivery", async () => {
  const projectId = `project:b6-history-${crypto.randomUUID()}`;
  const instanceId = "utility:1";
  const params = { version: 1, state: createDefaultUtilityParams() };
  await setLocalEffectInstance(projectId, "track", "utility", params, { instanceId });
  const history: HistoryEntry[] = [];
  let deliveries = 0;
  let dispose = () => {};
  const mounted = createRoot(end => {
    dispose = end;
    const view = createLocalEffectsView({ projectId: () => projectId });
    const registry = createProcessorEditRegistry(() => 120);
    const commit = createTimelineEffectCommit({ projectId: () => projectId, tracks: () => [],
      pushHistory: entry => { history.push(entry); } });
    const device = createEffectsPanelAudioDevice({
      audioEngine: () => new AudioEngine(), projectId: () => projectId, userId: () => "local",
      projectGeneration: () => 1, roomEffects: () => [], sidechainRoutes: () => [],
      canWriteCurrentTargetEffects: () => true, usesLegacyAudioEngine: () => false, localEffectsView: view,
      allocateProcessorEdit: registry.allocate,
      deliverProcessor: () => {
        deliveries++;
        return { receipt: { key: instanceId, serial: deliveries },
          settled: Promise.resolve({ state: "refused", reason: "native-refused" }) };
      },
      onEffectParamsCommitted: commit.committed,
    }, () => "track", () => undefined);
    return { view, device };
  });
  try {
    await mounted.view.reload();
    mounted.device.utility.changeInstance(instanceId, value => ({ ...value, state: { ...value.state, gainDb: -6 } }));
    await mounted.device.flushPending();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ type: "effect-params", projectId, data: { to: { state: { gainDb: -6 } } } });
    expect((await listLocalEffects(projectId)).find(row => row.instanceId === instanceId)?.params)
      .toMatchObject({ state: { gainDb: -6 } });
    const atRelease = deliveries;
    await mounted.device.flushPending();
    expect(deliveries).toBe(atRelease);
    expect(history).toHaveLength(1);
  } finally { dispose(); }
});

test("settles preparation before comparing instrument-ready callbacks with the prepared graph", async () => {
  const instrument: TrackInstrumentParams = { kind: "synth", instanceId: "synth:1", params: createDefaultSynthParams() };
  const preparation = Promise.withResolvers<void>();
  const published: TrackInstrumentParams[] = [];
  const rebuilds: (TrackInstrumentParams | undefined)[] = [];
  const announce = createInstrumentPlaybackChange({
    mountedProjectGeneration: () => 0, awaitPlaybackPreparation: () => preparation.promise,
    preparedInstrument: () => published[0], isStructuralRebuildInProgress: () => false, isPreparingPlayback: () => false,
    isPlaying: () => true, isNativePlaybackPrepared: () => true, isPortableBrowserPlaybackPrepared: () => false,
    syncPlaybackBackend: async (_tracks, _intent, override) => { rebuilds.push(override?.instrument); },
    renderTracks: () => [], captureStructuralPlaybackIntent: () => ({ resumePlayback: true, playheadSec: 0 }),
  });
  const announced = announce("track", instrument);
  // The preparation the announce waits on is what publishes the instrument.
  published.push(instrument);
  preparation.resolve();
  await announced;
  expect(rebuilds).toEqual([]);
});

test("scopes effect history to the committed project and keeps patch failures silent", () => {
  let projectId: string | undefined = "project:a";
  const pushed: HistoryEntry[] = [];
  const commit = createTimelineEffectCommit({ projectId: () => projectId,
    tracks: () => [{ id: "track", historyRef: "history:a", name: "A", volume: 1, clips: [] }],
    pushHistory: entry => { pushed.push(entry); } });
  const from = createDefaultUtilityParams();
  const payload: EffectParamsCommitPayload = { effect: "utility", targetId: "track", instanceId: "utility:1",
    from: { version: 1, state: from }, to: { version: 1, state: { ...from, gainDb: -6 } } };

  // A patch settling after navigation names the project it was made in; it is dropped without an error.
  projectId = "project:b";
  expect(() => commit.committed(payload, "project:a")).not.toThrow();
  expect(pushed).toHaveLength(0);

  commit.committed(payload, "project:b");
  commit.committed(payload);
  expect(pushed.map(entry => entry.projectId)).toEqual(["project:b", "project:b"]);
});

const externalProcessor = (instanceId: string, supportsState: boolean) => ({
  instanceId,
  targetId: "track",
  index: 0,
  manifest: {
    identity: { format: "vst3" as const, classId: "class", vendor: "vendor", name: "effect", version: "1",
      architecture: "arm64" as const, binaryFingerprint: "a".repeat(64) },
    role: "effect" as const,
    audioInputs: [{ name: "Input", channels: 2, enabled: true }],
    audioOutputs: [{ name: "Output", channels: 2, enabled: true }],
    sidechainInputs: [],
    parameters: [],
    latencyFrames: 0,
    tailFrames: 0,
    supportsBypass: true,
    supportsEditor: true,
    supportsState,
  },
  parameterOverrides: {},
  latencyFrames: 0,
  tailFrames: 0,
  bypassed: false,
  health: { state: "ready" as const, updatedAt: 1 },
  updatedAt: 1,
});

const quietConsole = () => {
  const { info, error } = console;
  console.info = () => {};
  console.error = () => {};
  return () => { console.info = info; console.error = error; };
};

const mountEditorRequests = (options: { captureOk?: boolean } = {}) => {
  const [projectId, setProjectId] = createSignal("project:a");
  const [generation, setGeneration] = createSignal(1);
  const sync = Promise.withResolvers<void>();
  const log: string[] = [];
  const intents: TimelinePlaybackRebuildIntent[] = [];
  let dispose = () => {};
  const requests = createRoot(end => {
    dispose = end;
    return createExternalProcessorEditorRequests({
      projectId, mountedProjectGeneration: generation,
      openEffectsForTarget: targetId => { log.push(`open:${targetId}`); },
      captureStructuralPlaybackIntent: () => ({ resumePlayback: true, playheadSec: 2 }),
      syncPlaybackBackend: async (_tracks, intent) => { log.push("sync"); intents.push(intent); await sync.promise; },
      renderTracks: () => [],
      nativePlaybackEnabled: () => true,
      captureVstState: async instanceId => {
        log.push(`capture:${instanceId}`);
        return options.captureOk === false
          ? { ok: false as const, error: "worker gone" }
          : { ok: true as const, bytes: new Uint8Array([1]), sha256: "hash" };
      },
      persistState: async (project, instanceId) => { log.push(`persist:${project}:${instanceId}`); return externalProcessor(instanceId, true); },
    });
  });
  return { requests, sync, log, intents, setProjectId, setGeneration, dispose };
};

test("opens an inserted VST editor only after the matching playback rebuild and baseline state capture", async () => {
  const restore = quietConsole();
  const mounted = mountEditorRequests();
  try {
    const processor = externalProcessor("vst:ready", true);
    const inserted = mounted.requests.inserted(processor);
    expect(mounted.requests.autoOpenInstanceId()).toBeUndefined();
    expect(mounted.intents[0]).toMatchObject({ projectId: undefined, externalProcessor: { projectId: "project:a", processor } });
    mounted.sync.resolve();
    await inserted;
    expect(mounted.log).toEqual(["open:track", "sync", "capture:vst:ready", "persist:project:a:vst:ready"]);
    expect(mounted.requests.autoOpenInstanceId()).toBe("vst:ready");
    mounted.requests.autoOpenHandled("vst:other");
    expect(mounted.requests.autoOpenInstanceId()).toBe("vst:ready");
    mounted.requests.autoOpenHandled("vst:ready");
    expect(mounted.requests.autoOpenInstanceId()).toBeUndefined();
  } finally { mounted.dispose(); restore(); }
});

test("a plug-in without saved state opens its editor without a capture", async () => {
  const restore = quietConsole();
  const mounted = mountEditorRequests();
  try {
    mounted.sync.resolve();
    await mounted.requests.inserted(externalProcessor("vst:stateless", false));
    expect(mounted.log).toEqual(["open:track", "sync"]);
    expect(mounted.requests.autoOpenInstanceId()).toBe("vst:stateless");
  } finally { mounted.dispose(); restore(); }
});

test("never opens the editor of a plug-in that failed while staged, was refused by the browser engine, or lost its capture", async () => {
  const restore = quietConsole();
  try {
    const failed = mountEditorRequests();
    markVstInstanceFailed("vst:failed");
    failed.sync.resolve();
    await failed.requests.inserted(externalProcessor("vst:failed", true));
    expect(failed.log).toEqual(["open:track", "sync"]);
    expect(failed.requests.autoOpenInstanceId()).toBeUndefined();
    failed.dispose();

    const limited = mountEditorRequests();
    addInstanceLimit("vst:limited", "The browser engine does not host VST3 plug-ins yet.");
    limited.sync.resolve();
    await limited.requests.inserted(externalProcessor("vst:limited", true));
    expect(limited.log).toEqual(["open:track", "sync"]);
    expect(limited.requests.autoOpenInstanceId()).toBeUndefined();
    limited.dispose();

    const uncaptured = mountEditorRequests({ captureOk: false });
    uncaptured.sync.resolve();
    await uncaptured.requests.inserted(externalProcessor("vst:uncaptured", true));
    expect(uncaptured.log).toEqual(["open:track", "sync", "capture:vst:uncaptured"]);
    expect(uncaptured.requests.autoOpenInstanceId()).toBeUndefined();
    uncaptured.dispose();
  } finally { clearVstInstanceFailures(); clearInstanceLimits(); restore(); }
});

test("drops the editor request when the project or generation changes during the rebuild, and persists to the drop's project", async () => {
  const restore = quietConsole();
  try {
    for (const navigate of [
      (mounted: ReturnType<typeof mountEditorRequests>) => mounted.setProjectId("project:b"),
      (mounted: ReturnType<typeof mountEditorRequests>) => mounted.setGeneration(2),
    ]) {
      const mounted = mountEditorRequests();
      const inserted = mounted.requests.inserted(externalProcessor("vst:navigated", true));
      navigate(mounted);
      mounted.sync.resolve();
      await inserted;
      expect(mounted.log).toContain("persist:project:a:vst:navigated");
      expect(mounted.requests.autoOpenInstanceId()).toBeUndefined();
      mounted.dispose();
    }
  } finally { restore(); }
});

test("persists a captured editor state to the project it names, even after navigation", async () => {
  const restore = quietConsole();
  try {
    const persisted: string[] = [];
    const state = { bytes: new Uint8Array([1]), sha256: "hash" };
    const persist = createCapturedEditorStatePersister(async (projectId, instanceId) => {
      persisted.push(`${projectId}:${instanceId}`);
      return instanceId === "vst:deleted" ? undefined : externalProcessor(instanceId, true);
    });
    await persist({ projectId: "project:old", instanceId: "vst:one", state });
    expect(persisted).toEqual(["project:old:vst:one"]);
    await expect(persist({ projectId: "project:old", instanceId: "vst:deleted", state }))
      .rejects.toThrow('The captured native VST editor processor "vst:deleted" no longer exists.');
    const failing = createCapturedEditorStatePersister(async () => { throw new Error("disk full"); });
    await expect(failing({ projectId: "project:old", instanceId: "vst:one", state })).rejects.toThrow("disk full");
  } finally { restore(); }
});
