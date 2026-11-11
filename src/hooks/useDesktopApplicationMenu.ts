import {
  desktopApplicationMenuExtensionCommandSchema,
  type DesktopApplicationMenuExtensionContribution,
  type DesktopApplicationMenuMessage,
  type DesktopApplicationMenuState,
} from "@daw-browser/desktop-protocol/application-menu";
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { isLocalId } from "@daw-browser/shared";
import type { TransportControlsProps } from "~/components/timeline/transport-types";
import { keyboardTargetOwner } from "~/lib/keyboard-event-target";

const gridDenominatorForState = (
  value: number,
): DesktopApplicationMenuState["gridDenominator"] => {
  if (value === 2 || value === 4 || value === 8 || value === 12 || value === 16) {
    return value;
  }
  return 4;
};

// Walks open shadow roots so a text field inside one still counts as the focus owner.
const focusedKeyboardPath = () => {
  const path: Element[] = [];
  for (let element = document.activeElement; element; element = element.shadowRoot?.activeElement ?? null) {
    path.push(element);
  }
  return path;
};

const editableFocusOwner = () => keyboardTargetOwner(focusedKeyboardPath()) === "editable";

const editableOrOverlayFocused = () => keyboardTargetOwner(focusedKeyboardPath()) !== null;

const focusedLocalKeyboardOwner = () => {
  const path = focusedKeyboardPath();
  const focusedElement = path.find((element) => element.closest('[data-timeline-keyboard-local="true"]'));
  return focusedElement?.closest('[data-timeline-keyboard-local="true"]') ?? null;
};

