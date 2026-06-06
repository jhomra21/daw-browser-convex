import { type Component, createEffect, createSignal, For, Show } from "solid-js";
import { Button } from "~/components/ui/button";
import { MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator } from "~/components/ui/menubar";
import { copyText } from "~/lib/clipboard";
import { isLocalId } from "@daw-browser/shared";
import { cn } from "~/lib/utils";
import type { ProjectsMenuController } from "~/hooks/useProjectsMenuController";
import { NativeMenuTrigger } from "./toolbar-context";
import type { TimelineProjectMenuModel } from "./transport-types";

type ProjectsMenuProps = {
  projectMenu: TimelineProjectMenuModel;
  menu: ProjectsMenuController;
};

export const ProjectsMenu: Component<ProjectsMenuProps> = (props) => {
  const [shareCopied, setShareCopied] = createSignal(false);
  const menu = () => props.menu;
  const projectMenu = () => props.projectMenu;
  const currentProject = () =>
    projectMenu().projects.find((project) => project.projectId === projectMenu().currentProjectId);
  const isCurrentProjectLocal = () =>
    isLocalId("project", projectMenu().currentProjectId);
  const currentProjectMode = () => currentProject()?.mode;
  const isBackupProject = () => isCurrentProjectLocal() && currentProjectMode() === "backup";
  const canShareCurrentProject = () =>
    !isCurrentProjectLocal() && projectMenu().canManageSharing;
  const shareDisabledTitle = () => (
    isCurrentProjectLocal() ? "Open a cloud/shared project to copy an invite link" : "Only project owners can copy invite links"
  );
  const hasSharedOutboxWork = () => Boolean((projectMenu().sharedOutboxStatus?.pending ?? 0) + (projectMenu().sharedOutboxStatus?.failed ?? 0));
  const backupSaveLabel = () => {
    if (!isBackupProject()) return null;
    if (projectMenu().cloudBackupStatus === "backing-up") return "Backing up to cloud";
    if (projectMenu().cloudBackupStatus === "backed-up") return "Backed up to cloud";
    if (projectMenu().cloudBackupStatus === "failed") return "Cloud backup failed";
    return "Cloud backup enabled";
  };
  const currentSaveLabel = () =>
    hasSharedOutboxWork()
      ? `${projectMenu().sharedOutboxStatus?.pending ?? 0} shared change${(projectMenu().sharedOutboxStatus?.pending ?? 0) === 1 ? "" : "s"} pending, ${projectMenu().sharedOutboxStatus?.failed ?? 0} failed`
      : backupSaveLabel()
        ?? (isCurrentProjectLocal()
      ? "Saved locally on this device"
      : projectMenu().currentUserId
        ? "Saved to cloud project"
        : "Sign in to sync this project");
  const onShare = async () => {
    setShareCopied(false);
    const shareUrl = await projectMenu().onShare?.();
    if (!shareUrl) return;
    await copyText(shareUrl);
    setShareCopied(true);
  };

  createEffect(() => {
    projectMenu().currentProjectId;
    setShareCopied(false);
  });

  return (
    <MenubarMenu value="project">
      <NativeMenuTrigger label="Project" />
      <MenubarContent
        class="w-full border-neutral-800 bg-neutral-900"
        style={{ width: "min(92vw, 24rem)" }}
      >
        <div class="w-full p-2">
          <div class="mb-2 rounded-lg border border-neutral-800 bg-neutral-950/80 p-3">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-xs uppercase tracking-wide text-neutral-500">
                  Save status
                </div>
                <div class="mt-1 text-sm font-medium text-neutral-100">
                  {currentSaveLabel()}
                </div>
              </div>
              <span
                class={cn(
                  "shrink-0 rounded-full border px-2 py-1 text-[11px] font-medium",
                  isCurrentProjectLocal()
                    ? "border-emerald-900/70 bg-emerald-950/40 text-emerald-300"
                    : projectMenu().currentUserId
                      ? "border-sky-900/70 bg-sky-950/40 text-sky-300"
                      : "border-amber-900/70 bg-amber-950/40 text-amber-300",
                )}
              >
                {isCurrentProjectLocal() ? "Local" : "Cloud"}
              </span>
            </div>
            <div class="mt-3 grid grid-cols-2 gap-2">
              <Button
                variant="secondary"
                size="sm"
                class="justify-center"
                onClick={projectMenu().onOpenExport}
              >
                Export audio
              </Button>
              <Button
                variant="secondary"
                size="sm"
                class="justify-center"
                disabled={!isCurrentProjectLocal() || !projectMenu().currentUserId || !projectMenu().onBackUpNow}
                onClick={() => void projectMenu().onBackUpNow?.()}
                title={
                  !isCurrentProjectLocal()
                    ? "Back up local projects from this button"
                    : projectMenu().currentUserId
                    ? "Back up this project to the cloud"
                    : "Sign in to enable backup and share"
                }
              >
                Back up now
              </Button>
              <Button
                variant="secondary"
                size="sm"
                class={cn(
                  "justify-center",
                  shareCopied() && "border-emerald-700 bg-emerald-950/60 text-emerald-200 hover:bg-emerald-950/70",
                )}
                disabled={!canShareCurrentProject() || !projectMenu().currentUserId || !projectMenu().onShare}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  void onShare();
                }}
                title={!canShareCurrentProject() ? shareDisabledTitle() : undefined}
              >
                <Show when={shareCopied()} fallback="Copy share link">
                  Copied
                </Show>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                class="justify-center"
                disabled={!isCurrentProjectLocal() || !projectMenu().onExportArchive}
                onClick={() => void projectMenu().onExportArchive?.()}
                title={!isCurrentProjectLocal() ? "Export local projects as .dawproject archives" : undefined}
              >
                Export .dawproject
              </Button>
              <Button
                variant="secondary"
                size="sm"
                class="justify-center"
                onClick={() => void projectMenu().onImportArchive?.()}
              >
                Import .dawproject
              </Button>
              <Show when={isCurrentProjectLocal() && projectMenu().onChooseProjectFolder}>
                <Button
                  variant="secondary"
                  size="sm"
                  class="col-span-2 justify-center"
                  onClick={() => void projectMenu().onChooseProjectFolder?.()}
                  title="Choose or regrant a local project storage folder"
                >
                  Choose storage folder
                </Button>
              </Show>
              <Show when={isBackupProject()}>
                <Button
                  variant="secondary"
                  size="sm"
                  class="justify-center"
                  disabled={!projectMenu().onRestoreCloudBackup}
                  onClick={() => void projectMenu().onRestoreCloudBackup?.()}
                >
                  Restore cloud backup
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  class="justify-center"
                  disabled={!projectMenu().onDuplicateCloudBackup}
                  onClick={() => void projectMenu().onDuplicateCloudBackup?.()}
                >
                  Duplicate cloud backup
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  class="justify-center"
                  disabled={!projectMenu().onDownloadForOffline}
                  onClick={() => void projectMenu().onDownloadForOffline?.()}
                >
                  Download for offline
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  class="justify-center"
                  disabled={!projectMenu().onDisableBackup}
                  onClick={() => void projectMenu().onDisableBackup?.()}
                >
                  Disable backup
                </Button>
              </Show>
              <Show when={!isCurrentProjectLocal() && hasSharedOutboxWork()}>
                <Button
                  variant="secondary"
                  size="sm"
                  class="col-span-2 justify-center"
                  disabled={!projectMenu().onRetrySharedChanges}
                  onClick={() => void projectMenu().onRetrySharedChanges?.()}
                >
                  Retry shared changes
                </Button>
              </Show>
            </div>
          </div>
          <div class="flex items-center justify-between px-1 pb-2">
            <span class="text-sm font-semibold text-neutral-100">
              My Projects
            </span>
            <Button
              variant="default"
              class="text-neutral-100"
              size="sm"
              onClick={() => void projectMenu().onCreateProject()}
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
            <For each={projectMenu().projects}>
              {(project) => {
                const projectId = project.projectId;
                const isEditing = () => menu().editingProjectId() === projectId;
                const isConfirmingDelete = () =>
                  menu().confirmingProjectId() === projectId;
                const isRenaming = () => menu().renamingProjectId() === projectId;

                return (
                  <Show
                    when={!isEditing() && !isConfirmingDelete()}
                    fallback={
                      <div
                        data-project-rid={projectId}
                        class={cn(
                          "group relative flex w-full items-center justify-between gap-2 pr-12",
                          projectMenu().currentProjectId === projectId &&
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
                                  projectMenu().currentProjectId === projectId
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
                                await menu().confirmProjectRename(projectId);
                              }}
                            >
                              <input
                                data-project-input={projectId}
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
                                    await menu().confirmProjectRename(projectId);
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
                                menu().deletingProjectId() === projectId
                                  ? "cursor-not-allowed text-neutral-400 opacity-60"
                                  : "cursor-pointer text-green-500 hover:text-green-400",
                              )}
                              aria-label={
                                menu().deletingProjectId() === projectId
                                  ? "Deleting…"
                                  : "Confirm delete"
                              }
                              disabled={menu().deletingProjectId() === projectId}
                              onPointerDown={menu().stopMenuPress}
                              onPointerUp={menu().stopMenuPress}
                              onClick={async (event) => {
                                menu().stopMenuPress(event);
                                await menu().confirmProjectDelete(projectId);
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
                                menu().deletingProjectId() === projectId
                                  ? "cursor-not-allowed text-neutral-400 opacity-60"
                                  : "cursor-pointer text-neutral-400 hover:text-neutral-300",
                              )}
                              aria-label="Cancel delete"
                              disabled={menu().deletingProjectId() === projectId}
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
                                  await menu().confirmProjectRename(projectId);
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
                      data-project-rid={projectId}
                      class={cn(
                        "group relative flex w-full cursor-pointer items-center justify-between gap-2 pr-12 hover:bg-neutral-800 hover:text-neutral-100 focus:bg-neutral-800 focus:text-neutral-100 data-[highlighted]:bg-neutral-800 data-[highlighted]:text-neutral-100",
                        projectMenu().currentProjectId === projectId && "text-green-400",
                      )}
                      onSelect={() => {
                        menu().setConfirmingProjectId(null);
                        projectMenu().onOpenProject(projectId);
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
                            projectMenu().currentProjectId === projectId
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
                              menu().beginProjectRename(projectId, project.name);
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
                              menu().setConfirmingProjectId(projectId);
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
            <Show when={projectMenu().projects.length === 0}>
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
