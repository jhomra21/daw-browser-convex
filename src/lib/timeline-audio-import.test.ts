import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'

import type { Clip, Track } from '@daw-browser/timeline-core/types'
import { createLocalProject, openLocalProjectDb } from './local-project-db'
import { readLocalAssetBytes } from './local-assets'
import { createLocalTimelineRepository } from './timeline-repository/local-timeline-repository'
import { createAudioImportTransaction } from './timeline-audio-import'

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 1
  readonly length = 44_100
  readonly numberOfChannels = 1
  readonly sampleRate = 44_100

  copyFromChannel(destination: Float32Array, _channelNumber: number, _bufferOffset?: number) {
    destination.fill(0)
  }

  copyToChannel(_source: Float32Array, _channelNumber: number, _bufferOffset?: number) {}

  getChannelData(_channel: number) {
    return new Float32Array(this.length)
  }
}

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
  return { files, root }
}

test('host audio import persists bytes and the canonical local asset identity', async () => {
  const storage = Object.getOwnPropertyDescriptor(navigator, 'storage')
  const { root } = createAssetStorage()
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => root },
  })

  try {
    const project = await createLocalProject(`Host import ${crypto.randomUUID()}`)
    const db = await openLocalProjectDb(project.id)
    const persistedTrack = (await createLocalTimelineRepository(project.id).loadSnapshot()).tracks[0]
    if (!persistedTrack) throw new Error('Expected a persisted track.')
    const track: Track = { ...persistedTrack, clips: [] }
    const inserted: Clip[] = []
    const decoded = new TestAudioBuffer()
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
            storeBuffer: () => undefined,
            storeBuffers: () => undefined,
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
      file: new File(['host-import-bytes'], 'host-import.wav', { type: 'audio/wav' }),
      decoded,
      track,
      startSec: 0,
    })

    expect(result.status).toBe('created')
    if (result.status !== 'created') throw new Error('Expected a created local clip.')
    expect(inserted[0]).toMatchObject({
      id: result.clipId,
      sourceAssetKey: result.assetId,
    })

    const asset = await db.get('assets', result.assetId)
    expect(asset).toMatchObject({
      id: result.assetId,
      storagePath: `${result.assetId}.wav`,
      sourceKind: 'upload',
    })
    const retained = await readLocalAssetBytes(project.id, result.assetId)
    expect(retained.status).toBe('ready')
    if (retained.status === 'ready') {
      expect(await retained.file.text()).toBe('host-import-bytes')
    }
  } finally {
    if (storage) Object.defineProperty(navigator, 'storage', storage)
    else Reflect.deleteProperty(navigator, 'storage')
  }
})
