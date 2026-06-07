import { queryFileSystemHandlePermission, requestFileSystemHandlePermission } from '~/lib/local-project-db'
import { createLocalExportWritable, type LocalExportWritable } from '~/lib/local-export'

const STEMS_DIRECTORY_NAME = 'stems'

export const sanitizeStemFileName = (name: string): string => {
  const safeName = name.trim().replace(/[/\\:<>|?*"']/g, '-').replace(/\s+/g, ' ')
  return safeName || 'stem'
}

const requestWritableDirectory = async (handle: FileSystemDirectoryHandle): Promise<void> => {
  const current = await queryFileSystemHandlePermission(handle)
  if (current === 'granted') return
  const requested = await requestFileSystemHandlePermission(handle)
  if (requested !== 'granted') throw new DOMException('Stem export folder permission is required.', 'NotAllowedError')
}

export const chooseStemExportDirectory = async (): Promise<FileSystemDirectoryHandle> => {
  if (typeof window === 'undefined' || !window.showDirectoryPicker) {
    throw new Error('Folder selection is not supported in this browser.')
  }
  const selectedDirectory = await window.showDirectoryPicker()
  await requestWritableDirectory(selectedDirectory)
  return selectedDirectory.getDirectoryHandle(STEMS_DIRECTORY_NAME, { create: true })
}

export const createStemExportWritable = async (
  stemsDir: FileSystemDirectoryHandle,
  fileName: string,
): Promise<LocalExportWritable> => {
  const fileHandle = await stemsDir.getFileHandle(fileName, { create: true })
  return createLocalExportWritable(fileHandle)
}
