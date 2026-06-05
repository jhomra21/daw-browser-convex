import { createFileRoute } from '@tanstack/solid-router'
import { createSignal, onCleanup, onMount, Suspense, lazy } from 'solid-js'
import LocalProjectPicker from '~/components/LocalProjectPicker'
import { isLocalId } from '@daw-browser/shared'
import { readLocationSearchParam } from '~/lib/location-search-param'
import { markLocalProjectOpened } from '~/lib/local-project-db'
import { useSessionQuery } from '~/lib/session'

const Timeline = lazy(() => import('~/components/Timeline'))

export const Route = createFileRoute('/')({
  component: Index,
})

function Index() {
  const [projectId, setProjectId] = createSignal<string | null>(null)
  const [shareToken, setShareToken] = createSignal<string | null>(null)
  const session = useSessionQuery()

  const readProjectIdFromLocation = () => {
    return readLocationSearchParam('projectId')
  }

  onMount(() => {
    const syncLocationState = () => {
      setProjectId(readProjectIdFromLocation())
      setShareToken(readLocationSearchParam('shareToken'))
    }
    syncLocationState()
    window.addEventListener('popstate', syncLocationState)
    onCleanup(() => {
      window.removeEventListener('popstate', syncLocationState)
    })
  })

  const openProject = (nextProjectId: string) => {
    const url = new URL(window.location.href)
    url.searchParams.set('projectId', nextProjectId)
    url.searchParams.delete('roomId')
    history.pushState(null, '', url.toString())
    setProjectId(nextProjectId)
    void markLocalProjectOpened(nextProjectId)
  }

  const requiresCloudLogin = () => {
    const rid = projectId()
    return Boolean(((rid && !isLocalId('project', rid)) || shareToken()) && session.data === null)
  }

  const loginUrl = () => `/Login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`

  return (
    <main class="h-screen w-screen overflow-hidden">
      {requiresCloudLogin() ? (
        <section class="flex h-full w-full items-center justify-center bg-neutral-950 px-6 text-neutral-100">
          <div class="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900 p-6 shadow-2xl shadow-black/40">
            <h1 class="text-2xl font-semibold tracking-tight">Sign in to open cloud project</h1>
            <p class="mt-2 text-sm text-neutral-400">
              Local projects open without an account. Cloud and shared projects require sign-in.
            </p>
            <a
              class="mt-6 inline-flex h-10 items-center rounded-md bg-neutral-100 px-4 text-sm font-medium text-neutral-950 hover:bg-neutral-200"
              href={loginUrl()}
            >
              Sign in
            </a>
          </div>
        </section>
      ) : projectId() || shareToken() ? (
          <Suspense fallback={<div class="flex h-full items-center justify-center text-sm text-neutral-400">Loading studio...</div>}>
            <Timeline />
          </Suspense>
        ) : (
          <LocalProjectPicker onOpenProject={openProject} />
        )}
    </main>
  )
}
