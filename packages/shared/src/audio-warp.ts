export type AudioWarpMode = 'repitch' | 'stretch'

export type AudioWarpPayload = {
  enabled: boolean
  sourceBpm?: number
  sourceBeatOffset?: number
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
    mode: value.mode === 'stretch' ? 'stretch' : 'repitch',
  }
}

export function audioWarpEqual(left: AudioWarpPayload | undefined, right: AudioWarpPayload | undefined) {
  if (isDisabledDefaultWarp(left) && isDisabledDefaultWarp(right)) return true
  return left?.enabled === right?.enabled
    && left?.sourceBpm === right?.sourceBpm
    && (left?.sourceBeatOffset ?? 0) === (right?.sourceBeatOffset ?? 0)
    && (left?.mode ?? 'repitch') === (right?.mode ?? 'repitch')
}
