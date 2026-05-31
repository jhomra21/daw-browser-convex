import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import type { Accessor } from 'solid-js'

import { useConvexQuery, convexClient, convexApi } from '~/lib/convex'
import { isLocalId } from '~/lib/local-ids'
import {
  createLocalProject,
  deleteLocalProject,
  type LocalProjectMode,
  listLocalProjects,
  markLocalProjectOpened,
  renameLocalProject,
} from '~/lib/local-project-db'
import { flushLocalProjectPendingWrites } from '~/lib/local-project-pending-writes'
import { subscribeToLocalProjectChanges } from '~/lib/local-project-changes'
import { useSessionQuery } from '~/lib/session'
import { clearShareTokenFromUrl, useTimelineProjectRoute } from './useTimelineProjectRoute'

export type TimelineProject = {
  projectId: string
  name: string
  mode?: LocalProjectMode
}

type DeleteOwnedRoomResult =
  | { status: 'deleted' }
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

type UseTimelineDataReturn = {
  projectId: Accessor<string>
  setProjectId: (projectId: string) => void
  userId: () => string
  projects: Accessor<TimelineProject[]>
  fullView: ReturnType<typeof useConvexQuery>
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

export function useTimelineData(): UseTimelineDataReturn {
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
    () => userId() ? ({ userId: userId() }) : null,
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
    convexApi.timeline.fullView,
    () => {
      const rid = projectId()
      const uid = userId()
      if (!rid || isLocalId('project', rid) || !uid || bootstrapProjectId() === rid || acceptingShareToken()) return null
      return { projectId: rid, userId: uid }
    },
    () => {
      const rid = projectId()
      const uid = userId()
      const bootstrapRid = bootstrapProjectId()
      return ['timeline', rid, uid, bootstrapRid]
    }
  )

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
        window.alert('This share link could not be accepted.')
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
        window.alert('This project could not be created.')
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
        window.alert('This project could not be deleted.')
      }
      return { status: 'error' as const }
    }
  }

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
        window.alert('This local project could not be created.')
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
        window.alert('This local project could not be renamed.')
      }
      return
    }

    const ownerUserId = userId()
    if (!ownerUserId) return
    try {
      await convexClient.mutation(convexApi.projects.setName, {
        projectId: targetProjectId,
        userId: ownerUserId,
        name,
      })
    } catch {
      window.alert('This project could not be renamed.')
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
        window.alert('This local project could not be deleted.')
      }
      return
    }

    const ownerUserId = userId()
    if (!ownerUserId) return

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
    fullView,
    navigateToRoom,
    createProject,
    renameProject,
    deleteProject,
  }
}
