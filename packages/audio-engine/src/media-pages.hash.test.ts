import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { sha256File } from './media-pages'

// One hashed slice blocks the renderer main thread, so it must stay far below a 512-frame (10.7 ms) audio block:
// the native publication handshake needs its replies handled between slices.
test('yields after every 64 KiB slice and keeps the digest of an independent hash', async () => {
  const bytes = new Uint8Array(4 * 1024 * 1024 + 123)
  bytes.forEach((_, index) => { bytes[index] = index * 31 })
  let yields = 0
  const digest = await sha256File(new File([bytes], 'import.wav'), undefined, async () => { yields += 1 })
  expect(digest).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect(yields).toBeGreaterThanOrEqual(Math.floor(bytes.length / (64 * 1024)))
})

test('yields while hashing multi-megabyte recording files without changing the digest', async () => {
  const bytes = new Uint8Array(3 * 1024 * 1024)
  bytes[0] = 1
  bytes[bytes.length - 1] = 2
  let yields = 0
  const digest = await sha256File(
    new File([bytes], 'recording.pcm'),
    undefined,
    async () => { yields += 1 },
  )
  expect(digest).toBe('e622e5231ab2572dd3edb5673769650eedaac6f6d258e4066b0589b05e5d2980')
  expect(yields).toBeGreaterThanOrEqual(1)
})
