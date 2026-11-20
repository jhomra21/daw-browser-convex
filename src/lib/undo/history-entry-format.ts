import {
  AUDIO_EFFECT_KINDS,
  isAudioEffectKind,
  isJsonBoolean,
  isJsonNumber,
  isJsonObject,
  isJsonString,
  normalizeAudioWarp,
  type JsonObject,
  type JsonValue,
} from '@daw-browser/shared'
import type { EffectType, HistoryEntry } from '~/lib/undo/types'

const EFFECT_TYPES: ReadonlySet<string> = new Set([
  ...AUDIO_EFFECT_KINDS,
  'synth',
  'instrument',
  'arp',
  ...AUDIO_EFFECT_KINDS.map((effect): EffectType => `master-${effect}`),
])

const isEffectType = (value: JsonValue): value is EffectType => isJsonString(value) && EFFECT_TYPES.has(value)

const isString = (value: JsonValue): value is string => isJsonString(value)
const isNumber = (value: JsonValue): value is number => isJsonNumber(value) && Number.isFinite(value)
const isBoolean = (value: JsonValue): value is boolean => isJsonBoolean(value)
const isScope = (value: JsonValue) => value === 'shared' || value === 'local'
const isAudioWarp = (value: JsonValue) => normalizeAudioWarp(value) !== undefined

const isClipFades = (value: JsonValue) => isJsonObject(value)
  && isNumber(value.fadeInSec)
  && isNumber(value.fadeOutSec)
  && isNumber(value.fadeInCurve)
  && isNumber(value.fadeOutCurve)

const isClipTiming = (value: JsonValue) => isJsonObject(value)
  && isNumber(value.startSec)
  && isNumber(value.duration)
  && (value.leftPadSec === undefined || isNumber(value.leftPadSec))
  && (value.bufferOffsetSec === undefined || isNumber(value.bufferOffsetSec))
  && (value.audioWarp === undefined || isAudioWarp(value.audioWarp))
  && (value.gain === undefined || isNumber(value.gain))
  && (value.fades === undefined || isClipFades(value.fades))
  && (value.midiOffsetBeats === undefined || isNumber(value.midiOffsetBeats))

const isMidiNote = (value: JsonValue) => isJsonObject(value)
  && isString(value.id)
  && isNumber(value.beat)
  && isNumber(value.length)
  && isNumber(value.pitch)
  && isNumber(value.channel)
  && (value.velocity === undefined || isNumber(value.velocity))

const isMidiNoteChange = (value: JsonValue) => isJsonObject(value)
  && isString(value.id)
  && (value.before !== undefined || value.after !== undefined)
  && (value.before === undefined || isMidiNote(value.before))
  && (value.after === undefined || isMidiNote(value.after))

const isRoutingSnapshot = (value: JsonValue) => isJsonObject(value)
  && Array.isArray(value.sends)
  && value.sends.every((send) => isJsonObject(send) && isString(send.targetTrackRef) && isNumber(send.amount))
  && (value.outputTargetRef === undefined || isString(value.outputTargetRef))

const isSidechainRouteSnapshot = (value: JsonValue) => isJsonObject(value)
  && isString(value.sourceTrackRef)
  && isString(value.targetTrackRef)
  && isString(value.effectInstanceId)

const isClipSnapshot = (value: JsonValue) => isJsonObject(value)
  && isString(value.clipRef)
  && isNumber(value.startSec)
  && isNumber(value.duration)
  && (value.currentId === undefined || isString(value.currentId))
  && (value.recoveryId === undefined || isString(value.recoveryId))
  && (value.recoveryOperationId === undefined || isString(value.recoveryOperationId))
  && (value.recoverySourceClipId === undefined || isString(value.recoverySourceClipId))
  && (value.deleteOperationId === undefined || isString(value.deleteOperationId))
  && (value.name === undefined || isString(value.name))
  && (value.sampleUrl === undefined || isString(value.sampleUrl))
  && (value.sourceAssetKey === undefined || isString(value.sourceAssetKey))
  && (value.sourceKind === undefined || isString(value.sourceKind))
  && (value.gain === undefined || isNumber(value.gain))
  && (value.fades === undefined || isClipFades(value.fades))
  && (
    value.timing === undefined
    || isJsonObject(value.timing) && isClipTiming({ startSec: 0, duration: 0, ...value.timing })
  )

