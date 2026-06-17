export const DEFAULT_MASTER_VOLUME = 1

export function normalizeMasterVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MASTER_VOLUME
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100))
}
