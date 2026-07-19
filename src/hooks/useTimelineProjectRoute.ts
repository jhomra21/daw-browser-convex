import { batch, createSignal, onCleanup, onMount } from 'solid-js'
import { isLocalId } from '@daw-browser/shared'
import { readLocationSearchParam } from '~/lib/location-search-param'

type UseTimelineProjectRouteOptions = {
  onLocalProjectOpened: (projectId: string) => void
  bootstrapIfEmpty: boolean
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

  const replaceRoom = (nextProjectId: string) => {
    resolveRoom(nextProjectId, { history: 'replace' })
  }

  const navigateToRoom = (nextProjectId: string) => {
    resolveRoom(nextProjectId, { history: 'push' })
    if (isLocalId('project', nextProjectId)) options.onLocalProjectOpened(nextProjectId)
  }

  const setProjectId = (nextProjectId: string) => {
    setBootstrapProjectId(null)
    setMountedProjectId(nextProjectId)
  }

  onMount(() => {
    const syncLocationState = () => {
      const nextProjectId = readLocationSearchParam('projectId')
      const nextShareToken = readLocationSearchParam('shareToken')
      setAcceptingShareToken(nextShareToken)
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

    syncLocationState()
    const syncRoomFromHistory = () => syncLocationState()
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
    replaceRoom,
    navigateToRoom,
  }
}
