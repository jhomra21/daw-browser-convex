// Shared index/selection helpers for API handlers

export const toZeroBased = (n: any): number | undefined => {
  if (n === null || n === undefined) return undefined
  const x = Number(n)
  if (!Number.isFinite(x)) return undefined
  const floored = Math.floor(x)
  return floored - 1
}

export const asPositiveIndex = (n: any): number | undefined => {
  const idx = toZeroBased(n)
  return (typeof idx === 'number' && idx >= 0) ? idx : undefined
}

export function trackAtIndex<T>(list: readonly T[] | undefined, value: any): T | undefined {
  const idx = asPositiveIndex(value)
  return (typeof idx === 'number' && list) ? (list[idx] as T | undefined) : undefined
}

export function clipAtIndex<T>(clips: readonly T[], value: any): T | undefined {
  const idx = toZeroBased(value)
  if (typeof idx !== 'number') return undefined
  const safeIdx = idx < 0 ? 0 : idx
  return clips[safeIdx]
}

export function clipsFromIndices<T>(clips: readonly T[], values: readonly any[] | undefined): T[] {
  if (!Array.isArray(values) || values.length === 0) return []
  return values.map(v => clipAtIndex(clips, v)).filter(Boolean) as T[]
}

export function normalizeTrackIndices(values: readonly any[] | undefined): number[] {
  if (!Array.isArray(values) || values.length === 0) return []
  const result: number[] = []
  for (const v of values) {
    const idx = asPositiveIndex(v)
    if (typeof idx === 'number') result.push(idx)
  }
  return result
}
