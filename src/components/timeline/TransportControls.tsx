import { Link, useNavigate } from "@tanstack/solid-router";
import {
  type Accessor,
  type Component,
  For,
  type JSX,
  Show,
  createContext,
  createMemo,
  useContext,
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
  MenubarTrigger,
} from "~/components/ui/menubar";
import type { InsertSampleInput } from "~/hooks/useTimelineClipImport";
import { useExportsMenuController } from "~/hooks/useExportsMenuController";
import { useProjectsMenuController } from "~/hooks/useProjectsMenuController";
import { useSamplesMenuController } from "~/hooks/useSamplesMenuController";
import { useShareMenuController } from "~/hooks/useShareMenuController";
import { useTransportTempoController } from "~/hooks/useTransportTempoController";
import type { TimelineProject } from "~/hooks/useTimelineData";
import { authClient } from "~/lib/auth-client";
import { queryClient } from "~/lib/query-client";
import { useSessionQuery } from "~/lib/session";
import { cn } from "~/lib/utils";
import type { Track } from "~/types/timeline";

type TransportControlsProps = {
  isPlaying: boolean;
  playheadSec: number;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onAddAudio: () => void;
  onMasterFX: () => void;
  onShare?: () => void;
  bpm: number;
  onChangeBpm: (next: number) => void;
  metronomeEnabled: boolean;
  onToggleMetronome: () => void;
  gridEnabled: boolean;
  onToggleGrid: () => void;
  gridDenominator: number;
  onChangeGridDenominator: (n: number) => void;
  loopEnabled: boolean;
  onToggleLoop: () => void;
  isRecording: boolean;
  onToggleRecord: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onJumpToClip: (
    clipId: string,
    trackId: Track["id"],
    startSec: number,
  ) => void;
  onInsertSample: (input: InsertSampleInput) => void | Promise<void>;
  currentRoomId: string;
  currentUserId?: string;
  projects: TimelineProject[];
  onOpenProject: (roomId: string) => void;
  onCreateProject: () => void | Promise<void>;
  onDeleteProject: (roomId: string) => void | Promise<void>;
  onRenameProject: (roomId: string, name: string) => void | Promise<void>;
  onOpenExport: () => void;
};

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

type NativeMenuTriggerProps = {
  label: string;
};

const nativeMenuTriggerClass =
  "h-7 rounded px-2 text-xs font-medium text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100";

const NativeMenuTrigger: Component<NativeMenuTriggerProps> = (props) => (
  <MenubarTrigger
    class={cn(
      nativeMenuTriggerClass,
      "data-[expanded]:bg-neutral-800 data-[expanded]:text-neutral-100",
    )}
  >
    {props.label}
  </MenubarTrigger>
);

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

type ToolbarContextValue = {
  toolbar: TransportControlsProps;
  projectsMenu: ReturnType<typeof useProjectsMenuController>;
  samplesMenu: ReturnType<typeof useSamplesMenuController>;
  exportsMenu: ReturnType<typeof useExportsMenuController>;
};

const ToolbarContext = createContext<ToolbarContextValue>();

const useToolbar = () => {
  const context = useContext(ToolbarContext);

  if (!context) {
    throw new Error("useToolbar must be used inside ToolbarProvider");
  }

  return context;
};

const ToolbarProvider: Component<{
  value: ToolbarContextValue;
  children: JSX.Element;
}> = (props) => (
  <ToolbarContext.Provider value={props.value}>
    {props.children}
  </ToolbarContext.Provider>
);

