import { normalizeAudioWarp } from '@daw-browser/shared'
import { AUDIO_EFFECT_ORDER, type AudioEffectKind } from '@daw-browser/shared'
import type { EffectType, HistoryEntry, PersistedHistory } from '~/lib/undo/types'

const PERSISTED_HISTORY_VERSION = 3 as const
const READABLE_PERSISTED_HISTORY_VERSIONS: ReadonlySet<number> = new Set([2, PERSISTED_HISTORY_VERSION])

type PersistedHistoryEnvelope = {
  version: number
  undo: unknown[]
  redo: unknown[]
}

const EFFECT_TYPES: ReadonlySet<string> = new Set([
  ...AUDIO_EFFECT_ORDER,
  'synth',
  'instrument',
  'arp',
  ...AUDIO_EFFECT_ORDER.map((effect): EffectType => `master-${effect}`),
])

const isEffectType = (value: unknown): value is EffectType => typeof value === 'string' && EFFECT_TYPES.has(value)

const isAudioEffectKind = (value: unknown): value is AudioEffectKind =>
  typeof value === 'string' && AUDIO_EFFECT_ORDER.some((effect) => effect === value)

function isPersistedHistoryEnvelope(value: unknown): value is PersistedHistoryEnvelope {
  return isRecord(value)
    && isNumber(value.version)
    && READABLE_PERSISTED_HISTORY_VERSIONS.has(value.version)
    && Array.isArray(value.undo)
    && Array.isArray(value.redo)
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
  && (value.color === undefined || isString(value.color))

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

const isTrackGroupChildUpdate = (value: unknown) => isRecord(value)
  && isString(value.trackRef)
  && (value.previousGroupRef === undefined || isString(value.previousGroupRef))
  && (value.previousOutputTargetRef === undefined || isString(value.previousOutputTargetRef))
  && (value.nextOutputTargetRef === undefined || isString(value.nextOutputTargetRef))

const isTrackUngroupChildSnapshot = (value: unknown) => isRecord(value)
  && isString(value.trackRef)
  && isString(value.previousGroupRef)
  && (value.previousOutputTargetRef === undefined || isString(value.previousOutputTargetRef))
  && (value.nextOutputTargetRef === undefined || isString(value.nextOutputTargetRef))

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

const isTrackAutomationSnapshot = (value: unknown) => (
  Array.isArray(value) && value.every(isAutomationEnvelope)
)

const isTrackEffectSnapshot = (value: unknown) => {
  if (!isRecord(value)) return false
  const audioEffects = value.audioEffects
  return (audioEffects === undefined || (Array.isArray(audioEffects) && audioEffects.every((effect) => (
    isRecord(effect)
    && isAudioEffectKind(effect.effect)
    && effect.params !== undefined
    && (effect.instanceId === undefined || isString(effect.instanceId))
    && (effect.index === undefined || isNumber(effect.index))
  ))))
}

function isHistoryEntryData(type: string, data: Record<string, unknown>, allowSectionEdit: boolean, version: number) {
  switch (type) {
    case 'section-edit':
      return allowSectionEdit
        && Array.isArray(data.entries)
        && data.entries.every((entry) => isHistoryEntryValue(entry, false, version))
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
    case 'clip-color':
      return isString(data.clipRef)
        && (data.from === undefined || isString(data.from))
        && (data.to === undefined || isString(data.to))
    case 'track-create':
      return isTrackCreateData(data)
    case 'track-clip-create':
      return isRecord(data.track) && isTrackCreateData(data.track) && isRecord(data.clip) && isClipSnapshot(data.clip)
    case 'track-delete':
      return isTrackSnapshot(data.track)
        && Array.isArray(data.clips)
        && data.clips.every(isClipSnapshot)
        && (data.automation === undefined || (Array.isArray(data.automation) && data.automation.every(isAutomationEnvelope)))
        && (data.recreatedTrackId === undefined || isString(data.recreatedTrackId))
    case 'track-volume':
      return isString(data.trackRef) && isScope(data.scope) && isNumber(data.from) && isNumber(data.to)
    case 'track-mute':
    case 'track-solo':
      return isString(data.trackRef) && isScope(data.scope) && isBoolean(data.from) && isBoolean(data.to)
    case 'track-routing':
      return isString(data.trackRef) && isRoutingSnapshot(data.from) && isRoutingSnapshot(data.to)
    case 'track-group':
      return isString(data.groupTrackRef)
        && (data.currentGroupTrackId === undefined || isString(data.currentGroupTrackId))
        && isRecord(data.groupTrack)
        && isNumber(data.groupTrack.index)
        && isString(data.groupTrack.name)
        && (data.groupTrack.color === undefined || isString(data.groupTrack.color))
        && Array.isArray(data.childUpdates)
        && data.childUpdates.every(isTrackGroupChildUpdate)
    case 'track-ungroup':
      return isString(data.groupTrackRef)
        && (data.sourceGroupTrackId === undefined || isString(data.sourceGroupTrackId))
        && (data.currentGroupTrackId === undefined || isString(data.currentGroupTrackId))
        && (data.restoreOperationId === undefined || isString(data.restoreOperationId))
        && (isTrackSnapshot(data.groupTrack) || (version === PERSISTED_HISTORY_VERSION && data.groupTrack === undefined))
        && (data.effects === undefined || isTrackEffectSnapshot(data.effects))
        && (data.automation === undefined || isTrackAutomationSnapshot(data.automation))
        && Array.isArray(data.childSnapshots)
        && data.childSnapshots.every(isTrackUngroupChildSnapshot)
    case 'track-color':
      return isString(data.trackRef)
        && (data.from === undefined || isString(data.from))
        && (data.to === undefined || isString(data.to))
    case 'track-color-cascade':
      return Array.isArray(data.tracks)
        && data.tracks.every((update) => isRecord(update)
          && isString(update.trackRef)
          && (update.from === undefined || isString(update.from))
          && (update.to === undefined || isString(update.to)))
        && Array.isArray(data.clips)
        && data.clips.every((update) => isRecord(update)
          && isString(update.clipRef)
          && (update.from === undefined || isString(update.from))
          && isString(update.to))
    case 'track-reorder':
      return Array.isArray(data.patches)
        && data.patches.every((patch) => isRecord(patch)
          && isString(patch.trackRef)
          && isNumber(patch.fromIndex)
          && isNumber(patch.toIndex)
          && (patch.fromGroupRef === undefined || isString(patch.fromGroupRef))
          && (patch.toGroupRef === undefined || isString(patch.toGroupRef))
          && (patch.fromOutputTargetRef === undefined || isString(patch.fromOutputTargetRef))
          && (patch.toOutputTargetRef === undefined || isString(patch.toOutputTargetRef)))
    case 'effect-params':
      return (data.trackRef === undefined || isString(data.trackRef))
        && (data.instanceId === undefined || isString(data.instanceId))
        && isEffectType(data.effect)
        && isRecord(data.from)
        && isRecord(data.to)
    case 'automation-envelope-change':
      return (data.before === null || isAutomationEnvelope(data.before))
        && (data.after === null || isAutomationEnvelope(data.after))
    default:
      return false
  }
}

function isHistoryEntryValue(value: unknown, allowSectionEdit: boolean, version: number): value is HistoryEntry {
  return isRecord(value)
    && typeof value.type === 'string'
    && typeof value.projectId === 'string'
    && isRecord(value.data)
    && isHistoryEntryData(value.type, value.data, allowSectionEdit, version)
}

function isHistoryEntry(value: unknown, version: number): value is HistoryEntry {
  return isHistoryEntryValue(value, true, version)
}

function readHistoryEntries(entries: unknown[], version: number) {
  return entries.filter((entry) => isHistoryEntry(entry, version))
}

export function normalizePersistedHistory(value: unknown): PersistedHistory {
  if (isPersistedHistoryEnvelope(value)) {
    return {
      undo: readHistoryEntries(value.undo, value.version),
      redo: readHistoryEntries(value.redo, value.version),
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
