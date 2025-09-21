import { createFileRoute, redirect } from '@tanstack/solid-router'
import Timeline from '~/components/Timeline'
import { queryClient } from '~/lib/query-client'
import { fetchSession } from '~/lib/session'

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
        to: '/Login',
        search: { redirect: location.href },
      })
    }
  },
  component: Index,
})

function Index() {
  return (
    <main class="h-screen w-screen overflow-hidden">
      <Timeline />
    </main>
  )
}
