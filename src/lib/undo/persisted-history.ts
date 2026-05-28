import type { AudioSourceMetadata } from '~/lib/audio-source'
import { sanitizeAudioSourceKind } from '~/lib/audio-source-rules'
import type { HistoryClipSnapshot, HistoryEntry, PersistedHistory, TrackRoutingHistorySnapshot } from '~/lib/undo/types'

const PERSISTED_HISTORY_VERSION = 2 as const

type PersistedHistoryEnvelope = {
  version: typeof PERSISTED_HISTORY_VERSION
  undo: unknown[]
  redo: unknown[]
}

type LegacyPersistedHistory = {
  undo: unknown[]
  redo: unknown[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const next = value[key]
  return isRecord(next) ? next : undefined
}

function readString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const next = value?.[key]
  return typeof next === 'string' ? next : undefined
}

function readNumber(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const next = value?.[key]
  return typeof next === 'number' ? next : undefined
}

function readBoolean(value: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const next = value?.[key]
  return typeof next === 'boolean' ? next : undefined
}

function readArray(value: Record<string, unknown> | undefined, key: string): unknown[] {
  const next = value?.[key]
  return Array.isArray(next) ? next : []
}

function readAny(value: Record<string, unknown> | undefined, key: string): any {
  return value?.[key]
}

function readTrackKind(value: Record<string, unknown> | undefined, key: string): 'audio' | 'instrument' | undefined {
  const next = readString(value, key)
  return next === 'audio' || next === 'instrument' ? next : undefined
}

function readTrackChannelRole(value: Record<string, unknown> | undefined, key: string): 'track' | 'group' | 'return' | undefined {
  const next = readString(value, key)
  return next === 'track' || next === 'group' || next === 'return' ? next : undefined
}

function readAudioSourceMetadata(value: Record<string, unknown> | undefined): AudioSourceMetadata | undefined {
  const durationSec = readNumber(value, 'durationSec')
  const sampleRate = readNumber(value, 'sampleRate')
  const channelCount = readNumber(value, 'channelCount')
  if (durationSec === undefined || sampleRate === undefined || channelCount === undefined) return undefined
  return { durationSec, sampleRate, channelCount }
}

function readClipTiming(value: Record<string, unknown> | undefined): {
  leftPadSec?: number
  bufferOffsetSec?: number
  midiOffsetBeats?: number
} | undefined {
  if (!value) return undefined
  const leftPadSec = readNumber(value, 'leftPadSec')
  const bufferOffsetSec = readNumber(value, 'bufferOffsetSec')
  const midiOffsetBeats = readNumber(value, 'midiOffsetBeats')
  if (leftPadSec === undefined && bufferOffsetSec === undefined && midiOffsetBeats === undefined) return undefined
  return { leftPadSec, bufferOffsetSec, midiOffsetBeats }
}

function readRoutingSnapshot(value: Record<string, unknown> | undefined): TrackRoutingHistorySnapshot {
  return {
    sends: readArray(value, 'sends').flatMap((send) => {
      const record = isRecord(send) ? send : undefined
      const targetTrackRef = readString(record, 'targetTrackRef')
      const amount = readNumber(record, 'amount')
      if (!targetTrackRef || amount === undefined) return []
      return [{ targetTrackRef, amount }]
    }),
    outputTargetRef: readString(value, 'outputTargetRef'),
  }
}

function readEffectParamsEntry(
  projectId: string,
  effect: string | undefined,
  trackRef: string | undefined,
  data: Record<string, unknown>,
): HistoryEntry | null {
  const from = readAny(data, 'from')
  const to = readAny(data, 'to')

  switch (effect) {
    case 'eq':
      return { type: 'effect-params', projectId, data: { effect, trackRef, from, to } }
    case 'reverb':
      return { type: 'effect-params', projectId, data: { effect, trackRef, from, to } }
    case 'synth':
      return { type: 'effect-params', projectId, data: { effect, trackRef, from, to } }
    case 'arp':
      return { type: 'effect-params', projectId, data: { effect, trackRef, from, to } }
    case 'master-eq':
      return { type: 'effect-params', projectId, data: { effect, trackRef: undefined, from, to } }
    case 'master-reverb':
      return { type: 'effect-params', projectId, data: { effect, trackRef: undefined, from, to } }
    default:
      return null
  }
}

