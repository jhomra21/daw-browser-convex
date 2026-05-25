import { Link, useNavigate } from "@tanstack/solid-router";
import {
  type Accessor,
  type Component,
  For,
  Show,
  createMemo,
} from "solid-js";
import Icon from "~/components/ui/Icon";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarPortal,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
} from "~/components/ui/menubar";
import { useExportsMenuController } from "~/hooks/useExportsMenuController";
import { useProjectsMenuController } from "~/hooks/useProjectsMenuController";
import { useSamplesMenuController } from "~/hooks/useSamplesMenuController";
import { useShareMenuController } from "~/hooks/useShareMenuController";
import { useTransportTempoController } from "~/hooks/useTransportTempoController";
import { authClient } from "~/lib/auth-client";
import { isLocalId } from "~/lib/local-ids";
import { queryClient } from "~/lib/query-client";
import { useSessionQuery } from "~/lib/session";
import { cn } from "~/lib/utils";
import type { Track } from "~/types/timeline";
import { ProjectsMenu } from "./projects-menu";
import { ProjectMediaMenu } from "./project-media-menu";
import { NativeMenuTrigger, nativeMenuTriggerClass } from "./toolbar-context";
import type { TransportControlsProps } from "./transport-types";

type TransportBarController = {
  isRecording: boolean;
  onToggleRecord: () => void;
  isPlaying: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  tempoDraft: Accessor<string>;
  setTempoDraft: (value: string) => void;
  tempoEditing: Accessor<boolean>;
  setTempoEditing: (value: boolean) => void;
  commitTempo: () => void;
  beginTempoDrag: (event: PointerEvent) => void;
  updateTempoDrag: (event: PointerEvent) => void;
  endTempoDrag: (event: PointerEvent) => void;
  metronomeEnabled: boolean;
  onToggleMetronome: () => void;
  loopEnabled: boolean;
  onToggleLoop: () => void;
  gridEnabled: boolean;
  onToggleGrid: () => void;
  gridDenominator: number;
  onChangeGridDenominator: (next: number) => void;
  bpm: number;
};

const nativeMenuItemClass =
  "cursor-pointer text-neutral-200 hover:bg-neutral-800 hover:text-neutral-100 focus:bg-neutral-800 focus:text-neutral-100 data-[highlighted]:bg-neutral-800 data-[highlighted]:text-neutral-100";

const gridDenominators = [2, 4, 8, 12, 16];

type ShareMenuController = {
  onOpenChange: (open: boolean) => void;
  onOpen: () => Promise<void>;
  onClose: () => void;
  copied: boolean;
  shareUrl: string;
  onCopy: () => Promise<void>;
};

