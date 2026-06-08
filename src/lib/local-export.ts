import type { EncodeAudioBufferTarget } from '@daw-browser/audio-engine/export-mixdown'
import { queryFileSystemHandlePermission, requestFileSystemHandlePermission } from '~/lib/local-project-db'

type BlobDownloadInput = {
  blob: Blob
  suggestedName: string
}

type SaveBlobInput = BlobDownloadInput & {
  types?: FilePickerAcceptType[]
}

type LocalExportWritableInput = {
  suggestedName: string
  types?: FilePickerAcceptType[]
}

export type LocalExportWritable = {
  writable: FileSystemWritableFileStream
}

type LocalExportTarget = Extract<EncodeAudioBufferTarget, { mode: 'stream' }>

export const chooseLocalExportFile = async (input: LocalExportWritableInput): Promise<FileSystemFileHandle | undefined> => {
  if (typeof window === 'undefined' || !window.showSaveFilePicker) return
  return await window.showSaveFilePicker({
    suggestedName: input.suggestedName,
    types: input.types,
  })
}

export const createLocalExportWritable = async (handle: FileSystemFileHandle): Promise<LocalExportWritable> => {
  const writable = await handle.createWritable?.()
  if (!writable) throw new Error('Writable file streams are not supported.')
  return { writable }
}

const requestWritableExportDirectory = async (handle: FileSystemDirectoryHandle): Promise<void> => {
  const current = await queryFileSystemHandlePermission(handle)
  if (current === 'granted') return
  const requested = await requestFileSystemHandlePermission(handle)
  if (requested !== 'granted') throw new DOMException('Export folder permission is required.', 'NotAllowedError')
}

export const chooseLocalExportDirectory = async (): Promise<FileSystemDirectoryHandle> => {
  if (typeof window === 'undefined' || !window.showDirectoryPicker) {
    throw new Error('Folder selection is not supported in this browser.')
  }
  const directory = await window.showDirectoryPicker()
  await requestWritableExportDirectory(directory)
  return directory
}

export const createLocalExportDirectoryWritable = async (
  directory: FileSystemDirectoryHandle,
  fileName: string,
): Promise<LocalExportWritable> => {
  const fileHandle = await directory.getFileHandle(fileName, { create: true })
  return createLocalExportWritable(fileHandle)
}

export const createLocalExportTarget = (localExport: LocalExportWritable): LocalExportTarget => ({
  mode: 'stream',
  writable: localExport.writable,
  close: () => localExport.writable.close(),
  abort: (reason) => localExport.writable.abort(reason),
})

export const downloadBlob = (input: BlobDownloadInput): void => {
  const url = URL.createObjectURL(input.blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = input.suggestedName
    anchor.rel = 'noopener'
    anchor.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}

export const saveBlobLocally = async (input: SaveBlobInput): Promise<void> => {
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({
      suggestedName: input.suggestedName,
      types: input.types,
    })
    const { writable } = await createLocalExportWritable(handle)
    try {
      await writable.write(input.blob)
      await writable.close()
    } catch (error) {
      try {
        await writable.abort()
      } catch {}
      throw error
    }
    return
  }

  downloadBlob(input)
}
