import { expect, test } from 'bun:test'

import { sha256File } from './media-pages'

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
