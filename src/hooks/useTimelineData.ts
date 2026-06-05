import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { FunctionReturnType } from 'convex/server'
import type { UseQueryResult } from '@tanstack/solid-query'

import { useConvexQuery, convexClient, convexApi } from '~/lib/convex'
import { isLocalId } from '@daw-browser/shared'
import {
  createLocalProject,
  deleteLocalProject,
  type LocalProjectMode,
  listLocalProjects,
  markLocalProjectOpened,
  purgeLocalProjectCache,
  renameLocalProject,
} from '~/lib/local-project-db'
import { flushLocalProjectPendingWrites } from '~/lib/local-project-pending-writes'
import { subscribeToLocalProjectChanges } from '~/lib/local-project-changes'
import { useSessionQuery } from '~/lib/session'
import { cacheRemoteTimelineSnapshot } from '~/lib/remote-timeline-cache'
import { isProjectRole, type ProjectRole } from '@daw-browser/shared'
import { clearShareTokenFromUrl, useTimelineProjectRoute } from './useTimelineProjectRoute'

export type TimelineProject = {
  projectId: string
  name: string
  mode?: LocalProjectMode
}

type DeleteOwnedRoomResult =
  | { status: 'deleted' }
  | { status: 'error' }

type LeaveCloudProjectResult =
  | { status: 'left' }
  | { status: 'error' }

type DeleteCurrentOwnedRoomResult =
  | { status: 'deleted'; destinationProjectId: string }
  | { status: 'error' }

type CreateOwnedRoomResult =
  | { status: 'created' }
  | { status: 'error' }

type EnsureOwnedRoomOptions = {
  showAlertOnError?: boolean
}

type UseTimelineDataInput = {
  notify: (title: string, message: string) => void
}

type UseTimelineDataReturn = {
  projectId: Accessor<string>
  setProjectId: (projectId: string) => void
  userId: () => string
  projects: Accessor<TimelineProject[]>
  currentProjectRole: Accessor<ProjectRole | null>
  fullView: UseQueryResult<FunctionReturnType<typeof convexApi.timeline.fullViewAuthed>, Error>
  navigateToRoom: (projectId: string) => void
  createProject: () => Promise<void>
  renameProject: (projectId: string, name: string) => Promise<void>
  deleteProject: (projectId: string) => Promise<void>
}

const normalizeProjects = (value: unknown): TimelineProject[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((project) => {
    if (!project || typeof project !== 'object') return []
    const projectId = 'projectId' in project && typeof project.projectId === 'string' ? project.projectId : ''
    const name = 'name' in project && typeof project.name === 'string' ? project.name : ''
    if (!projectId || !name) return []
    return [{ projectId, name }]
  })
}