function readClipSnapshot(value: Record<string, unknown> | undefined): HistoryClipSnapshot | null {
  const clipRef = readString(value, 'clipRef')
  if (!clipRef) return null
  const source = readAudioSourceMetadata(readRecord(value, 'source'))
  const sourceKind = sanitizeAudioSourceKind(readString(value, 'sourceKind'))
  return {
    clipRef,
    startSec: readNumber(value, 'startSec') ?? 0,
    duration: readNumber(value, 'duration') ?? 0,
    name: readString(value, 'name'),
    sampleUrl: readString(value, 'sampleUrl'),
    source,
    sourceAssetKey: readString(value, 'sourceAssetKey'),
    sourceKind: sourceKind ?? undefined,
    midi: value?.midi,
    timing: readClipTiming(readRecord(value, 'timing')),
  }
}

function readLegacyClipSnapshot(
  value: Record<string, unknown> | undefined,
  clipRef: string,
): HistoryClipSnapshot {
  return {
    clipRef,
    startSec: readNumber(value, 'startSec') ?? 0,
    duration: readNumber(value, 'duration') ?? 0,
    name: readString(value, 'name'),
    sampleUrl: readString(value, 'sampleUrl'),
    midi: value?.midi,
    timing: readClipTiming(readRecord(value, 'timing')),
  }
}

function buildLegacyClipRef(prefix: string, index: number) {
  return `${prefix}:clip:${index}`
}

