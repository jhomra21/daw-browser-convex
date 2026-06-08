import { chooseLocalExportDirectory, createLocalExportDirectoryWritable, type LocalExportWritable } from '~/lib/local-export'

const STEMS_DIRECTORY_NAME = 'stems'

export const sanitizeStemFileName = (name: string): string => {
  const safeName = name.trim().replace(/[/\\:<>|?*"']/g, '-').replace(/\s+/g, ' ')
  return safeName || 'stem'
}

export const chooseStemExportDirectory = async (): Promise<FileSystemDirectoryHandle> => {
  const selectedDirectory = await chooseLocalExportDirectory()
  return selectedDirectory.getDirectoryHandle(STEMS_DIRECTORY_NAME, { create: true })
}

export const createStemExportWritable = async (
  stemsDir: FileSystemDirectoryHandle,
  fileName: string,
): Promise<LocalExportWritable> => {
  return createLocalExportDirectoryWritable(stemsDir, fileName)
}
