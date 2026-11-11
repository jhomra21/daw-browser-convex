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

test("B6 hook fixture and Timeline use the production history seam, never a fixture copy", async () => {
  const timeline = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");
  const fixture = await readFile(new URL("../../tools/acceptance/ae-08-processor-state-fuzz-hook.ts", import.meta.url), "utf8");
  expect(timeline).toContain('from "~/components/timeline/create-timeline-effect-commit"');
  expect(timeline).toContain("onEffectParamsCommitted: effectCommit.committed");
  expect(fixture).toContain('from "../../src/components/timeline/create-timeline-effect-commit"');
  expect(fixture).toContain("projectId: () => projectId, tracks, pushHistory: history.pushHistory");
  expect(fixture).not.toContain("ae-08-processor-state-fuzz-hook-commit");
});

test("STEP5 B7 shared playback input boundary is used by Timeline and both fixtures", async () => {
  for (const file of ["src/components/Timeline.tsx", "tools/acceptance/device-control-cost.browser.test.ts",
    "tools/acceptance/ae-08-processor-state-fuzz-hook.ts"]) {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    expect(source).toContain("pickNativePlaybackInputs(");
    expect(source).toContain("processorStructure:");
  }
});

test("3B1 r2 comments and audio-adapter witness describe registration and independent native settlement", async () => {
  const hook = await readFile(new URL("../../tools/acceptance/ae-08-processor-state-fuzz-hook.ts", import.meta.url), "utf8");
  const cost = await readFile(new URL("../../tools/acceptance/device-control-cost.browser.test.ts", import.meta.url), "utf8");
  const panel = await readFile(new URL("./timeline/create-effects-panel-state.ts", import.meta.url), "utf8");
  const audioTest = await readFile(new URL("./timeline/create-effects-panel-audio-effects-state.test.ts", import.meta.url), "utf8");
  expect({
    obsoleteHookTranslator: hook.includes("handleNativeBuiltInPreview"),
    obsoleteCostTranslator: cost.includes("handleNativeBuiltInPreview"),
    nativeVetoesSave: panel.includes("engine or native failure"),
    booleanFlushName: audioTest.includes("awaits the boolean native flush"),
  }).toEqual({ obsoleteHookTranslator: false, obsoleteCostTranslator: false, nativeVetoesSave: false, booleanFlushName: false });
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

test("records effect history without dispatching native delivery or rebuilding playback", async () => {
  const source = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");
  const handler = await readFile(new URL("./timeline/create-timeline-effect-commit.ts", import.meta.url), "utf8");
  expect(source).toContain("const effectCommit = createTimelineEffectCommit({ projectId, tracks: renderTracks, pushHistory });");
  expect(handler).toContain("input.pushHistory(entry,");
  expect(handler).not.toContain("deliverProcessor(");
  expect(handler).not.toContain("rebuildPlaybackBackend(");
  expect(source).toContain("deliverProcessor,");
  expect(source).toContain("joinPublication,");
  expect(source).toContain("return instrumentPlaybackChangeTail =");
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

test("bypasses degraded external processors and excludes persisted degraded rows from playback", async () => {
  const source = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");

  expect(source).toContain(
    `.filter((processor) => !processor.bypassed && processor.health.state !== "degraded");`,
  );
});

test("rebuilds prepared browser or native ownership with captured project intent", async () => {
  const source = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");
  expect(source).toContain("projectGeneration: mountedProjectGeneration(),");
  expect(source).toContain("if (isNativePlaybackPrepared() || isPortableBrowserPlaybackPrepared())");
  expect(source).toContain("&& !isStructuralRebuildInProgress()");
  expect(source).toContain("&& !isPreparingPlayback()) return;");
  expect(source).toContain("rebuildBackend: true,");
  expect(source).toContain("const rebuildPlaybackBackend =");
  expect(source).toContain("nativePlaybackRevision += 1;");
  expect(source).toContain("if (isPlaying()) restartTimelineSchedule(renderTracks()).catch");
});

test("keeps graph revisions stable during compilation and bumps them at structural rebuild boundaries", async () => {
  const source = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");
  expect(source).toContain("let nativePlaybackRevision = 1;");
  expect(source).toContain("revision: nativePlaybackRevision,");
  expect(source).toContain("nativePlaybackRevision += 1;");
  expect(source).not.toContain("revision: ++nativePlaybackRevision,");
});

test("hands an inserted processor to the bound rebuild compiler and verifies current persistence", async () => {
  const source = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");
  const playbackSource = await readFile(new URL("../hooks/useTimelinePlayback.ts", import.meta.url), "utf8");
  expect(source).toContain("readPersisted: getLocalExternalProcessor,");
  expect(source).toContain("externalProcessor: {");
  expect(source).toContain("projectId: insertedProjectId,");
  expect(source).toContain("processor,");
  expect(source).toContain("await rebuildPlaybackBackend(renderTracks(), insertionIntent);");
  expect(source).toContain("await deleteLocalExternalProcessor(insertedProjectId, processor.instanceId);");
  expect(source).toContain("externalProcessor: undefined,");
  expect(playbackSource).toContain("externalProcessor: options.externalProcessor,");
  expect(source).toContain("resolveNativeLivePlaybackProcessors");
  expect(playbackSource).toContain("externalProcessor?: LivePlaybackCompileContext[\"externalProcessor\"]");
  expect(playbackSource).toContain("const compileContext = requestedIntent?.instrumentOverride !== undefined");
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

test("offers trusted VST3 catalog recovery without retrying playback automatically", async () => {
  const source = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");
  const recoveryStart = source.indexOf("if (classifyNativeVst3PlaybackFault(message)");
  const recoveryEnd = source.indexOf('\n        notify("Native playback stopped", message);', recoveryStart);
  if (recoveryStart < 0 || recoveryEnd < 0) throw new Error("Expected the native VST3 recovery handler.");
  const recovery = source.slice(recoveryStart, recoveryEnd);

  expect(recovery).toContain('title: "Plug-in authorization required"');
  expect(recovery).toContain("This project uses VST3 plug-ins that must be verified again before playback.");
  expect(recovery).toContain('label: "Rescan plug-ins"');
  expect(recovery).toContain('busyLabel: "Rescanning…"');
  expect(recovery).toContain('cancelLabel: "Cancel"');
  expect(recovery).toContain("canUseVst3CatalogAction");
  expect(recovery).toContain("saveVst3TrustAcknowledgement");
  expect(source).toContain("await bridge.scan()");
  expect(source).toContain('new Event("daw-plugin-catalog-changed")');
  expect(source).toContain("setAppMessage(null)");
  expect(recovery).toContain("onAction: scanVst3Catalog");
  expect(recovery).toContain("void scanVst3Catalog().catch");
  expect(recovery).toContain("setVst3TrustAcknowledged(acknowledged);");
  expect(recovery).toContain("saveVst3TrustAcknowledgement(vst3TrustStorage);");
  expect(source).toContain("vst3ScanPromise");
  expect(recovery.match(/scanVst3Catalog\(\)/g)).toHaveLength(1);
  expect(recovery).not.toContain("requestPlay()");
  expect(source).toContain('notify("Native playback stopped", message);');
});

test("routes browser keyboard toggles through the extension host exactly once", async () => {
  const source = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");
  expect(source).toContain("const timelineExtensionHost = createTimelineExtensionHost({");
  expect(source).toContain("toggle: leftBrowser.toggleOpen,");
  expect(source).toContain("executeExtensionShortcut: timelineExtensionHost.shortcuts.execute,");
  expect(source).not.toContain("onToggleBrowser: leftBrowser.toggleOpen");
  expect(source.match(/createTimelineExtensionHost\(/g)).toHaveLength(1);
  expect(source.match(/timelineExtensionHost\.dispose\(\)/g)).toHaveLength(1);
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
