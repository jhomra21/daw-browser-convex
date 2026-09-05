import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'

import { createAudioPcmSourceResolver } from './audio-pcm-source-resolver'
import { createLocalProject, openLocalProjectDb } from './local-project-db'
import { sha256File } from '@daw-browser/audio-engine/media-pages'

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
  expect(result.identity).toMatch(/^asset:local:session:[0-9a-f-]{36}$/u)
  expect(result.persistable).toBe(false)
})

test('admits a local content hash only after verifying the resolved File bytes', async () => {
  const project = await createLocalProject(`Verified resolver ${crypto.randomUUID()}`)
  const file = new File([wave()], 'sample.wav', { type: 'audio/wav' })
  const db = await openLocalProjectDb(project.id)
  await db.put('assets', {
    id: 'asset:verified',
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    storagePath: 'sample.wav',
    contentHash: await sha256File(file),
    durationSec: 5 / 48_000,
    sampleRate: 48_000,
    channelCount: 1,
    createdAt: 1,
    updatedAt: 1,
  })
  const resolver = createAudioPcmSourceResolver({
    projectId: () => project.id,
    readLocalAsset: async () => ({ status: 'ready', file }),
  })

  const result = await resolver(clip({ sourceAssetKey: 'asset:verified' }))

  expect(result.contentHashVerified).toBe(true)
  expect(result.persistable).toBe(true)
  expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/u)
  expect(result.identity).toBe(`asset:verified:${result.contentHash}`)
})

test('does not alias different files that carry the same forged canonical hash', async () => {
  const project = await createLocalProject(`Forged resolver ${crypto.randomUUID()}`)
  const firstBytes = wave()
  const secondBytes = wave()
  secondBytes[44] = 7
  const db = await openLocalProjectDb(project.id)
  for (const id of ['asset:forged-a', 'asset:forged-b']) {
    await db.put('assets', {
      id,
      name: `${id}.wav`,
      mimeType: 'audio/wav',
      sizeBytes: firstBytes.byteLength,
      storagePath: `${id}.wav`,
      contentHash: 'a'.repeat(64),
      durationSec: 5 / 48_000,
      sampleRate: 48_000,
      channelCount: 1,
      createdAt: 1,
      updatedAt: 1,
    })
  }
  const resolver = createAudioPcmSourceResolver({
    projectId: () => project.id,
    readLocalAsset: async (_projectId, assetId) => ({
      status: 'ready',
      file: new File([assetId.endsWith('a') ? firstBytes : secondBytes], `${assetId}.wav`, { type: 'audio/wav' }),
    }),
  })

  const first = await resolver(clip({ sourceAssetKey: 'asset:forged-a' }))
  const second = await resolver(clip({ sourceAssetKey: 'asset:forged-b' }))

  expect(first.persistable).toBe(false)
  expect(second.persistable).toBe(false)
  expect(first.identity).not.toBe(second.identity)
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
