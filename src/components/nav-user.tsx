import type { Component } from "solid-js"
import { Show, createMemo } from "solid-js"
import { Link, useNavigate } from "@tanstack/solid-router"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "~/components/ui/dropdown-menu"
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar"
import { Button } from "~/components/ui/button"
import Icon from "~/components/ui/Icon"
import { useSessionQuery } from "~/lib/session"
import { authClient } from "~/lib/auth-client"
import { queryClient } from "~/lib/query-client"

export const NavUser: Component = () => {
  const navigate = useNavigate()
  const session = useSessionQuery()
  const user = createMemo(() => session()?.data?.user as any)

  const getInitials = (name: string) => {
    if (!name || name === "Guest") return name.charAt(0).toUpperCase() || "G";
    return name
      .split(' ')
      .map(part => part[0]?.toUpperCase() || '')
      .join('')
      .slice(0, 2) || 'U'
  }

  const handleSignOut = async () => {
    try {
      await authClient.signOut()
    } finally {
      queryClient.setQueryData(["session"], null)
      navigate({ to: "/Login" })
    }
  }

  return (
    <Show
      when={user()?.email}
      fallback={
        <Button as={Link} to="/Login" size="icon" variant="default" aria-label="Sign in">
          <Icon name="log-in" class="h-4 w-4" />
        </Button>
      }
    >
      <DropdownMenu>
        <DropdownMenuTrigger>
          <Button variant="ghost" size="icon" aria-label="User menu" class="hover:bg-neutral-800">
            <Avatar class="h-8 w-8 rounded-lg shrink-0 border border-neutral-800">
              <Show when={user()?.image}>
                <AvatarImage src={(user()?.image as string) || ''} alt={(user()?.name as string) || ''} crossorigin="anonymous" referrerpolicy="no-referrer" />
              </Show>
              <AvatarFallback class="rounded-lg bg-transparent text-xs">
                {getInitials((user()?.name as string) || (user()?.email as string) || "")}
              </AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent class="w-56 bg-neutral-900">
          <DropdownMenuLabel class="p-0">
            <div class="flex items-center gap-2 px-2 py-2 text-left text-sm">
              <Avatar class="h-8 w-8 rounded-lg">
                <Show when={user()?.image}>
                  <AvatarImage src={(user()?.image as string) || ''} alt={(user()?.name as string) || ''} crossorigin="anonymous" referrerpolicy="no-referrer" />
                </Show>
                <AvatarFallback class="rounded-lg text-xs">{getInitials((user()?.name as string) || (user()?.email as string) || "")}</AvatarFallback>
              </Avatar>
              <div class="grid flex-1 text-left text-sm leading-tight min-w-0">
                <span class="truncate font-semibold text-neutral-300">{user()?.name || user()?.email}</span>
                <Show when={user()?.name && user()?.email}>
                  <span class="truncate text-xs text-neutral-400">{user()?.email}</span>
                </Show>
              </div>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem as={Link} to="/Login" class="cursor-pointer text-neutral-200">
            <Icon name="user" class="mr-2 h-4 w-4" />
            Account
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem class="cursor-pointer text-neutral-200" as={Link} to="/about">
            <Icon name="house" class="mr-2 h-4 w-4" />
            About
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem class="cursor-pointer text-neutral-200" onSelect={handleSignOut}>
            <Icon name="log-out" class="mr-2 h-4 w-4" />
            Logout
          </DropdownMenuItem>
          
        </DropdownMenuContent>
      </DropdownMenu>
    </Show>
  )
}