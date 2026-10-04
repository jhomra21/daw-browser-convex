import { expect, test } from 'bun:test'

import { readPlanarFloat32Channels } from './encode-recording-wav'

test('reads each planar recording channel without per-sample conversion', () => {
  const source = new Float32Array([0.25, -0.5, 0.75, -1])
  const payload = new Uint8Array(source.buffer)
  const channels = readPlanarFloat32Channels(payload, 2, 2)
  expect(Array.from(channels[0] ?? [])).toEqual([0.25, -0.5])
  expect(Array.from(channels[1] ?? [])).toEqual([0.75, -1])
})