const isTrackCreateData = (value: JsonValue) => isJsonObject(value)
  && isString(value.trackRef)
  && isNumber(value.index)
  && (value.currentTrackId === undefined || isString(value.currentTrackId))
  && (value.kind === undefined || value.kind === 'audio' || value.kind === 'instrument')
  && (value.channelRole === undefined || value.channelRole === 'track' || value.channelRole === 'group' || value.channelRole === 'return')
  && (value.collapsed === undefined || isBoolean(value.collapsed))
  && (value.color === undefined || isString(value.color))

const isTrackSnapshot = (value: JsonValue) => isJsonObject(value)
  && (value.trackRef === undefined || isString(value.trackRef))
  && isNumber(value.index)
  && isString(value.name)
  && isNumber(value.volume)
  && (value.muted === undefined || isBoolean(value.muted))
  && (value.soloed === undefined || isBoolean(value.soloed))
  && (value.kind === undefined || value.kind === 'audio' || value.kind === 'instrument')
  && (value.channelRole === undefined || value.channelRole === 'track' || value.channelRole === 'group' || value.channelRole === 'return')
  && isRoutingSnapshot(value.routing)

const isTrackGroupChildUpdate = (value: JsonValue) => isJsonObject(value)
  && isString(value.trackRef)
  && (value.previousGroupRef === undefined || isString(value.previousGroupRef))
  && (value.previousOutputTargetRef === undefined || isString(value.previousOutputTargetRef))
  && (value.nextOutputTargetRef === undefined || isString(value.nextOutputTargetRef))

const isTrackUngroupChildSnapshot = (value: JsonValue) => isJsonObject(value)
  && isString(value.trackRef)
  && isString(value.previousGroupRef)
  && (value.previousOutputTargetRef === undefined || isString(value.previousOutputTargetRef))
  && (value.nextOutputTargetRef === undefined || isString(value.nextOutputTargetRef))

const isAutomationPoint = (value: JsonValue) => isJsonObject(value)
  && isString(value.id)
  && isNumber(value.timeSec)
  && isNumber(value.value)
  && (value.interpolation === 'linear' || value.interpolation === 'hold')

const isAutomationEnvelope = (value: JsonValue) => isJsonObject(value)
  && isString(value.id)
  && isString(value.projectId)
  && isJsonObject(value.target)
  && (value.target.kind === 'master' || (value.target.kind === 'track' && isString(value.target.trackId)))
  && isString(value.targetKey)
  && isString(value.parameterId)
  && isBoolean(value.enabled)
  && Array.isArray(value.points)
  && value.points.every(isAutomationPoint)
  && isNumber(value.updatedAt)

const isTrackAutomationSnapshot = (value: JsonValue) => (
  Array.isArray(value) && value.every(isAutomationEnvelope)
)

const isTrackEffectSnapshot = (value: JsonValue) => {
  if (!isJsonObject(value)) return false
  const audioEffects = value.audioEffects

  return (audioEffects === undefined || (Array.isArray(audioEffects) && audioEffects.every((effect) => (
    isJsonObject(effect)
    && isAudioEffectKind(effect.effect)
    && effect.params !== undefined
    && (effect.instanceId === undefined || isString(effect.instanceId))
    && (effect.index === undefined || isNumber(effect.index))
  ))))
}

type HistoryEntryOf<Type extends HistoryEntry['type']> = Extract<HistoryEntry, { type: Type }>

type ValidateContext = { allowSectionEdit: boolean; version: number }

// How one entry type is read from persisted JSON and merged within a gesture; replay lives in exec.ts.
type HistoryEntryFormat<Type extends HistoryEntry['type']> = {
  validate: (data: JsonObject, context: ValidateContext) => boolean
  // Entries persisted before v7 get rewritten on read; readEntries re-reads nested entries the same way.
  upgradeLegacy?: (entry: HistoryEntryOf<Type>, readEntries: (entries: HistoryEntry[]) => HistoryEntry[]) => HistoryEntryOf<Type>
  // Two consecutive entries of one gesture collapse into one, or stay separate when this returns undefined.
  merge?: (prev: HistoryEntryOf<Type>, entry: HistoryEntryOf<Type>) => HistoryEntryOf<Type> | undefined
}

type HistoryEntryFormats = { [Type in HistoryEntry['type']]: HistoryEntryFormat<Type> }

const keepFirstFrom = <Entry extends { data: { from: unknown } }>(prev: Entry, entry: Entry): Entry => (
  { ...entry, data: { ...entry.data, from: prev.data.from } }
)

const isTrackMixData = (data: JsonObject) => isString(data.trackRef) && isScope(data.scope) && isBoolean(data.from) && isBoolean(data.to)

const isOptionalColor = (data: JsonObject) => (data.from === undefined || isString(data.from)) && (data.to === undefined || isString(data.to))

