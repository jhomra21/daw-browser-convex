import { streamThirtyTrackMixedRateWav } from './mixed-rate-media'
import type { planThirtyTrackMixedRateSources } from './spec'

type Source = ReturnType<typeof planThirtyTrackMixedRateSources>[number]
type WritableDirectory = Pick<FileSystemDirectoryHandle, 'getFileHandle' | 'removeEntry'>

export const writeThirtyTrackV3MediaFile = async (
  source: Source,
  directory: WritableDirectory,
): Promise<File> => {
  const name = `30-track-v3-source-${source.trackIndex}.wav`
  const handle = await directory.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  try {
    for await (const page of streamThirtyTrackMixedRateWav(source)) await writable.write(page)
    await writable.close()
    const file = await handle.getFile()
    if (file.size !== source.uncompressedBytes + 44) throw new Error('Mixed-rate WAV length changed during storage.')
    return file
  } catch (error) {
    await writable.abort().catch(() => undefined)
    await directory.removeEntry(name).catch(() => undefined)
    throw error
  }
}
