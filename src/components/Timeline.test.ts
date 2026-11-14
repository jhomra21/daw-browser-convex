import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import "fake-indexeddb/auto";
import { createRoot } from "solid-js";
import { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import { createDefaultUtilityParams } from "@daw-browser/shared";
import type { Track } from "@daw-browser/timeline-core/types";
import type { HistoryEntry, EffectParamsCommitPayload } from "~/lib/undo/types";
import { setLocalEffectInstance, listLocalEffects } from "~/lib/local-effects";
import { createProcessorEditRegistry } from "./timeline/create-processor-edit-registry";
import { createEffectsPanelAudioDevice } from "./timeline/create-effects-panel-audio-effects-state";
import { createLocalEffectsView } from "./timeline/create-local-effects-view";
import createTimelineEffectCommit from "./timeline/create-timeline-effect-commit";

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
  const source = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");
  const start = source.indexOf('onStructuralPlaybackChange: (targetId:');
  const end = source.indexOf('\n      usesLegacyAudioEngine,', start);
  const handler = source.slice(start, end);
  expect(handler).toContain("await awaitPlaybackPreparation();");
  expect(handler.indexOf("await awaitPlaybackPreparation();"))
    .toBeLessThan(handler.indexOf("const previous = preparedInstrument(targetId);"));
  expect(handler).toContain("if (JSON.stringify(previous) === JSON.stringify(instrument)) return;");
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

test("persists captured editor state using its bound project after navigation", async () => {
  const source = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");
  const start = source.indexOf("const unsubscribeCapturedEditorState");
  const end = source.indexOf("\n    });", start);
  if (start < 0 || end < 0) throw new Error("Expected the captured editor state handler.");
  const handler = source.slice(start, end);
  expect(handler).toContain("persistLocalExternalProcessorState(");
  expect(handler).toContain("payload.projectId");
  expect(handler).toContain("localVstStateOwnerId(payload.projectId, userId())");
  expect(handler).toContain("if (!persisted) throw new Error");
  expect(handler).not.toContain("payload.projectId !== projectId()");
});

test("opens an inserted VST editor only after the matching playback rebuild", async () => {
  const source = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");
  const start = source.indexOf("onExternalPluginInserted: async");
  const end = source.indexOf("\n    },\n  });", start);
  if (start < 0 || end < 0) throw new Error("Expected the external plugin insertion handler.");
  const handler = source.slice(start, end);

  expect(handler).toContain("instanceId: processor.instanceId");
  expect(handler).toContain("projectId: intent.projectId ?? projectId()");
  expect(handler).toContain("projectGeneration: intent.projectGeneration ?? mountedProjectGeneration()");
  expect(handler).toContain("requestToken: ++externalProcessorEditorRequestToken");
  expect(handler).toContain("ready: false");
  expect(handler.indexOf("setPendingExternalProcessorEditorRequest(request)"))
    .toBeLessThan(handler.indexOf("await syncPlaybackBackend(renderTracks(), insertionIntent)"));
  // A prepared native session, playing or paused, joins the plug-in in place: the insertion never names a rebuild.
  expect(handler).not.toContain("rebuildPlaybackBackend");
  // A Play that lands while the insertion is staged supersedes its adoption and leaves the plug-in unbound: the baseline
  // state capture is refused, and the insertion adopts once more, in the transport state then, before it is read again.
  const baselineCapture = handler.indexOf("captureVstState(processor.instanceId)");
  const adoptAgain = handler.indexOf("await syncPlaybackBackend(renderTracks(), captureInsertionIntent())");
  expect(baselineCapture).toBeGreaterThan(0);
  expect(adoptAgain).toBeGreaterThan(baselineCapture);
  expect(adoptAgain).toBeLessThan(handler.indexOf("captureVstState(processor.instanceId)", baselineCapture + 1));
  // A plug-in that failed while staged never opens its editor as ready.
  expect(handler.indexOf("vstInstanceFailed(processor.instanceId)"))
    .toBeGreaterThan(handler.indexOf("await syncPlaybackBackend(renderTracks(), insertionIntent)"));
  expect(handler.indexOf("vstInstanceFailed(processor.instanceId)"))
    .toBeLessThan(handler.indexOf("setPendingExternalProcessorEditorRequest({ ...currentRequest, ready: true })"));
  expect(handler).toContain("pendingExternalProcessorEditorRequest()?.requestToken === request.requestToken");
  expect(handler).toContain("currentRequest?.requestToken === request.requestToken");
  expect(handler).toContain("setPendingExternalProcessorEditorRequest();");
  expect(handler).toContain("currentRequest.projectId === projectId()");
  expect(handler).toContain("currentRequest.projectGeneration === mountedProjectGeneration()");
  expect(handler).toContain("{ ...currentRequest, ready: true }");
  expect(handler.indexOf("await syncPlaybackBackend(renderTracks(), insertionIntent)"))
    .toBeLessThan(handler.indexOf("setPendingExternalProcessorEditorRequest({ ...currentRequest, ready: true })"));

  const exposureStart = source.indexOf("autoOpenExternalProcessorId:");
  const exposureEnd = source.indexOf("\n      onExternalProcessorAutoOpenHandled:", exposureStart);
  if (exposureStart < 0 || exposureEnd < 0) throw new Error("Expected the external editor exposure.");
  const exposure = source.slice(exposureStart, exposureEnd);
  expect(exposure).toContain("request?.ready");
  expect(exposure).toContain("request.projectId === projectId()");
  expect(exposure).toContain("request.projectGeneration === mountedProjectGeneration()");
  const handledEnd = source.indexOf("\n      captureStructuralPlaybackIntent", exposureEnd);
  if (handledEnd < 0) throw new Error("Expected the external editor handled callback boundary.");
  const handled = source.slice(exposureEnd, handledEnd);
  expect(handled).toContain("request?.ready && request.instanceId === instanceId");
  expect(handled).toContain("setPendingExternalProcessorEditorRequest();");
});

test("keeps arrangement and clip selection clicks from seeking during playback", async () => {
  const timeline = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");
  const selection = await readFile(new URL("../hooks/useTimelineSelection.ts", import.meta.url), "utf8");

  expect(timeline).toContain("isPlaying,\n    startScrub,");
  expect(selection).toContain("if (!options.isPlaying()) startScrub(event.clientX, { listen: false });");
  expect(selection).toContain("if (!options.isPlaying()) moveScrub(event.clientX);");
});
