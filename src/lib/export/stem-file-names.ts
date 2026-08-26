export const sanitizeStemFileName = (name: string): string => {
  const safeName = name.trim().replace(/[/\\:<>|?*"']/g, '-').replace(/\s+/g, ' ')
  return safeName || 'stem'
}

export const createUniqueStemFileName = (
  stemName: string,
  extension: string,
  usedNames: Set<string>,
): string => {
  const baseName = sanitizeStemFileName(stemName)
  let index = 1
  while (true) {
    const fileName = index === 1
      ? `${baseName}${extension}`
      : `${baseName} ${index}${extension}`
    if (!usedNames.has(fileName)) {
      usedNames.add(fileName)
      return fileName
    }
    index += 1
  }
}
