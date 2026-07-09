import { isHexColor } from '@daw-browser/shared'

export const parseHexColor = (value: unknown, fallback: string): string =>
  typeof value === "string" && isHexColor(value) ? value : fallback

export const colorInputValue = (color: string, fallback: string): string => {
  const parsed = parseHexColor(color, fallback)
  if (parsed.length !== 4) return parsed
  return `#${parsed[1]}${parsed[1]}${parsed[2]}${parsed[2]}${parsed[3]}${parsed[3]}`
}