const FileMenu: Component = () => {
  const context = useToolbar();
  const toolbar = () => context.toolbar;

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

const EditMenu: Component = () => {
  const context = useToolbar();
  const toolbar = () => context.toolbar;

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

const ProjectsMenu: Component = () => {
  const context = useToolbar();
  const toolbar = () => context.toolbar;
  const menu = () => context.projectsMenu;

  return (
    <MenubarMenu value="project">
      <NativeMenuTrigger label="Project" />
      <MenubarContent
        class="w-full border-neutral-800 bg-neutral-900"
        style={{ width: "min(92vw, 24rem)" }}
      >
        <div class="w-full p-2">
          <div class="flex items-center justify-between px-1 pb-2">
            <span class="text-sm font-semibold text-neutral-100">
              My Projects
            </span>
            <Button
              variant="default"
              class="text-neutral-100"
              size="sm"
              onClick={() => void toolbar().onCreateProject()}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                class="mr-1 h-4 w-4"
              >
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 5v14m-7-7h14"
                />
                <title>New</title>
              </svg>
              New
            </Button>
          </div>
          <MenubarSeparator />
          <div class="max-h-72 overflow-y-auto">
            <For each={toolbar().projects}>
              {(project) => {
                const roomId = project.roomId;
                const isEditing = () => menu().editingProjectId() === roomId;
                const isConfirmingDelete = () =>
                  menu().confirmingProjectId() === roomId;
                const isRenaming = () => menu().renamingProjectId() === roomId;

                return (
                  <Show
                    when={!isEditing() && !isConfirmingDelete()}
                    fallback={
                      <div
                        data-project-rid={roomId}
                        class={cn(
                          "group relative flex w-full items-center justify-between gap-2 pr-12",
                          toolbar().currentRoomId === roomId &&
                            "text-green-400",
                        )}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div class="flex min-w-0 flex-1 items-center gap-2">
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            class="h-4 w-4 text-neutral-400"
                          >
                            <path
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              d="M3 7h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
                            />
                            <title>Project</title>
                          </svg>
                          <Show
                            when={isEditing()}
                            fallback={
                              <span
                                class={cn(
                                  "max-w-56 truncate font-mono text-xs",
                                  toolbar().currentRoomId === roomId
                                    ? "text-green-400"
                                    : "text-neutral-200",
                                )}
                                title={project.name}
                              >
                                {project.name}
                              </span>
                            }
                          >
                            <form
                              class="flex min-w-0 w-full items-center gap-2"
                              onSubmit={async (event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                await menu().confirmProjectRename(roomId);
                              }}
                            >
                              <input
                                data-project-input={roomId}
                                value={menu().editingName()}
                                onInput={(event) => {
                                  menu().stopPropagation(event);
                                  menu().setEditingName(
                                    event.currentTarget.value,
                                  );
                                }}
                                onKeyDown={async (event) => {
                                  menu().stopPropagation(event);
                                  if (
                                    event.key === "Enter" ||
                                    event.code === "Enter" ||
                                    event.code === "NumpadEnter"
                                  ) {
                                    event.preventDefault();
                                    await menu().confirmProjectRename(roomId);
                                    return;
                                  }
                                  if (event.key === "Escape") {
                                    event.preventDefault();
                                    menu().cancelProjectRename();
                                  }
                                }}
                                onKeyUp={menu().stopPropagation}
                                onPointerUp={menu().stopPropagation}
                                onPointerMove={menu().stopPropagation}
                                class="w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1 pr-12 text-xs text-neutral-100 outline-none focus:border-neutral-500"
                                ref={(element) => {
                                  const stopCapture = (event: Event) => {
                                    event.stopPropagation();
                                  };
                                  element.addEventListener(
                                    "pointermove",
                                    stopCapture,
                                    { capture: true },
                                  );
                                  element.addEventListener(
                                    "pointerdown",
                                    stopCapture,
                                    { capture: true },
                                  );
                                  element.addEventListener(
                                    "pointerup",
                                    stopCapture,
                                    { capture: true },
                                  );
                                }}
                              />
                              <div class="shrink-0" />
                              <button
                                type="submit"
                                tabindex={-1}
                                aria-hidden="true"
                                class="hidden"
                              />
                            </form>
                          </Show>
                        </div>
                        <div
                          class="absolute right-2 top-1/2 -translate-y-1/2"
                          data-project-controls
                        >
                          <div
                            class={cn(
                              "absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-1 transition-opacity duration-150",
                              isConfirmingDelete()
                                ? "opacity-100"
                                : "pointer-events-none opacity-0",
                            )}
                          >
                            <button
                              class={cn(
                                "rounded p-1",
                                menu().deletingProjectId() === roomId
                                  ? "cursor-not-allowed text-neutral-400 opacity-60"
                                  : "cursor-pointer text-green-500 hover:text-green-400",
                              )}
                              aria-label={
                                menu().deletingProjectId() === roomId
                                  ? "Deleting…"
                                  : "Confirm delete"
                              }
                              disabled={menu().deletingProjectId() === roomId}
                              onPointerDown={menu().stopMenuPress}
                              onPointerUp={menu().stopMenuPress}
                              onClick={async (event) => {
                                menu().stopMenuPress(event);
                                await menu().confirmProjectDelete(roomId);
                              }}
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
                                <title>Confirm</title>
                              </svg>
                            </button>
                            <button
                              class={cn(
                                "rounded p-1",
                                menu().deletingProjectId() === roomId
                                  ? "cursor-not-allowed text-neutral-400 opacity-60"
                                  : "cursor-pointer text-neutral-400 hover:text-neutral-300",
                              )}
                              aria-label="Cancel delete"
                              disabled={menu().deletingProjectId() === roomId}
                              onPointerDown={menu().stopMenuPress}
                              onPointerUp={menu().stopMenuPress}
                              onClick={(event) => {
                                menu().stopMenuPress(event);
                                menu().setConfirmingProjectId(null);
                              }}
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
                                <title>Cancel</title>
                              </svg>
                            </button>
                          </div>
                          <Show when={isEditing()}>
                            <div class="absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-1">
                              <button
                                class={cn(
                                  "rounded p-1",
                                  isRenaming()
                                    ? "cursor-not-allowed text-neutral-400 opacity-60"
                                    : "cursor-pointer text-green-500 hover:text-green-400",
                                )}
                                aria-label={
                                  isRenaming() ? "Renaming…" : "Confirm rename"
                                }
                                disabled={isRenaming()}
                                onPointerDown={menu().stopMenuPress}
                                onPointerUp={menu().stopMenuPress}
                                onClick={async (event) => {
                                  menu().stopMenuPress(event);
                                  await menu().confirmProjectRename(roomId);
                                }}
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
                                  <title>Confirm</title>
                                </svg>
                              </button>
                              <button
                                class={cn(
                                  "rounded p-1",
                                  isRenaming()
                                    ? "cursor-not-allowed text-neutral-400 opacity-60"
                                    : "cursor-pointer text-neutral-400 hover:text-neutral-300",
                                )}
                                aria-label="Cancel rename"
                                disabled={isRenaming()}
                                onPointerDown={menu().stopMenuPress}
                                onPointerUp={menu().stopMenuPress}
                                onClick={(event) => {
                                  menu().stopMenuPress(event);
                                  menu().cancelProjectRename();
                                }}
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
                                  <title>Cancel</title>
                                </svg>
                              </button>
                            </div>
                          </Show>
                        </div>
                      </div>
                    }
                  >
                    <MenubarItem
                      data-project-rid={roomId}
                      class={cn(
                        "group relative flex w-full cursor-pointer items-center justify-between gap-2 pr-12 hover:bg-neutral-800 hover:text-neutral-100 focus:bg-neutral-800 focus:text-neutral-100 data-[highlighted]:bg-neutral-800 data-[highlighted]:text-neutral-100",
                        toolbar().currentRoomId === roomId && "text-green-400",
                      )}
                      onSelect={() => {
                        menu().setConfirmingProjectId(null);
                        toolbar().onOpenProject(roomId);
                      }}
                    >
                      <div class="flex min-w-0 flex-1 items-center gap-2">
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          class="h-4 w-4 text-neutral-400 group-hover:text-neutral-200"
                        >
                          <path
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M3 7h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
                          />
                          <title>Project</title>
                        </svg>
                        <span
                          class={cn(
                            "max-w-56 truncate font-mono text-xs",
                            toolbar().currentRoomId === roomId
                              ? "text-green-400 group-hover:text-green-300"
                              : "text-neutral-200 group-hover:text-neutral-100",
                          )}
                          title={project.name}
                        >
                          {project.name}
                        </span>
                      </div>
                      <div
                        class="absolute right-2 top-1/2 -translate-y-1/2"
                        data-project-controls
                      >
                        <div class="pointer-events-none flex items-center gap-1 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100">
                          <button
                            class="cursor-pointer p-1 text-neutral-400 hover:text-neutral-200"
                            aria-label="Edit project name"
                            onPointerDown={menu().stopMenuPress}
                            onPointerUp={menu().stopMenuPress}
                            onClick={(event) => {
                              menu().stopMenuPress(event);
                              menu().beginProjectRename(roomId, project.name);
                            }}
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
                                d="M12 20h9"
                              />
                              <path
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"
                              />
                              <title>Edit</title>
                            </svg>
                          </button>
                          <button
                            class="cursor-pointer p-1 text-neutral-400 hover:text-red-500"
                            aria-label="Delete project"
                            onPointerDown={menu().stopMenuPress}
                            onPointerUp={menu().stopMenuPress}
                            onClick={(event) => {
                              menu().stopMenuPress(event);
                              menu().setConfirmingProjectId(roomId);
                            }}
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
                                d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-1 0v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6m3 4v8m4-8v8"
                              />
                              <title>Delete</title>
                            </svg>
                          </button>
                        </div>
                      </div>
                    </MenubarItem>
                  </Show>
                );
              }}
            </For>
            <Show when={toolbar().projects.length === 0}>
              <div class="px-2 py-2 text-xs text-neutral-500">
                No projects yet
              </div>
            </Show>
          </div>
        </div>
      </MenubarContent>
    </MenubarMenu>
  );
};

const ProjectMediaMenu: Component = () => {
  const context = useToolbar();
  const samples = () => context.samplesMenu;
  const exportsMenu = () => context.exportsMenu;
  const hasProjectSamples = () => samples().samples().length > 0;
  const hasDefaultSamples = () => samples().defaultSamples().length > 0;
  const hasExports = () => exportsMenu().exports().length > 0;
  const hasMedia = () =>
    hasProjectSamples() || hasDefaultSamples() || hasExports();

  return (
    <MenubarMenu
      value="media"
      onOpenChange={(open) => {
        samples().onOpenChange(open);
        exportsMenu().onOpenChange(open);
      }}
    >
      <NativeMenuTrigger label="Media" />
      <MenubarContent
        class="w-full border-neutral-800 bg-neutral-900"
        style={{
          width: "min(92vw, 30rem)",
          "pointer-events": samples().isDraggingSample() ? "none" : undefined,
        }}
      >
        <div class="w-full p-2">
          <div class="flex items-center justify-between px-1 pb-2">
            <span class="text-sm font-semibold text-neutral-100">Media</span>
          </div>
          <MenubarSeparator />
          <div class="max-h-80 overflow-x-hidden overflow-y-auto">
            <Show
              when={hasMedia()}
              fallback={
                <div class="px-2 py-2 text-xs text-neutral-500">
                  No media yet
                </div>
              }
            >
              <Show when={hasProjectSamples()}>
                <div class="px-2 pb-2 pt-1 text-xs uppercase tracking-wide text-neutral-500">
                  Samples in Project
                </div>
                <For each={samples().samples()}>
                  {(sample) => {
                    const sampleKey = sample.key;
                    const isConfirming = () =>
                      samples().confirmingSampleKey() === sampleKey;
                    const isDeleting = () =>
                      samples().deletingSampleKey() === sampleKey;
                    const isInserting = () =>
                      samples().insertingSampleKey() === sampleKey;

                    return (
                      <MenubarItem
                        data-sample-key={sampleKey}
                        class="group relative flex w-full cursor-pointer items-center justify-between gap-2 pr-20 hover:bg-neutral-800 hover:text-neutral-100 focus:bg-neutral-800 focus:text-neutral-100 data-[highlighted]:bg-neutral-800 data-[highlighted]:text-neutral-100"
                        onSelect={() => {
                          if (sample.earliestClip) {
                            samples().onJumpToClip(
                              sample.earliestClip.clipId,
                              sample.earliestClip.trackId,
                              sample.earliestClip.startSec,
                            );
                          }
                        }}
                      >
                        <div
                          class="flex min-w-0 flex-1 items-center gap-2"
                          draggable={!!sample.url}
                          onDragStart={(event) =>
                            samples().onStartSampleDrag(event, sample)
                          }
                          onDragEnd={() => samples().setIsDraggingSample(false)}
                        >
                          <Icon
                            name="file-audio"
                            class="h-4 w-4 text-neutral-400 group-hover:text-neutral-200"
                          />
                          <span
                            class="max-w-48 truncate font-mono text-xs text-neutral-200 group-hover:text-neutral-100"
                            title={sample.name}
                          >
                            {sample.name}
                          </span>
                          <span class="shrink-0 text-xs text-neutral-400">
                            x{sample.count}
                          </span>
                        </div>
                        <div class="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                          <button
                            class="cursor-pointer p-1 text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
                            aria-label="Copy sample URL"
                            disabled={!sample.url}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              event.preventDefault();
                            }}
                            onPointerUp={(event) => {
                              event.stopPropagation();
                              event.preventDefault();
                            }}
                            onClick={async (event) => {
                              event.stopPropagation();
                              event.preventDefault();
                              await samples().copyText(sample.url);
                            }}
                          >
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
                              <title>Copy URL</title>
                            </svg>
                          </button>
                          <button
                            class={cn(
                              "cursor-pointer p-1 text-neutral-400 hover:text-neutral-100 disabled:opacity-50",
                              isInserting() && "cursor-not-allowed opacity-60",
                            )}
                            aria-label="Insert sample"
                            disabled={!sample.url || isInserting()}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              event.preventDefault();
                            }}
                            onPointerUp={(event) => {
                              event.stopPropagation();
                              event.preventDefault();
                            }}
                            onClick={async (event) => {
                              event.stopPropagation();
                              event.preventDefault();
                              await samples().onInsertSample(sample);
                            }}
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
                                d="M4 11h16M12 4v16"
                              />
                              <title>Insert</title>
                            </svg>
                          </button>
                          <Show
                            when={isConfirming()}
                            fallback={
                              <button
                                class={cn(
                                  "cursor-pointer p-1",
                                  sample.count > 0
                                    ? "cursor-not-allowed text-neutral-500 opacity-50"
                                    : "text-red-500 hover:text-red-400",
                                )}
                                aria-label={
                                  sample.count > 0
                                    ? "Cannot delete sample in use"
                                    : "Delete sample"
                                }
                                disabled={sample.count > 0}
                                onPointerDown={(event) => {
                                  event.stopPropagation();
                                  event.preventDefault();
                                }}
                                onPointerUp={(event) => {
                                  event.stopPropagation();
                                  event.preventDefault();
                                }}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  event.preventDefault();
                                  if (sample.count === 0) {
                                    samples().setConfirmingSampleKey(sampleKey);
                                  }
                                }}
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
                                    d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-1 0v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6m3 4v8m4-8v8"
                                  />
                                  <title>Delete</title>
                                </svg>
                              </button>
                            }
                          >
                            <div class="flex items-center gap-1">
                              <button
                                class={cn(
                                  "cursor-pointer p-1",
                                  isDeleting()
                                    ? "cursor-not-allowed text-neutral-400 opacity-60"
                                    : "text-green-500 hover:text-green-400",
                                )}
                                aria-label={
                                  isDeleting() ? "Deleting…" : "Confirm delete"
                                }
                                disabled={isDeleting()}
                                onPointerDown={(event) => {
                                  event.stopPropagation();
                                  event.preventDefault();
                                }}
                                onPointerUp={(event) => {
                                  event.stopPropagation();
                                  event.preventDefault();
                                }}
                                onClick={async (event) => {
                                  event.stopPropagation();
                                  event.preventDefault();
                                  await samples().onDeleteSample(sample);
                                }}
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
                                  <title>Confirm</title>
                                </svg>
                              </button>
                              <button
                                class="cursor-pointer p-1 text-neutral-400 hover:text-neutral-300"
                                aria-label="Cancel delete"
                                onPointerDown={(event) => {
                                  event.stopPropagation();
                                  event.preventDefault();
                                }}
                                onPointerUp={(event) => {
                                  event.stopPropagation();
                                  event.preventDefault();
                                }}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  event.preventDefault();
                                  samples().setConfirmingSampleKey(null);
                                }}
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
                                  <title>Cancel</title>
                                </svg>
                              </button>
                            </div>
                          </Show>
                        </div>
                      </MenubarItem>
                    );
                  }}
                </For>
              </Show>
              <Show when={hasDefaultSamples()}>
                <Show when={hasProjectSamples()}>
                  <MenubarSeparator class="my-2" />
                </Show>
                <div class="px-2 pb-2 pt-1 text-xs uppercase tracking-wide text-neutral-500">
                  Default Samples
                </div>
                <For each={samples().defaultSamples()}>
                  {(sample) => {
                    const isInserting = () =>
                      samples().insertingSampleKey() === sample.key;
                    const size = () => samples().formatBytes(sample.sizeBytes);

                    return (
                      <MenubarItem
                        data-sample-key={sample.key}
                        class="group relative flex w-full cursor-pointer items-center justify-between gap-2 pr-16 hover:bg-neutral-800 hover:text-neutral-100 focus:bg-neutral-800 focus:text-neutral-100 data-[highlighted]:bg-neutral-800 data-[highlighted]:text-neutral-100"
                        onSelect={() => {}}
                      >
                        <div
                          class="flex min-w-0 flex-1 items-center gap-2"
                          draggable={!!sample.url}
                          onDragStart={(event) =>
                            samples().onStartSampleDrag(event, sample)
                          }
                          onDragEnd={() => samples().setIsDraggingSample(false)}
                        >
                          <Icon
                            name="file-audio"
                            class="h-4 w-4 text-neutral-400 group-hover:text-neutral-200"
                          />
                          <span
                            class="max-w-48 truncate font-mono text-xs text-neutral-200 group-hover:text-neutral-100"
                            title={sample.name}
                          >
                            {sample.name}
                          </span>
                          <Show when={size()}>
                            <span class="shrink-0 text-xs text-neutral-400">
                              {size()}
                            </span>
                          </Show>
                        </div>
                        <div class="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                          <button
                            class="cursor-pointer p-1 text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
                            aria-label="Copy sample URL"
                            disabled={!sample.url}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              event.preventDefault();
                            }}
                            onPointerUp={(event) => {
                              event.stopPropagation();
                              event.preventDefault();
                            }}
                            onClick={async (event) => {
                              event.stopPropagation();
                              event.preventDefault();
                              await samples().copyText(sample.url);
                            }}
                          >
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
                              <title>Copy URL</title>
                            </svg>
                          </button>
                          <button
                            class={cn(
                              "cursor-pointer p-1 text-neutral-400 hover:text-neutral-100 disabled:opacity-50",
                              isInserting() && "cursor-not-allowed opacity-60",
                            )}
                            aria-label="Insert default sample"
                            disabled={!sample.url || isInserting()}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              event.preventDefault();
                            }}
                            onPointerUp={(event) => {
                              event.stopPropagation();
                              event.preventDefault();
                            }}
                            onClick={async (event) => {
                              event.stopPropagation();
                              event.preventDefault();
                              await samples().onInsertSample(sample);
                            }}
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
                                d="M4 11h16M12 4v16"
                              />
                              <title>Insert</title>
                            </svg>
                          </button>
                        </div>
                      </MenubarItem>
                    );
                  }}
                </For>
              </Show>
              <Show when={hasExports()}>
                <Show when={hasProjectSamples() || hasDefaultSamples()}>
                  <MenubarSeparator class="my-2" />
                </Show>
                <div class="px-2 pb-2 pt-1 text-xs uppercase tracking-wide text-neutral-500">
                  Exports
                </div>
                <For each={exportsMenu().exports()}>
                  {(item) => (
                    <MenubarItem
                      class="group relative flex w-full cursor-pointer items-center justify-between gap-2 pr-12 hover:bg-neutral-800 hover:text-neutral-100 focus:bg-neutral-800 focus:text-neutral-100 data-[highlighted]:bg-neutral-800 data-[highlighted]:text-neutral-100"
                      onSelect={() => {
                        if (item.url) {
                          window.open(item.url, "_blank");
                        }
                      }}
                    >
                      <div class="flex min-w-0 flex-1 items-center gap-2">
                        <Icon
                          name="file-audio"
                          class="h-4 w-4 text-neutral-400 group-hover:text-neutral-200"
                        />
                        <span
                          class="max-w-48 truncate font-mono text-xs text-neutral-200 group-hover:text-neutral-100"
                          title={item.name}
                        >
                          {item.name}
                        </span>
                        <span class="shrink-0 text-xs uppercase text-neutral-400">
                          {item.format}
                        </span>
                      </div>
                      <button
                        class="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer p-1 text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
                        aria-label="Copy export URL"
                        disabled={!item.url}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          event.preventDefault();
                        }}
                        onPointerUp={(event) => {
                          event.stopPropagation();
                          event.preventDefault();
                        }}
                        onClick={async (event) => {
                          event.stopPropagation();
                          event.preventDefault();
                          await exportsMenu().copyText(item.url);
                        }}
                      >
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
                          <title>Copy URL</title>
                        </svg>
                      </button>
                    </MenubarItem>
                  )}
                </For>
              </Show>
            </Show>
          </div>
        </div>
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
          size="sm"
          onClick={transport().onToggleLoop}
          aria-pressed={transport().loopEnabled}
          aria-label="Toggle loop region"
          class={cn(
            nativeMenuTriggerClass,
            transport().loopEnabled && "text-green-400",
          )}
        >
          <Icon name="repeat" class="h-4 w-4" />
          <span class="text-xs">Loop</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={transport().onToggleGrid}
          aria-pressed={transport().gridEnabled}
          aria-label="Toggle snap to grid"
          class={cn(
            nativeMenuTriggerClass,
            transport().gridEnabled && "text-green-400",
          )}
        >
          <Icon name="grid" class="h-4 w-4" />
          <span class="text-xs">Grid</span>
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

