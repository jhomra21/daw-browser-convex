import { expect, test } from 'bun:test'

import { compareControlSnapshotText } from './controlProjection'

test('orders snapshot identifiers by code unit', () => {
  expect(['a', 'A', '_', '-', 'Z'].sort(compareControlSnapshotText)).toEqual(['-', 'A', 'Z', '_', 'a'])
})
