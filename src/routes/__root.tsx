import { createRootRoute, Outlet } from '@tanstack/solid-router'
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
  component: () => (
    <>
      <Outlet />
      <TanStackRouterDevtools />
    </>
  ),
})
