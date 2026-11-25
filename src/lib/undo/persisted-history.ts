import { AUDIO_EFFECT_PARAMS_VERSION, isJsonNumber, isJsonObject, type JsonValue } from '@daw-browser/shared'
import { isHistoryEntryValue, upgradeLegacyHistoryEntry } from '~/lib/undo/history-entry-format'
import type { HistoryEntry, PersistedHistory } from '~/lib/undo/types'
import { serializeJsonValue } from '~/lib/json'
import { z } from 'zod'

const PERSISTED_HISTORY_VERSION = 8 as const
const READABLE_PERSISTED_HISTORY_VERSIONS: ReadonlySet<number> = new Set([2, 3, 4, 5, 6, PERSISTED_HISTORY_VERSION])

type PersistedHistoryEnvelope = {
  version: number
  // The effect params versions the entries were written under. Entries hold params in that shape and replay them as is, so a
  // history saved under other versions (or none: every record before version 8) is dropped rather than migrated.
  effectParamsVersions?: JsonValue
  undo: JsonValue[]
  redo: JsonValue[]
}

const effectParamsVersionEntries = Object.entries(AUDIO_EFFECT_PARAMS_VERSION)

function matchesCurrentEffectParamsVersions(value: JsonValue | undefined): boolean {
  return isJsonObject(value)
    && Object.keys(value).length === effectParamsVersionEntries.length
    && effectParamsVersionEntries.every(([kind, version]) => value[kind] === version)
}

function isPersistedHistoryEnvelope(value: JsonValue): value is PersistedHistoryEnvelope {
  return isJsonObject(value)
    && isJsonNumber(value.version)
    && Number.isFinite(value.version)
    && READABLE_PERSISTED_HISTORY_VERSIONS.has(value.version)
    && matchesCurrentEffectParamsVersions(value.effectParamsVersions)
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
    effectParamsVersions: { ...AUDIO_EFFECT_PARAMS_VERSION },
    undo: value.undo.map(serializeJsonValue),
    redo: value.redo.map(serializeJsonValue),
  }
}
