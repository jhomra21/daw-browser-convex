import { expect, test } from 'bun:test'
import { readStoredZipEntries, writeStoredZip } from './project-archive-stream'

const bytes = (value: number, length: number) => new Uint8Array(length).fill(value)

test('streams stored entries in bounded chunks and reads them from slices', async () => {
  const chunks: Uint8Array[] = []
  await writeStoredZip([
    { name: 'manifest.json', file: new Blob(['{"version":2}']) },
    { name: 'assets/audio', file: new Blob([bytes(42, 150_000)]) },
  ], async (chunk) => {
    expect(chunk.length).toBeLessThanOrEqual(65_536)
    chunks.push(chunk)
  })
  const archive = new Blob(chunks.map((chunk) => Uint8Array.from(chunk).buffer))
  const result = new Map<string, Blob>()
  for await (const entry of readStoredZipEntries(archive)) result.set(entry.name, entry.file)
  expect(await result.get('manifest.json')?.text()).toBe('{"version":2}')
  expect(new Uint8Array(await result.get('assets/audio')!.arrayBuffer())).toEqual(bytes(42, 150_000))
})

test('rejects truncated, corrupt, duplicate, and unsupported archives', async () => {
  const chunks: Uint8Array[] = []
  await writeStoredZip([{ name: 'a', file: new Blob(['hello']) }], (chunk) => { chunks.push(chunk) })
  const original = new Uint8Array(await new Blob(chunks.map((chunk) => Uint8Array.from(chunk).buffer)).arrayBuffer())
  const read = async (data: Uint8Array) => {
    for await (const entry of readStoredZipEntries(new Blob([Uint8Array.from(data).buffer]))) await entry.file.arrayBuffer()
  }
  await expect(read(original.slice(0, -3))).rejects.toThrow()
  const corrupt = original.slice()
  corrupt[31] ^= 1
  await expect(read(corrupt)).rejects.toThrow()
  const unsupported = original.slice()
  unsupported[8] = 8
  await expect(read(unsupported)).rejects.toThrow()
  const repeated: Uint8Array[] = []
  await writeStoredZip([{ name: 'a', file: new Blob(['x']) }, { name: 'a', file: new Blob(['y']) }], (chunk) => { repeated.push(chunk) })
  await expect(read(new Uint8Array(await new Blob(repeated.map((chunk) => Uint8Array.from(chunk).buffer)).arrayBuffer()))).rejects.toThrow()
})

test('does not expose entries before the central directory is validated', async () => {
  const chunks: Uint8Array[] = []
  await writeStoredZip([{ name: 'manifest.json', file: new Blob(['{}']) }], (chunk) => { chunks.push(chunk) })
  const truncated = new Blob(chunks.map((chunk) => Uint8Array.from(chunk).buffer)).slice(0, -1)
  const entries: string[] = []
  await expect((async () => {
    for await (const entry of readStoredZipEntries(truncated)) entries.push(entry.name)
  })()).rejects.toThrow()
  expect(entries).toEqual([])
})
