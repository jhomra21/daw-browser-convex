export const formatBytes = (bytes?: number): string => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const formatted = value >= 10 ? value.toFixed(0) : value.toFixed(1)
  return `${formatted} ${units[unitIndex]}`
}
