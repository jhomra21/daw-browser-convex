import { expect, test } from 'bun:test'
import { planThirtyTrackV3 } from './v3-spec'
import { writeThirtyTrackV3MediaFile } from './v3-media-file'

test('writes a mixed-rate source through bounded pages with exact WAV length', async () => {
  const source = planThirtyTrackV3().audio[1]!
  const chunks: Uint8Array[] = []
  let removed = false
  const directory = {
    getFileHandle: async () => ({
      createWritable: async () => ({
        write: async (chunk: Uint8Array) => { chunks.push(Uint8Array.from(chunk)) },
        close: async () => undefined,
        abort: async () => undefined,
      }),
      getFile: async () => new File(chunks.map((chunk) => Uint8Array.from(chunk).buffer), 'source.wav'),
    }),
    removeEntry: async () => { removed = true },
  }
  const file = await writeThirtyTrackV3MediaFile(source, directory)
  expect(file.size).toBe(source.uncompressedBytes + 44)
  expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(16_384 * 2 * 4)
  expect(removed).toBeFalse()
})

test('cleans a partially written source on a failed page write', async () => {
  const source = planThirtyTrackV3().audio[1]!
  let removed = false
  let aborted = false
  const directory = {
    getFileHandle: async () => ({
      createWritable: async () => ({
        write: async () => { throw new Error('storage full') },
        close: async () => undefined,
        abort: async () => { aborted = true },
      }),
      getFile: async () => new File([], 'source.wav'),
    }),
    removeEntry: async () => { removed = true },
  }
  await expect(writeThirtyTrackV3MediaFile(source, directory)).rejects.toThrow('storage full')
  expect(aborted).toBeTrue()
  expect(removed).toBeTrue()
})
