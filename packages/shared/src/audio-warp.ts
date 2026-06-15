export type AudioWarpMode = 'repitch' | 'stretch'

export type AudioWarpMarker = {
  id: string
  sourceBeat: number
  timelineBeat: number
}

export type AudioWarpPayload = {
  enabled: boolean
  sourceBpm?: number
  sourceBeatOffset?: number
  markers?: AudioWarpMarker[]
  mode: AudioWarpMode
}

const MIN_WARP_BPM = 30
const MAX_WARP_BPM = 300
const MIN_SOURCE_BEAT_OFFSET = -16
const MAX_SOURCE_BEAT_OFFSET = 16
const SOURCE_BEAT_OFFSET_PRECISION = 1_000

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const normalizeWarpBpm = (value: unknown) => (
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_WARP_BPM, Math.max(MIN_WARP_BPM, Math.round(value)))
    : undefined
)

const normalizeSourceBeatOffset = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const normalized = Math.round(
    Math.min(MAX_SOURCE_BEAT_OFFSET, Math.max(MIN_SOURCE_BEAT_OFFSET, value)) * SOURCE_BEAT_OFFSET_PRECISION,
  ) / SOURCE_BEAT_OFFSET_PRECISION
  return Object.is(normalized, -0) || normalized === 0 ? undefined : normalized
}

const normalizeMarkerBeat = (value: unknown) => (
  typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * SOURCE_BEAT_OFFSET_PRECISION) / SOURCE_BEAT_OFFSET_PRECISION
    : undefined
)

export function normalizeAudioWarpMarkers(value: unknown): AudioWarpMarker[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ordered = value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) return []
    const sourceBeat = normalizeMarkerBeat(entry.sourceBeat)
    const timelineBeat = normalizeMarkerBeat(entry.timelineBeat)
    return sourceBeat === undefined || timelineBeat === undefined ? [] : [{ id: entry.id, sourceBeat, timelineBeat }]
  }).sort((left, right) => left.timelineBeat - right.timelineBeat)

  const markers: AudioWarpMarker[] = []
  const ids = new Set<string>()
  for (const marker of ordered) {
    const previous = markers[markers.length - 1]
    if (ids.has(marker.id)) continue
    if (previous && (marker.timelineBeat <= previous.timelineBeat || marker.sourceBeat <= previous.sourceBeat)) continue
    ids.add(marker.id)
    markers.push(marker)
  }
  return markers.length > 0 ? markers : undefined
}

export function mapTimelineBeatToSourceBeat(markers: readonly AudioWarpMarker[], timelineBeat: number): number {
  if (markers.length === 0) return timelineBeat
  if (markers.length === 1) return timelineBeat + markers[0].sourceBeat - markers[0].timelineBeat
  const findSegment = () => {
    for (let index = 0; index < markers.length - 1; index++) {
      if (timelineBeat <= markers[index + 1].timelineBeat) return [markers[index], markers[index + 1]] as const
    }
    return [markers[markers.length - 2], markers[markers.length - 1]] as const
  }
  const [left, right] = timelineBeat < markers[0].timelineBeat
    ? [markers[0], markers[1]] as const
    : findSegment()
  const timelineSpan = Math.max(1e-6, right.timelineBeat - left.timelineBeat)
  return left.sourceBeat + (timelineBeat - left.timelineBeat) * ((right.sourceBeat - left.sourceBeat) / timelineSpan)
}

export function mapSourceBeatToTimelineBeat(markers: readonly AudioWarpMarker[], sourceBeat: number): number {
  if (markers.length === 0) return sourceBeat
  if (markers.length === 1) return sourceBeat + markers[0].timelineBeat - markers[0].sourceBeat
  const findSegment = () => {
    for (let index = 0; index < markers.length - 1; index++) {
      if (sourceBeat <= markers[index + 1].sourceBeat) return [markers[index], markers[index + 1]] as const
    }
    return [markers[markers.length - 2], markers[markers.length - 1]] as const
  }
  const [left, right] = sourceBeat < markers[0].sourceBeat
    ? [markers[0], markers[1]] as const
    : findSegment()
  const sourceSpan = Math.max(1e-6, right.sourceBeat - left.sourceBeat)
  return left.timelineBeat + (sourceBeat - left.sourceBeat) * ((right.timelineBeat - left.timelineBeat) / sourceSpan)
}

export const linearGainToDb = (gain: number) => (
  gain <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(gain)
)

export const dbToLinearGain = (db: number) => (
  Number.isFinite(db) ? Math.min(2, Math.max(0, 10 ** (db / 20))) : 0
)

const isDisabledDefaultWarp = (value: AudioWarpPayload | undefined) => (
  !value || (
    value.enabled === false
    && value.sourceBpm === undefined
    && value.sourceBeatOffset === undefined
    && value.mode === 'repitch'
  )
)

export function createDefaultAudioWarp(projectBpm: number): AudioWarpPayload {
  return {
    enabled: false,
    sourceBpm: normalizeWarpBpm(projectBpm),
    mode: 'repitch',
  }
}

export function normalizeAudioWarp(value: unknown): AudioWarpPayload | undefined {
  if (!isRecord(value)) return undefined
  return {
    enabled: 'enabled' in value ? Boolean(value.enabled) : false,
    sourceBpm: normalizeWarpBpm(value.sourceBpm),
    sourceBeatOffset: normalizeSourceBeatOffset(value.sourceBeatOffset),
    markers: normalizeAudioWarpMarkers(value.markers),
    mode: value.mode === 'stretch' ? 'stretch' : 'repitch',
  }
}

export function audioWarpEqual(left: AudioWarpPayload | undefined, right: AudioWarpPayload | undefined) {
  if (isDisabledDefaultWarp(left) && isDisabledDefaultWarp(right)) return true
  return left?.enabled === right?.enabled
    && left?.sourceBpm === right?.sourceBpm
    && (left?.sourceBeatOffset ?? 0) === (right?.sourceBeatOffset ?? 0)
    && JSON.stringify(left?.markers ?? []) === JSON.stringify(right?.markers ?? [])
    && (left?.mode ?? 'repitch') === (right?.mode ?? 'repitch')
}
