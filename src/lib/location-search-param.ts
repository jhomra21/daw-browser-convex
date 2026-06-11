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
