import {
  type DesktopApplicationMenuCommand,
  type DesktopApplicationMenuState,
} from "@daw-browser/desktop-protocol/application-menu";
import { createEffect, onCleanup, type Accessor } from "solid-js";
import { isLocalId } from "@daw-browser/shared";
import type { TransportControlsProps } from "~/components/timeline/transport-types";

const gridDenominatorForState = (
  value: number,
): DesktopApplicationMenuState["gridDenominator"] => {
  if (value === 2 || value === 4 || value === 8 || value === 12 || value === 16) {
    return value;
  }
  return 4;
};

const dispatchApplicationMenuCommand = (
  command: DesktopApplicationMenuCommand,
  transportProps: Accessor<TransportControlsProps>,
) => {
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
      transport.onUndo();
      return;
    case "redo":
      transport.onRedo();
      return;
    case "duplicate":
      transport.onDuplicateSelection();
      return;
    case "delete":
      transport.onDeleteSelection();
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

export const useDesktopApplicationMenu = (
  transportProps: Accessor<TransportControlsProps>,
) => {
  const bridge = window.dawDesktop?.applicationMenu;
  if (!bridge) return;

  const removeCommandListener = bridge.onCommand((command) => {
    dispatchApplicationMenuCommand(command, transportProps);
  });

  createEffect(() => {
    const transport = transportProps();
    const state: DesktopApplicationMenuState = {
      ready: true,
      canExportArchive: isLocalId("project", transport.projectMenu.currentProjectId),
      signedIn: Boolean(transport.projectMenu.currentUserId),
      metronomeEnabled: transport.metronomeEnabled,
      loopEnabled: transport.loopEnabled,
      gridEnabled: transport.gridEnabled,
      syncMix: transport.tracksMenu.syncMix,
      gridDenominator: gridDenominatorForState(transport.gridDenominator),
    };
    bridge.setState(state);
  });

  onCleanup(() => {
    removeCommandListener();
    bridge.setState({
      ready: false,
      canExportArchive: false,
      signedIn: false,
      metronomeEnabled: false,
      loopEnabled: false,
      gridEnabled: false,
      syncMix: false,
      gridDenominator: 4,
    });
  });
};
