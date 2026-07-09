export const parseHexColor = (value: unknown, fallback: string): string =>
  typeof value === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : fallback

export const colorInputValue = (color: string, fallback: string): string => {
  const parsed = parseHexColor(color, fallback)
  if (parsed.length !== 4) return parsed
  return `#${parsed[1]}${parsed[1]}${parsed[2]}${parsed[2]}${parsed[3]}${parsed[3]}`
}