function readLegacyEntry(entry: Record<string, unknown>): HistoryEntry | null {
  const type = readString(entry, 'type')
  const projectId = readString(entry, 'projectId') ?? readString(entry, 'roomId') ?? ''
  const data = readRecord(entry, 'data')
  if (!type || !data) return null

  if (type === 'clip-create') {
    const trackId = readString(data, 'trackId')
    const clipRecord = readRecord(data, 'clip')
    const clipRef = readString(clipRecord, 'originalId') ?? readString(clipRecord, 'currentId')
    if (!trackId || !clipRecord || !clipRef) return null
    return {
      type,
      projectId,
      data: {
        trackRef: trackId,
        clip: {
          ...readLegacyClipSnapshot(clipRecord, clipRef),
          currentId: readString(clipRecord, 'currentId'),
        },
      },
    }
  }

  if (type === 'clip-delete') {
    const legacyItems = readArray(data, 'items').flatMap((item, index) => {
      const record = isRecord(item) ? item : undefined
      const trackId = readString(record, 'trackId')
      const clipRecord = readRecord(record, 'clip')
      if (!trackId || !clipRecord) return []
      const clipRef = buildLegacyClipRef(`${trackId}:delete`, index)
      return [{
        trackRef: trackId,
        clip: readLegacyClipSnapshot(clipRecord, clipRef),
      }]
    })
    const legacyTrackId = readString(data, 'trackId')
    const legacyClips = readArray(data, 'clips').flatMap((clip, index) => {
      const record = isRecord(clip) ? clip : undefined
      if (!legacyTrackId || !record) return []
      const clipRef = buildLegacyClipRef(`${legacyTrackId}:delete`, index)
      return [{
        trackRef: legacyTrackId,
        clip: readLegacyClipSnapshot(record, clipRef),
      }]
    })
    const items = legacyItems.length > 0 ? legacyItems : legacyClips
    if (items.length === 0) return null
    const recreatedClipIds = readArray(data, 'recreatedClipIds')
    return {
      type,
      projectId,
      data: {
        items,
        recreatedClips: items.flatMap((item, index) => {
          const clipId = typeof recreatedClipIds[index] === 'string' ? recreatedClipIds[index] : undefined
          if (!clipId) return []
          return [{ clipRef: item.clip.clipRef, clipId }]
        }),
      },
    }
  }

  if (type === 'clips-move') {
    const moves = readArray(data, 'moves').flatMap((move) => {
      const record = isRecord(move) ? move : undefined
      const from = readRecord(record, 'from')
      const to = readRecord(record, 'to')
      const clipId = readString(record, 'clipId')
      const fromTrackId = readString(from, 'trackId')
      const toTrackId = readString(to, 'trackId')
      if (!clipId || !fromTrackId || !toTrackId) return []
      return [{
        clipRef: clipId,
        from: { trackRef: fromTrackId, startSec: readNumber(from, 'startSec') ?? 0 },
        to: { trackRef: toTrackId, startSec: readNumber(to, 'startSec') ?? 0 },
      }]
    })
    return moves.length > 0
      ? {
          type,
          projectId,
          data: { moves },
        }
      : null
  }

  if (type === 'clip-timing') {
    const clipId = readString(data, 'clipId')
    const from = readRecord(data, 'from')
    const to = readRecord(data, 'to')
    if (!clipId) return null
    return {
      type,
      projectId,
      data: {
        clipRef: clipId,
        from: {
          startSec: readNumber(from, 'startSec') ?? 0,
          duration: readNumber(from, 'duration') ?? 0,
          leftPadSec: readNumber(from, 'leftPadSec'),
          bufferOffsetSec: readNumber(from, 'bufferOffsetSec'),
          midiOffsetBeats: readNumber(from, 'midiOffsetBeats'),
        },
        to: {
          startSec: readNumber(to, 'startSec') ?? 0,
          duration: readNumber(to, 'duration') ?? 0,
          leftPadSec: readNumber(to, 'leftPadSec'),
          bufferOffsetSec: readNumber(to, 'bufferOffsetSec'),
          midiOffsetBeats: readNumber(to, 'midiOffsetBeats'),
        },
      },
    }
  }

  if (type === 'track-create') {
    const trackId = readString(data, 'trackId')
    if (!trackId) return null
    return {
      type,
      projectId,
      data: {
        trackRef: trackId,
        currentTrackId: trackId,
        index: Number.MAX_SAFE_INTEGER,
        kind: readTrackKind(data, 'kind'),
        channelRole: undefined,
      },
    }
  }

  if (type === 'track-delete') {
    const track = readRecord(data, 'track')
    const trackId = readString(track, 'id')
    if (!trackId || !track) return null
    const clips = readArray(data, 'clips').flatMap((clip, index) => {
      const record = isRecord(clip) ? clip : undefined
      if (!record) return []
      return [readLegacyClipSnapshot(record, buildLegacyClipRef(`${trackId}:track-delete`, index))]
    })
    const recreatedClipIds = readArray(data, 'recreatedClipIds')
    return {
      type,
      projectId,
      data: {
        track: {
          trackRef: trackId,
          index: Number.MAX_SAFE_INTEGER,
          name: readString(track, 'name') ?? 'Track 1',
          volume: readNumber(track, 'volume') ?? 0.8,
          muted: readBoolean(track, 'muted'),
          soloed: readBoolean(track, 'soloed'),
          kind: readTrackKind(track, 'kind'),
          channelRole: undefined,
          routing: { sends: [], outputTargetRef: undefined },
        },
        clips,
        effects: isRecord(data.effects) ? {
          eq: readAny(data.effects, 'eq'),
          reverb: readAny(data.effects, 'reverb'),
          synth: readAny(data.effects, 'synth'),
          arp: readAny(data.effects, 'arp'),
        } : undefined,
        inboundRouting: [],
        recreatedTrackId: readString(data, 'recreatedTrackId'),
        recreatedClips: clips.flatMap((clip, index) => {
          const clipId = typeof recreatedClipIds[index] === 'string' ? recreatedClipIds[index] : undefined
          if (!clipId) return []
          return [{ clipRef: clip.clipRef, clipId }]
        }),
      },
    }
  }

  if (type === 'track-volume') {
    const trackId = readString(data, 'trackId')
    if (!trackId) return null
    return {
      type,
      projectId,
      data: {
        trackRef: trackId,
        scope: 'shared',
        from: readNumber(data, 'from') ?? 0,
        to: readNumber(data, 'to') ?? 0,
      },
    }
  }

  if (type === 'track-mute') {
    const trackId = readString(data, 'trackId')
    if (!trackId) return null
    return {
      type,
      projectId,
      data: {
        trackRef: trackId,
        scope: 'shared',
        from: !!readBoolean(data, 'from'),
        to: !!readBoolean(data, 'to'),
      },
    }
  }

  if (type === 'track-solo') {
    const trackId = readString(data, 'trackId')
    if (!trackId) return null
    return {
      type,
      projectId,
      data: {
        trackRef: trackId,
        scope: 'shared',
        from: !!readBoolean(data, 'from'),
        to: !!readBoolean(data, 'to'),
      },
    }
  }

  if (type === 'effect-params') {
    const effect = readString(data, 'effect')
    const targetId = readString(data, 'targetId')
    const trackRef = targetId && targetId !== 'master' ? targetId : undefined
    return readEffectParamsEntry(projectId, effect, trackRef, data)
  }

  return null
}

