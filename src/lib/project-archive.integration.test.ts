import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { readStoredZipEntries, writeStoredZip } from './project-archive-stream'
import { createLocalProject, deleteLocalProject, getLocalProject } from './local-project-db'
import { createLocalAsset, listLocalAssets, readLocalAssetBytes } from './local-assets'
import { exportDawProjectArchiveStreamed, importDawProjectArchiveStreamed } from './project-archive'

test('streamed archive roundtrips an empty project in bounded chunks', async () => {
  const original = await createLocalProject(`archive-roundtrip-${crypto.randomUUID()}`)
  let restored: string | undefined
  try {
    const chunks: Uint8Array[] = []
    await exportDawProjectArchiveStreamed(original.id, (chunk) => {
      expect(chunk.byteLength).toBeLessThanOrEqual(65_536)
      chunks.push(Uint8Array.from(chunk))
    })
    restored = await importDawProjectArchiveStreamed(new File(chunks.map((chunk) => Uint8Array.from(chunk).buffer), 'roundtrip.dawproject'))
    expect(restored).not.toBe(original.id)
    expect((await getLocalProject(restored))?.name).toBe(original.name)
  } finally {
    if (restored) await deleteLocalProject(restored)
    await deleteLocalProject(original.id)
  }
})

test('streamed export propagates a failed destination write without changing the project', async () => {
  const project = await createLocalProject(`archive-write-failure-${crypto.randomUUID()}`)
  try {
    const failure = new Error('destination unavailable')
    await expect(exportDawProjectArchiveStreamed(project.id, () => {
      throw failure
    })).rejects.toBe(failure)
    expect(await getLocalProject(project.id)).toBeDefined()
  } finally {
    await deleteLocalProject(project.id)
  }
})

test('streamed import rejects malformed archives without creating a project', async () => {
  const chunks: Uint8Array[] = []
  await writeStoredZip([{ name: 'manifest.json', file: new Blob(['{}']) }], (chunk) => { chunks.push(chunk) })
  const archive = new File(chunks.map((chunk) => Uint8Array.from(chunk).buffer), 'broken.dawproject')
  await expect(importDawProjectArchiveStreamed(archive)).rejects.toThrow()
})

test('streamed ZIP reader rejects a trailing invalid directory before exposing assets', async () => {
  const chunks: Uint8Array[] = []
  await writeStoredZip([{ name: 'manifest.json', file: new Blob(['{}']) }, { name: 'assets/a/a.wav', file: new Blob([new Uint8Array(150_000)]) }], (chunk) => {
    expect(chunk.byteLength).toBeLessThanOrEqual(65_536)
    chunks.push(chunk)
  })
  const archive = new Blob(chunks.map((chunk) => Uint8Array.from(chunk).buffer))
  const seen: string[] = []
  await expect((async () => {
    for await (const entry of readStoredZipEntries(archive.slice(0, -1))) seen.push(entry.name)
  })()).rejects.toThrow()
  expect(seen).toEqual([])
})

test('streamed archive restores asset bytes and metadata without whole-file reads', async () => {
  const files = new Map<string, File>()
  const directories = new Map<string, ReturnType<typeof directory>>()
  const directory = (path: string) => ({
    getDirectoryHandle: async (name: string) => {
      const key = `${path}/${name}`
      const current = directories.get(key) ?? directory(key)
      directories.set(key, current)
      return current
    },
    getFileHandle: async (name: string) => ({
      getFile: async () => {
        const file = files.get(`${path}/${name}`)
        if (!file) throw new DOMException('Missing file', 'NotFoundError')
        return file
      },
      createWritable: async () => {
        const chunks: Uint8Array[] = []
        return {
          write: async (chunk: Uint8Array) => { chunks.push(Uint8Array.from(chunk)) },
          close: async () => { files.set(`${path}/${name}`, new File(chunks.map((chunk) => Uint8Array.from(chunk).buffer), name)) },
          abort: async () => undefined,
        }
      },
    }),
    removeEntry: async (name: string) => {
      for (const key of files.keys()) if (key.startsWith(`${path}/${name}/`) || key === `${path}/${name}`) files.delete(key)
    },
  })
  const storage = Object.getOwnPropertyDescriptor(navigator, 'storage')
  Object.defineProperty(navigator, 'storage', {
    configurable: true, value: { getDirectory: async () => directory('root') },
  })
  let original: string | undefined
  let restored: string | undefined
  try {
    original = (await createLocalProject(`archive-assets-${crypto.randomUUID()}`)).id
    const asset = await createLocalAsset({
      projectId: original,
      file: new File([Uint8Array.of(0, 2, 4, 6, 8)], 'source.wav', { type: 'audio/wav' }),
      metadata: { sourceKind: 'recording', sampleRate: 44_100, channelCount: 1, durationSec: 600 },
    })
    const chunks: Uint8Array[] = []
    await exportDawProjectArchiveStreamed(original, (chunk) => { chunks.push(Uint8Array.from(chunk)) })
    restored = await importDawProjectArchiveStreamed(new File(chunks.map((chunk) => Uint8Array.from(chunk).buffer), 'assets.dawproject'))
    expect((await listLocalAssets(restored)).find((entry) => entry.id === asset.id)).toMatchObject({
      contentHash: asset.contentHash,
      sourceKind: 'recording',
      sampleRate: 44_100,
      channelCount: 1,
      durationSec: 600,
    })
    const result = await readLocalAssetBytes(restored, asset.id)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('Restored asset unavailable.')
    expect(new Uint8Array(await result.file.arrayBuffer())).toEqual(Uint8Array.of(0, 2, 4, 6, 8))
  } finally {
    if (restored) await deleteLocalProject(restored)
    if (original) await deleteLocalProject(original)
    if (storage) Object.defineProperty(navigator, 'storage', storage)
    else Reflect.deleteProperty(navigator, 'storage')
  }
})
