import { useQuery } from '@tanstack/solid-query'
import { authClient } from '~/lib/auth-client'

export type ClientSession = {
  user: {
    id: string
    email?: string
    name?: string
    image?: string | null
    [k: string]: any
  }
  session: Record<string, any>
} | null

// Fetcher used by both the route guard and components
export async function fetchSession() {
  const res = await authClient.getSession()
  return res?.data ?? null
}

export function useSessionQuery() {
  return useQuery<ClientSession>(() => ({
    queryKey: ['session'],
    queryFn: fetchSession,
    staleTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    retry: false,
  }))
}
