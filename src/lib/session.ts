import { useQuery } from '@tanstack/solid-query'
import { authClient } from '~/lib/auth-client'

type ClientSession = {
  user: {
    id: string
    email?: string
    name?: string
    image?: string | null
  }
  session: Record<string, unknown>
} | null

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

export const normalizeClientSession = (value: unknown): ClientSession => {
  if (!isRecord(value) || !isRecord(value.user) || !isRecord(value.session)) return null

  const { user: rawUser, session } = value
  const { id } = rawUser
  if (typeof id !== 'string' || id.trim() === '') return null

  const user: NonNullable<ClientSession>['user'] = { id }
  if (typeof rawUser.email === 'string') user.email = rawUser.email
  if (typeof rawUser.name === 'string') user.name = rawUser.name
  if (typeof rawUser.image === 'string' || rawUser.image === null) user.image = rawUser.image

  return { user, session }
}

// Fetcher used by both the route guard and components
export async function fetchSession(): Promise<ClientSession> {
  const res = await authClient.getSession()
  return normalizeClientSession(res?.data)
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