export function useTimelineData(input: UseTimelineDataInput): UseTimelineDataReturn {
  const [localProjects, setLocalProjects] = createSignal<TimelineProject[]>([])
  const pendingOwnedRoomKeys = new Set<string>()

  const session = useSessionQuery()
  const userId = () => session.data?.user.id ?? ''

  const loadLocalProjects = async () => {
    const rows = await listLocalProjects()
    setLocalProjects(rows.map((project) => ({
      projectId: project.id,
      name: project.name,
      mode: project.mode,
    })))
  }

  const route = useTimelineProjectRoute({
    onLocalProjectOpened: (rid) => void markLocalProjectOpened(rid).then(loadLocalProjects),
  })
  const projectId = route.projectId
  const bootstrapProjectId = route.bootstrapProjectId
  const acceptingShareToken = route.acceptingShareToken
  const setAcceptingShareToken = route.setAcceptingShareToken
  const setProjectId = route.setProjectId
  const replaceRoom = route.replaceRoom
  const navigateToRoom = route.navigateToRoom
  const clearBootstrapProjectId = route.clearBootstrapProjectId

  onMount(() => {
    void loadLocalProjects()
  })

  createEffect(() => {
    const rid = projectId()
    if (!isLocalId('project', rid)) return
    const unsubscribe = subscribeToLocalProjectChanges(rid, () => void loadLocalProjects())
    onCleanup(unsubscribe)
  })

  const myProjects = useConvexQuery(
    convexApi.projects.listMineDetailed,
    () => userId() ? ({}) : null,
    () => ['my-projects', userId()]
  )
  const projectsLoaded = createMemo(() => myProjects.status === 'success')
  const projects = createMemo<TimelineProject[]>(() => {
    const byId = new Map<string, TimelineProject>()
    for (const project of normalizeProjects(myProjects.data)) byId.set(project.projectId, project)
    for (const project of localProjects()) byId.set(project.projectId, project)
    return [...byId.values()]
  })
  const hasLocalProject = (rid: string) => localProjects().some((project) => project.projectId === rid)

  const fullView = useConvexQuery(
    convexApi.timeline.fullViewAuthed,
    () => {
      const rid = projectId()
      const uid = userId()
      if (!rid || isLocalId('project', rid) || !uid || bootstrapProjectId() === rid || acceptingShareToken()) return null
      return { projectId: rid }
    },
    () => ['timeline-full-view-authed', projectId(), userId(), bootstrapProjectId(), acceptingShareToken()]
  )

  const projectRole = useConvexQuery(
    convexApi.projectAccess.roleForUser,
    () => {
      const rid = projectId()
      const uid = userId()
      if (!rid || isLocalId('project', rid) || !uid || bootstrapProjectId() === rid || acceptingShareToken()) return null
      return { projectId: rid }
    },
    () => ['timeline-project-role', projectId(), userId(), bootstrapProjectId(), acceptingShareToken()]
  )
  const currentProjectRole = createMemo<ProjectRole | null>(() => (
    isProjectRole(projectRole.data) ? projectRole.data : null
  ))

  createEffect(() => {
    const rid = projectId()
    const data = fullView.data
    if (!rid || isLocalId('project', rid) || !data) return
    void cacheRemoteTimelineSnapshot(rid, data).catch(() => undefined)
  })

  createEffect(() => {
    const token = acceptingShareToken()
    const uid = userId()
    if (!token || !uid) return
    void fetch('/api/share-invites/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Share invite accept failed.')
        return await response.json()
      })
      .then((result) => {
        setAcceptingShareToken(null)
        clearShareTokenFromUrl()
        if (result?.projectId) replaceRoom(result.projectId)
      })
      .catch(() => {
        setAcceptingShareToken(null)
        clearShareTokenFromUrl()
        input.notify('Share link failed', 'This share link could not be accepted.')
      })
  })

  const createOwnedRoom = async (
    rid: string,
    uid: string,
    options?: EnsureOwnedRoomOptions,
  ): Promise<CreateOwnedRoomResult> => {
    const key = `${uid}:${rid}`
    if (!rid || !uid || pendingOwnedRoomKeys.has(key)) {
      return { status: 'error' }
    }

    pendingOwnedRoomKeys.add(key)
    try {
      const response = await fetch('/api/cloud-projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: rid }),
      })
      if (!response.ok) throw new Error('Project create failed')
      return { status: 'created' }
    } catch {
      if (options?.showAlertOnError) {
        input.notify('Project create failed', 'This project could not be created.')
      }
      return { status: 'error' }
    } finally {
      pendingOwnedRoomKeys.delete(key)
    }
  }

  createEffect(() => {
    const uid = userId()
    if (!uid) return
    const bootstrapRid = bootstrapProjectId()
    if (!bootstrapRid) return
    const accessibleProjects = projects()
    const key = `${uid}:${bootstrapRid}`
    if (pendingOwnedRoomKeys.has(key)) return

    if (!projectsLoaded()) return

    if (accessibleProjects.length > 0) {
      const target = accessibleProjects[0]?.projectId
      if (target && target !== projectId()) {
        replaceRoom(target)
      } else {
        clearBootstrapProjectId()
      }
      return
    }

    void createOwnedRoom(bootstrapRid, uid, { showAlertOnError: true }).then((result) => {
      if (bootstrapProjectId() !== bootstrapRid) return
      if (result.status === 'created' && projectId() !== bootstrapRid) {
        replaceRoom(bootstrapRid)
        return
      }
      clearBootstrapProjectId()
    })
  })

  const deleteOwnedRoom = async (
    targetProjectId: string,
    options?: { showAlertOnError?: boolean },
  ): Promise<DeleteOwnedRoomResult> => {
    try {
      const response = await fetch(`/api/cloud-projects/${encodeURIComponent(targetProjectId)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Project delete failed.')
      return { status: 'deleted' as const }
    } catch {
      if (options?.showAlertOnError !== false) {
        input.notify('Project delete failed', 'This project could not be deleted.')
      }
      return { status: 'error' as const }
    }
  }

  const leaveCloudProject = async (
    targetProjectId: string,
  ): Promise<LeaveCloudProjectResult> => {
    try {
      const response = await fetch(`/api/cloud-projects/${encodeURIComponent(targetProjectId)}/access`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Project leave failed.')
      await purgeLocalProjectCache(targetProjectId)
      await loadLocalProjects()
      return { status: 'left' as const }
    } catch {
      input.notify('Project remove failed', 'This project could not be removed from your account.')
      return { status: 'error' as const }
    }
  }

  const navigateAfterAccessLoss = async (targetProjectId: string) => {
    await purgeLocalProjectCache(targetProjectId)
    await loadLocalProjects()
    const destinationProjectId = projects().find((project) => project.projectId !== targetProjectId)?.projectId
    if (destinationProjectId) {
      navigateToRoom(destinationProjectId)
      return
    }
    const replacement = await createLocalProject('Untitled')
    await loadLocalProjects()
    navigateToRoom(replacement.id)
  }

  createEffect(() => {
    if (fullView.status !== 'error') return
    const currentProjectId = projectId()
    if (!currentProjectId || isLocalId('project', currentProjectId)) return
    const error = fullView.error
    const message = error instanceof Error ? error.message : ''
    const lowerMessage = message.toLowerCase()
    if (!lowerMessage.includes('access') && !lowerMessage.includes('permission')) return
    void navigateAfterAccessLoss(currentProjectId)
  })

  const deleteCurrentOwnedRoom = async (
    targetProjectId: string,
    ownerUserId: string,
  ): Promise<DeleteCurrentOwnedRoomResult> => {
    const existingDestination = projects().find((project) => project.projectId !== targetProjectId)?.projectId
    const destinationProjectId = existingDestination ?? crypto.randomUUID()
    let createdDestination = false
    if (!existingDestination) {
      const created = await createOwnedRoom(destinationProjectId, ownerUserId, { showAlertOnError: true })
      if (created.status !== 'created') {
        return { status: 'error' as const }
      }
      createdDestination = true
    }

    const result = await deleteOwnedRoom(targetProjectId)
    if (result.status !== 'deleted') {
      if (createdDestination) {
        await deleteOwnedRoom(destinationProjectId, { showAlertOnError: false })
      }
      return result
    }

    return {
      status: 'deleted' as const,
      destinationProjectId,
    }
  }

  const createProject = async () => {
    const currentProjectId = projectId()
    const ownerUserId = userId()
    if (!ownerUserId || isLocalId('project', currentProjectId)) {
      try {
        const project = await createLocalProject('Untitled')
        await loadLocalProjects()
        navigateToRoom(project.id)
      } catch {
        input.notify('Local project create failed', 'This local project could not be created.')
      }
      return
    }

    const nextProjectId = crypto.randomUUID()
    const result = await createOwnedRoom(nextProjectId, ownerUserId, { showAlertOnError: true })
    if (result.status !== 'created') return
    navigateToRoom(nextProjectId)
  }

  const renameProject = async (targetProjectId: string, name: string) => {
    if (isLocalId('project', targetProjectId)) {
      try {
        await renameLocalProject(targetProjectId, name)
        await loadLocalProjects()
      } catch {
        input.notify('Local project rename failed', 'This local project could not be renamed.')
      }
      return
    }

    const ownerUserId = userId()
    if (!ownerUserId) return
    try {
      await convexClient.mutation(convexApi.projects.setName, {
        projectId: targetProjectId,
        name,
      })
    } catch {
      input.notify('Project rename failed', 'This project could not be renamed.')
    }
  }

  const deleteProject = async (targetProjectId: string) => {
    if (isLocalId('project', targetProjectId) && hasLocalProject(targetProjectId)) {
      try {
        await flushLocalProjectPendingWrites(targetProjectId)
        await deleteLocalProject(targetProjectId)
        await loadLocalProjects()
        if (targetProjectId === projectId()) {
          const replacement = await createLocalProject('Untitled')
          await loadLocalProjects()
          navigateToRoom(replacement.id)
        }
      } catch {
        input.notify('Local project delete failed', 'This local project could not be deleted.')
      }
      return
    }

    const ownerUserId = userId()
    if (!ownerUserId) return

    const canDeleteAsOwner = await convexClient.query(convexApi.projects.canDeleteAsOwner, {
      projectId: targetProjectId,
    }).catch(() => false)
    if (!canDeleteAsOwner) {
      const result = await leaveCloudProject(targetProjectId)
      if (result.status !== 'left' || targetProjectId !== projectId()) return
      const destinationProjectId = projects().find((project) => project.projectId !== targetProjectId)?.projectId
      if (destinationProjectId) {
        navigateToRoom(destinationProjectId)
        return
      }
      const replacement = await createLocalProject('Untitled')
      await loadLocalProjects()
      navigateToRoom(replacement.id)
      return
    }

    if (targetProjectId !== projectId()) {
      await deleteOwnedRoom(targetProjectId)
      return
    }

    const result = await deleteCurrentOwnedRoom(
      targetProjectId,
      ownerUserId,
    )
    if (result.status !== 'deleted') {
      return
    }
    navigateToRoom(result.destinationProjectId)
  }

  return {
    projectId,
    setProjectId,
    userId,
    projects,
    currentProjectRole,
    fullView,
    navigateToRoom,
    createProject,
    renameProject,
    deleteProject,
  }
}
