export const DEFAULT_MIXER_VOLUME = 1
export const MAX_MIXER_VOLUME = 2
export const MIXER_VOLUME_MIN_DB = -60
export const MIXER_VOLUME_MAX_DB = 6
export const MIXER_VOLUME_SLIDER_STEP = 0.001

export const DEFAULT_MASTER_VOLUME = DEFAULT_MIXER_VOLUME

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

export function normalizeMixerVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MIXER_VOLUME
  return Math.round(clamp(value, 0, MAX_MIXER_VOLUME) * 100) / 100
}

export function normalizeMasterVolume(value: number): number {
  return normalizeMixerVolume(value)
}

export function mixerVolumeToDb(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return Number.NEGATIVE_INFINITY
  return 20 * Math.log10(value)
}

export function formatMixerVolumeDb(value: number): string {
  const normalized = Number.isFinite(value)
    ? clamp(value, 0, MAX_MIXER_VOLUME)
    : 0
  if (normalized === 0) return '-inf'
  const db = mixerVolumeToDb(normalized)
  const formatted = db.toFixed(1)
  return db > 0 ? `+${formatted}` : formatted
}

export function mixerVolumeToSliderPosition(value: number): number {
  const db = mixerVolumeToDb(value)
  if (!Number.isFinite(db)) return 0
  return clamp(
    (db - MIXER_VOLUME_MIN_DB) / (MIXER_VOLUME_MAX_DB - MIXER_VOLUME_MIN_DB),
    0,
    1,
  )
}

export function mixerSliderPositionToVolume(position: number): number {
  const normalizedPosition = clamp(
    Number.isFinite(position) ? position : 0,
    0,
    1,
  )
  if (normalizedPosition === 0) return 0
  const db =
    MIXER_VOLUME_MIN_DB +
    normalizedPosition * (MIXER_VOLUME_MAX_DB - MIXER_VOLUME_MIN_DB)
  return normalizeMixerVolume(10 ** (db / 20))
}
