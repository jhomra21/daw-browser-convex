import { createRootRoute, Outlet, HeadContent } from '@tanstack/solid-router'
import { TanStackRouterDevtools } from '@tanstack/solid-router-devtools'

export const Route = createRootRoute({
  errorComponent: (props: any) => (
    <div class="p-4 text-red-500">
      <h2 class="text-lg font-semibold">Something went wrong</h2>
      <pre class="mt-2 whitespace-pre-wrap text-sm">
        {String(props?.error?.message ?? props?.error ?? 'Unknown error')}
      </pre>
    </div>
  ),
  head: () => ({
    meta: [
      { title: 'Realtime Collaborative DAW - Convex, Solid, TanStack, MediaBunny' },
    ],
    links: [
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml', sizes: 'any' },
    ],
  }),
  component: () => (
    <>
      <HeadContent />
      <Outlet />
      <TanStackRouterDevtools />
    </>
  ),
})
