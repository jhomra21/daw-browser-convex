export type AgentMixFallbackMode = 'last-track' | 'all-tracks' | 'none'

export function toZeroBasedCommandIndex(value: number | undefined | null) {
  if (value == null || !Number.isFinite(value)) return undefined
  const normalized = Math.floor(value) - 1
  return normalized >= 0 ? normalized : undefined
}

export function normalizeCommandTrackIndices(values: readonly number[] | undefined) {
  if (!Array.isArray(values) || values.length === 0) return []
  const result: number[] = []
  for (const value of values) {
    const index = toZeroBasedCommandIndex(value)
    if (typeof index === 'number') result.push(index)
  }
  return result
}

export function resolveAgentMixTargetIndices(input: {
  trackCount: number
  trackIndex?: number
  trackIndices?: number[]
  fallback: AgentMixFallbackMode
}) {
  const clamp = (indices: number[]) => indices.filter((index) => index >= 0 && index < Math.max(0, input.trackCount))

  const explicit = clamp(normalizeCommandTrackIndices(input.trackIndices))
  if (explicit.length > 0) return explicit

  const single = toZeroBasedCommandIndex(input.trackIndex)
  if (typeof single === 'number') return clamp([single])

  switch (input.fallback) {
    case 'last-track':
      return input.trackCount > 0 ? [input.trackCount - 1] : []
    case 'all-tracks':
      return Array.from({ length: Math.max(0, input.trackCount) }, (_, index) => index)
    default:
      return []
  }
}
