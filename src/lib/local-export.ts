type SaveBlobInput = {
  blob: Blob
  suggestedName: string
  types?: FilePickerAcceptType[]
}

type LocalExportWritableInput = {
  suggestedName: string
  types?: FilePickerAcceptType[]
}

type LocalExportWritable = {
  writable: FileSystemWritableFileStream
}

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
