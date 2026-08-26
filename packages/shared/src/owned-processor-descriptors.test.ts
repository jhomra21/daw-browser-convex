import { describe, expect, test } from 'bun:test'
import {
  OWNED_PROCESSOR_DESCRIPTORS,
  OWNED_PROCESSOR_KINDS,
  OWNED_PROCESSOR_PARAMETER_IDS,
  mergeOwnedProcessorParams,
} from './owned-processor-descriptors'

describe('owned processor descriptors', () => {
  test('every owned kind has persistence, migration, normalization, and parameter membership', () => {
    expect(Object.keys(OWNED_PROCESSOR_DESCRIPTORS)).toEqual([...OWNED_PROCESSOR_KINDS])
    expect(Object.keys(OWNED_PROCESSOR_PARAMETER_IDS)).toEqual([...OWNED_PROCESSOR_KINDS])
    for (const kind of OWNED_PROCESSOR_KINDS) {
      const descriptor = OWNED_PROCESSOR_DESCRIPTORS[kind]
      expect(descriptor.persistsState).toBe(true)
      expect(descriptor.migratesEnvelope).toBe(true)
      expect(descriptor.normalizeParams({}).version).toBe(1)
      expect(OWNED_PROCESSOR_PARAMETER_IDS[kind].length).toBeGreaterThan(0)
    }
  })

  test('deep-merges the owned nested state declared by descriptors', () => {
    const merged = mergeOwnedProcessorParams(
      'gate',
      { version: 1, state: { sidechain: { frequencyHz: 2_000 } } },
      { version: 1, state: { sidechain: { enabled: true, filterType: 'highpass', frequencyHz: 100, q: 1 } } },
    )
    expect(Object.entries(merged.state).find(([key]) => key === 'sidechain')?.[1]).toEqual({
      enabled: true,
      filterType: 'highpass',
      frequencyHz: 2_000,
      q: 1,
    })
  })
})
