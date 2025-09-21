import { createFileRoute, redirect } from '@tanstack/solid-router'
import Timeline from '~/components/Timeline'
import { authClient } from '~/lib/auth-client'

export const Route = createFileRoute('/')({
  // Use a router-native guard that runs before the component loads
  beforeLoad: async ({ location }) => {
    try {
      const res = await authClient.getSession()
      if (!res?.data) {
        throw redirect({
          to: '/Login',
          search: { redirect: location.href },
        })
      }
    } catch {
      // On any error fetching the session, be safe and redirect to login
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
