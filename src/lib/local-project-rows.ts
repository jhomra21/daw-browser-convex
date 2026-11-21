import type { LocalProjectStoredValue } from '~/lib/local-project-db'

export const TRACK_ROW_KIND = 'track'
export const CLIP_ROW_KIND = 'clip'
export const EFFECT_ROW_KIND = 'effect'
export const AUTOMATION_ROW_KIND = 'automation-envelope'
export const SIDECHAIN_ROW_KIND = 'sidechain-route'

export type LocalProjectStoredObject = { readonly [key: string]: LocalProjectStoredValue }

export const isLocalProjectStoredObject = (
  value: LocalProjectStoredValue,
): value is LocalProjectStoredObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === null
}
