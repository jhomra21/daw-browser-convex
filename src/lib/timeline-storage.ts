import { normalizePersistedHistory, serializePersistedHistory } from '~/lib/undo/persisted-history'
import type { PersistedHistory } from '~/lib/undo/types'
import type { TrackId, TrackSend } from '@daw-browser/timeline-core/types'
import { clampPixelsPerSecond, DEFAULT_PIXELS_PER_SECOND } from '~/lib/timeline-view'
import { isJsonBoolean, isJsonNumber, isJsonObject } from '@daw-browser/shared'

const MIX_KEY_PREFIX = 'mb:mix:'
const MIX_SYNC_KEY_PREFIX = 'mb:mix-sync:'
const GRID_KEY_PREFIX = 'mb:grid:'
const TIMELINE_SCALE_KEY_PREFIX = 'mb:timeline-scale:'
const HISTORY_KEY_PREFIX = 'mb:history:'

export type LocalMixPatch = Partial<{
  muted: boolean
  soloed: boolean
  volume: number
  sends: TrackSend[]
  outputTargetId: TrackId | null
}>

export type LocalMixMap = Record<string, LocalMixPatch>

type HistoryStorageScope = {
  projectId?: string
  userId?: string
}

export const canUseLocalStorage = () => {
  if (globalThis.window === undefined) return false

  try {
    const storage = window.localStorage

    return Boolean(storage)
  } catch {
    return false
  }
}

export const loadLocalMixMap = (rid?: string): LocalMixMap => {
  if (!rid) return {}

  if (!canUseLocalStorage()) return {}

  try {
    return JSON.parse(localStorage.getItem(`${MIX_KEY_PREFIX}${rid}`) || '{}')
  } catch {
    return {}
  }
}

export const saveLocalMixMap = (rid: string | undefined, map: LocalMixMap) => {
  if (!rid) return

  if (!canUseLocalStorage()) return

  try {
    localStorage.setItem(`${MIX_KEY_PREFIX}${rid}`, JSON.stringify(map))
  } catch {}
}

export const stripSharedTrackLocalOverrides = (
  map: LocalMixMap,
  writableTrackIds: Iterable<string>,
): LocalMixMap => {
  let next: LocalMixMap | null = null

  for (const trackId of writableTrackIds) {
    const entry = (next ?? map)[trackId]

    if (!entry) continue

    if (
      entry.muted === undefined
      && entry.soloed === undefined
      && entry.sends === undefined
      && entry.outputTargetId === undefined
    ) continue

    if (!next) next = { ...map }

    if (entry.volume === undefined) {
      delete next[trackId]
      continue
    }

    next[trackId] = {
      volume: entry.volume,
    }
  }

  return next ?? map
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

type GridSettings = {
  enabled: boolean
  denominator: number
}

export const loadGridSettings = (rid?: string): GridSettings => {
  if (!rid) return { enabled: true, denominator: 4 }

  if (!canUseLocalStorage()) return { enabled: true, denominator: 4 }

  try {
    const raw = localStorage.getItem(`${GRID_KEY_PREFIX}${rid}`)

    if (!raw) return { enabled: true, denominator: 4 }
    const parsed = JSON.parse(raw)

    if (!isJsonObject(parsed)) return { enabled: true, denominator: 4 }

    return {
      enabled: isJsonBoolean(parsed.enabled) ? parsed.enabled : true,
      denominator: isJsonNumber(parsed.denominator) ? parsed.denominator : 4,
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

export const loadTimelineScale = (rid?: string): number => {
  if (!rid || !canUseLocalStorage()) return DEFAULT_PIXELS_PER_SECOND

  try {
    const raw = localStorage.getItem(`${TIMELINE_SCALE_KEY_PREFIX}${rid}`)

    if (raw === null) return DEFAULT_PIXELS_PER_SECOND

    return clampPixelsPerSecond(Number(raw))
  } catch {
    return DEFAULT_PIXELS_PER_SECOND
  }
}

export const saveTimelineScale = (rid: string | undefined, value: number) => {
  if (!rid || !canUseLocalStorage() || !Number.isFinite(value)) return

  try {
    localStorage.setItem(
      `${TIMELINE_SCALE_KEY_PREFIX}${rid}`,
      String(clampPixelsPerSecond(value)),
    )
  } catch {}
}

const toHistoryStorageKey = (scope: HistoryStorageScope) => {
  if (!scope.projectId) return null

  return scope.userId ? `${scope.projectId}:${scope.userId}` : scope.projectId
}

const toHistoryLocalStorageKey = (storageKey: string) => `${HISTORY_KEY_PREFIX}${storageKey}`

const readStoredHistory = (storageKey: string) => {
  const raw = localStorage.getItem(toHistoryLocalStorageKey(storageKey))

  if (!raw) return null

  return JSON.parse(raw)
}

export const loadHistory = (scope: HistoryStorageScope): PersistedHistory => {
  if (!scope.projectId || !canUseLocalStorage()) return { undo: [], redo: [] }

  try {
    const scopedKey = scope.userId ? `${scope.projectId}:${scope.userId}` : scope.projectId
    const scopedHistory = readStoredHistory(scopedKey)

    return scopedHistory === null ? { undo: [], redo: [] } : normalizePersistedHistory(scopedHistory)
  } catch {
    return { undo: [], redo: [] }
  }
}

export const saveHistory = (scope: HistoryStorageScope, value: PersistedHistory) => {
  const storageKey = toHistoryStorageKey(scope)

  if (!storageKey || !canUseLocalStorage()) return

  try {
    localStorage.setItem(toHistoryLocalStorageKey(storageKey), JSON.stringify(serializePersistedHistory(value)))
  } catch {}
}
