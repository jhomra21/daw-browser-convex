import { createEffect, createResource, createSignal, For, Show, type Accessor } from "solid-js";
import { isLocalId } from "@daw-browser/shared";
import { Button } from "~/components/ui/button";
import ProjectDeleteDialog from "~/components/project-delete-dialog";
import ProjectRenameDialog, { type ProjectDialogProject } from "~/components/project-rename-dialog";
import { ProjectSaveStatusBadge } from "~/components/project-save-status-badge";
import { useShareMenuController } from "~/hooks/useShareMenuController";
import { getProjectSaveStatus } from "~/lib/project-save-status";
import { cn } from "~/lib/utils";
import {
  createLocalProject,
  deleteLocalProject,
  listLocalProjects,
  renameLocalProject,
  type LocalProjectEntry,
} from "~/lib/local-project-db";
import { flushLocalProjectPendingWrites } from "~/lib/local-project-pending-writes";
import type { DashboardTimelineModel } from "./types";
import { DashboardRow, DashboardScrollView, DashboardSection, EmptyDashboardState } from "./dashboard-shared";

const formatUpdatedAt = (value: number) => {
  if (!value) return "Never opened";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
};

const getNextUntitledProjectName = (projects: LocalProjectEntry[]) => {
  const names = new Set(projects.map((project) => project.name));
  if (!names.has("Untitled")) return "Untitled";

  let index = 2;
  while (names.has(`Untitled ${index}`)) index += 1;
  return `Untitled ${index}`;
};

type LocalProjectsDashboardViewProps = {
  projects: Accessor<LocalProjectEntry[] | undefined>;
  reloadProjects: () => void;
  onOpenProject: (projectId: string) => void;
};

