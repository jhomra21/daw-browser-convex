export const structuredCloneJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return Array.from(value, (item) => item === undefined ? null : structuredCloneJsonValue(item))
  }
  if (typeof value !== 'object' || value === null) return value
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, structuredCloneJsonValue(item)]),
  )
}
