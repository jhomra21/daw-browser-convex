import type {
  AppExtensionCommandDeclaration,
  AppExtensionDefinition,
  AppExtensionShortcutDeclaration,
} from "../extension-kernel";

export type BrowserToggleExtensionViews = Readonly<{
  browser: Readonly<{
    toggle: () => void;
  }>;
}>;

const browserToggleCommandContract = "application.command/v1";

export const builtinViewToggleBrowserCommand: AppExtensionCommandDeclaration = {
  id: "view.toggle-browser",
  contributionId: "builtin.view.toggle-browser",
  title: "Toggle Browser",
  replacement: {
    allowed: true,
    contract: browserToggleCommandContract,
  },
};

export const builtinViewToggleBrowserShortcut: AppExtensionShortcutDeclaration = {
  id: "view.toggle-browser.shortcut",
  commandId: builtinViewToggleBrowserCommand.id,
  chord: { mod: true, alt: true, key: "b" },
  conditions: [{ kind: "editable-target", matches: false }],
};

export const createBuiltinViewToggleBrowser = (
  views: BrowserToggleExtensionViews,
): AppExtensionDefinition => ({
  id: "builtin.view.toggle-browser",
  version: "1.0.0",
  commands: [builtinViewToggleBrowserCommand],
  shortcuts: [builtinViewToggleBrowserShortcut],
  activate: ({ bindCommand }) => {
    bindCommand(builtinViewToggleBrowserCommand.id, () => {
      views.browser.toggle();
    });
  },
});
