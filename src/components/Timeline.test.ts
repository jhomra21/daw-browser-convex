import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("rebuilds the active backend once after a playing built-in effect commit", async () => {
  const source = await readFile(new URL("./Timeline.tsx", import.meta.url), "utf8");
  const handlerStart = source.indexOf("function handleEffectParamsCommitted");
  if (handlerStart < 0) throw new Error("Expected the effect commit handler.");
  const handlerEnd = source.indexOf("\n  // DOM refs", handlerStart);
  if (handlerEnd < 0) throw new Error("Expected the effect commit handler boundary.");
  const handler = source.slice(handlerStart, handlerEnd);

  expect(handler.indexOf("pushEffectParamsHistory(payload, committedProjectId);"))
    .toBeLessThan(handler.indexOf("if (!isPlaying()) return;"));
  expect(handler.match(/restartTimelineSchedule\(renderTracks\(\), \{ rebuildBackend: true \}\)/g))
    .toHaveLength(1);
  expect(handler).toContain("if (!isPlaying()) return;");
});
