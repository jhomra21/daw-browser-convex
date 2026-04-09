import { batch, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import type { Accessor } from 'solid-js'

import { useConvexQuery, convexClient, convexApi } from '~/lib/convex'
import { getProjectDeleteConflictMessage, type DeleteConflictReason } from '~/lib/delete-conflict-messages'
import { useSessionQuery } from '~/lib/session'

export type TimelineProject = {
  roomId: string
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
  | { status: 'deleted'; destinationRoomId: string }
  | { status: 'conflict'; conflictTrackIds: string[]; conflicts: ProjectDeleteConflict[] }
  | { status: 'error' }

type CreateOwnedRoomResult =
  | { status: 'created' }
  | { status: 'error' }

type EnsureOwnedRoomOptions = {
  showAlertOnError?: boolean
}

type UseTimelineDataReturn = {
  roomId: Accessor<string>
  setRoomId: (roomId: string) => void
  userId: () => string
  projects: Accessor<TimelineProject[]>
  fullView: ReturnType<typeof useConvexQuery>
  navigateToRoom: (roomId: string) => void
  createProject: () => Promise<void>
  renameProject: (roomId: string, name: string) => Promise<void>
  deleteProject: (roomId: string) => Promise<void>
}

const normalizeProjects = (value: unknown): TimelineProject[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((project) => {
    if (!project || typeof project !== 'object') return []
    const roomId = 'roomId' in project && typeof project.roomId === 'string' ? project.roomId : ''
    const name = 'name' in project && typeof project.name === 'string' ? project.name : ''
    if (!roomId || !name) return []
    return [{ roomId, name }]
  })
}

export function useTimelineData(): UseTimelineDataReturn {
  const [roomId, setRoomIdState] = createSignal<string>('')
  const [bootstrapRoomId, setBootstrapRoomId] = createSignal<string | null>(null)
  const pendingOwnedRoomKeys = new Set<string>()

  const session = useSessionQuery()
  const userId = () => session.data?.user.id ?? ''

  const setRoomId = (nextRoomId: string) => {
    setBootstrapRoomId(null)
    setRoomIdState(nextRoomId)
  }

  const updateRoomUrl = (rid: string, mode: 'push' | 'replace') => {
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('roomId', rid)
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
      setBootstrapRoomId(options?.bootstrap ?? null)
      setRoomIdState(rid)
    })
  }

  const replaceRoom = (rid: string) => {
    resolveRoom(rid, { history: 'replace' })
  }

  const navigateToRoom = (rid: string) => {
    resolveRoom(rid, { history: 'push' })
  }

  const readRoomIdFromLocation = () => {
    try {
      const url = new URL(window.location.href)
      const rid = url.searchParams.get('roomId')
      return rid && rid.trim() ? rid : null
    } catch {
      return null
    }
  }

  onMount(() => {
    const syncRoomFromHistory = () => {
      const nextRoomId = readRoomIdFromLocation()
      if (nextRoomId) {
        resolveRoom(nextRoomId)
        return
      }
      const currentRoomId = roomId()
      if (currentRoomId) {
        replaceRoom(currentRoomId)
        return
      }
      const fallbackRoomId = crypto.randomUUID()
      resolveRoom(fallbackRoomId, {
        history: 'replace',
        bootstrap: fallbackRoomId,
      })
    }

    const initialRoomId = readRoomIdFromLocation()
    if (initialRoomId) {
      resolveRoom(initialRoomId)
    } else {
      const generatedRoomId = crypto.randomUUID()
      resolveRoom(generatedRoomId, {
        history: 'replace',
        bootstrap: generatedRoomId,
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
    return normalizeProjects(myProjects.data)
  })

  const fullView = useConvexQuery(
    convexApi.timeline.fullView,
    () => roomId() ? ({ roomId: roomId() }) : null,
    () => ['timeline', roomId()]
  )

  const ensureOwnedRoom = async (
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
      await convexClient.mutation(convexApi.projects.ensureOwnedRoom, { roomId: rid, userId: uid })
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
    const bootstrapRid = bootstrapRoomId()
    if (!bootstrapRid) return
    const accessibleProjects = projects()
    const key = `${uid}:${bootstrapRid}`
    if (pendingOwnedRoomKeys.has(key)) return

    if (!projectsLoaded()) return

    if (accessibleProjects.length > 0) {
      const target = accessibleProjects[0]?.roomId
      if (target && target !== roomId()) {
        replaceRoom(target)
      } else {
        setBootstrapRoomId(null)
      }
      return
    }

    void ensureOwnedRoom(bootstrapRid, uid, { showAlertOnError: true }).then((result) => {
      if (bootstrapRoomId() !== bootstrapRid) return
      if (result.status === 'created' && roomId() !== bootstrapRid) {
        replaceRoom(bootstrapRid)
        return
      }
      setBootstrapRoomId(null)
    })
  })

  createEffect(() => {
    const uid = userId()
    const rid = roomId()
    if (!uid || !rid) return
    if (bootstrapRoomId() === rid) return
    void ensureOwnedRoom(rid, uid)
  })

  const showProjectDeleteConflict = (result: { conflicts?: ProjectDeleteConflict[] } | null | undefined) => {
    const conflicts = Array.isArray(result?.conflicts) ? result.conflicts : []
    window.alert(getProjectDeleteConflictMessage(conflicts.map((conflict) => conflict.reason)))
  }

  const deleteOwnedRoom = async (targetRoomId: string, ownerUserId: string): Promise<DeleteOwnedRoomResult> => {
    try {
      const result = await convexClient.mutation(convexApi.projects.deleteOwnedInRoom, {
        roomId: targetRoomId,
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
    targetRoomId: string,
    ownerUserId: string,
  ): Promise<DeleteCurrentOwnedRoomResult> => {
    try {
      const result = await convexClient.mutation(convexApi.projects.deleteCurrentOwnedInRoom, {
        roomId: targetRoomId,
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
    const nextRoomId = crypto.randomUUID()
    const ownerUserId = userId()
    if (!ownerUserId) return
    const result = await ensureOwnedRoom(nextRoomId, ownerUserId, { showAlertOnError: true })
    if (result.status !== 'created') return
    navigateToRoom(nextRoomId)
  }

  const renameProject = async (targetRoomId: string, name: string) => {
    const ownerUserId = userId()
    if (!ownerUserId) return
    try {
      await convexClient.mutation(convexApi.projects.setName, {
        roomId: targetRoomId,
        userId: ownerUserId,
        name,
      })
    } catch {
      window.alert('This project could not be renamed.')
    }
  }

  const deleteProject = async (targetRoomId: string) => {
    const ownerUserId = userId()
    if (!ownerUserId) return

    if (targetRoomId !== roomId()) {
      const result = await deleteOwnedRoom(targetRoomId, ownerUserId)
      if (result.status === 'conflict') {
        showProjectDeleteConflict(result)
      }
      return
    }

    const result = await deleteCurrentOwnedRoom(
      targetRoomId,
      ownerUserId,
    )
    if (result.status === 'conflict') {
      showProjectDeleteConflict(result)
      return
    }
    if (result.status !== 'deleted') {
      return
    }
    navigateToRoom(result.destinationRoomId)
  }

  return {
    roomId,
    setRoomId,
    userId,
    projects,
    fullView,
    navigateToRoom,
    createProject,
    renameProject,
    deleteProject,
  }
}
