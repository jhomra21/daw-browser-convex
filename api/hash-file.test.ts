import { expect, test } from 'bun:test'
import { sha256 } from '@noble/hashes/sha2.js'
import { hashFile } from './hash-file'

test('hashes a file incrementally without reading the whole file', async () => {
  const chunks = [Uint8Array.from([1, 2]), Uint8Array.from([3, 4, 5])]
  const file = new File([Uint8Array.from([1, 2, 3, 4, 5])], 'fixture.bin')
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: () => Promise.reject(new Error('whole-file read is not allowed')),
  })
  Object.defineProperty(file, 'stream', {
    configurable: true,
    value: () => new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
  })

  await expect(hashFile(file)).resolves.toBe(
    Array.from(sha256(Uint8Array.from([1, 2, 3, 4, 5])), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  )
})
