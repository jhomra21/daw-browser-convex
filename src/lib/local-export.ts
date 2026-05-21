type SaveBlobInput = {
  blob: Blob
  suggestedName: string
  types?: FilePickerAcceptType[]
}

export const saveBlobLocally = async (input: SaveBlobInput): Promise<void> => {
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({
      suggestedName: input.suggestedName,
      types: input.types,
    })
    const writable = await handle.createWritable?.()
    if (!writable) {
      throw new Error('Writable file streams are not supported.')
    }
    await writable.write(input.blob)
    await writable.close()
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
