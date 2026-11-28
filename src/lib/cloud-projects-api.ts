import { isJsonObject, isJsonString, parseJsonValue, type JsonValueInput } from '@daw-browser/shared'

// The worker's cloud project, share invite and member endpoints. Each function throws when the request fails.

type ProjectMember = {
  userId: string
  role: 'editor' | 'viewer'
}

const projectPath = (projectId: string) => `/api/cloud-projects/${encodeURIComponent(projectId)}`

const postJson = (url: string, body: JsonValueInput) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const readMembers = (value: JsonValueInput): ProjectMember[] | null => {
  const parsed = parseJsonValue(value)

  if (!isJsonObject(parsed) || !Array.isArray(parsed.members)) return null

  return parsed.members.flatMap((member): ProjectMember[] => {
    if (!isJsonObject(member) || !isJsonString(member.userId)) return []

    if (member.role !== 'editor' && member.role !== 'viewer') return []

    return [{ userId: member.userId, role: member.role }]
  })
}

export const createCloudProject = async (projectId: string): Promise<void> => {
  if (!(await postJson('/api/cloud-projects', { projectId })).ok) throw new Error('Project create failed')
}

export const deleteCloudProject = async (projectId: string): Promise<void> => {
  if (!(await fetch(projectPath(projectId), { method: 'DELETE' })).ok) throw new Error('Project delete failed.')
}

export const revokeCloudProjectAccess = async (projectId: string): Promise<void> => {
  if (!(await fetch(`${projectPath(projectId)}/access`, { method: 'DELETE' })).ok) throw new Error('Project leave failed.')
}

// Resolves to the project the invite grants access to, when the response names one.
export const acceptShareInvite = async (token: string): Promise<string | undefined> => {
  const response = await postJson('/api/share-invites/accept', { token })

  if (!response.ok) throw new Error('Share invite accept failed.')
  const result = parseJsonValue(await response.json())

  return isJsonObject(result) && isJsonString(result.projectId) && result.projectId ? result.projectId : undefined
}

// Resolves to the invite token, when the response carries one.
export const createViewerShareInvite = async (projectId: string): Promise<string | undefined> => {
  const response = await postJson('/api/share-invites', { projectId, role: 'viewer' })

  if (!response.ok) throw new Error('Failed to create share invite.')
  const result = parseJsonValue(await response.json())

  return isJsonObject(result) && isJsonString(result.token) ? result.token : undefined
}

export const listProjectMembers = async (projectId: string): Promise<ProjectMember[]> => {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`)
  const members = readMembers(await response.json().catch(() => null))

  if (!response.ok || !members) throw new Error('Members could not be loaded.')

  return members
}

export const revokeProjectMember = async (projectId: string, userId: string): Promise<void> => {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' })

  if (!response.ok) throw new Error('Member could not be removed.')
}
