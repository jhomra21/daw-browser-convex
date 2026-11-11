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

test("scopes effect history to the committed project and keeps patch failures silent", async () => {
  const history = await readFile(new URL("./timeline/create-timeline-effect-commit.ts", import.meta.url), "utf8");
  expect(history).toContain("const rid = committedProjectId ?? input.projectId();");
  expect(history).toContain("if (rid !== input.projectId()) return;");
  expect(history).not.toContain("deliverProcessor(");
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
    .toBeLessThan(handler.indexOf("await rebuildPlaybackBackend(renderTracks(), insertionIntent)"));
  expect(handler).toContain("pendingExternalProcessorEditorRequest()?.requestToken === request.requestToken");
  expect(handler).toContain("currentRequest?.requestToken === request.requestToken");
  expect(handler).toContain("setPendingExternalProcessorEditorRequest();");
  expect(handler).toContain("currentRequest.projectId === projectId()");
  expect(handler).toContain("currentRequest.projectGeneration === mountedProjectGeneration()");
  expect(handler).toContain("{ ...currentRequest, ready: true }");
  expect(handler.indexOf("await rebuildPlaybackBackend(renderTracks(), insertionIntent)"))
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
  const actions = await readFile(new URL("../hooks/useTimelineActions.ts", import.meta.url), "utf8");

  expect(timeline).toContain("isPlaying,\n    startScrub,");
  expect(selection).toContain("if (!options.isPlaying()) startScrub(event.clientX, { listen: false });");
  expect(selection).toContain("if (!options.isPlaying()) moveScrub(event.clientX);");
  expect(actions).toContain("if (!options.navigation.isPlaying()) {");
  expect(actions).toContain("options.navigation.setPlayhead(targetStartSec, options.tracks())");
});
