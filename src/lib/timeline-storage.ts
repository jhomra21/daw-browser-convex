import { normalizePersistedHistory, serializePersistedHistory } from '~/lib/undo/persisted-history'
import type { PersistedHistory } from '~/lib/undo/types'
import type { TrackId, TrackSend } from '@daw-browser/timeline-core/types'
import { DEFAULT_GRID } from '@daw-browser/timeline-core/project-defaults'
import { clampPixelsPerSecond, DEFAULT_PIXELS_PER_SECOND } from '~/lib/timeline-view'
import { createStoredValue } from '~/lib/stored-value'
import { isJsonBoolean, isJsonNumber, isJsonObject } from '@daw-browser/shared'

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

const localMixMap = createStoredValue<LocalMixMap>({
  key: (rid) => `mb:mix:${rid}`,
  fallback: () => ({}),
  parse: (raw) => JSON.parse(raw),
  serialize: JSON.stringify,
})

export const loadLocalMixMap = (rid?: string): LocalMixMap => rid ? localMixMap.read(rid) : {}

export const saveLocalMixMap = (rid: string | undefined, map: LocalMixMap) => {
  if (rid) localMixMap.write(rid, map)
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

const mixSyncFlag = createStoredValue<boolean>({
  key: (rid) => `mb:mix-sync:${rid}`,
  fallback: () => false,
  parse: (raw) => raw === '1',
  serialize: (value) => value ? '1' : '0',
})

export const loadMixSyncFlag = (rid?: string): boolean => rid ? mixSyncFlag.read(rid) : false

export const saveMixSyncFlag = (rid: string | undefined, value: boolean) => {
  if (rid) mixSyncFlag.write(rid, value)
}

type GridSettings = {
  enabled: boolean
  denominator: number
}

const gridSettings = createStoredValue<GridSettings>({
  key: (rid) => `mb:grid:${rid}`,
  fallback: () => ({ ...DEFAULT_GRID }),
  parse: (raw) => {
    const parsed = JSON.parse(raw)

    if (!isJsonObject(parsed)) return undefined

    return {
      enabled: isJsonBoolean(parsed.enabled) ? parsed.enabled : DEFAULT_GRID.enabled,
      denominator: isJsonNumber(parsed.denominator) ? parsed.denominator : DEFAULT_GRID.denominator,
    }
  },
  serialize: JSON.stringify,
})

export const loadGridSettings = (rid?: string): GridSettings => rid ? gridSettings.read(rid) : { ...DEFAULT_GRID }

export const saveGridSettings = (rid: string | undefined, enabled: boolean, denominator: number) => {
  if (rid) gridSettings.write(rid, { enabled, denominator })
}

const timelineScale = createStoredValue<number>({
  key: (rid) => `mb:timeline-scale:${rid}`,
  fallback: () => DEFAULT_PIXELS_PER_SECOND,
  parse: (raw) => clampPixelsPerSecond(Number(raw)),
  serialize: String,
})

export const loadTimelineScale = (rid?: string): number => rid ? timelineScale.read(rid) : DEFAULT_PIXELS_PER_SECOND

export const saveTimelineScale = (rid: string | undefined, value: number) => {
  if (rid && Number.isFinite(value)) timelineScale.write(rid, clampPixelsPerSecond(value))
}

const history = createStoredValue<PersistedHistory>({
  key: (storageKey) => `mb:history:${storageKey}`,
  fallback: () => ({ undo: [], redo: [] }),
  parse: (raw) => normalizePersistedHistory(JSON.parse(raw)),
  serialize: (value) => JSON.stringify(serializePersistedHistory(value)),
})

const toHistoryStorageKey = (scope: HistoryStorageScope) => {
  if (!scope.projectId) return null

  return scope.userId ? `${scope.projectId}:${scope.userId}` : scope.projectId
}

export const loadHistory = (scope: HistoryStorageScope): PersistedHistory => {
  const storageKey = toHistoryStorageKey(scope)

  return storageKey ? history.read(storageKey) : { undo: [], redo: [] }
}

export const saveHistory = (scope: HistoryStorageScope, value: PersistedHistory) => {
  const storageKey = toHistoryStorageKey(scope)

  if (storageKey) history.write(storageKey, value)
}
