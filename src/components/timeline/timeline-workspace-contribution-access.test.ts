import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  builtinBrowserWorkspaceContract,
  builtinBrowserWorkspaceContributionId,
  builtinBrowserWorkspaceExtensionId,
  createWorkspaceContributionRegistry,
} from "~/lib/extensions";
import { createTimelineWorkspaceContributionAccess } from "./timeline-workspace-contribution-access";

test("tracks Browser workspace replacement and restoration reactively", () => {
  createRoot((dispose) => {
    const registry = createWorkspaceContributionRegistry<string>();
    const access = createTimelineWorkspaceContributionAccess(registry);

    expect(access.browser()).toBeUndefined();

    const removeBase = registry.register(builtinBrowserWorkspaceExtensionId, {
      id: builtinBrowserWorkspaceContributionId,
      kind: "panel",
      title: "Browser",
      slot: "left",
      order: 0,
      replacement: {
        allowed: true,
        contract: builtinBrowserWorkspaceContract,
      },
      value: "base",
    });
    expect(access.browser()?.value).toBe("base");

    const removeReplacement = registry.register("extension.browser.replacement", {
      id: builtinBrowserWorkspaceContributionId,
      kind: "panel",
      title: "Browser",
      slot: "left",
      order: 0,
      replaces: {
        contract: builtinBrowserWorkspaceContract,
      },
      value: "replacement",
    });
    expect(access.browser()?.value).toBe("replacement");

    removeReplacement();
    expect(access.browser()?.value).toBe("base");

    removeBase();
    expect(access.browser()).toBeUndefined();

    dispose();
  });
});
