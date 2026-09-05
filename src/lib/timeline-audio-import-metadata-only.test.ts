import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'

import type { Clip, Track } from '@daw-browser/timeline-core/types'
import { createLocalProject } from './local-project-db'
import { createLocalTimelineRepository } from './timeline-repository/local-timeline-repository'
import { createAudioImportTransaction } from './timeline-audio-import'

const createAssetStorage = () => {
  const files = new Map<string, File>()
  const assets = {
    getFileHandle: async (name: string) => ({
      getFile: async () => files.get(name) ?? new File([], name),
      createWritable: async () => {
        let written: File | undefined
        return {
          write: async (file: File) => {
            written = file
          },
          close: async () => {
            if (written) files.set(name, written)
          },
          abort: async () => undefined,
        }
      },
    }),
    removeEntry: async (name: string) => {
      files.delete(name)
    },
  }
  const root = {
    getDirectoryHandle: async (name: string) => name === 'assets' ? assets : root,
  }
  return { root }
}

test('creates a local audio clip from persisted metadata without an AudioBuffer', async () => {
  const storage = Object.getOwnPropertyDescriptor(navigator, 'storage')
  const { root } = createAssetStorage()
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => root },
  })

  try {
    const project = await createLocalProject(`Metadata import ${crypto.randomUUID()}`)
    const persistedTrack = (await createLocalTimelineRepository(project.id).loadSnapshot()).tracks[0]
    if (!persistedTrack) throw new Error('Expected a persisted track.')
    const track: Track = { ...persistedTrack, clips: [] }
    const inserted: Clip[] = []
    const transaction = createAudioImportTransaction({
      project: {
        projectId: () => project.id,
        userId: () => undefined,
        tracks: () => [track],
        isActiveProjectTrack: () => true,
      },
      clips: {
        buffers: {
          writer: {
            storeBuffer: () => { throw new Error('AudioBuffer cache must remain optional.') },
            storeBuffers: () => { throw new Error('AudioBuffer cache must remain optional.') },
            removeBuffer: () => undefined,
          },
          getBuffer: () => undefined,
          getMediaStatus: () => undefined,
          preload: async () => undefined,
        },
        insertLocalClip: (_trackId, clip) => inserted.push(clip),
        selectClip: () => undefined,
        pushTrackClipCreateHistory: () => undefined,
      },
      cloud: { uploadToR2: async () => null },
      rollback: {
        removeLocalTrack: async () => undefined,
        removeCloudTrack: async () => undefined,
      },
    })

    const result = await transaction.createUploadedFileClip({
      file: new File(['project-owned-source'], 'long-source.wav', { type: 'audio/wav' }),
      source: {
        durationSec: 6 * 60 * 60,
        sampleRate: 48_000,
        channelCount: 2,
      },
      track,
      startSec: 0,
    })

    expect(result.status).toBe('created')
    if (result.status !== 'created') throw new Error('Expected a created local clip.')
    expect(inserted[0]).toMatchObject({
      id: result.clipId,
      buffer: null,
      duration: 6 * 60 * 60,
      sourceAssetKey: result.assetId,
      sourceDurationSec: 6 * 60 * 60,
      sourceSampleRate: 48_000,
      sourceChannelCount: 2,
    })
  } finally {
    if (storage) Object.defineProperty(navigator, 'storage', storage)
    else Reflect.deleteProperty(navigator, 'storage')
  }
})
