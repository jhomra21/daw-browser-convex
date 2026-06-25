function normalizeProjectId(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined
}

function buildRoomShareUrl(
  projectId: string | undefined,
  href: string,
  shareToken?: string,
): string | undefined {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) return undefined
  const url = new URL(href)
  url.searchParams.set('projectId', normalizedProjectId)
  if (shareToken) url.searchParams.set('shareToken', shareToken)
  return url.toString()
}

export function getInviteShareUrl(
  currentProjectId: string | undefined,
  shareToken: string,
): string | undefined {
  if (typeof window === 'undefined') return normalizeProjectId(currentProjectId)
  try {
    return buildRoomShareUrl(currentProjectId, window.location.href, shareToken)
  } catch {
    return normalizeProjectId(currentProjectId)
  }
}

export const ensureRoomShareLink = (
  currentProjectId: string | undefined,
  setProjectId: (projectId: string) => void,
): string | undefined => {
  if (typeof window === 'undefined') return currentProjectId
  try {
    const url = new URL(window.location.href)
    const normalizedCurrentProjectId = normalizeProjectId(currentProjectId)
    const urlProjectId = normalizeProjectId(url.searchParams.get('projectId') ?? undefined)
    const rid = normalizedCurrentProjectId ?? urlProjectId ?? crypto.randomUUID()
    const shareUrl = buildRoomShareUrl(rid, window.location.href)
    if (shareUrl && shareUrl !== window.location.href) {
      history.replaceState(null, '', shareUrl)
    }
    if (rid !== normalizedCurrentProjectId) {
      setProjectId(rid)
    }
    return rid
  } catch {
    return currentProjectId
  }
}
