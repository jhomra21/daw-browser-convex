import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { Menubar } from "~/components/ui/menubar";
import { EditMenu } from "./edit-menu";
import { ViewMenu } from "./view-menu";
import type { TransportControlsProps } from "../transport-types";
import { useTimelineKeyboard } from "~/hooks/useTimelineKeyboard";

const calls: string[] = [];
const record = (name: string) => () => { calls.push(name); };
const toolbar: TransportControlsProps = {
  isPlaying: false,
  playheadSec: 0,
  onPlay: record("transport:play"),
  onPause: record("transport:pause"),
  onStop: record("transport:stop"),
  onAddAudio: record("transport:add-audio"),
  tracksMenu: {
    syncMix: false,
    onToggleSyncMix: record("tracks:sync-mix"),
    onAddTrack: record("tracks:add"),
    onAddReturnTrack: record("tracks:add-return"),
    onAddGroupTrack: record("tracks:add-group"),
    onAddInstrumentTrack: record("tracks:add-instrument"),
  },
  bpm: 120,
  onChangeBpm: () => {},
  metronomeEnabled: false,
  onToggleMetronome: record("view:metronome"),
  gridEnabled: false,
  onToggleGrid: record("view:grid"),
  followEnabled: true,
  onToggleFollow: record("view:follow"),
  zoom: {
    onIn: record("view:zoom-in"),
    onOut: record("view:zoom-out"),
    onFit: record("view:zoom-fit"),
  },
  gridDenominator: 16,
  onChangeGridDenominator: (denominator) => { calls.push(`view:grid-resolution:${denominator}`); },
  loopEnabled: false,
  onToggleLoop: record("view:loop"),
  isRecording: false,
  onToggleRecord: record("transport:record"),
  onUndo: record("edit:undo"),
  onRedo: record("edit:redo"),
  canUndo: true,
  canRedo: true,
  canDuplicateSelection: true,
  canDeleteSelection: true,
  canCopySelection: true,
  canPasteSelection: true,
  canSelectAllClips: true,
  automationOverrideCount: 0,
  onReEnableAutomation: record("automation:enable"),
  onDeleteSelection: record("edit:delete"),
  onDuplicateSelection: record("edit:duplicate"),
  onCopySelection: record("edit:copy"),
  onPasteSelection: record("edit:paste"),
  onSelectAllClips: record("edit:select-all"),
  onJumpToClip: record("timeline:jump"),
  onInsertSample: record("timeline:insert-sample"),
  projectMenu: {
    currentProjectId: "fixture-project",
    canManageSharing: false,
    projects: [],
    onOpenProject: record("project:open"),
    onCreateProject: record("project:create"),
    onDeleteProject: record("project:delete"),
    onRenameProject: record("project:rename"),
    onOpenExport: record("project:export"),
    onOpenDashboard: record("project:dashboard"),
    onSignIn: record("project:sign-in"),
    onLogout: record("project:logout"),
    onAbout: record("project:about"),
    onExportArchive: record("project:export-archive"),
    onImportArchive: record("project:import-archive"),
  },
  browser: {
    open: false,
    onOpen: record("view:browser-open"),
    onToggle: record("view:browser-toggle"),
    onSelectTab: (tab) => { calls.push(`view:browser-tab:${tab}`); },
  },
  midiKeyboard: {
    enabled: () => false,
    canPlay: () => false,
    targetLabel: () => null,
    octave: () => 4,
    toggle: record("midi-keyboard:toggle"),
  },
};

const arrangement = document.createElement("div");
arrangement.id = "arrangement";
arrangement.tabIndex = 0;
arrangement.style.cssText = "position: absolute; top: 320px; left: 320px; width: 200px; height: 100px";
const root = document.createElement("div");
document.body.append(arrangement, root);
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === "d") event.preventDefault();
}, { capture: true });

const dispose = render(() => {
  useTimelineKeyboard({
    enabled: () => true,
    onSpace: record("timeline:space"),
    onDelete: record("timeline:delete"),
    onDuplicate: record("timeline:duplicate"),
    onCopy: () => { calls.push("timeline:copy"); return true; },
    onPaste: () => { calls.push("timeline:paste"); return true; },
    onAddAudioTrack: record("timeline:add-audio-track"),
    onAddReturnTrack: record("timeline:add-return-track"),
    onAddGroupTrack: record("timeline:add-group-track"),
    onGroupSelectedTracks: record("timeline:group-selected"),
    onUngroupSelectedTrack: record("timeline:ungroup-selected"),
    onAddInstrumentTrack: record("timeline:add-instrument-track"),
    onOpenExport: record("timeline:export"),
    onToggleFollow: record("timeline:follow"),
    executeExtensionShortcut: () => { calls.push("timeline:extension"); return true; },
    onUndo: record("timeline:undo"),
    onRedo: record("timeline:redo"),
  });
  return createComponent(Menubar, {
    class: "fixture-menubar",
    get children() {
      return [
        createComponent(ViewMenu, { toolbar }),
        createComponent(EditMenu, { toolbar }),
      ];
    },
  });
}, root);

const snapshot = () => {
  const trigger = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((element) => element.textContent?.trim() === "View");
  const menu = [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
    .find((element) => element.getClientRects().length > 0) ?? null;
  return {
    calls: [...calls],
    activeId: document.activeElement?.id ?? "",
    activeText: document.activeElement?.textContent?.trim() ?? "",
    activeRole: document.activeElement?.getAttribute("role") ?? "",
    activeInMenu: menu?.contains(document.activeElement) ?? false,
    viewExpanded: trigger?.getAttribute("aria-expanded") ?? null,
    menuVisible: menu !== null && trigger?.getAttribute("aria-expanded") === "true",
    menuItems: [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
      .map((item) => item.textContent?.trim() ?? ""),
  };
};

Object.assign(window, {
  productionMenuFocus: {
    calls,
    snapshot,
    dispose,
  },
});
