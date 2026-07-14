import { describe, expect, test } from 'bun:test'
import { sidechainRouteIdentity } from './live-mixer-runtime'

describe('live mixer sidechain identity', () => {
  test('scopes an effect instance identity by target track', () => {
    expect(sidechainRouteIdentity('target-a', 'compressor-1'))
      .not.toBe(sidechainRouteIdentity('target-b', 'compressor-1'))
    expect(sidechainRouteIdentity('target-a', 'compressor-1'))
      .toBe(sidechainRouteIdentity('target-a', 'compressor-1'))
  })
})
