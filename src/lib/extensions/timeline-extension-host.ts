import {
  createExtensionKernel,
  normalizeShortcutChord,
  type ExtensionKernel,
  type ShortcutChord,
  type ShortcutResolutionContext,
} from "./extension-kernel";
import {
  builtinViewToggleBrowserShortcut,
  createBuiltinViewToggleBrowser,
  type BrowserToggleExtensionViews,
} from "./builtins/view-toggle-browser";
import { createBuiltinExtensionManager } from "./builtin-manager";
import {
  builtinBrowserWorkspaceExtensionId,
  createBuiltinBrowserWorkspace,
} from "./builtins/workspace-browser";
import {
  createWorkspaceContributionRegistry,
  type WorkspaceContributionRegistry,
} from "./workspace-contributions";

export type TimelineExtensionWorkspace<TValue> = Readonly<{
  browser: TValue;
}>;

type TimelineExtensionHost<TWorkspaceValue> = Readonly<{
  shortcuts: Readonly<{
    execute: (
      chord: ShortcutChord,
      context: ShortcutResolutionContext,
    ) => boolean;
  }>;
  menu: Readonly<{
    contributions: () => readonly Readonly<{
      id: string
      commandId: string
      title: string
      order: number
      enabled: boolean
    }>[]
    execute: (commandId: string) => Promise<boolean>
    subscribe: (listener: () => void) => () => void
  }>;
  workspace: WorkspaceContributionRegistry<TWorkspaceValue>;
  activation: Promise<boolean>;
  dispose: () => Promise<void>;
}>;

const isToggleBrowserShortcut = (
  chord: ShortcutChord,
  context: ShortcutResolutionContext,
): boolean => {
  if (context.editableTarget) return false;
  try {
    const normalized = normalizeShortcutChord(chord);
    const declared = normalizeShortcutChord(builtinViewToggleBrowserShortcut.chord);
    return normalized.mod === declared.mod
      && normalized.alt === declared.alt
      && normalized.shift === declared.shift
      && normalized.key === declared.key
      && normalized.code === declared.code;
  } catch {
    return false;
  }
};

export const createTimelineExtensionHost = <TWorkspaceValue = never>(
  views: BrowserToggleExtensionViews,
  kernel: ExtensionKernel = createExtensionKernel(),
  workspace?: TimelineExtensionWorkspace<TWorkspaceValue>,
): TimelineExtensionHost<TWorkspaceValue> => {
  const definition = createBuiltinViewToggleBrowser(views);
  const workspaceRegistry = createWorkspaceContributionRegistry<TWorkspaceValue>();
  const workspaceDefinition = workspace === undefined
    ? undefined
    : createBuiltinBrowserWorkspace(workspaceRegistry, workspace.browser);
  const definitions = [definition];
  if (workspaceDefinition !== undefined) definitions.unshift(workspaceDefinition);
  const manager = createBuiltinExtensionManager(definitions, kernel);
  let state: "activating" | "active" | "failed" | "disposed" = "activating";
  const activation = (async (): Promise<boolean> => {
    try {
      if (workspaceDefinition !== undefined) {
        await manager.enable(builtinBrowserWorkspaceExtensionId);
      }
      await manager.enable(definition.id);
      if (state === "activating") state = "active";
      return true;
    } catch {
      if (state === "activating") state = "failed";
      return false;
    }
  })();

  const execute = (
    chord: ShortcutChord,
    context: ShortcutResolutionContext,
  ): boolean => {
    if (state === "disposed") return false;
    if (state !== "active") {
      if (!isToggleBrowserShortcut(chord, context)) return false;
      views.browser.toggle();
      return true;
    }
    const match = kernel.resolveShortcuts(chord, context)[0];
    if (!match) return false;
    void kernel.executeCommand(match.commandId).catch(() => {});
    return true;
  };

  const dispose = async (): Promise<void> => {
    if (state === "disposed") return;
    state = "disposed";
    await manager.dispose();
  };

  const contributions = () => kernel.snapshot().commands.map((command, index) => ({
    id: command.contributionId,
    commandId: command.id,
    title: command.title,
    order: index,
    enabled: true,
  }));

  const executeMenuCommand = async (commandId: string): Promise<boolean> => {
    const contribution = contributions().find((entry) => entry.commandId === commandId);
    if (!contribution) return false;
    await kernel.executeCommand(commandId);
    return true;
  };

  return Object.freeze({
    shortcuts: Object.freeze({ execute }),
    menu: Object.freeze({
      contributions,
      execute: executeMenuCommand,
      subscribe: (listener: () => void) => kernel.subscribe(() => listener()),
    }),
    workspace: workspaceRegistry,
    activation,
    dispose,
  });
};
