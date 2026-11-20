export const readLocationSearchParam = (name: string) => {
  try {
    const url = new URL(window.location.href)
    const value = url.searchParams.get(name)

    return value && value.trim() ? value : null
  } catch {
    return null
  }
}

export const writeLocationSearchParam = (name: string, value: string | null, mode: 'push' | 'replace' = 'replace') => {
  writeLocationSearchParams([{ name, value }], mode)
}

export const writeLocationSearchParams = (
  updates: readonly { name: string; value: string | null }[],
  mode: 'push' | 'replace' = 'replace',
) => {
  const url = new URL(window.location.href)

  for (const update of updates) {
    if (update.value) {
      url.searchParams.set(update.name, update.value)
    } else {
      url.searchParams.delete(update.name)
    }
  }

  if (mode === 'push') {
    history.pushState(null, '', url.toString())
  } else {
    history.replaceState(null, '', url.toString())
  }
}

const listeners = new Set<() => void>()

// Runs the listener on browser history navigation and after publishLocationSearchParams.
export const subscribeLocationSearch = (listener: () => void) => {
  window.addEventListener('popstate', listener)
  listeners.add(listener)

  return () => {
    window.removeEventListener('popstate', listener)
    listeners.delete(listener)
  }
}

export const publishLocationSearchParams = (
  updates: readonly { name: string; value: string | null }[],
  mode: 'push' | 'replace' = 'replace',
) => {
  writeLocationSearchParams(updates, mode)

  for (const listener of listeners) listener()
}

export const writeRoomLocation = (projectId: string, mode: 'push' | 'replace') => {
  try {
    writeLocationSearchParams([
      { name: 'projectId', value: projectId },
      { name: 'roomId', value: null },
    ], mode)
  } catch {}
}

export const clearShareTokenFromLocation = () => {
  try {
    writeLocationSearchParams([{ name: 'shareToken', value: null }])
  } catch {}
}
