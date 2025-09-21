import { type Component, Show } from 'solid-js'
import { Link, useNavigate } from '@tanstack/solid-router'
import { authClient } from '~/lib/auth-client'
import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '~/components/ui/dropdown-menu'
import { useSessionQuery } from '~/lib/session'
import { queryClient } from '~/lib/query-client'

const UserInfoDropdown: Component = () => {
  const session = useSessionQuery()
  const navigate = useNavigate()

  const email = () => session()?.data?.user?.email as string | undefined

  async function handleSignOut() {
    try {
      await authClient.signOut()
    } finally {
      // immediately reflect logout in cache
      queryClient.setQueryData(['session'], null)
      // Ensure the auth-guard reruns by navigating to /Login
      navigate({ to: '/Login' })
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <Button variant="outline" size="sm" aria-label="User menu" class="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
            <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 20a6 6 0 0 0-12 0" /><circle cx="12" cy="10" r="4" />
            </g>
            <title>User</title>
          </svg>
          <Show when={email()}>
            {(e) => <span class="max-w-[10rem] truncate hidden sm:inline">{e()}</span>}
          </Show>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent class="w-48 bg-neutral-900">
        <Show when={email()}>
          <DropdownMenuItem class="text-xs text-neutral-400 cursor-default" inset>
            Signed in as <span class="ml-1 text-neutral-200">{email()}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </Show>
        <DropdownMenuItem as={Link} to="/Login" class="text-xs text-neutral-400 cursor-default duration-0">Account</DropdownMenuItem>
        <DropdownMenuItem class="text-xs text-neutral-400 cursor-default duration-0" onSelect={handleSignOut}>Logout</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default UserInfoDropdown
