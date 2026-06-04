import { createResource, createSignal, For, Show } from 'solid-js'

import { Button } from '~/components/ui/button'
import ProjectDeleteDialog from '~/components/project-delete-dialog'
import ProjectRenameDialog from '~/components/project-rename-dialog'
import {
  createLocalProject,
  deleteLocalProject,
  listLocalProjects,
  renameLocalProject,
  type LocalProjectEntry,
} from '~/lib/local-project-db'
import { flushLocalProjectPendingWrites } from '~/lib/local-project-pending-writes'

type LocalProjectPickerProps = {
  onOpenProject: (projectId: string) => void
}

const formatUpdatedAt = (value: number) => {
  if (!value) return 'Never opened'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

const getNextUntitledProjectName = (projects: LocalProjectEntry[]) => {
  const names = new Set(projects.map((project) => project.name))
  if (!names.has('Untitled')) return 'Untitled'

  let index = 2
  while (names.has(`Untitled ${index}`)) index += 1
  return `Untitled ${index}`
}

export default function LocalProjectPicker(props: LocalProjectPickerProps) {
  const [reloadToken, setReloadToken] = createSignal(0)
  const [projects] = createResource(reloadToken, listLocalProjects)
  const [busy, setBusy] = createSignal(false)
  const [operationError, setOperationError] = createSignal<string | null>(null)
  const [renamingProject, setRenamingProject] = createSignal<LocalProjectEntry | null>(null)
  const [deletingProject, setDeletingProject] = createSignal<LocalProjectEntry | null>(null)

  const reload = () => setReloadToken((current) => current + 1)

  const createProject = async () => {
    setOperationError(null)
    setBusy(true)
    try {
      const project = await createLocalProject(getNextUntitledProjectName(projects() ?? []))
      props.onOpenProject(project.id)
    } catch {
      setOperationError('This local project could not be created.')
    } finally {
      setBusy(false)
    }
  }

  const beginRenameProject = (project: LocalProjectEntry) => {
    setOperationError(null)
    setRenamingProject(project)
  }

  const renameProject = async (project: LocalProjectEntry, name: string) => {
    setOperationError(null)
    setBusy(true)
    try {
      await renameLocalProject(project.id, name)
      setRenamingProject(null)
      reload()
    } catch {
      setOperationError('This local project could not be renamed.')
    } finally {
      setBusy(false)
    }
  }

  const beginRemoveProject = (project: LocalProjectEntry) => {
    setOperationError(null)
    setDeletingProject(project)
  }

  const removeProject = async (project: LocalProjectEntry) => {
    setOperationError(null)
    setBusy(true)
    try {
      await flushLocalProjectPendingWrites(project.id)
      await deleteLocalProject(project.id)
      setDeletingProject(null)
      reload()
    } catch {
      setOperationError('This local project could not be deleted.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section class="flex h-full w-full items-center justify-center bg-neutral-950 px-6 text-neutral-100">
      <div class="w-full max-w-3xl rounded-2xl border border-neutral-800 bg-neutral-900 p-6 shadow-2xl shadow-black/40">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h1 class="text-2xl font-semibold tracking-tight">Open a local project</h1>
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
            <div class="mt-4 rounded-lg border border-red-900/70 bg-red-950/40 px-3 py-2 text-sm text-red-200">
              {message()}
            </div>
          )}
        </Show>

        <div class="mt-6 space-y-3">
          <Show
            when={(projects() ?? []).length > 0}
            fallback={
              <div class="rounded-xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-400">
                No local projects yet.
              </div>
            }
          >
            <For each={projects() ?? []}>
              {(project) => (
                <article class="flex items-center justify-between gap-4 rounded-xl border border-neutral-800 bg-neutral-900/80 p-4">
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
                    <Button variant="outline" size="sm" onClick={() => beginRenameProject(project)} disabled={busy()}>
                      Rename
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => beginRemoveProject(project)} disabled={busy()}>
                      Delete
                    </Button>
                  </div>
                </article>
              )}
            </For>
          </Show>
        </div>
      </div>

      <ProjectRenameDialog
        open={Boolean(renamingProject())}
        project={renamingProject()}
        busy={busy()}
        onOpenChange={(open) => { if (!open) setRenamingProject(null) }}
        onConfirm={(project, name) => { void renameProject(project, name) }}
      />
      <ProjectDeleteDialog
        open={Boolean(deletingProject())}
        project={deletingProject()}
        busy={busy()}
        onOpenChange={(open) => { if (!open) setDeletingProject(null) }}
        onConfirm={(project) => { void removeProject(project) }}
      />
    </section>
  )
}
