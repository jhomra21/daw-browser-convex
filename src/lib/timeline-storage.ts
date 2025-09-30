const MIX_KEY_PREFIX = 'mb:mix:'
const MIX_SYNC_KEY_PREFIX = 'mb:mix-sync:'
const GRID_KEY_PREFIX = 'mb:grid:'
const BPM_KEY_PREFIX = 'mb:bpm:'
const LOOP_KEY_PREFIX = 'mb:loop:'

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

export const loadGridSettings = (rid?: string): { enabled: boolean; denominator: number } => {
  if (!rid) return { enabled: true, denominator: 4 }
  if (!canUseLocalStorage()) return { enabled: true, denominator: 4 }
  try {
    const raw = localStorage.getItem(`${GRID_KEY_PREFIX}${rid}`)
    if (!raw) return { enabled: true, denominator: 4 }
    const parsed = JSON.parse(raw)
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
      denominator: typeof parsed.denominator === 'number' ? parsed.denominator : 4,
    }
  } catch {
    return { enabled: true, denominator: 4 }
  }
}

export const saveGridSettings = (rid: string | undefined, enabled: boolean, denominator: number) => {
  if (!rid) return
  if (!canUseLocalStorage()) return
  try {
    localStorage.setItem(`${GRID_KEY_PREFIX}${rid}`, JSON.stringify({ enabled, denominator }))
  } catch {}
}

export const loadBpm = (rid?: string): number => {
  const DEFAULT = 120
  if (!rid) return DEFAULT
  if (!canUseLocalStorage()) return DEFAULT
  try {
    const raw = localStorage.getItem(`${BPM_KEY_PREFIX}${rid}`)
    const n = Number(raw)
    if (!Number.isFinite(n)) return DEFAULT
    const clamped = Math.min(300, Math.max(30, Math.round(n)))
    return clamped
  } catch {
    return DEFAULT
  }
}

export const saveBpm = (rid: string | undefined, value: number) => {
  if (!rid) return
  if (!canUseLocalStorage()) return
  const DEFAULT = 120
  const safeValue = Number.isFinite(value) ? value : DEFAULT
  const clamped = Math.min(300, Math.max(30, Math.round(safeValue)))
  try {
    localStorage.setItem(`${BPM_KEY_PREFIX}${rid}`, String(clamped))
  } catch {}
}

type LoopSettings = {
  enabled: boolean
  startSec: number
  endSec: number
}

const DEFAULT_LOOP: LoopSettings = { enabled: false, startSec: 0, endSec: 8 }
const cloneLoop = (src: LoopSettings): LoopSettings => ({ enabled: !!src.enabled, startSec: src.startSec, endSec: src.endSec })

export const loadLoopSettings = (rid?: string): LoopSettings => {
  if (!rid) return cloneLoop(DEFAULT_LOOP)
  if (!canUseLocalStorage()) return cloneLoop(DEFAULT_LOOP)
  try {
    const raw = localStorage.getItem(`${LOOP_KEY_PREFIX}${rid}`)
    if (!raw) return cloneLoop(DEFAULT_LOOP)
    const parsed = JSON.parse(raw)
    const start = Number(parsed?.startSec)
    const end = Number(parsed?.endSec)
    const safeStart = Number.isFinite(start) && start >= 0 ? start : DEFAULT_LOOP.startSec
    const minEnd = safeStart + 0.1
    const safeEnd = Number.isFinite(end) && end > safeStart ? end : Math.max(DEFAULT_LOOP.endSec, minEnd)
    return cloneLoop({
      enabled: Boolean(parsed?.enabled),
      startSec: safeStart,
      endSec: safeEnd,
    })
  } catch {
    return cloneLoop(DEFAULT_LOOP)
  }
}

export const saveLoopSettings = (rid: string | undefined, value: LoopSettings) => {
  if (!rid) return
  if (!canUseLocalStorage()) return
  const start = Number.isFinite(value.startSec) && value.startSec >= 0 ? value.startSec : DEFAULT_LOOP.startSec
  const minEnd = start + 0.1
  const end = Number.isFinite(value.endSec) && value.endSec > start ? value.endSec : Math.max(DEFAULT_LOOP.endSec, minEnd)
  const payload: LoopSettings = {
    enabled: !!value.enabled,
    startSec: start,
    endSec: end,
  }
  try {
    localStorage.setItem(`${LOOP_KEY_PREFIX}${rid}`, JSON.stringify(payload))
  } catch {}
}
