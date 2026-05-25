import { batch, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import type { Accessor } from 'solid-js'

import { useConvexQuery, convexClient, convexApi } from '~/lib/convex'
import { getProjectDeleteConflictMessage, type DeleteConflictReason } from '~/lib/delete-conflict-messages'
import { isLocalId } from '~/lib/local-ids'
import {
  createLocalProject,
  deleteLocalProject,
  listLocalProjects,
  markLocalProjectOpened,
  renameLocalProject,
} from '~/lib/local-project-db'
import { useSessionQuery } from '~/lib/session'

export type TimelineProject = {
  projectId: string
  name: string
}

type ProjectDeleteConflict = {
  trackId: string
  reason: DeleteConflictReason
}

type DeleteOwnedRoomResult =
  | { status: 'deleted' }
  | { status: 'conflict'; conflictTrackIds: string[]; conflicts: ProjectDeleteConflict[] }
  | { status: 'error' }

type DeleteCurrentOwnedRoomResult =
  | { status: 'deleted'; destinationProjectId: string }
  | { status: 'conflict'; conflictTrackIds: string[]; conflicts: ProjectDeleteConflict[] }
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
  const [projectId, setProjectIdState] = createSignal<string>('')
  const [bootstrapProjectId, setBootstrapProjectId] = createSignal<string | null>(null)
  const [localProjects, setLocalProjects] = createSignal<TimelineProject[]>([])
  const pendingOwnedRoomKeys = new Set<string>()

  const session = useSessionQuery()
  const userId = () => session.data?.user.id ?? ''

  const setProjectId = (nextProjectId: string) => {
    setBootstrapProjectId(null)
    setProjectIdState(nextProjectId)
  }

  const updateRoomUrl = (rid: string, mode: 'push' | 'replace') => {
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('projectId', rid)
      if (mode === 'replace') {
        history.replaceState(null, '', url.toString())
      } else {
        history.pushState(null, '', url.toString())
      }
    } catch {}
  }

  const resolveRoom = (
    rid: string,
    options?: {
      history?: 'push' | 'replace'
      bootstrap?: string | null
    },
  ) => {
    if (options?.history) {
      updateRoomUrl(rid, options.history)
    }
    batch(() => {
      setBootstrapProjectId(options?.bootstrap ?? null)
      setProjectIdState(rid)
    })
  }

  const replaceRoom = (rid: string) => {
    resolveRoom(rid, { history: 'replace' })
  }

  const navigateToRoom = (rid: string) => {
    resolveRoom(rid, { history: 'push' })
    if (isLocalId('project', rid)) void markLocalProjectOpened(rid).then(loadLocalProjects)
  }

  const loadLocalProjects = async () => {
    const rows = await listLocalProjects()
    setLocalProjects(rows.map((project) => ({
      projectId: project.id,
      name: project.name,
    })))
  }

  const readProjectIdFromLocation = () => {
    try {
      const url = new URL(window.location.href)
      const rid = url.searchParams.get('projectId')
      return rid && rid.trim() ? rid : null
    } catch {
      return null
    }
  }

  onMount(() => {
    void loadLocalProjects()
    const syncRoomFromHistory = () => {
      const nextProjectId = readProjectIdFromLocation()
      if (nextProjectId) {
        resolveRoom(nextProjectId)
        return
      }
      const currentProjectId = projectId()
      if (currentProjectId) {
        replaceRoom(currentProjectId)
        return
      }
      const fallbackProjectId = crypto.randomUUID()
      resolveRoom(fallbackProjectId, {
        history: 'replace',
        bootstrap: fallbackProjectId,
      })
    }

    const initialProjectId = readProjectIdFromLocation()
    if (initialProjectId) {
      resolveRoom(initialProjectId)
    } else {
      const generatedProjectId = crypto.randomUUID()
      resolveRoom(generatedProjectId, {
        history: 'replace',
        bootstrap: generatedProjectId,
      })
    }

    window.addEventListener('popstate', syncRoomFromHistory)
    onCleanup(() => {
      window.removeEventListener('popstate', syncRoomFromHistory)
    })
  })

  const myProjects = useConvexQuery(
    convexApi.projects.listMineDetailed,
    () => userId() ? ({ userId: userId() }) : null,
    () => ['my-projects', userId()]
  )
  const projectsLoaded = createMemo(() => myProjects.status === 'success')
  const projects = createMemo<TimelineProject[]>(() => {
    const byId = new Map<string, TimelineProject>()
    for (const project of localProjects()) byId.set(project.projectId, project)
    for (const project of normalizeProjects(myProjects.data)) byId.set(project.projectId, project)
    return [...byId.values()]
  })

  const fullView = useConvexQuery(
    convexApi.timeline.fullView,
    () => {
      const rid = projectId()
      const uid = userId()
      if (!rid || isLocalId('project', rid) || !uid || bootstrapProjectId() === rid) return null
      return { projectId: rid, userId: uid }
    },
    () => {
      const rid = projectId()
      const uid = userId()
      const bootstrapRid = bootstrapProjectId()
      return ['timeline', rid, uid, bootstrapRid]
    }
  )

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
      await convexClient.mutation(convexApi.projects.createOwnedRoom, { projectId: rid, userId: uid })
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
        setBootstrapProjectId(null)
      }
      return
    }

    void createOwnedRoom(bootstrapRid, uid, { showAlertOnError: true }).then((result) => {
      if (bootstrapProjectId() !== bootstrapRid) return
      if (result.status === 'created' && projectId() !== bootstrapRid) {
        replaceRoom(bootstrapRid)
        return
      }
      setBootstrapProjectId(null)
    })
  })

  const showProjectDeleteConflict = (result: { conflicts?: ProjectDeleteConflict[] } | null | undefined) => {
    const conflicts = Array.isArray(result?.conflicts) ? result.conflicts : []
    window.alert(getProjectDeleteConflictMessage(conflicts.map((conflict) => conflict.reason)))
  }

  const deleteOwnedRoom = async (targetProjectId: string, ownerUserId: string): Promise<DeleteOwnedRoomResult> => {
    try {
      const result = await convexClient.mutation(convexApi.projects.deleteOwnedInRoom, {
        projectId: targetProjectId,
        userId: ownerUserId,
      })
      if (result?.status === 'conflict') {
        return result
      }
      return { status: 'deleted' as const }
    } catch {
      window.alert('This project could not be deleted.')
      return { status: 'error' as const }
    }
  }

  const deleteCurrentOwnedRoom = async (
    targetProjectId: string,
    ownerUserId: string,
  ): Promise<DeleteCurrentOwnedRoomResult> => {
    try {
      const result = await convexClient.mutation(convexApi.projects.deleteCurrentOwnedInRoom, {
        projectId: targetProjectId,
        userId: ownerUserId,
      })
      if (result?.status === 'conflict') {
        return result
      }
      return result
    } catch {
      window.alert('This project could not be deleted.')
      return { status: 'error' as const }
    }
  }

  const createProject = async () => {
    const currentProjectId = projectId()
    if (!userId() || isLocalId('project', currentProjectId)) {
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
    const ownerUserId = userId()
    if (!ownerUserId) return
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
    if (isLocalId('project', targetProjectId)) {
      try {
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
      const result = await deleteOwnedRoom(targetProjectId, ownerUserId)
      if (result.status === 'conflict') {
        showProjectDeleteConflict(result)
      }
      return
    }

    const result = await deleteCurrentOwnedRoom(
      targetProjectId,
      ownerUserId,
    )
    if (result.status === 'conflict') {
      showProjectDeleteConflict(result)
      return
    }
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
