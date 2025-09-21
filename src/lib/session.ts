import { useQuery } from '@tanstack/solid-query'
import { createMemo } from 'solid-js'
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

function read<T>(v: unknown): T | undefined {
  return typeof v === 'function' ? (v as any)() : (v as any)
}

// Solid-friendly wrapper that mimics authClient.useSession() shape
// so existing usages like `session()?.data` still work with minimal changes.
export function useSessionQuery() {
  const q = useQuery<ClientSession>(() => ({
    queryKey: ['session'],
    queryFn: fetchSession,
    staleTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    retry: false,
  }))

  // Return an accessor to an object with plain values, not accessors,
  // to mirror the shape of authClient.useSession().
  return createMemo(() => ({
    data: read<ClientSession>(q.data),
    isLoading: !!read(q.isLoading),
    error: (read(q.error) as Error | null) ?? null,
    refetch: q.refetch,
  }))
}
