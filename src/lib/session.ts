import { useQuery } from '@tanstack/solid-query'
import { authClient } from '~/lib/auth-client'
import { isJsonObject, isJsonString, type JsonObject } from '@daw-browser/shared'
import { z } from 'zod'
import { serializeJsonValue } from '~/lib/json'

type ClientSession = {
  user: {
    id: string
    email?: string
    name?: string
    image?: string | null
  }
  session: JsonObject
} | null

export const normalizeClientSession = <Value>(value: Value): ClientSession => {
  const parsed = z.json().safeParse(value)
  if (!parsed.success || !isJsonObject(parsed.data) || !isJsonObject(parsed.data.user) || !isJsonObject(parsed.data.session)) return null

  const { user: rawUser, session } = parsed.data
  const { id } = rawUser
  if (!isJsonString(id) || id.trim() === '') return null

  const user: NonNullable<ClientSession>['user'] = { id }
  if (isJsonString(rawUser.email)) user.email = rawUser.email
  if (isJsonString(rawUser.name)) user.name = rawUser.name
  if (isJsonString(rawUser.image) || rawUser.image === null) user.image = rawUser.image

  return { user, session }
}

// Fetcher used by both the route guard and components
export async function fetchSession(): Promise<ClientSession> {
  const res = await authClient.getSession()
  return normalizeClientSession(serializeJsonValue(res?.data))
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
