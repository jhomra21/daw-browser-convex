import { batch, createSignal, onCleanup, onMount } from 'solid-js'
import { isLocalId } from '@daw-browser/shared'
import { readLocationSearchParam } from '~/lib/location-search-param'

type UseTimelineProjectRouteOptions = {
  onLocalProjectOpened: (projectId: string) => void
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
      setProjectIdState(nextProjectId)
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
    setProjectIdState(nextProjectId)
  }

  onMount(() => {
    const syncLocationState = (options?: { bootstrapIfEmpty?: boolean }) => {
      const nextProjectId = readLocationSearchParam('projectId')
      const nextShareToken = readLocationSearchParam('shareToken')
      setAcceptingShareToken(nextShareToken)
      if (nextProjectId) {
        resolveRoom(nextProjectId)
        return
      }
      batch(() => {
        setBootstrapProjectId(null)
        setProjectIdState('')
      })
      if (nextShareToken || !options?.bootstrapIfEmpty) return
      const generatedProjectId = crypto.randomUUID()
      resolveRoom(generatedProjectId, {
        history: 'replace',
        bootstrap: generatedProjectId,
      })
    }

    syncLocationState({ bootstrapIfEmpty: true })
    const syncRoomFromHistory = () => syncLocationState()
    window.addEventListener('popstate', syncRoomFromHistory)
    onCleanup(() => {
      window.removeEventListener('popstate', syncRoomFromHistory)
    })
  })

  return {
    projectId,
    bootstrapProjectId,
    acceptingShareToken,
    setAcceptingShareToken,
    setProjectId,
    clearBootstrapProjectId: () => setBootstrapProjectId(null),
    replaceRoom,
    navigateToRoom,
  }
}
