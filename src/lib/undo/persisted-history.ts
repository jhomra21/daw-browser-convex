import { isJsonNumber, isJsonObject, type JsonValue } from '@daw-browser/shared'
import { isHistoryEntryValue, upgradeLegacyHistoryEntry } from '~/lib/undo/history-entry-format'
import type { HistoryEntry, PersistedHistory } from '~/lib/undo/types'
import { serializeJsonValue } from '~/lib/json'
import { z } from 'zod'

const PERSISTED_HISTORY_VERSION = 7 as const
const READABLE_PERSISTED_HISTORY_VERSIONS: ReadonlySet<number> = new Set([2, 3, 4, 5, 6, PERSISTED_HISTORY_VERSION])

type PersistedHistoryEnvelope = {
  version: number
  undo: JsonValue[]
  redo: JsonValue[]
}

function isPersistedHistoryEnvelope(value: JsonValue): value is PersistedHistoryEnvelope {
  return isJsonObject(value)
    && isJsonNumber(value.version)
    && Number.isFinite(value.version)
    && READABLE_PERSISTED_HISTORY_VERSIONS.has(value.version)
    && Array.isArray(value.undo)
    && Array.isArray(value.redo)
}

function readHistoryEntries(entries: JsonValue[], version: number): HistoryEntry[] {
  return entries.flatMap((entry): HistoryEntry[] => {
    if (!isHistoryEntryValue(entry, true, version)) return []

    if (version >= PERSISTED_HISTORY_VERSION) return [entry]

    return [upgradeLegacyHistoryEntry(entry, (children) => readHistoryEntries(children.map(serializeJsonValue), version))]
  })
}

export function normalizePersistedHistory<Value>(value: Value): PersistedHistory {
  const parsed = z.json().safeParse(value)

  if (parsed.success && isPersistedHistoryEnvelope(parsed.data)) {
    return {
      undo: readHistoryEntries(parsed.data.undo, parsed.data.version),
      redo: readHistoryEntries(parsed.data.redo, parsed.data.version),
    }
  }

  return { undo: [], redo: [] }
}

export function serializePersistedHistory(value: PersistedHistory): PersistedHistoryEnvelope {
  return {
    version: PERSISTED_HISTORY_VERSION,
    undo: value.undo.map(serializeJsonValue),
    redo: value.redo.map(serializeJsonValue),
  }
}