// Menu undo/redo arrive without a keyboard event: text fields use native undo/redo, local editors use timeline history,
// overlays own their commands, and otherwise history belongs to the timeline.
const runEditCommand = (command: "undo" | "redo" | "duplicate" | "delete", runTimeline: () => void) => {
  const owner = keyboardTargetOwner(focusedKeyboardPath());
  if (owner === "editable") {
    if (command !== "duplicate") document.execCommand(command);
    return;
  }
  const localOwner = focusedLocalKeyboardOwner();
  if (localOwner) {
    if (command === "duplicate") localOwner.dispatchEvent(new Event("timeline-local-duplicate"));
    else if (command === "undo" || command === "redo") runTimeline();
    return;
  }
  if (owner === null) runTimeline();
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
  const transport = transportProps();
  switch (command) {
    case "new-project":
      void transport.projectMenu.onCreateProject();
      return;
    case "open-projects-dashboard":
      transport.projectMenu.onOpenDashboard("projects");
      return;
    case "open-samples-dashboard":
      transport.projectMenu.onOpenDashboard("samples");
      return;
    case "open-export-dashboard":
      transport.projectMenu.onOpenDashboard("export");
      return;
    case "import-audio":
      transport.onAddAudio();
      return;
    case "import-archive":
      void transport.projectMenu.onImportArchive();
      return;
    case "export-archive":
      void transport.projectMenu.onExportArchive();
      return;
    case "export-mixdown":
      transport.projectMenu.onOpenExport();
      return;
    case "sign-in":
      transport.projectMenu.onSignIn();
      return;
    case "open-account-dashboard":
      transport.projectMenu.onOpenDashboard("account");
      return;
    case "logout":
      void transport.projectMenu.onLogout();
      return;
    case "undo":
      runEditCommand("undo", () => transport.onUndo());
      return;
    case "redo":
      runEditCommand("redo", () => transport.onRedo());
      return;
    case "duplicate":
      runEditCommand("duplicate", () => transport.onDuplicateSelection());
      return;
    // A focused field is handled by the menu click in the main process. This runs the timeline only when no field or overlay owns focus.
    case "copy":
      if (!editableOrOverlayFocused()) transport.onCopySelection();
      return;
    case "paste":
      if (!editableOrOverlayFocused()) transport.onPasteSelection();
      return;
    case "select-all":
      if (!editableOrOverlayFocused()) transport.onSelectAllClips();
      return;
    case "delete":
      runEditCommand("delete", () => transport.onDeleteSelection());
      return;
    case "keyboard-shortcuts":
      transport.projectMenu.onOpenDashboard("keyboard");
      return;
    case "open-assets-browser":
      transport.browser.onSelectTab("assets");
      transport.browser.onOpen();
      return;
    case "open-effects-browser":
      transport.browser.onSelectTab("effects");
      transport.browser.onOpen();
      return;
    case "open-midi-instruments-browser":
      transport.browser.onSelectTab("midi-instruments");
      transport.browser.onOpen();
      return;
    case "toggle-metronome":
      transport.onToggleMetronome();
      return;
    case "toggle-loop":
      transport.onToggleLoop();
      return;
    case "toggle-grid":
      transport.onToggleGrid();
      return;
    case "toggle-follow":
      transport.onToggleFollow();
      return;
    case "zoom-in":
      transport.zoom.onIn();
      return;
    case "zoom-out":
      transport.zoom.onOut();
      return;
    case "zoom-to-fit":
      transport.zoom.onFit();
      return;
    case "set-grid-denominator-2":
      transport.onChangeGridDenominator(2);
      return;
    case "set-grid-denominator-4":
      transport.onChangeGridDenominator(4);
      return;
    case "set-grid-denominator-8":
      transport.onChangeGridDenominator(8);
      return;
    case "set-grid-denominator-12":
      transport.onChangeGridDenominator(12);
      return;
    case "set-grid-denominator-16":
      transport.onChangeGridDenominator(16);
      return;
    case "open-general-settings":
      transport.projectMenu.onOpenDashboard("general");
      return;
    case "open-timeline-settings":
      transport.projectMenu.onOpenDashboard("timeline");
      return;
    case "open-audio-settings":
      transport.projectMenu.onOpenDashboard("audio");
      return;
    case "about":
      transport.projectMenu.onAbout();
      return;
    case "toggle-sync-mix":
      transport.tracksMenu.onToggleSyncMix();
      return;
    case "add-audio-track":
      void transport.tracksMenu.onAddTrack();
      return;
    case "add-return-track":
      void transport.tracksMenu.onAddReturnTrack();
      return;
    case "add-group-track":
      void transport.tracksMenu.onAddGroupTrack();
      return;
    case "add-instrument-track":
      void transport.tracksMenu.onAddInstrumentTrack();
      return;
  }
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
  const bridge = window.dawDesktop?.applicationMenu;
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

  const menuState = createMemo<DesktopApplicationMenuState, undefined>(() => {
    extensionVersion();
    focusVersion();
    const transport = transportProps();
    const editable = editableFocusOwner();
    const localOwner = focusedLocalKeyboardOwner();
    return {
      ready: true,
      canExportArchive: isLocalId("project", transport.projectMenu.currentProjectId),
      canUndo: transport.canUndo || editable,
      canRedo: transport.canRedo || editable,
      canCut: editable,
      canCopy: editable || transport.canCopySelection,
      canPaste: editable || transport.canPasteSelection,
      canSelectAll: editable || transport.canSelectAllClips,
      canDuplicateSelection: !editable && localOwner
        ? localOwner.getAttribute("data-timeline-keyboard-duplicate-enabled") === "true"
        : !editable && transport.canDuplicateSelection,
      // A focused local editor owns the Delete key itself; the menu item would not reach it.
      canDeleteSelection: !editable && !localOwner && transport.canDeleteSelection,
      editableFocused: editable,
      signedIn: Boolean(transport.projectMenu.currentUserId),
      metronomeEnabled: transport.metronomeEnabled,
      loopEnabled: transport.loopEnabled,
      gridEnabled: transport.gridEnabled,
      followEnabled: transport.followEnabled,
      syncMix: transport.tracksMenu.syncMix,
      gridDenominator: gridDenominatorForState(transport.gridDenominator),
      extensionContributions: [...(extensionMenu?.contributions() ?? [])],
    };
  }, undefined, { equals: sameMenuState });

  createEffect(() => {
    bridge.setState(menuState());
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