function LocalProjectsDashboardView(props: LocalProjectsDashboardViewProps) {
  const [busy, setBusy] = createSignal(false);
  const [operationError, setOperationError] = createSignal<string | null>(null);
  const [renamingProject, setRenamingProject] = createSignal<LocalProjectEntry | null>(null);
  const [deletingProject, setDeletingProject] = createSignal<LocalProjectEntry | null>(null);

  const createProject = async () => {
    setOperationError(null);
    setBusy(true);
    try {
      const project = await createLocalProject(getNextUntitledProjectName(props.projects() ?? []));
      props.onOpenProject(project.id);
    } catch {
      setOperationError("This local project could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const renameProject = async (project: ProjectDialogProject, name: string) => {
    setOperationError(null);
    setBusy(true);
    try {
      await renameLocalProject(project.id, name);
      setRenamingProject(null);
      props.reloadProjects();
    } catch {
      setOperationError("This local project could not be renamed.");
    } finally {
      setBusy(false);
    }
  };

  const removeProject = async (project: ProjectDialogProject) => {
    setOperationError(null);
    setBusy(true);
    try {
      await flushLocalProjectPendingWrites(project.id);
      await deleteLocalProject(project.id);
      setDeletingProject(null);
      props.reloadProjects();
    } catch {
      setOperationError("This local project could not be deleted.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div class="flex items-start justify-between gap-4 px-1">
        <div>
          <h2 class="text-2xl font-semibold tracking-tight text-neutral-100">Open a local project</h2>
          <p class="mt-2 text-sm text-neutral-400">
            Create or reopen a browser-local project. Sign-in is not required for local work.
          </p>
        </div>
        <Button onClick={createProject} disabled={busy()}>
          New project
        </Button>
      </div>

      <Show when={operationError()}>
        {(message) => (
          <div class="border border-red-900/70 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {message()}
          </div>
        )}
      </Show>

      <div class="space-y-3">
        <Show
          when={props.projects()}
          fallback={
            <div class="border border-neutral-800 bg-neutral-900/80 p-4 text-sm text-neutral-400">
              Loading local projects...
            </div>
          }
        >
          {(projectList) => (
            <Show
              when={projectList().length > 0}
              fallback={
                <div class="border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-400">
                  No local projects yet.
                </div>
              }
            >
              <For each={projectList()}>
                {(project) => (
                  <article class="flex items-center justify-between gap-4 border border-neutral-800 bg-neutral-900/80 p-4">
                    <button
                      class="min-w-0 flex-1 text-left"
                      type="button"
                      onClick={() => props.onOpenProject(project.id)}
                      disabled={busy()}
                    >
                      <div class="truncate font-medium text-neutral-100">{project.name}</div>
                      <div class="mt-1 text-xs text-neutral-500">
                        Last opened {formatUpdatedAt(project.lastOpenedAt)}
                      </div>
                    </button>
                    <div class="flex shrink-0 gap-2">
                      <Button variant="outline" size="sm" onClick={() => setRenamingProject(project)} disabled={busy()}>
                        Rename
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setDeletingProject(project)} disabled={busy()}>
                        Delete
                      </Button>
                    </div>
                  </article>
                )}
              </For>
            </Show>
          )}
        </Show>
      </div>

      <ProjectRenameDialog
        open={Boolean(renamingProject())}
        project={renamingProject()}
        busy={busy()}
        onOpenChange={(open) => { if (!open) setRenamingProject(null); }}
        onConfirm={(project, name) => { void renameProject(project, name); }}
      />
      <ProjectDeleteDialog
        open={Boolean(deletingProject())}
        project={deletingProject()}
        busy={busy()}
        onOpenChange={(open) => { if (!open) setDeletingProject(null); }}
        onConfirm={(project) => { void removeProject(project); }}
      />
    </>
  );
}

type DashboardProjectsViewProps = {
  model?: DashboardTimelineModel;
  onOpenProject?: (projectId: string) => void;
};

function DashboardProjectSettings(props: { model: DashboardTimelineModel }) {
  const [shareCopied, setShareCopied] = createSignal(false);
  let loadedMembersProjectId = "";
  const projectMenu = () => props.model.projectMenu;
  const currentProject = () =>
    projectMenu().projects.find((project) => project.projectId === projectMenu().currentProjectId);
  const isCurrentProjectLocal = () => isLocalId("project", projectMenu().currentProjectId);
  const currentProjectMode = () => currentProject()?.mode;
  const isBackupProject = () => isCurrentProjectLocal() && currentProjectMode() === "backup";
  const canShareCurrentProject = () =>
    !isCurrentProjectLocal() && projectMenu().canManageSharing;
  const hasSharedOutboxWork = () => Boolean(
    (projectMenu().sharedOutboxStatus?.pending ?? 0) + (projectMenu().sharedOutboxStatus?.failed ?? 0),
  );
  const currentSaveStatus = () => getProjectSaveStatus({
    projectId: projectMenu().currentProjectId,
    userId: projectMenu().currentUserId,
    mode: currentProjectMode(),
    sharedOutboxStatus: projectMenu().sharedOutboxStatus,
    cloudBackupStatus: projectMenu().cloudBackupStatus,
  });
  const shareMenu = useShareMenuController({
    projectId: () => projectMenu().currentProjectId,
    onShare: () => projectMenu().onShare?.(),
  });
  const onShare = async () => {
    setShareCopied(false);
    await shareMenu.createShareUrl();
    setShareCopied(await shareMenu.copy());
  };

  createEffect(() => {
    const projectId = projectMenu().currentProjectId;
    const membersProjectId = canShareCurrentProject() ? projectId : "";
    if (loadedMembersProjectId === membersProjectId) return;
    loadedMembersProjectId = membersProjectId;
    setShareCopied(false);
    shareMenu.reset();
    if (!membersProjectId) return;
    void shareMenu.loadMembers();
  });

  return (
    <DashboardSection title="Project settings" description="Backup, sharing, storage, and sync controls for the current project.">
      <div class="px-1">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-xs uppercase tracking-wide text-neutral-500">Save status</div>
            <div class="mt-1 text-sm font-medium text-neutral-100">{currentSaveStatus().label}</div>
          </div>
          <ProjectSaveStatusBadge
            class="shrink-0"
            label="compact"
            projectId={projectMenu().currentProjectId}
            userId={projectMenu().currentUserId}
            mode={currentProjectMode()}
            sharedOutboxStatus={projectMenu().sharedOutboxStatus}
            cloudBackupStatus={projectMenu().cloudBackupStatus}
          />
        </div>
        <div class="mt-4 grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            size="sm"
            class="justify-center"
            disabled={!isCurrentProjectLocal() || !projectMenu().currentUserId || !projectMenu().onBackUpNow}
            onClick={() => void projectMenu().onBackUpNow?.()}
          >
            Back up now
          </Button>
          <Button
            variant="secondary"
            size="sm"
            class={cn("justify-center", shareCopied() && "border-emerald-700 bg-emerald-950/60 text-emerald-200 hover:bg-emerald-950/70")}
            disabled={!canShareCurrentProject() || !projectMenu().currentUserId || !projectMenu().onShare}
            onClick={() => void onShare()}
          >
            <Show when={shareCopied()} fallback="Copy share link">Copied</Show>
          </Button>
          <Show when={isCurrentProjectLocal() && projectMenu().onChooseProjectFolder}>
            <Button
              variant="secondary"
              size="sm"
              class="col-span-2 justify-center"
              onClick={() => void projectMenu().onChooseProjectFolder?.()}
            >
              Choose storage folder
            </Button>
          </Show>
          <Show when={isBackupProject()}>
            <Button variant="secondary" size="sm" class="justify-center" disabled={!projectMenu().onRestoreCloudBackup} onClick={() => void projectMenu().onRestoreCloudBackup?.()}>
              Restore cloud backup
            </Button>
            <Button variant="secondary" size="sm" class="justify-center" disabled={!projectMenu().onDuplicateCloudBackup} onClick={() => void projectMenu().onDuplicateCloudBackup?.()}>
              Duplicate cloud backup
            </Button>
            <Button variant="secondary" size="sm" class="justify-center" disabled={!projectMenu().onDownloadForOffline} onClick={() => void projectMenu().onDownloadForOffline?.()}>
              Download for offline
            </Button>
            <Button variant="secondary" size="sm" class="justify-center" disabled={!projectMenu().onDisableBackup} onClick={() => void projectMenu().onDisableBackup?.()}>
              Disable backup
            </Button>
          </Show>
          <Show when={!isCurrentProjectLocal() && hasSharedOutboxWork()}>
            <Button variant="secondary" size="sm" class="col-span-2 justify-center" disabled={!projectMenu().onRetrySharedChanges} onClick={() => void projectMenu().onRetrySharedChanges?.()}>
              Retry shared changes
            </Button>
          </Show>
        </div>
        <Show when={canShareCurrentProject()}>
          <div class="mt-4 border-t border-neutral-800 pt-3">
            <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Members</div>
            <Show when={!shareMenu.membersLoading()} fallback={<div class="text-xs text-neutral-500">Loading members...</div>}>
              <Show when={shareMenu.members().length > 0} fallback={<div class="text-xs text-neutral-500">No accepted members yet.</div>}>
                <div class="space-y-2">
                  <For each={shareMenu.members()}>
                    {(member) => (
                      <div class="flex items-center justify-between gap-3 border border-neutral-800 bg-neutral-950/60 px-3 py-2">
                        <div class="min-w-0">
                          <div class="truncate text-xs text-neutral-200">{member.userId}</div>
                          <div class="text-xs capitalize text-neutral-500">{member.role}</div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          class="shrink-0 text-red-300 hover:bg-red-950/40 hover:text-red-200"
                          disabled={shareMenu.revokingMemberId() === member.userId}
                          onClick={() => void shareMenu.revokeMember(member.userId)}
                        >
                          {shareMenu.revokingMemberId() === member.userId ? "Removing..." : "Remove"}
                        </Button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
            <Show when={shareMenu.shareError()}>
              <div class="mt-2 text-xs text-red-300">{shareMenu.shareError()}</div>
            </Show>
            <Show when={shareMenu.membersError()}>
              <div class="mt-2 text-xs text-red-300">{shareMenu.membersError()}</div>
            </Show>
          </div>
        </Show>
      </div>
    </DashboardSection>
  );
}

export function DashboardProjectsView(props: DashboardProjectsViewProps) {
  const [localProjectsReloadToken, setLocalProjectsReloadToken] = createSignal(0);
  const [renamingProject, setRenamingProject] = createSignal<ProjectDialogProject | null>(null);
  const [deletingProject, setDeletingProject] = createSignal<ProjectDialogProject | null>(null);
  const [busyProjectId, setBusyProjectId] = createSignal<string | null>(null);
  const menu = () => props.model?.projectMenu;
  const [localProjects] = createResource(
    () => props.onOpenProject && !menu() ? localProjectsReloadToken() : null,
    listLocalProjects,
  );
  const current = () => menu()?.projects.find((project) => project.projectId === menu()?.currentProjectId);
  const localProjectsView = () => props.onOpenProject
    ? (
      <LocalProjectsDashboardView
        projects={() => localProjects.latest ?? localProjects()}
        reloadProjects={() => setLocalProjectsReloadToken((currentToken) => currentToken + 1)}
        onOpenProject={props.onOpenProject}
      />
    )
    : <EmptyDashboardState title="No project context" message="Open a project to manage project state from the dashboard." />;
  const openDialogProject = (projectId: string, name: string): ProjectDialogProject => ({ id: projectId, name });
  const confirmRename = async (
    projectMenu: DashboardTimelineModel["projectMenu"],
    project: ProjectDialogProject,
    name: string,
  ) => {
    const nextName = name.trim();
    if (!nextName) {
      setRenamingProject(null);
      return;
    }
    setBusyProjectId(project.id);
    try {
      await projectMenu.onRenameProject(project.id, nextName);
      setRenamingProject(null);
    } finally {
      setBusyProjectId(null);
    }
  };
  const confirmDelete = async (
    projectMenu: DashboardTimelineModel["projectMenu"],
    project: ProjectDialogProject,
  ) => {
    setBusyProjectId(project.id);
    try {
      await projectMenu.onDeleteProject(project.id);
      setDeletingProject(null);
    } finally {
      setBusyProjectId(null);
    }
  };

  return (
    <DashboardScrollView>
      <Show when={props.model} fallback={localProjectsView()} keyed>
        {(model) => (
          <>
            <DashboardSection title="Current project">
              <DashboardRow
                label={current()?.name ?? model.projectMenu.currentProjectId}
                value={isLocalId("project", model.projectMenu.currentProjectId) ? "Local project" : "Cloud project"}
              />
            </DashboardSection>
            <DashboardProjectSettings model={model} />
            <DashboardSection title="Projects">
              <div class="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
                <div class="text-xs text-neutral-500">Create, open, rename, or delete projects.</div>
                <Button size="sm" onClick={() => void model.projectMenu.onCreateProject()}>
                  New project
                </Button>
              </div>
              <For each={model.projectMenu.projects}>
                {(project) => (
                  <DashboardRow
                    label={
                      <span class="truncate">{project.name ?? project.projectId}</span>
                    }
                    value={project.mode ?? (isLocalId("project", project.projectId) ? "Local" : "Cloud")}
                    action={
                      <div class="flex shrink-0 gap-2">
                        <Button size="sm" variant="ghost" onClick={() => model.projectMenu.onOpenProject(project.projectId)}>
                          Open
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setRenamingProject(openDialogProject(project.projectId, project.name))}>
                          Rename
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setDeletingProject(openDialogProject(project.projectId, project.name))}>
                          Delete
                        </Button>
                      </div>
                    }
                  />
                )}
              </For>
            </DashboardSection>
            <ProjectRenameDialog
              open={Boolean(renamingProject())}
              project={renamingProject()}
              busy={busyProjectId() === renamingProject()?.id}
              onOpenChange={(open) => { if (!open) setRenamingProject(null); }}
              onConfirm={(project, name) => { void confirmRename(model.projectMenu, project, name); }}
            />
            <ProjectDeleteDialog
              open={Boolean(deletingProject())}
              project={deletingProject()}
              busy={busyProjectId() === deletingProject()?.id}
              onOpenChange={(open) => { if (!open) setDeletingProject(null); }}
              onConfirm={(project) => { void confirmDelete(model.projectMenu, project); }}
            />
          </>
        )}
      </Show>
    </DashboardScrollView>
  );
}
