import { type Accessor, type Component, For, Show, type JSX } from "solid-js";
import Icon from "~/components/ui/Icon";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Menubar } from "~/components/ui/menubar";
import { useTransportTempoController } from "~/hooks/useTransportTempoController";
import { cn } from "~/lib/utils";
import { nativeMenuTriggerClass } from "./toolbar-context";
import type { TransportControlsProps } from "./transport-types";
import { getProjectSaveStatus } from "~/lib/project-save-status";
import { EditMenu } from "./menus/edit-menu";
import { FileMenu } from "./menus/file-menu";
import { SettingsMenu } from "./menus/settings-menu";
import { TracksMenu } from "./menus/tracks-menu";
import { ViewMenu } from "./menus/view-menu";
import { gridDenominators } from "./grid-options";

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

const TransportBar: Component<{ transport: TransportBarController }> = (
  props,
) => {
  const transport = () => props.transport;
  const centerIconButtonClass =
    "h-7 w-7 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100";

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
            class="w-auto appearance-none border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 focus:border-neutral-500 focus:outline-none"
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

const SaveStatus: Component<{ projectMenu: TransportControlsProps["projectMenu"] }> = (props) => {
  const currentProject = () =>
    props.projectMenu.projects.find((project) => project.projectId === props.projectMenu.currentProjectId);
  const status = () => getProjectSaveStatus({
    projectId: props.projectMenu.currentProjectId,
    userId: props.projectMenu.currentUserId,
    mode: currentProject()?.mode,
    sharedOutboxStatus: props.projectMenu.sharedOutboxStatus,
    cloudBackupStatus: props.projectMenu.cloudBackupStatus,
  });
  const isLocal = () => status().compactLabel === "Local";

  return (
    <TopRightIconButton
      tooltip={status().label}
      class={status().class}
    >
      <Show when={isLocal()} fallback={<CloudSaveIcon />}>
        <LocalSaveIcon />
      </Show>
    </TopRightIconButton>
  );
};

type TopRightIconButtonProps = {
  tooltip: string;
  class?: string;
  ariaPressed?: boolean;
  onClick?: () => void;
  children: JSX.Element;
};

const TopRightIconButton: Component<TopRightIconButtonProps> = (props) => (
  <Tooltip>
    <TooltipTrigger
      as={Button}
      variant="ghost"
      size="icon"
      onClick={props.onClick}
      aria-pressed={props.ariaPressed}
      aria-label={props.tooltip}
      class={cn(
        nativeMenuTriggerClass,
        "h-7 w-7 p-0",
        props.class,
      )}
    >
      {props.children}
    </TooltipTrigger>
    <TooltipContent>{props.tooltip}</TooltipContent>
  </Tooltip>
);

const LocalSaveIcon: Component = () => (
  <svg viewBox="0 0 20 20" class="h-4 w-4" aria-hidden="true">
    <path d="M4 5.5C4 4.7 4.7 4 5.5 4h9c.8 0 1.5.7 1.5 1.5v9c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z" fill="none" stroke="currentColor" stroke-width="1.5" />
    <path d="M7 4v4h6V4M7 13h6" stroke="currentColor" stroke-width="1.5" />
  </svg>
);

const CloudSaveIcon: Component = () => (
  <svg viewBox="0 0 20 20" class="h-4 w-4" aria-hidden="true">
    <path d="M6.5 15h7a3 3 0 0 0 .4-6 4.4 4.4 0 0 0-8.3-1.4A3.7 3.7 0 0 0 6.5 15Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5" />
  </svg>
);

const PianoKeysIcon: Component = () => (
  <svg viewBox="0 0 20 20" class="h-4 w-4" aria-hidden="true">
    <rect x="2.5" y="4" width="15" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5" />
    <path d="M6 4v12M10 4v12M14 4v12" stroke="currentColor" stroke-width="1" />
    <path d="M5 4h2.4v6H5zM9 4h2.4v6H9zM13 4h2.4v6H13z" fill="currentColor" />
  </svg>
);

const MidiKeyboardToggle: Component<{ midiKeyboard: TransportControlsProps["midiKeyboard"] }> = (props) => {
  const midiKeyboard = () => props.midiKeyboard;
  const baseNoteLabel = () => `C${midiKeyboard().octave + 4}`;
  const title = () => {
    if (!midiKeyboard().enabled) return "Turn on computer MIDI keyboard input";
    if (!midiKeyboard().targetLabel) return "Computer MIDI keyboard is on. Select an instrument track to play.";
    return `Computer MIDI keyboard is on: ${midiKeyboard().targetLabel}, ${baseNoteLabel()}`;
  };

  return (
    <TopRightIconButton
      onClick={midiKeyboard().onToggle}
      ariaPressed={midiKeyboard().enabled}
      tooltip={title()}
      class={cn(
        midiKeyboard().enabled && "border-amber-500/60 bg-amber-500/20 text-amber-300",
        midiKeyboard().enabled && midiKeyboard().canPlay && "border-green-500/50 bg-green-600/20 text-green-300",
      )}
    >
      <PianoKeysIcon />
    </TopRightIconButton>
  );
};

const TransportControls: Component<TransportControlsProps> = (props) => {
  const tempo = useTransportTempoController({
    bpm: () => props.bpm,
    onChangeBpm: props.onChangeBpm,
  });
  return (
    <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-neutral-800 bg-neutral-950 p-2">
      <div class="justify-self-start flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={props.browser.open}
          aria-label={props.browser.open ? "Hide browser sidebar" : "Show browser sidebar"}
          class={cn(
            nativeMenuTriggerClass,
            "focus:bg-neutral-800 focus:text-neutral-100 focus:outline-none",
            props.browser.open && "bg-neutral-800 text-neutral-100",
          )}
          onClick={props.browser.onToggle}
        >
          Browser
        </Button>
        <Menubar class="flex items-center gap-1">
          <FileMenu toolbar={props} />
          <EditMenu toolbar={props} />
          <ViewMenu toolbar={props} />
          <SettingsMenu toolbar={props} />
          <TracksMenu tracksMenu={props.tracksMenu} />
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
        <MidiKeyboardToggle midiKeyboard={props.midiKeyboard} />
        <SaveStatus projectMenu={props.projectMenu} />
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