function readCurrentEntry(entry: Record<string, unknown>): HistoryEntry | null {
  const type = readString(entry, 'type')
  const projectId = readString(entry, 'projectId') ?? readString(entry, 'roomId') ?? ''
  const data = readRecord(entry, 'data')
  if (!type || !data) return null

  if (type === 'clip-create') {
    const trackRef = readString(data, 'trackRef')
    const clipRecord = readRecord(data, 'clip')
    const clip = readClipSnapshot(clipRecord)
    if (!trackRef || !clip) return null
    return {
      type,
      projectId,
      data: {
        trackRef,
        clip: {
          ...clip,
          currentId: readString(clipRecord, 'currentId'),
        },
      },
    }
  }

  if (type === 'clip-delete') {
    const items = readArray(data, 'items').flatMap((item) => {
      const record = isRecord(item) ? item : undefined
      const trackRef = readString(record, 'trackRef')
      const clip = readClipSnapshot(readRecord(record, 'clip'))
      if (!trackRef || !clip) return []
      return [{ trackRef, clip }]
    })
    return {
      type,
      projectId,
      data: {
        items,
        recreatedClips: readArray(data, 'recreatedClips').flatMap((item) => {
          const record = isRecord(item) ? item : undefined
          const clipRef = readString(record, 'clipRef')
          const clipId = readString(record, 'clipId')
          if (!clipRef || !clipId) return []
          return [{ clipRef, clipId }]
        }),
      },
    }
  }

  if (type === 'clips-move') {
    return {
      type,
      projectId,
      data: {
        moves: readArray(data, 'moves').flatMap((move) => {
          const record = isRecord(move) ? move : undefined
          const from = readRecord(record, 'from')
          const to = readRecord(record, 'to')
          const clipRef = readString(record, 'clipRef')
          const fromTrackRef = readString(from, 'trackRef')
          const toTrackRef = readString(to, 'trackRef')
          if (!clipRef || !fromTrackRef || !toTrackRef) return []
          return [{
            clipRef,
            from: { trackRef: fromTrackRef, startSec: readNumber(from, 'startSec') ?? 0 },
            to: { trackRef: toTrackRef, startSec: readNumber(to, 'startSec') ?? 0 },
          }]
        }),
      },
    }
  }

  if (type === 'clip-timing') {
    const clipRef = readString(data, 'clipRef')
    const from = readRecord(data, 'from')
    const to = readRecord(data, 'to')
    if (!clipRef) return null
    return {
      type,
      projectId,
      data: {
        clipRef,
        from: {
          startSec: readNumber(from, 'startSec') ?? 0,
          duration: readNumber(from, 'duration') ?? 0,
          leftPadSec: readNumber(from, 'leftPadSec'),
          bufferOffsetSec: readNumber(from, 'bufferOffsetSec'),
          midiOffsetBeats: readNumber(from, 'midiOffsetBeats'),
        },
        to: {
          startSec: readNumber(to, 'startSec') ?? 0,
          duration: readNumber(to, 'duration') ?? 0,
          leftPadSec: readNumber(to, 'leftPadSec'),
          bufferOffsetSec: readNumber(to, 'bufferOffsetSec'),
          midiOffsetBeats: readNumber(to, 'midiOffsetBeats'),
        },
      },
    }
  }

  if (type === 'track-create') {
    const trackRef = readString(data, 'trackRef')
    if (!trackRef) return null
    return {
      type,
      projectId,
      data: {
        trackRef,
        currentTrackId: readString(data, 'currentTrackId'),
        index: readNumber(data, 'index') ?? 0,
        kind: readTrackKind(data, 'kind'),
        channelRole: readTrackChannelRole(data, 'channelRole'),
      },
    }
  }

  if (type === 'track-clip-create') {
    const track = readRecord(data, 'track')
    const clipRecord = readRecord(data, 'clip')
    const trackRef = readString(track, 'trackRef')
    const clipTrackRef = readString(clipRecord, 'trackRef')
    const clip = readClipSnapshot(clipRecord)
    if (!trackRef || !clipTrackRef || !clip) return null
    return {
      type,
      projectId,
      data: {
        track: {
          trackRef,
          currentTrackId: readString(track, 'currentTrackId'),
          index: readNumber(track, 'index') ?? 0,
          kind: readTrackKind(track, 'kind'),
          channelRole: readTrackChannelRole(track, 'channelRole'),
        },
        clip: {
          ...clip,
          trackRef: clipTrackRef,
          currentId: readString(clipRecord, 'currentId'),
        },
      },
    }
  }

  if (type === 'track-delete') {
    const track = readRecord(data, 'track')
    const trackRef = readString(track, 'trackRef')
    if (!trackRef) return null
    return {
      type,
      projectId,
      data: {
        track: {
          trackRef,
          index: readNumber(track, 'index') ?? 0,
          name: readString(track, 'name') ?? 'Track 1',
          volume: readNumber(track, 'volume') ?? 0.8,
          muted: readBoolean(track, 'muted'),
          soloed: readBoolean(track, 'soloed'),
          kind: readTrackKind(track, 'kind'),
          channelRole: readTrackChannelRole(track, 'channelRole'),
          routing: readRoutingSnapshot(readRecord(track, 'routing')),
        },
        clips: readArray(data, 'clips').flatMap((clip) => {
          const record = isRecord(clip) ? clip : undefined
          const snapshot = readClipSnapshot(record)
          return snapshot ? [snapshot] : []
        }),
        effects: isRecord(data.effects) ? {
          eq: readAny(data.effects, 'eq'),
          reverb: readAny(data.effects, 'reverb'),
          synth: readAny(data.effects, 'synth'),
          arp: readAny(data.effects, 'arp'),
        } : undefined,
        inboundRouting: readArray(data, 'inboundRouting').flatMap((routing) => {
          const record = isRecord(routing) ? routing : undefined
          const sourceTrackRef = readString(record, 'sourceTrackRef')
          if (!sourceTrackRef) return []
          const routingSnapshot = readRoutingSnapshot(record)
          return [{
            sourceTrackRef,
            sends: routingSnapshot.sends,
            outputTargetRef: routingSnapshot.outputTargetRef,
          }]
        }),
        recreatedTrackId: readString(data, 'recreatedTrackId'),
        recreatedClips: readArray(data, 'recreatedClips').flatMap((item) => {
          const record = isRecord(item) ? item : undefined
          const clipRef = readString(record, 'clipRef')
          const clipId = readString(record, 'clipId')
          if (!clipRef || !clipId) return []
          return [{ clipRef, clipId }]
        }),
      },
    }
  }

  if (type === 'track-volume') {
    const trackRef = readString(data, 'trackRef')
    if (!trackRef) return null
    return {
      type,
      projectId,
      data: {
        trackRef,
        scope: readString(data, 'scope') === 'local' ? 'local' : 'shared',
        from: readNumber(data, 'from') ?? 0,
        to: readNumber(data, 'to') ?? 0,
      },
    }
  }

  if (type === 'track-mute') {
    const trackRef = readString(data, 'trackRef')
    if (!trackRef) return null
    return {
      type,
      projectId,
      data: {
        trackRef,
        scope: readString(data, 'scope') === 'local' ? 'local' : 'shared',
        from: !!readBoolean(data, 'from'),
        to: !!readBoolean(data, 'to'),
      },
    }
  }

  if (type === 'track-solo') {
    const trackRef = readString(data, 'trackRef')
    if (!trackRef) return null
    return {
      type,
      projectId,
      data: {
        trackRef,
        scope: readString(data, 'scope') === 'local' ? 'local' : 'shared',
        from: !!readBoolean(data, 'from'),
        to: !!readBoolean(data, 'to'),
      },
    }
  }

  if (type === 'track-routing') {
    const trackRef = readString(data, 'trackRef')
    if (!trackRef) return null
    return {
      type,
      projectId,
      data: {
        trackRef,
        from: readRoutingSnapshot(readRecord(data, 'from')),
        to: readRoutingSnapshot(readRecord(data, 'to')),
      },
    }
  }

  if (type === 'effect-params') {
    const effect = readString(data, 'effect')
    const trackRef = readString(data, 'trackRef')
    return readEffectParamsEntry(projectId, effect, trackRef, data)
  }

  return null
}

