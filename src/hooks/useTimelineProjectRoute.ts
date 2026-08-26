import { batch, createSignal, onCleanup, onMount } from 'solid-js'
import { isLocalId } from '@daw-browser/shared'
import { readLocationSearchParam } from '~/lib/location-search-param'

type UseTimelineProjectRouteOptions = {
  onLocalProjectOpened: (projectId: string) => void
  bootstrapIfEmpty: boolean
}

export const settlePopstateProjectTransition = async (input: {
  currentProjectId: string
  nextProjectId: string | null | undefined
  settle: () => Promise<void>
  resolve: () => void
  restore: () => void
}) => {
  if (input.currentProjectId && input.nextProjectId !== input.currentProjectId) {
    try {
      await input.settle()
    } catch {
      input.restore()
      return
    }
  }
  input.resolve()
}

const updateRoomUrl = (projectId: string, mode: 'push' | 'replace') => {
  try {
    const url = new URL(window.location.href)
    url.searchParams.set('projectId', projectId)
    url.searchParams.delete('roomId')
    if (mode === 'replace') {
      history.replaceState(null, '', url.toString())
    } else {
      history.pushState(null, '', url.toString())
    }
  } catch {}
}

export const clearShareTokenFromUrl = () => {
  try {
    const url = new URL(window.location.href)
    url.searchParams.delete('shareToken')
    history.replaceState(null, '', url.toString())
  } catch {}
}

export const useTimelineProjectRoute = (options: UseTimelineProjectRouteOptions) => {
  const [projectId, setProjectIdState] = createSignal<string>('')
  const [mountedProjectGeneration, setMountedProjectGeneration] = createSignal(0)
  let settleProjectTransition: (() => Promise<void>) | undefined
  let historyTransition = 0
  const setMountedProjectId = (nextProjectId: string) => {
    if (projectId() !== nextProjectId) setMountedProjectGeneration((generation) => generation + 1)
    setProjectIdState(nextProjectId)
  }

  const [bootstrapProjectId, setBootstrapProjectId] = createSignal<string | null>(null)
  const [acceptingShareToken, setAcceptingShareToken] = createSignal<string | null>(null)

  const resolveRoom = (
    nextProjectId: string,
    routeOptions?: {
      history?: 'push' | 'replace'
      bootstrap?: string | null
    },
  ) => {
    if (routeOptions?.history) {
      updateRoomUrl(nextProjectId, routeOptions.history)
    }
    batch(() => {
      setBootstrapProjectId(routeOptions?.bootstrap ?? null)
      setMountedProjectId(nextProjectId)
    })
  }

  const settleBeforeRoomChange = async () => {
    await settleProjectTransition?.()
  }

  const replaceRoom = async (nextProjectId: string) => {
    await settleBeforeRoomChange()
    resolveRoom(nextProjectId, { history: 'replace' })
  }

  const navigateToRoom = async (nextProjectId: string) => {
    await settleBeforeRoomChange()
    resolveRoom(nextProjectId, { history: 'push' })
    if (isLocalId('project', nextProjectId)) options.onLocalProjectOpened(nextProjectId)
  }

  const setProjectId = async (nextProjectId: string) => {
    await settleBeforeRoomChange()
    setBootstrapProjectId(null)
    setMountedProjectId(nextProjectId)
  }

  onMount(() => {
    const syncLocationState = async (fromHistory = false) => {
      const nextProjectId = readLocationSearchParam('projectId')
      const nextShareToken = readLocationSearchParam('shareToken')
      setAcceptingShareToken(nextShareToken)
      const transition = ++historyTransition
      if (fromHistory) {
        let resolved = false
        await settlePopstateProjectTransition({
          currentProjectId: projectId(),
          nextProjectId,
          settle: settleBeforeRoomChange,
          resolve: () => { resolved = true },
          restore: () => updateRoomUrl(projectId(), 'replace'),
        })
        if (!resolved || transition !== historyTransition) return
      }
      if (nextProjectId) {
        resolveRoom(nextProjectId)
        return
      }
      batch(() => {
        setBootstrapProjectId(null)
        setMountedProjectId('')
      })
      if (nextShareToken || !options.bootstrapIfEmpty) return
      const generatedProjectId = crypto.randomUUID()
      resolveRoom(generatedProjectId, {
        history: 'replace',
        bootstrap: generatedProjectId,
      })
    }

    void syncLocationState()
    const syncRoomFromHistory = () => { void syncLocationState(true) }
    window.addEventListener('popstate', syncRoomFromHistory)
    onCleanup(() => {
      window.removeEventListener('popstate', syncRoomFromHistory)
    })
  })

  return {
    projectId,
    mountedProjectGeneration,
    bootstrapProjectId,
    acceptingShareToken,
    setAcceptingShareToken,
    setProjectId,
    clearBootstrapProjectId: () => setBootstrapProjectId(null),
    setProjectTransitionSettlement: (settle: (() => Promise<void>) | undefined) => {
      settleProjectTransition = settle
    },
    settleProjectTransition: settleBeforeRoomChange,
    replaceRoom,
    navigateToRoom,
  }
}
