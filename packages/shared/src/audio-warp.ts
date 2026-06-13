export type AudioWarpMode = 'repitch' | 'stretch'

export type AudioWarpPayload = {
  enabled: boolean
  sourceBpm?: number
  mode: AudioWarpMode
}

const MIN_WARP_BPM = 30
const MAX_WARP_BPM = 300

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const normalizeWarpBpm = (value: unknown) => (
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_WARP_BPM, Math.max(MIN_WARP_BPM, Math.round(value)))
    : undefined
)

const isDisabledDefaultWarp = (value: AudioWarpPayload | undefined) => (
  !value || (value.enabled === false && value.sourceBpm === undefined && value.mode === 'repitch')
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
    mode: value.mode === 'stretch' ? 'stretch' : 'repitch',
  }
}

export function audioWarpEqual(left: AudioWarpPayload | undefined, right: AudioWarpPayload | undefined) {
  if (isDisabledDefaultWarp(left) && isDisabledDefaultWarp(right)) return true
  return left?.enabled === right?.enabled
    && left?.sourceBpm === right?.sourceBpm
    && (left?.mode ?? 'repitch') === (right?.mode ?? 'repitch')
}
