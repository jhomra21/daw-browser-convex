import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'

import { createAudioPcmSourceResolver } from './audio-pcm-source-resolver'
import { createLocalProject, openLocalProjectDb } from './local-project-db'
import { sha256File } from '@daw-browser/audio-engine/media-pages'
import type { AudioStretchRuntimeClip } from '@daw-browser/audio-engine/audio-stretch-rendering'

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

const deferred = <Value>() => {
  let resolve: (value: Value) => void = () => {}
  const promise = new Promise<Value>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

const installFetch = (handler: () => Promise<Response>) => {
  const originalFetch = globalThis.fetch
  const fetchForTest: typeof fetch = async () => handler()
  fetchForTest.preconnect = () => {}
  globalThis.fetch = fetchForTest
  return () => {
    globalThis.fetch = originalFetch
  }
}

const clip = (input: {
  id?: string
  sourceAssetKey?: string
  sampleUrl?: string
  stretch?: boolean
}): AudioStretchRuntimeClip => ({
  id: input.id ?? 'clip-1',
  startSec: 0,
  duration: 1,
  sourceAssetKey: input.sourceAssetKey,
  sampleUrl: input.sampleUrl,
  sourceDurationSec: 5 / 48_000,
  sourceSampleRate: 48_000,
  sourceChannelCount: 1,
  buffer: undefined,
  audioWarp: input.stretch ? { enabled: true, mode: 'stretch', sourceBpm: 120 } : undefined,
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

test('deduplicates stable cloud source descriptor resolution', async () => {
  let resolves = 0
  const resolver = createAudioPcmSourceResolver({
    projectId: () => 'project/cloud',
    resolveUrl: () => {
      resolves += 1
      return dataUrl(wave())
    },
  })
  await resolver(clip({ sourceAssetKey: 'asset/stable' }))
  await resolver(clip({ sourceAssetKey: 'asset/stable' }))
  expect(resolves).toBe(1)
})

test('isolates descriptor caches between resolver instances', async () => {
  let firstResolves = 0
  let secondResolves = 0
  const first = createAudioPcmSourceResolver({
    projectId: () => 'project/isolation',
    resolveUrl: () => {
      firstResolves += 1
      return dataUrl(wave())
    },
  })
  const second = createAudioPcmSourceResolver({
    projectId: () => 'project/isolation',
    resolveUrl: () => {
      secondResolves += 1
      return dataUrl(wave())
    },
  })

  await first(clip({ sourceAssetKey: 'asset/isolation' }))
  await second(clip({ sourceAssetKey: 'asset/isolation' }))
  first.clear?.()
  await first(clip({ sourceAssetKey: 'asset/isolation' }))
  await second(clip({ sourceAssetKey: 'asset/isolation' }))

  expect(firstResolves).toBe(2)
  expect(secondResolves).toBe(1)
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
  expect(result.identity).toBe(`local:${project.id}:asset:local:session`)
  expect(result.persistable).toBe(false)
})

test('deduplicates repeated local descriptor resolution with a stable session identity', async () => {
  const project = await createLocalProject(`Stable local resolver ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  await db.put('assets', {
    id: 'asset:stable-local',
    name: 'sample.wav',
    mimeType: 'audio/wav',
    sizeBytes: wave().byteLength,
    storagePath: 'sample.wav',
    durationSec: 5 / 48_000,
    sampleRate: 48_000,
    channelCount: 1,
    createdAt: 1,
    updatedAt: 1,
  })
  let reads = 0
  const resolver = createAudioPcmSourceResolver({
    projectId: () => project.id,
    readLocalAsset: async () => {
      reads += 1
      return {
        status: 'ready',
        file: new File([wave()], 'sample.wav', { type: 'audio/wav' }),
      }
    },
  })

  const first = await resolver(clip({ sourceAssetKey: 'asset:stable-local' }))
  const second = await resolver(clip({ sourceAssetKey: 'asset:stable-local' }))

  expect(reads).toBe(1)
  expect(second).toBe(first)
  expect(second.identity).toBe(`local:${project.id}:asset:stable-local:session`)
  expect(second.persistable).toBe(false)
})

test('isolates unverified local identities between projects with equal asset keys', async () => {
  const firstProject = await createLocalProject(`First identity project ${crypto.randomUUID()}`)
  const secondProject = await createLocalProject(`Second identity project ${crypto.randomUUID()}`)
  for (const projectId of [firstProject.id, secondProject.id]) {
    const db = await openLocalProjectDb(projectId)
    await db.put('assets', {
      id: 'asset:shared-local',
      name: 'sample.wav',
      mimeType: 'audio/wav',
      sizeBytes: wave().byteLength,
      storagePath: 'sample.wav',
      durationSec: 5 / 48_000,
      sampleRate: 48_000,
      channelCount: 1,
      createdAt: 1,
      updatedAt: 1,
    })
  }
  let projectId = firstProject.id
  const resolver = createAudioPcmSourceResolver({
    projectId: () => projectId,
    readLocalAsset: async () => ({
      status: 'ready',
      file: new File([wave()], 'sample.wav', { type: 'audio/wav' }),
    }),
  })

  const first = await resolver(clip({ sourceAssetKey: 'asset:shared-local' }))
  projectId = secondProject.id
  const second = await resolver(clip({ sourceAssetKey: 'asset:shared-local' }))

  expect(first.persistable).toBe(false)
  expect(second.persistable).toBe(false)
  expect(first.identity).toBe(`local:${firstProject.id}:asset:shared-local:session`)
  expect(second.identity).toBe(`local:${secondProject.id}:asset:shared-local:session`)
  expect(first.identity).not.toBe(second.identity)
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

  const result = await resolver(clip({ sourceAssetKey: 'asset:verified', stretch: true }))

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

test('keeps a shared descriptor resolution alive for a remaining subscriber', async () => {
  const gate = deferred<{ status: 'ready'; file: File }>()
  const restoreFetch = installFetch(async () => {
    const result = await gate.promise
    return new Response(await result.file.arrayBuffer(), {
      headers: { 'content-type': 'audio/wav' },
    })
  })
  try {
    const resolver = createAudioPcmSourceResolver({
      projectId: () => 'project/shared',
      resolveUrl: () => 'https://resolver.test/shared.wav',
    })
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = resolver(clip({ sampleUrl: 'shared://sample' }), firstController.signal)
  await Promise.resolve()
  const second = resolver(clip({ sampleUrl: 'shared://sample' }), secondController.signal)
  firstController.abort()
  await expect(first).rejects.toMatchObject({ name: 'AbortError' })
  gate.resolve({
    status: 'ready',
    file: new File([wave()], 'sample.wav', { type: 'audio/wav' }),
  })
  await expect(second).resolves.toMatchObject({ identity: 'remote:https://resolver.test/shared.wav' })
  } finally {
    restoreFetch()
  }
})

test('replaces a shared resolution after its final subscriber aborts', async () => {
  const gates = [deferred<{ status: 'ready'; file: File }>(), deferred<{ status: 'ready'; file: File }>()]
  let reads = 0
  const restoreFetch = installFetch(async () => {
    const gate = gates[reads]
    reads += 1
    if (!gate) throw new Error('Unexpected extra source fetch.')
    const result = await gate.promise
    return new Response(await result.file.arrayBuffer(), {
      headers: { 'content-type': 'audio/wav' },
    })
  })
  try {
  const resolver = createAudioPcmSourceResolver({
    projectId: () => 'project/replace',
    resolveUrl: () => 'https://resolver.test/replace.wav',
  })
  const firstController = new AbortController()
  const first = resolver(clip({ sampleUrl: 'replace://sample' }), firstController.signal)
  await Promise.resolve()
  firstController.abort()
  await expect(first).rejects.toMatchObject({ name: 'AbortError' })

  const replacement = resolver(clip({ sampleUrl: 'replace://sample' }))
  await Promise.resolve()
  expect(reads).toBe(2)
  gates[1]!.resolve({
    status: 'ready',
    file: new File([wave()], 'sample.wav', { type: 'audio/wav' }),
  })
  await expect(replacement).resolves.toMatchObject({ identity: 'remote:https://resolver.test/replace.wav' })
  gates[0]!.resolve({
    status: 'ready',
    file: new File([wave()], 'sample.wav', { type: 'audio/wav' }),
  })
  } finally {
    restoreFetch()
  }
})