const SettingsMenu: Component = () => {
  const context = useToolbar();
  const toolbar = () => context.toolbar;
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
  const currentRoomId = () => props.currentRoomId;
  const currentUserId = () => props.currentUserId;
  const projectsMenu = useProjectsMenuController({
    onDeleteProject: props.onDeleteProject,
    onRenameProject: props.onRenameProject,
  });
  const samplesMenu = useSamplesMenuController({
    currentRoomId,
    currentUserId,
    onInsertSample: props.onInsertSample,
    onJumpToClip: props.onJumpToClip,
  });
  const exportsMenu = useExportsMenuController({
    currentRoomId,
  });
  const shareMenu = useShareMenuController({
    onShare: props.onShare,
    roomId: currentRoomId,
  });
  const tempo = useTransportTempoController({
    bpm: () => props.bpm,
    onChangeBpm: props.onChangeBpm,
  });
  const toolbarContext = {
    toolbar: props,
    projectsMenu,
    samplesMenu,
    exportsMenu,
  };

  return (
    <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-neutral-800 bg-neutral-950 p-2">
      <div class="justify-self-start flex items-center gap-1">
        <ToolbarProvider value={toolbarContext}>
          <Menubar class="flex items-center gap-1">
            <FileMenu />
            <EditMenu />
            <ProjectsMenu />
            <ProjectMediaMenu />
            <SettingsMenu />
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
        </ToolbarProvider>
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
