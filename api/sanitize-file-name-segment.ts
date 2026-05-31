export const sanitizeFileNameSegment = (name: string | undefined, fallback: string) => {
  const sanitize = (value: string) => value
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 180)
  const baseName = name?.toString() || fallback
  const normalizedName = baseName.replace(/\\/g, '/')
  const fileNameSegment = normalizedName.slice(normalizedName.lastIndexOf('/') + 1)
  const sanitized = sanitize(fileNameSegment)
  if (sanitized) return sanitized
  return sanitize(fallback) || 'file'
}
