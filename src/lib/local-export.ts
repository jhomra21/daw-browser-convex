import type { EncodeAudioBufferTarget } from '@daw-browser/audio-engine/export-mixdown'

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

type LocalExportWritable = {
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
    const handle = await chooseLocalExportFile(input)
    if (!handle) return
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
