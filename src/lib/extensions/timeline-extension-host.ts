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

type TimelineExtensionHost = Readonly<{
  shortcuts: Readonly<{
    execute: (
      chord: ShortcutChord,
      context: ShortcutResolutionContext,
    ) => boolean;
  }>;
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

export const createTimelineExtensionHost = (
  views: BrowserToggleExtensionViews,
  kernel: ExtensionKernel = createExtensionKernel(),
): TimelineExtensionHost => {
  const definition = createBuiltinViewToggleBrowser(views);
  let state: "activating" | "active" | "failed" | "disposed" = "activating";
  const activation = kernel.activate(definition).then(
    () => {
      if (state === "activating") state = "active";
      return true;
    },
    () => {
      if (state === "activating") state = "failed";
      return false;
    },
  );

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
    await kernel.dispose();
  };

  return Object.freeze({
    shortcuts: Object.freeze({ execute }),
    activation,
    dispose,
  });
};
