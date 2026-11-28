import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("keeps the complete panels model across panel replacement", async () => {
  const source = await readFile(new URL("./timeline-chrome.tsx", import.meta.url), "utf8");
  const panelSource = await readFile(new URL("./timeline-panels.tsx", import.meta.url), "utf8");

  expect(source).toContain("<TimelinePanels panels={props.panels} />");
  expect(panelSource).toContain("const panels = () => props.panels");
  expect(panelSource).toContain("<MidiClipEditor");
});
