import { createFileRoute, redirect } from '@tanstack/solid-router'
import { Suspense, lazy } from 'solid-js'
import { queryClient } from '~/lib/query-client'
import { fetchSession } from '~/lib/session'

const Timeline = lazy(() => import('~/components/Timeline'))

export const Route = createFileRoute('/')({
  // Use a router-native guard that runs before the component loads
  beforeLoad: async ({ location }) => {
    const session = await queryClient.ensureQueryData({
      queryKey: ['session'],
      queryFn: fetchSession,
      staleTime: 1000 * 60 * 15,
    })
    if (!session) {
      throw redirect({
        to: '/about',
        search: { redirect: location.href },
      })
    }
  },
  component: Index,
})

function Index() {
  return (
    <main class="h-screen w-screen overflow-hidden">
      <Suspense fallback={<div class="flex h-full items-center justify-center text-sm text-neutral-400">Loading studio...</div>}>
        <Timeline />
      </Suspense>
    </main>
  )
}
