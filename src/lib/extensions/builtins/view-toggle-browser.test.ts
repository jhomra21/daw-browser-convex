import { expect, test } from "bun:test";
import type { AppExtensionDefinition } from "../index";
import {
  builtinViewToggleBrowserCommand,
  builtinViewToggleBrowserShortcut,
  createBuiltinViewToggleBrowser,
} from "./view-toggle-browser";
import { createExtensionKernel } from "../index";

test("declares the stable browser toggle command and shortcut", () => {
  expect(builtinViewToggleBrowserCommand).toEqual({
    id: "view.toggle-browser",
    contributionId: "builtin.view.toggle-browser",
    title: "Toggle Browser",
    replacement: {
      allowed: true,
      contract: "application.command/v1",
    },
  });
  expect(builtinViewToggleBrowserShortcut).toEqual({
    id: "view.toggle-browser.shortcut",
    commandId: "view.toggle-browser",
    chord: { mod: true, alt: true, key: "b" },
    conditions: [{ kind: "editable-target", matches: false }],
  });
});

test("binds only the narrow browser view facade", async () => {
  let toggles = 0;
  const kernel = createExtensionKernel();
  await kernel.activate(createBuiltinViewToggleBrowser({
    browser: { toggle: () => { toggles += 1; } },
  }));

  expect(await kernel.executeCommand("view.toggle-browser")).toBeUndefined();
  expect(toggles).toBe(1);
  expect(kernel.snapshot().commands).toEqual([{
    id: "view.toggle-browser",
    contributionId: "builtin.view.toggle-browser",
    providerId: "builtin.view.toggle-browser",
    title: "Toggle Browser",
  }]);
  await kernel.dispose();
});

test("keeps browser state outside the extension definition when activation fails", async () => {
  let toggles = 0;
  const definition = createBuiltinViewToggleBrowser({
    browser: { toggle: () => { toggles += 1; } },
  });
  const failingDefinition: AppExtensionDefinition = {
    ...definition,
    activate: () => {
      throw new Error("activation failed");
    },
  };
  const kernel = createExtensionKernel();

  await expect(kernel.activate(failingDefinition)).rejects.toThrow("activation failed");
  expect(kernel.snapshot().commands).toEqual([]);
  expect(toggles).toBe(0);
  await kernel.dispose();
});
