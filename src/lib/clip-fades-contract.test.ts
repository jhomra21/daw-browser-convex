import { expect, test } from 'bun:test'

import type { SharedClipFades } from '@daw-browser/shared'
import type { NormalizedClipFades } from '@daw-browser/timeline-core/clip-fades'

type Assert<T extends true> = T
type SharedExtendsNormalized = Assert<SharedClipFades extends NormalizedClipFades ? true : false>
type NormalizedExtendsShared = Assert<NormalizedClipFades extends SharedClipFades ? true : false>

test('shared and timeline fade contracts remain bidirectionally assignable', () => {
  const sharedExtendsNormalized: SharedExtendsNormalized = true
  const normalizedExtendsShared: NormalizedExtendsShared = true
  expect(sharedExtendsNormalized && normalizedExtendsShared).toBe(true)
})
