import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'

import { createAudioPcmSourceResolver } from './audio-pcm-source-resolver'
import { createLocalProject, openLocalProjectDb } from './local-project-db'

const writeAscii = (bytes: Uint8Array, offset: number, value: string) => {
  bytes.set(new TextEncoder().encode(value), offset)
}

const wave = () => {
  const frames = 5
  const bytes = new Uint8Array(44 + frames * 2)
  const view = new DataView(bytes.buffer)
  writeAscii(bytes, 0, 'RIFF')
  view.setUint32(4, bytes.byteLength - 8, true)
  writeAscii(bytes, 8, 'WAVE')
  writeAscii(bytes, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 48_000, true)
  view.setUint32(28, 96_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(bytes, 36, 'data')
  view.setUint32(40, frames * 2, true)
  return bytes
}

const dataUrl = (bytes: Uint8Array) => {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
  return `data:audio/wav;base64,${btoa(binary)}`
}

const clip = (input: {
  id?: string
  sourceAssetKey?: string
  sampleUrl?: string
}) => ({
  id: input.id ?? 'clip-1',
  name: 'Audio',
  startSec: 0,
  duration: 1,
  color: '#fff',
  sourceAssetKey: input.sourceAssetKey,
  sampleUrl: input.sampleUrl,
  sourceDurationSec: 5 / 48_000,
  sourceSampleRate: 48_000,
  sourceChannelCount: 1,
  buffer: undefined,
})

test('resolves a metadata-only cloud asset through its canonical project URL', async () => {
  const calls: string[] = []
  const resolver = createAudioPcmSourceResolver({
    projectId: () => 'project/cloud',
    resolveUrl: (value) => {
      calls.push(value)
      return dataUrl(wave())
    },
  })

  const result = await resolver(clip({ sourceAssetKey: 'asset/cloud' }))

  expect(calls).toEqual(['/api/samples/project%2Fcloud/asset%2Fcloud'])
  expect(result.identity).toBe('asset:project/cloud:asset/cloud')
})

test('resolves a local asset from its local File without deriving a cloud URL', async () => {
  const project = await createLocalProject(`Resolver ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  await db.put('assets', {
    id: 'asset:local',
    name: 'sample.wav',
    mimeType: 'audio/wav',
    sizeBytes: wave().byteLength,
    storagePath: 'sample.wav',
    contentHash: 'content-hash',
    durationSec: 5 / 48_000,
    sampleRate: 48_000,
    channelCount: 1,
    createdAt: 1,
    updatedAt: 1,
  })
  const calls: string[] = []
  const resolver = createAudioPcmSourceResolver({
    projectId: () => project.id,
    resolveUrl: (value) => {
      calls.push(value)
      return value
    },
    readLocalAsset: async () => ({
      status: 'ready',
      file: new File([wave()], 'sample.wav', { type: 'audio/wav' }),
    }),
  })

  const result = await resolver(clip({ sourceAssetKey: 'asset:local' }))

  expect(calls).toEqual([])
  expect(result.identity).toBe('asset:local:content-hash')
})

test('preserves the explicit URL for legacy URL-backed clips', async () => {
  const calls: string[] = []
  const resolver = createAudioPcmSourceResolver({
    projectId: () => 'project/cloud',
    resolveUrl: (value) => {
      calls.push(value)
      return dataUrl(wave())
    },
  })
  const sampleUrl = 'https://legacy.example/audio.wav'

  await resolver(clip({ sampleUrl }))

  expect(calls).toEqual([sampleUrl])
})

test('reports a missing project ID for a metadata-only cloud asset', async () => {
  const resolver = createAudioPcmSourceResolver({
    projectId: () => undefined,
  })

  await expect(resolver(clip({ sourceAssetKey: 'cloud-asset' })))
    .rejects.toThrow('requires a project ID to resolve cloud audio asset "cloud-asset"')
})
