import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("queues supported native built-in commits and rebuilds unsupported commits", async () => {
  const source = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");
  const handlerStart = source.indexOf("function handleEffectParamsCommitted");
  if (handlerStart < 0) throw new Error("Expected the effect commit handler.");
  const handlerEnd = source.indexOf("\n  // DOM refs", handlerStart);
  if (handlerEnd < 0) throw new Error("Expected the effect commit handler boundary.");
  const handler = source.slice(handlerStart, handlerEnd);

  expect(handler).toContain("pushEffectParamsHistory(payload, committedProjectId);");
  expect(handler).toContain("mapNativeBuiltInParameterCommit(payload, bpm())");
  expect(handler).toContain("isNativePlaybackPrepared()");
  expect(handler).toContain("handleNativeBuiltInParameterResult(realtimeCommit)");
  expect(handler.match(/restartTimelineSchedule\(renderTracks\(\), \{ rebuildBackend: true \}\)/g))
    .toHaveLength(1);
  expect(handler).toContain("disposePreparedBackends()");
});

test("bypasses degraded external processors and excludes persisted degraded rows from playback", async () => {
  const source = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");

  expect(source).toContain(`bypassed: true,
        health: { state: "degraded"`);
  expect(source).toContain(
    `.filter((processor) => !processor.bypassed && processor.health.state !== "degraded");`,
  );
});
