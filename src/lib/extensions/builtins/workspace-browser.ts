import type { AppExtensionDefinition } from "../extension-kernel";
import { contributeWorkspace } from "../workspace-extension-api";
import type { WorkspaceContributionRegistry } from "../workspace-contributions";

export const builtinBrowserWorkspaceContributionId = "workspace.browser";
export const builtinBrowserWorkspaceExtensionId = "builtin.workspace.browser";
export const builtinBrowserWorkspaceContract = "workspace.panel.browser/v1";

export const createBuiltinBrowserWorkspace = <TValue>(
  registry: WorkspaceContributionRegistry<TValue>,
  value: TValue,
): AppExtensionDefinition => ({
  id: builtinBrowserWorkspaceExtensionId,
  version: "1.0.0",
  commands: [],
  shortcuts: [],
  activate: (context) => {
    contributeWorkspace(context, registry, {
      id: builtinBrowserWorkspaceContributionId,
      kind: "panel",
      title: "Browser",
      slot: "left",
      order: 0,
      replacement: {
        allowed: true,
        contract: builtinBrowserWorkspaceContract,
      },
      value,
    });
  },
});
