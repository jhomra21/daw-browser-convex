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
        const chunks: Uint8Array[] = []
        return {
          write: async (chunk: Uint8Array) => { chunks.push(chunk) },
          close: async () => {
            const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
            let offset = 0
            for (const chunk of chunks) {
              bytes.set(chunk, offset)
              offset += chunk.byteLength
            }
            files.set(name, new File([bytes], name))
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

test('rethrows an aborted cloud upload instead of converting it to a failed import', async () => {
  const controller = new AbortController()
  const track: Track = {
    id: 'cloud-track',
    historyRef: 'cloud-track',
    name: 'Cloud track',
    volume: 1,
    clips: [],
  }
  const inserted: Clip[] = []
  const removed: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async () => {
      controller.abort(new DOMException('Import canceled.', 'AbortError'))
      return new Response('request canceled', { status: 500 })
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    const transaction = createAudioImportTransaction({
      project: {
        projectId: () => 'cloud-project',
        userId: () => 'user-1',
        tracks: () => [track],
        isActiveProjectTrack: () => true,
      },
      clips: {
        buffers: {
          writer: {
            storeBuffer: () => undefined,
            storeBuffers: () => undefined,
            removeBuffer: (clipId) => removed.push(clipId),
          },
          getBuffer: () => undefined,
          getMediaStatus: () => undefined,
          preload: async () => undefined,
        },
        insertLocalClip: (_trackId, clip) => inserted.push(clip),
        removeLocalClips: (clipIds) => removed.push(...clipIds),
        selectClip: () => undefined,
        pushTrackClipCreateHistory: () => undefined,
      },
      cloud: {
        uploadToR2: async () => ({ assetKey: 'asset-1', url: 'https://example.test/asset-1.wav' }),
      },
      rollback: {
        removeLocalTrack: async () => undefined,
        removeCloudTrack: async () => undefined,
      },
    })

    await expect(transaction.createUploadedFileClip({
      file: new File(['audio'], 'clip.wav', { type: 'audio/wav' }),
      source: { durationSec: 1, sampleRate: 44_100, channelCount: 1 },
      track,
      startSec: 0,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    globalThis.fetch = originalFetch
  }

  expect(inserted).toHaveLength(1)
  expect(inserted[0]?.id).toStartWith('pending:')
  expect(removed.some((clipId) => clipId.startsWith('pending:'))).toBe(true)
})