function isPersistedHistoryEnvelope(value: unknown): value is PersistedHistoryEnvelope {
  return isRecord(value) && value.version === PERSISTED_HISTORY_VERSION && Array.isArray(value.undo) && Array.isArray(value.redo)
}

function isLegacyPersistedHistory(value: unknown): value is LegacyPersistedHistory {
  return isRecord(value) && Array.isArray(value.undo) && Array.isArray(value.redo)
}

function readHistoryEntries(entries: unknown[]): HistoryEntry[] {
  return entries.flatMap((entry) => {
    const record = isRecord(entry) ? entry : undefined
    if (!record) return []
    const current = readCurrentEntry(record)
    if (current) return [current]
    const legacy = readLegacyEntry(record)
    return legacy ? [legacy] : []
  })
}

function serializeHistoryEntry(entry: HistoryEntry): unknown {
  if (entry.type === 'track-create') {
    return {
      ...entry,
      data: {
        trackRef: entry.data.trackRef,
        currentTrackId: entry.data.currentTrackId,
        index: entry.data.index,
        kind: entry.data.kind,
        channelRole: entry.data.channelRole,
      },
    }
  }

  if (entry.type === 'track-delete') {
    return {
      ...entry,
      data: {
        track: entry.data.track,
        clips: entry.data.clips,
        effects: entry.data.effects,
        inboundRouting: entry.data.inboundRouting,
        recreatedTrackId: entry.data.recreatedTrackId,
        recreatedClips: entry.data.recreatedClips,
      },
    }
  }

  return entry
}

export function normalizePersistedHistory(value: unknown): PersistedHistory {
  if (isPersistedHistoryEnvelope(value)) {
    return {
      undo: readHistoryEntries(value.undo),
      redo: readHistoryEntries(value.redo),
    }
  }
  if (isLegacyPersistedHistory(value)) {
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
    undo: value.undo.map(serializeHistoryEntry),
    redo: value.redo.map(serializeHistoryEntry),
  }
}
