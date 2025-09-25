export const ensureRoomShareLink = (
  currentRoomId: string | undefined,
  setRoomId: (roomId: string) => void,
): string | undefined => {
  if (typeof window === 'undefined') return currentRoomId
  try {
    const url = new URL(window.location.href)
    let rid = url.searchParams.get('roomId') ?? currentRoomId
    if (!rid) {
      rid = crypto.randomUUID()
      url.searchParams.set('roomId', rid)
      history.replaceState(null, '', url.toString())
      setRoomId(rid)
    } else if (rid !== currentRoomId) {
      // Make sure UI state tracks existing roomId in URL
      setRoomId(rid)
    }
    return rid
  } catch {
    return currentRoomId
  }
}
