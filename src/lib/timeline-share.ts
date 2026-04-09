function normalizeRoomId(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined
}

function buildRoomShareUrl(roomId: string | undefined, href: string): string | undefined {
  const normalizedRoomId = normalizeRoomId(roomId)
  if (!normalizedRoomId) return undefined
  const url = new URL(href)
  url.searchParams.set('roomId', normalizedRoomId)
  return url.toString()
}

export function getRoomShareUrl(currentRoomId: string | undefined): string | undefined {
  if (typeof window === 'undefined') return normalizeRoomId(currentRoomId)
  try {
    return buildRoomShareUrl(currentRoomId, window.location.href)
  } catch {
    return normalizeRoomId(currentRoomId)
  }
}

export const ensureRoomShareLink = (
  currentRoomId: string | undefined,
  setRoomId: (roomId: string) => void,
): string | undefined => {
  if (typeof window === 'undefined') return currentRoomId
  try {
    const url = new URL(window.location.href)
    const normalizedCurrentRoomId = normalizeRoomId(currentRoomId)
    const urlRoomId = normalizeRoomId(url.searchParams.get('roomId') ?? undefined)
    const rid = normalizedCurrentRoomId ?? urlRoomId ?? crypto.randomUUID()
    const shareUrl = buildRoomShareUrl(rid, window.location.href)
    if (shareUrl && shareUrl !== window.location.href) {
      history.replaceState(null, '', shareUrl)
    }
    if (rid !== normalizedCurrentRoomId) {
      setRoomId(rid)
    }
    return rid
  } catch {
    return currentRoomId
  }
}
