import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

type PanelsModel = {
  effectsPanel: {
    projectId?: string;
  };
};

const readStablePanels = <Model extends PanelsModel>(container: { panels: Model }): Model => container.panels;

test("keeps the complete panels model across panel replacement", async () => {
  const source = await readFile(new URL("./timeline-chrome.tsx", import.meta.url), "utf8");
  const panelSource = await readFile(new URL("./timeline-panels.tsx", import.meta.url), "utf8");
  const replacement = { effectsPanel: { projectId: "project-b" } };
  const transientFlattenedProps = {
    ...replacement,
    effectsPanel: undefined,
  } satisfies { effectsPanel?: PanelsModel["effectsPanel"] };

  expect(transientFlattenedProps.effectsPanel).toBeUndefined();
  expect(source).toContain("<TimelinePanels panels={props.panels} />");

  const stableContainer = { panels: replacement };
  expect(readStablePanels(stableContainer)).toBe(replacement);
  expect(readStablePanels(stableContainer).effectsPanel.projectId).toBe("project-b");
  expect(panelSource).toContain("const panels = () => props.panels");
});
