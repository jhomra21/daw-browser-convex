import { batch, createEffect, createSignal, onMount } from 'solid-js'
import type { Accessor, Setter } from 'solid-js'

import { useConvexQuery, convexClient, convexApi } from '~/lib/convex'
import { useSessionQuery } from '~/lib/session'

type UseTimelineDataReturn = {
  roomId: Accessor<string>
  setRoomId: Setter<string>
  userId: () => string
  myProjects: ReturnType<typeof useConvexQuery>
  fullView: ReturnType<typeof useConvexQuery>
  navigateToRoom: (roomId: string) => void
}

export function useTimelineData(): UseTimelineDataReturn {
  const [roomId, setRoomId] = createSignal<string>('')
  const [ridAutoCreated, setRidAutoCreated] = createSignal(false)
  const pendingEnsureRoomKeys = new Set<string>()

  const session = useSessionQuery()
  const userId = () => (session.data?.user as any)?.id ?? ''

  const navigateToRoom = (rid: string) => {
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('roomId', rid)
      history.pushState(null, '', url.toString())
      setRoomId(rid)
    } catch {
      setRoomId(rid)
    }
  }

  onMount(() => {
    try {
      const url = new URL(window.location.href)
      let rid = url.searchParams.get('roomId')
      if (!rid) {
        rid = crypto.randomUUID()
        url.searchParams.set('roomId', rid)
        history.replaceState(null, '', url.toString())
        batch(() => {
          setRoomId(rid!)
          setRidAutoCreated(true)
        })
      } else {
        const existingRid = rid
        batch(() => {
          setRoomId(existingRid)
          setRidAutoCreated(false)
        })
      }
    } catch {
      batch(() => {
        setRoomId('default')
        setRidAutoCreated(true)
      })
    }
  })

  const myProjects = useConvexQuery(
    convexApi.projects.listMineDetailed,
    () => userId() ? ({ userId: userId() }) : null,
    () => ['my-projects', userId()]
  )

  const fullView = useConvexQuery(
    convexApi.timeline.fullView,
    () => roomId() ? ({ roomId: roomId() }) : null,
    () => ['timeline', roomId()]
  )

  const ensureRoomOwnership = (rid: string, uid: string) => {
    const key = `${uid}:${rid}`
    if (!rid || !uid || pendingEnsureRoomKeys.has(key)) return

    pendingEnsureRoomKeys.add(key)
    void convexClient.mutation(convexApi.projects.ensureOwnedRoom, { roomId: rid, userId: uid })
      .finally(() => {
        pendingEnsureRoomKeys.delete(key)
      })
  }

  createEffect(() => {
    const uid = userId()
    if (!uid) return
    const rid = roomId()
    const projects = myProjects.data

    if (ridAutoCreated()) {
      if (!Array.isArray(projects)) return
      if (projects.length > 0) {
        const target = projects[0]?.roomId
        if (target && target !== rid) {
          navigateToRoom(target)
        }
        setRidAutoCreated(false)
        return
      }

      if (rid) {
        ensureRoomOwnership(rid, uid)
      }
      setRidAutoCreated(false)
      return
    }

    if (rid) {
      ensureRoomOwnership(rid, uid)
    }
  })

  return {
    roomId,
    setRoomId,
    userId,
    myProjects,
    fullView,
    navigateToRoom
  }
}
