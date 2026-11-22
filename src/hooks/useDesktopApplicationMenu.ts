import {
  desktopApplicationMenuCommands,
  desktopApplicationMenuExtensionCommandSchema,
  type DesktopApplicationMenuExtensionContribution,
  type DesktopApplicationMenuMessage,
  type DesktopApplicationMenuState,
} from "@daw-browser/desktop-protocol/application-menu";
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { isLocalId } from "@daw-browser/shared";
import type { TransportControlsProps } from "~/hooks/transport-types";
import { editableFocusOwner, focusedLocalKeyboardOwner, runUserCommand } from "~/hooks/user-commands";
import { desktopBridge } from "~/lib/runtime";

const gridDenominatorForState = (
  value: number,
): DesktopApplicationMenuState["gridDenominator"] => {
  if (value === 2 || value === 4 || value === 8 || value === 12 || value === 16) {
    return value;
  }

  return 4;
};

const dispatchApplicationMenuCommand = (
  command: DesktopApplicationMenuMessage,
  transportProps: Accessor<TransportControlsProps>,
  extensionMenu?: Readonly<{
    execute: (commandId: string) => Promise<boolean>
    subscribe?: (listener: () => void) => () => void
  }>,
) => {
  const extensionCommand = desktopApplicationMenuExtensionCommandSchema.safeParse(command);

  if (extensionCommand.success) {
    void extensionMenu?.execute(extensionCommand.data.commandId);

    return;
  }

  const userCommand = desktopApplicationMenuCommands.find((candidate) => candidate === command);

  if (userCommand) runUserCommand(userCommand, transportProps());
};

// transportProps rebuilds on every playhead publish, so the memo re-runs; equal state keeps the IPC send from following it.
const sameMenuState = (prev: DesktopApplicationMenuState, next: DesktopApplicationMenuState) =>
  JSON.stringify(prev) === JSON.stringify(next);

export const useDesktopApplicationMenu = (
  transportProps: Accessor<TransportControlsProps>,
  extensionMenu?: Readonly<{
    contributions: () => readonly DesktopApplicationMenuExtensionContribution[]
    execute: (commandId: string) => Promise<boolean>
    subscribe: (listener: () => void) => () => void
  }>,
) => {
  const bridge = desktopBridge()?.applicationMenu;

  if (!bridge) return;
  const [extensionVersion, setExtensionVersion] = createSignal(0);

  const removeExtensionListener = extensionMenu?.subscribe?.(() => {
    setExtensionVersion((version) => version + 1);
  });

  const removeCommandListener = bridge.onCommand((command) => {
    dispatchApplicationMenuCommand(command, transportProps, extensionMenu);
  });

  // A focused text field keeps Edit > Undo/Redo enabled, so the macOS key equivalent reaches runEditCommand.
  // The focus signal is only a trigger: the memo reads the current focus owner itself, so a removed field cannot leave a stale value.
  const [focusVersion, setFocusVersion] = createSignal(0);
  const onFocusChange = () => setFocusVersion((version) => version + 1);

  // focusout fires with focus already on body when focus moves to another field; that field's focusin follows, so skip it.
  const onFocusOut = (event: FocusEvent) => {
    if (event.relatedTarget === null) onFocusChange();
  };

  document.addEventListener("focusin", onFocusChange);
  document.addEventListener("focusout", onFocusOut);
  window.addEventListener("timeline-local-duplicate-state-change", onFocusChange);

  const menuState = createMemo<DesktopApplicationMenuState>(() => {
    extensionVersion();
    focusVersion();
    const transport = transportProps();
    const editable = editableFocusOwner();
    const localOwner = focusedLocalKeyboardOwner();

    return {
      ready: true,
      canExportArchive: isLocalId("project", transport.projectMenu.currentProjectId),
      canUndo: transport.edit.canUndo || editable,
      canRedo: transport.edit.canRedo || editable,
      canCut: editable,
      canCopy: editable || transport.edit.canCopySelection,
      canPaste: editable || transport.edit.canPasteSelection,
      canSelectAll: editable || transport.edit.canSelectAllClips,
      canDuplicateSelection: !editable && localOwner
        ? localOwner.getAttribute("data-timeline-keyboard-duplicate-enabled") === "true"
        : !editable && transport.edit.canDuplicateSelection,
      // A focused local editor owns the Delete key itself; the menu item would not reach it.
      canDeleteSelection: !editable && !localOwner && transport.edit.canDeleteSelection,
      editableFocused: editable,
      signedIn: Boolean(transport.projectMenu.currentUserId),
      metronomeEnabled: transport.timeline.metronomeEnabled,
      loopEnabled: transport.timeline.loopEnabled,
      gridEnabled: transport.timeline.gridEnabled,
      followEnabled: transport.timeline.followEnabled,
      syncMix: transport.tracksMenu.syncMix,
      gridDenominator: gridDenominatorForState(transport.timeline.gridDenominator),
      extensionContributions: [...(extensionMenu?.contributions() ?? [])],
    };
  }, { equals: sameMenuState });

  createEffect(menuState, (state) => {
    bridge.setState(state);
  });

  onCleanup(() => {
    removeCommandListener();
    removeExtensionListener?.();
    document.removeEventListener("focusin", onFocusChange);
    document.removeEventListener("focusout", onFocusOut);
    window.removeEventListener("timeline-local-duplicate-state-change", onFocusChange);
    bridge.setState({
      ready: false,
      canExportArchive: false,
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canSelectAll: false,
      canDuplicateSelection: false,
      canDeleteSelection: false,
      editableFocused: false,
      signedIn: false,
      metronomeEnabled: false,
      loopEnabled: false,
      gridEnabled: false,
      followEnabled: false,
      syncMix: false,
      gridDenominator: 4,
    });
  });
};
