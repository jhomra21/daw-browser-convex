import { normalizeAudioWarp } from '@daw-browser/shared'
import type { EffectType, HistoryEntry, PersistedHistory } from '~/lib/undo/types'

const PERSISTED_HISTORY_VERSION = 3 as const

type PersistedHistoryEnvelope = {
  version: typeof PERSISTED_HISTORY_VERSION
  undo: unknown[]
  redo: unknown[]
}

const EFFECT_TYPES: ReadonlySet<string> = new Set([
  'eq',
  'compressor',
  'saturator',
  'delay',
  'reverb',
  'synth',
  'instrument',
  'arp',
  'master-eq',
  'master-compressor',
  'master-saturator',
  'master-delay',
  'master-reverb',
] satisfies EffectType[])

function isPersistedHistoryEnvelope(value: unknown): value is PersistedHistoryEnvelope {
  return isRecord(value) && value.version === PERSISTED_HISTORY_VERSION && Array.isArray(value.undo) && Array.isArray(value.redo)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
const isScope = (value: unknown) => value === 'shared' || value === 'local'
const isAudioWarp = (value: unknown) => normalizeAudioWarp(value) !== undefined

const isClipTiming = (value: unknown) => isRecord(value)
  && isNumber(value.startSec)
  && isNumber(value.duration)
  && (value.leftPadSec === undefined || isNumber(value.leftPadSec))
  && (value.bufferOffsetSec === undefined || isNumber(value.bufferOffsetSec))
  && (value.audioWarp === undefined || isAudioWarp(value.audioWarp))
  && (value.gain === undefined || isNumber(value.gain))
  && (value.midiOffsetBeats === undefined || isNumber(value.midiOffsetBeats))

const isRoutingSnapshot = (value: unknown) => isRecord(value)
  && Array.isArray(value.sends)
  && value.sends.every((send) => isRecord(send) && isString(send.targetTrackRef) && isNumber(send.amount))
  && (value.outputTargetRef === undefined || isString(value.outputTargetRef))

const isClipSnapshot = (value: unknown) => isRecord(value)
  && isString(value.clipRef)
  && isNumber(value.startSec)
  && isNumber(value.duration)
  && (value.currentId === undefined || isString(value.currentId))
  && (value.name === undefined || isString(value.name))
  && (value.sampleUrl === undefined || isString(value.sampleUrl))
  && (value.sourceAssetKey === undefined || isString(value.sourceAssetKey))
  && (value.sourceKind === undefined || isString(value.sourceKind))
  && (value.timing === undefined || isClipTiming({ startSec: 0, duration: 0, ...value.timing }))

const isTrackCreateData = (value: unknown) => isRecord(value)
  && isString(value.trackRef)
  && isNumber(value.index)
  && (value.currentTrackId === undefined || isString(value.currentTrackId))
  && (value.kind === undefined || value.kind === 'audio' || value.kind === 'instrument')
  && (value.channelRole === undefined || value.channelRole === 'track' || value.channelRole === 'group' || value.channelRole === 'return')

const isTrackSnapshot = (value: unknown) => isRecord(value)
  && (value.trackRef === undefined || isString(value.trackRef))
  && isNumber(value.index)
  && isString(value.name)
  && isNumber(value.volume)
  && (value.muted === undefined || isBoolean(value.muted))
  && (value.soloed === undefined || isBoolean(value.soloed))
  && (value.kind === undefined || value.kind === 'audio' || value.kind === 'instrument')
  && (value.channelRole === undefined || value.channelRole === 'track' || value.channelRole === 'group' || value.channelRole === 'return')
  && isRoutingSnapshot(value.routing)

const isAutomationPoint = (value: unknown) => isRecord(value)
  && isString(value.id)
  && isNumber(value.timeSec)
  && isNumber(value.value)
  && (value.interpolation === 'linear' || value.interpolation === 'hold')

const isAutomationEnvelope = (value: unknown) => isRecord(value)
  && isString(value.id)
  && isString(value.projectId)
  && isRecord(value.target)
  && (value.target.kind === 'master' || (value.target.kind === 'track' && isString(value.target.trackId)))
  && isString(value.targetKey)
  && isString(value.parameterId)
  && isBoolean(value.enabled)
  && Array.isArray(value.points)
  && value.points.every(isAutomationPoint)
  && isNumber(value.updatedAt)

function isHistoryEntryData(type: string, data: Record<string, unknown>) {
  switch (type) {
    case 'clip-create':
      return isString(data.trackRef) && isClipSnapshot(data.clip)
    case 'clip-delete':
      return Array.isArray(data.items)
        && data.items.every((item) => isRecord(item) && isString(item.trackRef) && isClipSnapshot(item.clip))
    case 'clips-move':
      return Array.isArray(data.moves)
        && data.moves.every((move) => isRecord(move)
          && isString(move.clipRef)
          && isRecord(move.from)
          && isString(move.from.trackRef)
          && isNumber(move.from.startSec)
          && isRecord(move.to)
          && isString(move.to.trackRef)
          && isNumber(move.to.startSec))
    case 'clip-timing':
      return isString(data.clipRef) && isClipTiming(data.from) && isClipTiming(data.to)
    case 'clip-audio-warp':
      return isString(data.clipRef)
        && isRecord(data.from)
        && isAudioWarp(data.from.audioWarp)
        && isRecord(data.to)
        && isAudioWarp(data.to.audioWarp)
    case 'track-create':
      return isTrackCreateData(data)
    case 'track-clip-create':
      return isRecord(data.track) && isTrackCreateData(data.track) && isRecord(data.clip) && isClipSnapshot(data.clip)
    case 'track-delete':
      return isTrackSnapshot(data.track)
        && Array.isArray(data.clips)
        && data.clips.every(isClipSnapshot)
        && (data.recreatedTrackId === undefined || isString(data.recreatedTrackId))
    case 'track-volume':
      return isString(data.trackRef) && isScope(data.scope) && isNumber(data.from) && isNumber(data.to)
    case 'track-mute':
    case 'track-solo':
      return isString(data.trackRef) && isScope(data.scope) && isBoolean(data.from) && isBoolean(data.to)
    case 'track-routing':
      return isString(data.trackRef) && isRoutingSnapshot(data.from) && isRoutingSnapshot(data.to)
    case 'effect-params':
      return (data.trackRef === undefined || isString(data.trackRef))
        && isString(data.effect)
        && EFFECT_TYPES.has(data.effect)
        && isRecord(data.from)
        && isRecord(data.to)
    case 'automation-envelope-change':
      return (data.before === null || isAutomationEnvelope(data.before))
        && (data.after === null || isAutomationEnvelope(data.after))
    default:
      return false
  }
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  return isRecord(value)
    && typeof value.type === 'string'
    && typeof value.projectId === 'string'
    && isRecord(value.data)
    && isHistoryEntryData(value.type, value.data)
}

function readHistoryEntries(entries: unknown[]) {
  return entries.filter(isHistoryEntry)
}

export function normalizePersistedHistory(value: unknown): PersistedHistory {
  if (isPersistedHistoryEnvelope(value)) {
    return {
      undo: readHistoryEntries(value.undo),
      redo: readHistoryEntries(value.redo),
    }
  }
  return { undo: [], redo: [] }
}

export function serializePersistedHistory(value: PersistedHistory): PersistedHistoryEnvelope {
  return {
    version: PERSISTED_HISTORY_VERSION,
    undo: value.undo,
    redo: value.redo,
  }
}