const FileMenu: Component<{ toolbar: TransportControlsProps }> = (props) => {
  const toolbar = () => props.toolbar;

  return (
    <MenubarMenu value="file">
      <NativeMenuTrigger label="File" />
      <MenubarContent class="w-56 border-neutral-800 bg-neutral-900">
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={toolbar().onAddAudio}
        >
          Add Audio...
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={toolbar().onOpenExport}
        >
          Export Mixdown...
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
};

const EditMenu: Component<{ toolbar: TransportControlsProps }> = (props) => {
  const toolbar = () => props.toolbar;

  return (
    <MenubarMenu value="edit">
      <NativeMenuTrigger label="Edit" />
      <MenubarContent class="w-44 border-neutral-800 bg-neutral-900">
        <MenubarItem class={nativeMenuItemClass} onSelect={toolbar().onUndo}>
          Undo
        </MenubarItem>
        <MenubarItem class={nativeMenuItemClass} onSelect={toolbar().onRedo}>
          Redo
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
};

const TracksMenu: Component<{ tracksMenu: TransportControlsProps["tracksMenu"] }> = (props) => {
  const tracksMenu = () => props.tracksMenu;

  return (
    <MenubarMenu value="tracks">
      <NativeMenuTrigger label="Tracks" />
      <MenubarContent class="w-64 border-neutral-800 bg-neutral-900">
        <MenubarItem
          class={cn(nativeMenuItemClass, tracksMenu().syncMix && "text-blue-300")}
          onSelect={tracksMenu().onToggleSyncMix}
        >
          Sync Mix
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem class={nativeMenuItemClass} onSelect={tracksMenu().onAddTrack}>
          <span>Add Track</span>
          <MenubarShortcut>Shift + T</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={tracksMenu().onAddReturnTrack}
        >
          <span>Return</span>
          <MenubarShortcut>Shift + R</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={tracksMenu().onAddGroupTrack}
        >
          <span>Group</span>
          <MenubarShortcut>Shift + G</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={tracksMenu().onAddInstrumentTrack}
        >
          <span>Instrument</span>
          <MenubarShortcut>Ctrl/Cmd + Shift + T</MenubarShortcut>
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
};

const TransportBar: Component<{ transport: TransportBarController }> = (
  props,
) => {
  const transport = () => props.transport;
  const centerIconButtonClass =
    "h-7 w-7 rounded text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100";

  return (
    <div class="justify-self-center flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        onClick={transport().onToggleRecord}
        aria-pressed={transport().isRecording}
        aria-label={
          transport().isRecording ? "Stop recording" : "Start recording"
        }
        class={cn(
          centerIconButtonClass,
          transport().isRecording && "bg-red-500 hover:bg-red-500/90",
        )}
      >
        <span
          class={cn(
            "h-3.5 w-3.5 rounded-full",
            transport().isRecording ? "bg-background" : "bg-current",
          )}
        />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => {
          if (transport().isPlaying) {
            transport().onPause();
            return;
          }
          transport().onPlay();
        }}
        aria-label={transport().isPlaying ? "Pause" : "Play"}
        class={centerIconButtonClass}
      >
        <Show
          when={transport().isPlaying}
          fallback={<Icon name="play" class="h-4 w-4 fill-current" />}
        >
          <Icon name="pause" class="h-4 w-4" />
        </Show>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={transport().onStop}
        aria-label="Stop"
        class={centerIconButtonClass}
      >
        <Icon name="stop" class="h-4 w-4 fill-current" />
      </Button>
      <div class="flex items-center">
        <label class="flex items-center gap-1 text-xs text-neutral-400 pr-1">
          <input
            type="text"
            value={transport().tempoDraft()}
            size={Math.max(transport().tempoDraft().length + 1, 2)}
            class="w-auto appearance-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 focus:border-neutral-500 focus:outline-none"
            inputmode="numeric"
            pattern="[0-9]*"
            onFocus={() => transport().setTempoEditing(true)}
            onBlur={() => {
              if (transport().tempoEditing()) {
                transport().commitTempo();
              }
              transport().setTempoEditing(false);
            }}
            onInput={(event) =>
              transport().setTempoDraft(event.currentTarget.value)
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                transport().commitTempo();
                transport().setTempoEditing(false);
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                transport().setTempoDraft(String(transport().bpm));
                transport().setTempoEditing(false);
                event.currentTarget.blur();
              }
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              transport().beginTempoDrag(event);
            }}
            onPointerMove={transport().updateTempoDrag}
            onPointerUp={transport().endTempoDrag}
            onPointerCancel={transport().endTempoDrag}
          />
          <span class="text-xs text-neutral-500">BPM</span>
        </label>
        <Button
          variant="ghost"
          size="icon"
          onClick={transport().onToggleMetronome}
          aria-pressed={transport().metronomeEnabled}
          aria-label="Toggle metronome"
          class={centerIconButtonClass}
        >
          <Icon name="metronome" class="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={transport().onToggleLoop}
          aria-pressed={transport().loopEnabled}
          aria-label="Toggle loop region"
          class={cn(
            centerIconButtonClass,
            transport().loopEnabled && "text-green-400",
          )}
        >
          <Icon name="repeat" class="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={transport().onToggleGrid}
          aria-pressed={transport().gridEnabled}
          aria-label="Toggle snap to grid"
          class={cn(
            centerIconButtonClass,
            transport().gridEnabled && "text-green-400",
          )}
        >
          <Icon name="grid" class="h-4 w-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger>
            <Button variant="ghost" size="sm" class={nativeMenuTriggerClass}>
              {`1/${transport().gridDenominator}`}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            class="w-full border-neutral-800 bg-neutral-900"
            style={{ width: "10rem" }}
          >
            <div class="p-1">
              <div class="px-2 pb-1 text-xs text-neutral-400">Grid</div>
              <For each={gridDenominators}>
                {(denominator) => (
                  <DropdownMenuItem
                    class="cursor-pointer text-neutral-50"
                    onSelect={() =>
                      transport().onChangeGridDenominator(denominator)
                    }
                  >
                    1/{denominator}
                  </DropdownMenuItem>
                )}
              </For>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
};

const ShareMenu: Component<{ share: ShareMenuController }> = (props) => {
  const share = () => props.share;

  return (
    <MenubarMenu
      value="share"
      onOpenChange={(open) => {
        if (open) {
          void share().onOpen();
        } else {
          share().onOpenChange(false);
        }
      }}
    >
      <NativeMenuTrigger label="Share" />
      <MenubarContent
        class="w-full border-neutral-800 bg-neutral-900"
        style={{ width: "min(92vw, 24rem)" }}
      >
        <div class="w-full p-3">
          <div class="mb-3 flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-sm font-semibold text-neutral-200">
                Share this room
              </span>
            </div>
            <MenubarItem
              class="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
              aria-label="Close"
              onSelect={share().onClose}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                class="h-4 w-4"
              >
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="m7 7l10 10M17 7L7 17"
                />
                <title>Close</title>
              </svg>
            </MenubarItem>
          </div>
          <div class="flex w-full items-center gap-2">
            <div class="min-w-0 w-full max-w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-200 shadow-inner">
              <div
                class="font-mono"
                style={{
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                  "white-space": "nowrap",
                }}
              >
                {share().shareUrl}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={share().copied ? "Copied" : "Copy URL"}
              class={cn(
                "shrink-0",
                share().copied ? "text-green-500" : "text-neutral-400",
              )}
              onClick={() => void share().onCopy()}
            >
              <Show
                when={share().copied}
                fallback={
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    class="h-4 w-4"
                  >
                    <g
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <rect width="8" height="8" x="8" y="8" rx="2" />
                      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                    </g>
                    <title>Copy</title>
                  </svg>
                }
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  class="h-4 w-4"
                >
                  <path
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="m5 12l5 5L20 7"
                  />
                  <title>Copied</title>
                </svg>
              </Show>
            </Button>
          </div>
        </div>
      </MenubarContent>
    </MenubarMenu>
  );
};

const ShortcutsSubMenu: Component = () => (
  <MenubarSub>
    <MenubarSubTrigger class={nativeMenuItemClass}>Shortcuts</MenubarSubTrigger>
    <MenubarPortal>
      <MenubarSubContent
        class="border-neutral-800 bg-neutral-900 text-neutral-100"
        style={{ width: "min(92vw, 22rem)" }}
      >
        <MenubarLabel class="text-neutral-400">Timeline</MenubarLabel>
        <MenubarItem disabled>
          Play / Pause
          <MenubarShortcut>Space</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled>
          Delete selection or track
          <MenubarShortcut>Del / Backspace</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled>
          Duplicate clips
          <MenubarShortcut>Ctrl/Cmd + D</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled>
          Add Audio Track
          <MenubarShortcut>Shift + T</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled>
          Add Return Track
          <MenubarShortcut>Shift + R</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled>
          Add Group Track
          <MenubarShortcut>Shift + G</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled>
          Add Instrument Track
          <MenubarShortcut>Ctrl/Cmd + Shift + T</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarLabel class="text-neutral-400">
          MIDI Editor (when keyboard enabled)
        </MenubarLabel>
        <MenubarItem disabled>
          Note keys
          <MenubarShortcut>A S D F G H J K L ;</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled>
          Sharp keys
          <MenubarShortcut>W E T Y U O P</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled>
          Octave down
          <MenubarShortcut>Z</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled>
          Octave up
          <MenubarShortcut>X</MenubarShortcut>
        </MenubarItem>
      </MenubarSubContent>
    </MenubarPortal>
  </MenubarSub>
);

const SettingsMenu: Component<{ toolbar: TransportControlsProps }> = (props) => {
  const toolbar = () => props.toolbar;
  const navigate = useNavigate();
  const session = useSessionQuery();
  const user = createMemo(() => session.data?.user);

  const handleSignOut = async () => {
    try {
      await authClient.signOut();
    } finally {
      queryClient.setQueryData(["session"], null);
      navigate({ to: "/Login" });
    }
  };

  return (
    <MenubarMenu value="settings">
      <NativeMenuTrigger label="Settings" />
      <MenubarContent class="w-56 border-neutral-800 bg-neutral-900">
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={toolbar().onMasterFX}
        >
          Master FX
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={toolbar().onToggleMetronome}
        >
          {toolbar().metronomeEnabled ? "Disable" : "Enable"} Metronome
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={toolbar().onToggleLoop}
        >
          {toolbar().loopEnabled ? "Disable" : "Enable"} Loop
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={toolbar().onToggleGrid}
        >
          {toolbar().gridEnabled ? "Disable" : "Enable"} Grid
        </MenubarItem>
        <MenubarSeparator />
        <div class="px-2 pb-1 pt-1 text-xs text-neutral-500">
          Grid Resolution
        </div>
        <For each={gridDenominators}>
          {(denominator) => (
            <MenubarItem
              class={cn(
                nativeMenuItemClass,
                toolbar().gridDenominator === denominator && "text-green-400",
              )}
              onSelect={() => toolbar().onChangeGridDenominator(denominator)}
            >
              1/{denominator}
            </MenubarItem>
          )}
        </For>
        <MenubarSeparator />
        <ShortcutsSubMenu />
        <MenubarSeparator />
        <Show
          when={user()?.email}
          fallback={
            <MenubarItem as={Link} to="/Login" class={nativeMenuItemClass}>
              Sign in
            </MenubarItem>
          }
        >
          <MenubarItem as={Link} to="/Login" class={nativeMenuItemClass}>
            Account
          </MenubarItem>
          <MenubarItem class={nativeMenuItemClass} onSelect={handleSignOut}>
            Logout
          </MenubarItem>
        </Show>
        <MenubarItem as={Link} to="/about" class={nativeMenuItemClass}>
          About
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
};

const TransportControls: Component<TransportControlsProps> = (props) => {
  const currentProjectId = () => props.currentProjectId;
  const currentUserId = () => props.currentUserId;
  const projectsMenu = useProjectsMenuController({
    onDeleteProject: props.onDeleteProject,
    onRenameProject: props.onRenameProject,
  });
  const samplesMenu = useSamplesMenuController({
    currentProjectId,
    currentUserId,
    onInsertSample: props.onInsertSample,
    onJumpToClip: props.onJumpToClip,
  });
  const exportsMenu = useExportsMenuController({
    currentProjectId,
    currentUserId,
  });
  const shareMenu = useShareMenuController({
    onShare: props.onShare,
    projectId: currentProjectId,
  });
  const tempo = useTransportTempoController({
    bpm: () => props.bpm,
    onChangeBpm: props.onChangeBpm,
  });
  const saveStatus = () =>
    isLocalId("project", currentProjectId())
      ? { label: "Saved locally", class: "border-emerald-900/70 bg-emerald-950/40 text-emerald-300" }
      : currentUserId()
        ? { label: "Cloud saved", class: "border-sky-900/70 bg-sky-950/40 text-sky-300" }
        : { label: "Sign in to sync", class: "border-amber-900/70 bg-amber-950/40 text-amber-300" };

  return (
    <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-neutral-800 bg-neutral-950 p-2">
      <div class="justify-self-start flex items-center gap-1">
        <Menubar class="flex items-center gap-1">
          <FileMenu toolbar={props} />
          <EditMenu toolbar={props} />
          <ProjectsMenu
            currentProjectId={props.currentProjectId}
            currentUserId={props.currentUserId}
            projects={props.projects}
            onOpenProject={props.onOpenProject}
            onCreateProject={props.onCreateProject}
            onOpenExport={props.onOpenExport}
            onShare={props.onShare}
            onChooseProjectFolder={props.onChooseProjectFolder}
            onBackUpNow={props.onBackUpNow}
            onExportArchive={props.onExportArchive}
            onImportArchive={props.onImportArchive}
            menu={projectsMenu}
          />
          <ProjectMediaMenu samples={samplesMenu} exportsMenu={exportsMenu} />
          <SettingsMenu toolbar={props} />
          <TracksMenu tracksMenu={props.tracksMenu} />
          <ShareMenu
            share={{
              onOpenChange: shareMenu.onOpenChange,
              onOpen: shareMenu.onOpen,
              onClose: shareMenu.onClose,
              copied: shareMenu.copied(),
              shareUrl: shareMenu.shareUrl(),
              onCopy: shareMenu.onCopy,
            }}
          />
        </Menubar>
      </div>

      <TransportBar
        transport={{
          isRecording: props.isRecording,
          onToggleRecord: props.onToggleRecord,
          isPlaying: props.isPlaying,
          onPlay: props.onPlay,
          onPause: props.onPause,
          onStop: props.onStop,
          tempoDraft: tempo.tempoDraft,
          setTempoDraft: tempo.setTempoDraft,
          tempoEditing: tempo.tempoEditing,
          setTempoEditing: tempo.setTempoEditing,
          commitTempo: tempo.commitTempo,
          beginTempoDrag: tempo.beginTempoDrag,
          updateTempoDrag: tempo.updateTempoDrag,
          endTempoDrag: tempo.endTempoDrag,
          metronomeEnabled: props.metronomeEnabled,
          onToggleMetronome: props.onToggleMetronome,
          loopEnabled: props.loopEnabled,
          onToggleLoop: props.onToggleLoop,
          gridEnabled: props.gridEnabled,
          onToggleGrid: props.onToggleGrid,
          gridDenominator: props.gridDenominator,
          onChangeGridDenominator: props.onChangeGridDenominator,
          bpm: props.bpm,
        }}
      />

      <div class="justify-self-end flex items-center gap-3">
        <span
          class={cn(
            "rounded-full border px-2 py-1 text-[11px] font-medium",
            saveStatus().class,
          )}
        >
          {saveStatus().label}
        </span>
        <div class="flex items-center gap-2 text-xs">
          <span class="text-neutral-500">Playhead</span>
          <span class="tabular-nums text-neutral-200">
            {props.playheadSec.toFixed(2)}s
          </span>
        </div>
      </div>
    </div>
  );
};

export default TransportControls;
