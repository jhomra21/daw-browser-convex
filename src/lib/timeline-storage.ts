const MIX_KEY_PREFIX = 'mb:mix:'
const MIX_SYNC_KEY_PREFIX = 'mb:mix-sync:'

export const canUseLocalStorage = () => {
  if (typeof window === 'undefined') return false
  try {
    const storage = window.localStorage
    return Boolean(storage)
  } catch {
    return false
  }
}

export const loadLocalMixMap = (rid?: string): Record<string, { muted?: boolean; soloed?: boolean }> => {
  if (!rid) return {}
  if (!canUseLocalStorage()) return {}
  try {
    return JSON.parse(localStorage.getItem(`${MIX_KEY_PREFIX}${rid}`) || '{}')
  } catch {
    return {}
  }
}

export const saveLocalMix = (
  rid: string | undefined,
  trackId: string,
  update: Partial<{ muted: boolean; soloed: boolean }>,
) => {
  if (!rid) return
  if (!canUseLocalStorage()) return
  const map = loadLocalMixMap(rid)
  map[trackId] = { ...(map[trackId] || {}), ...update }
  try {
    localStorage.setItem(`${MIX_KEY_PREFIX}${rid}`, JSON.stringify(map))
  } catch {}
}

export const loadMixSyncFlag = (rid?: string): boolean => {
  if (!rid) return false
  if (!canUseLocalStorage()) return false
  try {
    return localStorage.getItem(`${MIX_SYNC_KEY_PREFIX}${rid}`) === '1'
  } catch {
    return false
  }
}

export const saveMixSyncFlag = (rid: string | undefined, value: boolean) => {
  if (!rid) return
  if (!canUseLocalStorage()) return
  try {
    localStorage.setItem(`${MIX_SYNC_KEY_PREFIX}${rid}`, value ? '1' : '0')
  } catch {}
}
