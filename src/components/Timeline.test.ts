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
  expect(handler).toContain("encodeNativeBuiltInStateCommit(payload, bpm())");
  expect(handler).toContain("isNativePlaybackPrepared()");
  expect(handler).toContain("isPortableBrowserPlaybackPrepared()");
  expect(handler).toContain("handleNativeBuiltInStatePatchResult(payload)");
  expect(handler.match(/rebuildPlaybackBackend\(renderTracks\(\)\)/g))
    .toHaveLength(2);
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
