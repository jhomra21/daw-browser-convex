export type PendingTrackMixState = {
  muted?: boolean
  soloed?: boolean
}

export function pruneMapToKeys<TId extends string, T>(
  current: Map<TId, T>,
  existingKeys: Set<TId>,
) {
  let next: Map<TId, T> | null = null
  for (const [key] of current) {
    if (existingKeys.has(key)) continue
    if (!next) next = new Map(current)
    next.delete(key)
  }
  return next ?? current
}

export function reuseMapIfEqual<TId extends string, T>(
  previous: Map<TId, T> | undefined,
  next: Map<TId, T>,
  areEqual: (left: T, right: T | undefined) => boolean,
) {
  if (!previous) return next
  if (previous.size !== next.size) return next
  for (const [key, value] of previous) {
    const nextValue = next.get(key)
    if (!next.has(key) || !areEqual(value, nextValue)) {
      return next
    }
  }
  return previous
}

export function isPendingTrackMixStateEqual(
  left: PendingTrackMixState,
  right: PendingTrackMixState,
) {
  return left.muted === right.muted && left.soloed === right.soloed
}
