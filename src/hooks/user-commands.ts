import type { DesktopApplicationMenuCommand } from "@daw-browser/desktop-protocol/application-menu";
import type { TransportControlsProps } from "~/hooks/transport-types";
import { keyboardTargetOwner } from "~/lib/keyboard-event-target";

// Walks open shadow roots so a text field inside one still counts as the focus owner.
const focusedKeyboardPath = () => {
  const path: Element[] = [];

  for (let element = document.activeElement; element; element = element.shadowRoot?.activeElement ?? null) {
    path.push(element);
  }

  return path;
};

export const editableFocusOwner = () => keyboardTargetOwner(focusedKeyboardPath()) === "editable";

const editableOrOverlayFocused = () => keyboardTargetOwner(focusedKeyboardPath()) !== null;

export const focusedLocalKeyboardOwner = () => {
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

type UserCommandRun = (transport: TransportControlsProps) => void;

// The behavior of every protocol menu command. The desktop menu runs all of them; the in-app menubar runs the
// ones it shares (runUserCommand) and keeps its own direct handlers for the edit commands, which skip focus routing.
export const userCommands: Readonly<Record<DesktopApplicationMenuCommand, UserCommandRun>> = {
  "new-project": (transport) => void transport.projectMenu.onCreateProject(),
  "open-projects-dashboard": (transport) => transport.projectMenu.onOpenDashboard("projects"),
  "open-samples-dashboard": (transport) => transport.projectMenu.onOpenDashboard("samples"),
  "open-export-dashboard": (transport) => transport.projectMenu.onOpenDashboard("export"),
  "import-audio": (transport) => transport.onAddAudio(),
  "import-archive": (transport) => void transport.projectMenu.onImportArchive(),
  "export-archive": (transport) => void transport.projectMenu.onExportArchive(),
  "export-mixdown": (transport) => transport.projectMenu.onOpenExport(),
  "sign-in": (transport) => transport.projectMenu.onSignIn(),
  "open-account-dashboard": (transport) => transport.projectMenu.onOpenDashboard("account"),
  logout: (transport) => void transport.projectMenu.onLogout(),
  undo: (transport) => runEditCommand("undo", () => transport.edit.onUndo()),
  redo: (transport) => runEditCommand("redo", () => transport.edit.onRedo()),
  duplicate: (transport) => runEditCommand("duplicate", () => transport.edit.onDuplicateSelection()),
  // A focused field is handled by the menu click in the main process. These run the timeline only when no field or overlay owns focus.
  copy: (transport) => {
    if (!editableOrOverlayFocused()) transport.edit.onCopySelection();
  },
  paste: (transport) => {
    if (!editableOrOverlayFocused()) transport.edit.onPasteSelection();
  },
  "select-all": (transport) => {
    if (!editableOrOverlayFocused()) transport.edit.onSelectAllClips();
  },
  delete: (transport) => runEditCommand("delete", () => transport.edit.onDeleteSelection()),
  "keyboard-shortcuts": (transport) => transport.projectMenu.onOpenDashboard("keyboard"),
  "open-assets-browser": (transport) => {
    transport.browser.onSelectTab("assets");
    transport.browser.onOpen();
  },
  "open-effects-browser": (transport) => {
    transport.browser.onSelectTab("effects");
    transport.browser.onOpen();
  },
  "open-midi-instruments-browser": (transport) => {
    transport.browser.onSelectTab("midi-instruments");
    transport.browser.onOpen();
  },
  "toggle-metronome": (transport) => transport.timeline.onToggleMetronome(),
  "toggle-loop": (transport) => transport.timeline.onToggleLoop(),
  "toggle-grid": (transport) => transport.timeline.onToggleGrid(),
  "toggle-follow": (transport) => transport.timeline.onToggleFollow(),
  "zoom-in": (transport) => transport.timeline.zoom.onIn(),
  "zoom-out": (transport) => transport.timeline.zoom.onOut(),
  "zoom-to-fit": (transport) => transport.timeline.zoom.onFit(),
  "set-grid-denominator-2": (transport) => transport.timeline.onChangeGridDenominator(2),
  "set-grid-denominator-4": (transport) => transport.timeline.onChangeGridDenominator(4),
  "set-grid-denominator-8": (transport) => transport.timeline.onChangeGridDenominator(8),
  "set-grid-denominator-12": (transport) => transport.timeline.onChangeGridDenominator(12),
  "set-grid-denominator-16": (transport) => transport.timeline.onChangeGridDenominator(16),
  "open-general-settings": (transport) => transport.projectMenu.onOpenDashboard("general"),
  "open-timeline-settings": (transport) => transport.projectMenu.onOpenDashboard("timeline"),
  "open-audio-settings": (transport) => transport.projectMenu.onOpenDashboard("audio"),
  about: (transport) => transport.projectMenu.onAbout(),
  "toggle-sync-mix": (transport) => transport.tracksMenu.onToggleSyncMix(),
  "add-audio-track": (transport) => void transport.tracksMenu.onAddTrack(),
  "add-return-track": (transport) => void transport.tracksMenu.onAddReturnTrack(),
  "add-group-track": (transport) => void transport.tracksMenu.onAddGroupTrack(),
  "add-instrument-track": (transport) => void transport.tracksMenu.onAddInstrumentTrack(),
};

export const runUserCommand = (command: DesktopApplicationMenuCommand, transport: TransportControlsProps) => {
  userCommands[command](transport);
};
