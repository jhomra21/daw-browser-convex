export const readLocationSearchParam = (name: string) => {
  try {
    const url = new URL(window.location.href)
    const value = url.searchParams.get(name)
    return value && value.trim() ? value : null
  } catch {
    return null
  }
}
