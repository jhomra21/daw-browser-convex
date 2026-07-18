import { chooseLocalExportDirectory, createLocalExportDirectoryWritable, type LocalExportWritable } from '~/lib/local-export'
import { sanitizeStemFileName } from '~/lib/export/stem-file-names'

const STEMS_DIRECTORY_NAME = 'stems'

export const chooseStemExportDirectory = async (): Promise<FileSystemDirectoryHandle> => {
  const selectedDirectory = await chooseLocalExportDirectory()
  return selectedDirectory.getDirectoryHandle(STEMS_DIRECTORY_NAME, { create: true })
}

export const createStemExportWritable = async (
  stemsDir: FileSystemDirectoryHandle,
  fileName: string,
): Promise<LocalExportWritable> => {
  return createLocalExportDirectoryWritable(stemsDir, sanitizeStemFileName(fileName))
}
