import { createResource, createSignal, For, Show } from 'solid-js'

import { Button } from '~/components/ui/button'
import {
  createLocalProject,
  deleteLocalProject,
  listLocalProjects,
  renameLocalProject,
  type LocalProjectEntry,
} from '~/lib/local-project-db'

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

export default function LocalProjectPicker(props: LocalProjectPickerProps) {
  const [reloadToken, setReloadToken] = createSignal(0)
  const [projects] = createResource(reloadToken, listLocalProjects)
  const [busy, setBusy] = createSignal(false)

  const reload = () => setReloadToken((current) => current + 1)

  const createProject = async () => {
    const name = window.prompt('Project name', 'Untitled')
    if (name === null) return
    setBusy(true)
    try {
      const project = await createLocalProject(name)
      props.onOpenProject(project.id)
    } catch {
      window.alert('This local project could not be created.')
    } finally {
      setBusy(false)
    }
  }

  const renameProject = async (project: LocalProjectEntry) => {
    const name = window.prompt('Project name', project.name)
    if (name === null) return
    setBusy(true)
    try {
      await renameLocalProject(project.id, name)
      reload()
    } catch {
      window.alert('This local project could not be renamed.')
    } finally {
      setBusy(false)
    }
  }

  const removeProject = async (project: LocalProjectEntry) => {
    const confirmation = window.prompt(`Type "${project.name}" to delete this local project.`)
    if (confirmation !== project.name) return
    setBusy(true)
    try {
      await deleteLocalProject(project.id)
      reload()
    } catch {
      window.alert('This local project could not be deleted.')
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
                    <Button variant="outline" size="sm" onClick={() => renameProject(project)} disabled={busy()}>
                      Rename
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => removeProject(project)} disabled={busy()}>
                      Delete
                    </Button>
                  </div>
                </article>
              )}
            </For>
          </Show>
        </div>
      </div>
    </section>
  )
}
