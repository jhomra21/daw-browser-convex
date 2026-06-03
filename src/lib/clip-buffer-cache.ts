import type { Clip } from '~/types/timeline'

type ClipMediaStatus = NonNullable<Clip['mediaStatus']>
export type EnsureClipBuffer = (clipId: string, sampleUrl?: string) => Promise<void>

type ClipBufferCache = {
  readonly size: number
  getBuffer: (clipId: string) => AudioBuffer | undefined
  hasBuffer: (clipId: string) => boolean
  storeBuffer: (clipId: string, buffer: AudioBuffer) => void
  storeBuffers: (entries: Iterable<readonly [string, AudioBuffer]>) => void
  storeSharedBuffer: (clipIds: Iterable<string>, buffer: AudioBuffer) => void
  removeBuffer: (clipId: string) => void
  clear: () => void
}

export type ClipBufferWriter = Pick<ClipBufferCache, 'storeBuffer' | 'storeBuffers' | 'removeBuffer'>

export type ClipMediaCache = {
  getBuffer: (clipId: string) => AudioBuffer | undefined
  getMediaStatus: (clipId: string) => ClipMediaStatus | undefined
}

export type ClipBuffers = ClipMediaCache & {
  writer: ClipBufferWriter
  preload: EnsureClipBuffer
}

type ClipMediaStatusCache = {
  get: (clipId: string) => ClipMediaStatus | undefined
  set: (clipId: string, status: ClipMediaStatus) => void
  delete: (clipId: string) => boolean
  clear: () => void
  readonly size: number
}

export function createClipBufferCache(input: {
  mediaStatus: ClipMediaStatusCache
  onChange: () => void
}): ClipBufferCache {
  const buffers = new Map<string, AudioBuffer>()

  const clearMediaStatus = (clipId: string) => input.mediaStatus.delete(clipId)

  const notifyIfChanged = (didChange: boolean) => {
    if (didChange) input.onChange()
  }

  const setEntries = (entries: Iterable<readonly [string, AudioBuffer]>) => {
    let didChange = false
    for (const [clipId, buffer] of entries) {
      didChange = clearMediaStatus(clipId) || buffers.get(clipId) !== buffer || didChange
      buffers.set(clipId, buffer)
    }
    notifyIfChanged(didChange)
  }

  return {
    get size() {
      return buffers.size
    },
    getBuffer: (clipId) => buffers.get(clipId),
    hasBuffer: (clipId) => buffers.has(clipId),
    storeBuffer: (clipId, buffer) => {
      setEntries([[clipId, buffer]])
    },
    storeBuffers: (entries) => {
      setEntries(entries)
    },
    storeSharedBuffer: (clipIds, buffer) => {
      setEntries(Array.from(clipIds, (clipId): readonly [string, AudioBuffer] => [clipId, buffer]))
    },
    removeBuffer: (clipId) => {
      const hadMediaStatus = input.mediaStatus.delete(clipId)
      notifyIfChanged(buffers.delete(clipId) || hadMediaStatus)
    },
    clear: () => {
      const hadBuffers = buffers.size > 0
      const hadMediaStatus = input.mediaStatus.size > 0
      if (!hadBuffers && !hadMediaStatus) return
      buffers.clear()
      input.mediaStatus.clear()
      notifyIfChanged(true)
    },
  }
}
