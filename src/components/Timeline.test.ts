import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("patches supported native built-in commits and rebuilds unsupported commits", async () => {
  const source = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");
  const handlerStart = source.indexOf("function handleEffectParamsCommitted");
  if (handlerStart < 0) throw new Error("Expected the effect commit handler.");
  const handlerEnd = source.indexOf("\n  // DOM refs", handlerStart);
  if (handlerEnd < 0) throw new Error("Expected the effect commit handler boundary.");
  const handler = source.slice(handlerStart, handlerEnd);

  expect(handler).toContain("pushEffectParamsHistory(payload, committedProjectId);");
  expect(handler).toContain('if (payload.effect === "instrument") return;');
  expect(handler.indexOf('if (payload.effect === "instrument") return;'))
    .toBeGreaterThan(handler.indexOf("pushEffectParamsHistory(payload, committedProjectId);"));
  expect(handler).toContain("encodeNativeBuiltInStateCommit(payload, bpm())");
  expect(handler).toContain("isNativePlaybackPrepared()");
  expect(handler).toContain("isPortableBrowserPlaybackPrepared()");
  expect(handler).toContain("handleNativeBuiltInStatePatchResult(payload)");
  expect(handler.match(/rebuildPlaybackBackend\(renderTracks\(\)\)/g))
    .toHaveLength(1);
  expect(handler.indexOf("pushEffectParamsHistory(payload, committedProjectId);"))
    .toBeLessThan(handler.indexOf("mapNativeBuiltInParameterCommit(payload, bpm())"));
  expect(handler.indexOf("const result = await control?.flush(mapped);"))
    .toBeLessThan(handler.indexOf("handleNativeBuiltInStatePatchResult(payload)"));
  expect(handler).toContain("if (isPlaying() || isNativePlaybackPrepared() || isPortableBrowserPlaybackPrepared())");
  expect(handler).toContain('notify(\n          "Built-in effect update failed"');
});

test("scopes effect history to the committed project and keeps patch failures silent", async () => {
  const source = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");
  const historyStart = source.indexOf("const pushEffectParamsHistory");
  const historyEnd = source.indexOf("\n  const handleNativeBuiltInStatePatchResult", historyStart);
  if (historyStart < 0 || historyEnd < 0) throw new Error("Expected the effect history boundary.");
  const history = source.slice(historyStart, historyEnd);
  expect(history).toContain("const rid = committedProjectId ?? projectId();");
  expect(history).toContain("if (rid !== projectId()) return;");
  const patchStart = source.indexOf("const handleNativeBuiltInStatePatchResult");
  const patchEnd = source.indexOf("\n  const handleNativeBuiltInPreview", patchStart);
  if (patchStart < 0 || patchEnd < 0) throw new Error("Expected the state patch boundary.");
  expect(source.slice(patchStart, patchEnd)).not.toContain("notify(");
});

test("bypasses degraded external processors and excludes persisted degraded rows from playback", async () => {
  const source = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");

  expect(source).toContain(`bypassed: true,
        health: { state: "degraded"`);
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
    .toBeLessThan(handler.indexOf("await rebuildPlaybackBackend(renderTracks(), intent)"));
  expect(handler).toContain("pendingExternalProcessorEditorRequest()?.requestToken === request.requestToken");
  expect(handler).toContain("currentRequest?.requestToken === request.requestToken");
  expect(handler).toContain("setPendingExternalProcessorEditorRequest();");
  expect(handler).toContain("currentRequest.projectId === projectId()");
  expect(handler).toContain("currentRequest.projectGeneration === mountedProjectGeneration()");
  expect(handler).toContain("{ ...currentRequest, ready: true }");
  expect(handler.indexOf("await rebuildPlaybackBackend(renderTracks(), intent)"))
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
