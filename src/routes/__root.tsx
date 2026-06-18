import { createRootRoute, Outlet, HeadContent } from '@tanstack/solid-router'
import { ErrorBoundary, Suspense, lazy } from 'solid-js'

const TanStackRouterDevtools = import.meta.env.DEV
  ? lazy(() => import('@tanstack/solid-router-devtools').then((mod) => ({ default: mod.TanStackRouterDevtools })))
  : null

const isChunkLoadError = (error: unknown) => {
  if (!(error instanceof Error)) return false
  return /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError/i.test(error.message)
}

const AppErrorFallback = (props: { error: unknown }) => (
  <div class="flex min-h-screen items-center justify-center bg-neutral-950 p-6 text-neutral-100">
    <div class="max-w-md border border-neutral-800 bg-neutral-900 p-5 shadow-2xl shadow-black/40">
      <h2 class="text-lg font-semibold">
        {isChunkLoadError(props.error) ? 'Connection needed to finish loading' : 'Something went wrong'}
      </h2>
      <p class="mt-2 text-sm text-neutral-400">
        {isChunkLoadError(props.error)
          ? 'This part of the app was not cached yet. Reconnect, then reload once to finish updating the local app shell.'
          : String(props.error instanceof Error ? props.error.message : props.error)}
      </p>
    </div>
  </div>
)

export const Route = createRootRoute({
  errorComponent: (props) => <AppErrorFallback error={props.error} />,
  head: () => ({
    meta: [
      { title: 'Browser DAW - Convex, Better-Auth, Solid, TanStack, MediaBunny' },
    ],
    links: [
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml', sizes: 'any' },
    ],
  }),
  component: () => (
    <>
      <HeadContent />
      <ErrorBoundary fallback={(error) => <AppErrorFallback error={error} />}>
        <Outlet />
      </ErrorBoundary>
      <Suspense fallback={null}>
        {TanStackRouterDevtools ? <TanStackRouterDevtools /> : null}
      </Suspense>
    </>
  ),
})
