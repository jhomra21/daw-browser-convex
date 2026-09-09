import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'

import { createLocalProject, openLocalProjectDb, purgeLocalProjectCache } from './local-project-db'
import { createLocalAsset } from './local-assets'

const createRoot = () => {
  const files = new Map<string, File>()
  const writes: number[] = []
  const assets = {
    getFileHandle: async (name: string) => ({
      createWritable: async () => {
        const chunks: Uint8Array[] = []
        return {
          write: async (chunk: Uint8Array) => {
            writes.push(chunk.byteLength)
            chunks.push(chunk)
          },
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
  return { files, root, writes }
}

test('hashes streamed local asset bytes and ignores caller hash metadata', async () => {
  const { files, root } = createRoot()
  const storage = Object.getOwnPropertyDescriptor(navigator, 'storage')
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => root },
  })
  try {
    const project = await createLocalProject(`Assets ${crypto.randomUUID()}`)
    const file = new File(['abc'], 'kick.wav', { type: 'audio/wav' })
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => Promise.reject(new Error('whole-file read is not allowed')),
    })
    const created = await createLocalAsset({
      projectId: project.id,
      file,
      metadata: { sourceKind: 'upload', channelCount: 2 },
    })
    expect(created.contentHash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(created.sourceKind).toBe('upload')
    expect(created.channelCount).toBe(2)

    const ignored = await createLocalAsset({
      projectId: project.id,
      file,
      metadata: { contentHash: 'a'.repeat(64), sourceKind: 'recording', channelCount: 1 },
    })
    expect(ignored.contentHash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(files.size).toBe(2)
  } finally {
    if (storage) Object.defineProperty(navigator, 'storage', storage)
    else Reflect.deleteProperty(navigator, 'storage')
  }
})

test('hashes large chunked streams without reading a whole-file buffer', async () => {
  const { root } = createRoot()
  const storage = Object.getOwnPropertyDescriptor(navigator, 'storage')
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => root },
  })
  try {
    const project = await createLocalProject(`Assets ${crypto.randomUUID()}`)
    const chunks = [new Uint8Array(1024 * 1024), new Uint8Array(1024 * 1024)]
    const file = new File(chunks, 'large.wav', { type: 'audio/wav' })
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => Promise.reject(new Error('whole-file read is not allowed')),
    })
    Object.defineProperty(file, 'stream', {
      value: () => new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      }),
    })
    const created = await createLocalAsset({ projectId: project.id, file })
    expect(created.contentHash).toMatch(/^[0-9a-f]{64}$/)
  } finally {
    if (storage) Object.defineProperty(navigator, 'storage', storage)
    else Reflect.deleteProperty(navigator, 'storage')
  }
})

test('persists large local assets as bounded writable chunks', async () => {
  const { root, writes } = createRoot()
  const storage = Object.getOwnPropertyDescriptor(navigator, 'storage')
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => root },
  })
  try {
    const project = await createLocalProject(`Assets ${crypto.randomUUID()}`)
    const chunk = new Uint8Array(2 * 1024 * 1024 + 1)
    const file = new File([chunk], 'large.wav', { type: 'audio/wav' })
    Object.defineProperty(file, 'stream', {
      value: () => new ReadableStream({
        start(controller) {
          controller.enqueue(chunk)
          controller.close()
        },
      }),
    })
    await createLocalAsset({ projectId: project.id, file })
    expect(writes).toEqual([1024 * 1024, 1024 * 1024, 1])
  } finally {
    if (storage) Object.defineProperty(navigator, 'storage', storage)
    else Reflect.deleteProperty(navigator, 'storage')
  }
})

test('does not write a file when digesting its stream fails', async () => {
  const { files, root } = createRoot()
  const storage = Object.getOwnPropertyDescriptor(navigator, 'storage')
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => root },
  })
  try {
    const project = await createLocalProject(`Assets ${crypto.randomUUID()}`)
    const file = new File(['abc'], 'kick.wav', { type: 'audio/wav' })
    Object.defineProperty(file, 'stream', {
      value: () => new ReadableStream({
        start(controller) {
          controller.error(new Error('Digest failed'))
        },
      }),
    })
    await expect(createLocalAsset({ projectId: project.id, file })).rejects.toThrow('Digest failed')
    expect(files.size).toBe(0)
  } finally {
    if (storage) Object.defineProperty(navigator, 'storage', storage)
    else Reflect.deleteProperty(navigator, 'storage')
  }
})

test('removes a newly written file when persistence fails', async () => {
  const { files, root } = createRoot()
  const storage = Object.getOwnPropertyDescriptor(navigator, 'storage')
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => root },
  })
  try {
    const project = await createLocalProject(`Assets ${crypto.randomUUID()}`)
    const db = await openLocalProjectDb(project.id)
    const originalPut = db.put.bind(db)
    db.put = async () => {
      throw new Error('DB put failed')
    }
    await expect(createLocalAsset({
      projectId: project.id,
      file: new File(['abc'], 'kick.wav', { type: 'audio/wav' }),
    })).rejects.toThrow('DB put failed')
    expect(files.size).toBe(0)
    db.put = originalPut
  } finally {
    if (storage) Object.defineProperty(navigator, 'storage', storage)
    else Reflect.deleteProperty(navigator, 'storage')
  }
})

test('removes a newly written file when opening persistence fails', async () => {
  const { files, root } = createRoot()
  const storage = Object.getOwnPropertyDescriptor(navigator, 'storage')
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => root },
  })
  try {
    const project = await createLocalProject(`Assets ${crypto.randomUUID()}`)
    await purgeLocalProjectCache(project.id)
    const open = indexedDB.open
    indexedDB.open = () => {
      throw new Error('DB open failed')
    }
    await expect(createLocalAsset({
      projectId: project.id,
      file: new File(['abc'], 'kick.wav', { type: 'audio/wav' }),
    })).rejects.toThrow('DB open failed')
    expect(files.size).toBe(0)
    indexedDB.open = open
  } finally {
    if (storage) Object.defineProperty(navigator, 'storage', storage)
    else Reflect.deleteProperty(navigator, 'storage')
  }
})