// A missing row is a type error.
const HISTORY_ENTRY_FORMATS: HistoryEntryFormats = {
  'section-edit': {
    validate: (data, { allowSectionEdit, version }) => allowSectionEdit
      && Array.isArray(data.entries)
      && data.entries.every((entry) => isHistoryEntryValue(entry, false, version)),
    upgradeLegacy: (entry, readEntries) => ({ ...entry, data: { ...entry.data, entries: readEntries(entry.data.entries) } }),
  },
  'control-range-delete': {
    validate: (data) => Array.isArray(data.trackRefs)
      && data.trackRefs.length > 0
      && data.trackRefs.every(isString)
      && isNumber(data.startSec)
      && isNumber(data.endSec)
      && data.endSec > data.startSec
      && isString(data.recoveryId)
      && (data.restoreOperationId === undefined || isString(data.restoreOperationId))
      && (data.deleteOperationId === undefined || isString(data.deleteOperationId))
      && (data.restoreExpectedRevision === undefined || isNumber(data.restoreExpectedRevision))
      && (data.deleteExpectedRevision === undefined || isNumber(data.deleteExpectedRevision))
      && (data.deleteApprovalToken === undefined || isString(data.deleteApprovalToken)),
  },
  'clip-create': { validate: (data) => isString(data.trackRef) && isClipSnapshot(data.clip) },
  'clip-delete': {
    validate: (data) => Array.isArray(data.items)
      && data.items.every((item) => isJsonObject(item) && isString(item.trackRef) && isClipSnapshot(item.clip))
      && (data.legacyRecreate === undefined || isBoolean(data.legacyRecreate))
      && (data.deleteOperationId === undefined || isString(data.deleteOperationId)),
    upgradeLegacy: (entry) => entry.data.items.some((item) => !item.clip.recoveryId)
      ? {
        ...entry,
        data: {
          ...entry.data,
          items: entry.data.items.map((item) => ({ ...item, clip: { ...item.clip, legacyHistory: true } })),
          legacyRecreate: true,
        },
      }
      : entry,
  },
  'clips-move': {
    validate: (data) => Array.isArray(data.moves)
      && data.moves.every((move) => isJsonObject(move)
        && isString(move.clipRef)
        && isJsonObject(move.from)
        && isString(move.from.trackRef)
        && isNumber(move.from.startSec)
        && isJsonObject(move.to)
        && isString(move.to.trackRef)
        && isNumber(move.to.startSec)),
  },
  'clip-timing': {
    validate: (data) => isString(data.clipRef) && isClipTiming(data.from) && isClipTiming(data.to),
    merge: keepFirstFrom,
  },
  'clip-audio-warp': {
    validate: (data) => isString(data.clipRef)
      && isJsonObject(data.from)
      && isAudioWarp(data.from.audioWarp)
      && isJsonObject(data.to)
      && isAudioWarp(data.to.audioWarp),
  },
  'clip-fades': {
    validate: (data) => isString(data.clipRef) && isClipFades(data.from) && isClipFades(data.to),
    merge: keepFirstFrom,
  },
  'clip-midi-notes': { validate: (data) => isString(data.clipRef) && Array.isArray(data.changes) && data.changes.every(isMidiNoteChange) },
  'clip-color': { validate: (data) => isString(data.clipRef) && isOptionalColor(data) },
  'track-create': { validate: isTrackCreateData },
  'track-clip-create': { validate: (data) => isJsonObject(data.track) && isTrackCreateData(data.track) && isJsonObject(data.clip) && isClipSnapshot(data.clip) },
  'track-delete': {
    validate: (data) => isTrackSnapshot(data.track)
      && Array.isArray(data.clips)
      && data.clips.every(isClipSnapshot)
      && (data.automation === undefined || (Array.isArray(data.automation) && data.automation.every(isAutomationEnvelope)))
      && (data.sidechainRoutes === undefined || (Array.isArray(data.sidechainRoutes) && data.sidechainRoutes.every(isSidechainRouteSnapshot)))
      && (data.recreatedTrackId === undefined || isString(data.recreatedTrackId)),
  },
  'track-volume': {
    validate: (data) => isString(data.trackRef) && isScope(data.scope) && isNumber(data.from) && isNumber(data.to),
    merge: keepFirstFrom,
  },
  'track-mute': { validate: isTrackMixData, merge: keepFirstFrom },
  'track-solo': { validate: isTrackMixData, merge: keepFirstFrom },
  'track-routing': {
    validate: (data) => isString(data.trackRef) && isRoutingSnapshot(data.from) && isRoutingSnapshot(data.to),
    merge: keepFirstFrom,
  },
  'track-group': {
    validate: (data) => isString(data.groupTrackRef)
      && (data.currentGroupTrackId === undefined || isString(data.currentGroupTrackId))
      && isJsonObject(data.groupTrack)
      && isNumber(data.groupTrack.index)
      && isString(data.groupTrack.name)
      && (data.groupTrack.color === undefined || isString(data.groupTrack.color))
      && Array.isArray(data.childUpdates)
      && data.childUpdates.every(isTrackGroupChildUpdate),
  },
  'track-ungroup': {
    validate: (data, { version }) => isString(data.groupTrackRef)
      && (data.sourceGroupTrackId === undefined || isString(data.sourceGroupTrackId))
      && (data.currentGroupTrackId === undefined || isString(data.currentGroupTrackId))
      && (data.restoreOperationId === undefined || isString(data.restoreOperationId))
      && (isTrackSnapshot(data.groupTrack) || (version >= 3 && data.groupTrack === undefined))
      && (data.effects === undefined || isTrackEffectSnapshot(data.effects))
      && (data.automation === undefined || isTrackAutomationSnapshot(data.automation))
      && (data.sidechainRoutes === undefined || (Array.isArray(data.sidechainRoutes) && data.sidechainRoutes.every(isSidechainRouteSnapshot)))
      && Array.isArray(data.childSnapshots)
      && data.childSnapshots.every(isTrackUngroupChildSnapshot),
  },
  'track-color': { validate: (data) => isString(data.trackRef) && isOptionalColor(data) },
  'track-color-cascade': {
    validate: (data) => Array.isArray(data.tracks)
      && data.tracks.every((update) => isJsonObject(update) && isString(update.trackRef) && isOptionalColor(update))
      && Array.isArray(data.clips)
      && data.clips.every((update) => isJsonObject(update)
        && isString(update.clipRef)
        && (update.from === undefined || isString(update.from))
        && isString(update.to)),
  },
  'track-reorder': {
    validate: (data) => Array.isArray(data.patches)
      && data.patches.every((patch) => isJsonObject(patch)
        && isString(patch.trackRef)
        && isNumber(patch.fromIndex)
        && isNumber(patch.toIndex)
        && (patch.fromGroupRef === undefined || isString(patch.fromGroupRef))
        && (patch.toGroupRef === undefined || isString(patch.toGroupRef))
        && (patch.fromOutputTargetRef === undefined || isString(patch.fromOutputTargetRef))
        && (patch.toOutputTargetRef === undefined || isString(patch.toOutputTargetRef))),
  },
  'effect-params': {
    validate: (data) => (data.trackRef === undefined || isString(data.trackRef))
      && (data.instanceId === undefined || isString(data.instanceId))
      && isEffectType(data.effect)
      && isJsonObject(data.from)
      && isJsonObject(data.to),
    merge: (prev, entry) => (
      prev.data.effect === entry.data.effect
      && prev.data.trackRef === entry.data.trackRef
      && prev.data.instanceId === entry.data.instanceId
        ? keepFirstFrom(prev, entry)
        : undefined
    ),
  },
  'automation-envelope-change': {
    validate: (data) => (data.before === null || isAutomationEnvelope(data.before))
      && (data.after === null || isAutomationEnvelope(data.after)),
  },
}

const formatOf = <Type extends HistoryEntry['type']>(type: Type): HistoryEntryFormat<Type> => HISTORY_ENTRY_FORMATS[type]

const isHistoryEntryType = (type: string): type is HistoryEntry['type'] => Object.hasOwn(HISTORY_ENTRY_FORMATS, type)

export function isHistoryEntryValue(
  value: JsonValue,
  allowSectionEdit: boolean,
  version: number,
): value is JsonObject & HistoryEntry {
  return isJsonObject(value)
    && typeof value.type === 'string'
    && typeof value.projectId === 'string'
    && isJsonObject(value.data)
    && isHistoryEntryType(value.type)
    && formatOf(value.type).validate(value.data, { allowSectionEdit, version })
}

export const upgradeLegacyHistoryEntry = (
  entry: HistoryEntry,
  readEntries: (entries: HistoryEntry[]) => HistoryEntry[],
): HistoryEntry => formatOf(entry.type).upgradeLegacy?.(entry, readEntries) ?? entry

export const mergeHistoryEntries = (prev: HistoryEntry, entry: HistoryEntry): HistoryEntry | undefined => (
  formatOf(entry.type).merge?.(prev, entry)
)
